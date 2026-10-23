// Batches reuse the displayed route as baseline; legacy previews remain isolated.
BR.RouteImpact = L.Class.extend({
    initialize(profile, routing, router) {
        this.profile = profile;
        this.routing = routing;
        this.router = router;
        router.routeImpact = this;
        this.batchActive = 0;
        this.version = 0;
        this.cache = new Map();
        this.requests = new Set();
        this.toggle = document.getElementById('profile-route-estimates');
        this.status = document.getElementById('profile-route-estimates-status');
        this.toggle.disabled = !BR.conf.allowRouteEstimates;
        let enabled = true;
        try {
            enabled = localStorage.getItem('routingprofile.routeEstimates') !== 'false';
        } catch (err) {
            // Browser storage is optional.
        }
        this.toggle.checked = !!BR.conf.allowRouteEstimates && enabled;
        this.toggle.onchange = () => {
            try {
                localStorage.setItem('routingprofile.routeEstimates', String(this.toggle.checked));
            } catch (err) {
                // Keep the choice for this session.
            }
            this.schedule();
        };
        profile.on('textchange name clear default', this.schedule, this);
        profile.editor.on('change', () => this.schedule());
        $('#profile_params').on('input change', 'input, select', () => this.schedule());
        $('#profileEditorTabs a[data-toggle="tab"]').on('shown.bs.tab', () => this.schedule());
        routing.on(
            'routing:routeWaypointStart routing:rerouteSegmentStart ' +
                'routing:rerouteAllSegmentsStart routing:setWaypointsStart ' +
                'routing:cleared waypoint:click waypoint:dragstart',
            this.schedule,
            this
        );
        routing.on(
            'routing:routeWaypointEnd routing:rerouteSegmentEnd routing:rerouteAllSegmentsEnd routing:setWaypointsEnd',
            this.refresh,
            this
        );
        if (routing._waypoints) routing._waypoints.on('layeradd layerremove', this.schedule, this);
        this.schedule();
    },

    schedule() {
        if (this._batchRun && this._matchesBatch(this._batchRun)) {
            this._renderBatch(this._batchRun);
            return;
        }
        const version = ++this.version;
        this._cancelBatch();
        clearTimeout(this.timer);
        this.requests.forEach((xhr) => xhr.abort());
        this.requests.clear();
        this._clearIndicators();
        if (!BR.conf.allowRouteEstimates) {
            this._status('unavailable');
            return;
        }
        this.status.textContent = '';
        if (!this.toggle.checked) return;
        this._status('waiting');
        this.timer = setTimeout(() => this._run(version), 800);
    },

    refresh() {
        if (!BR.conf.allowRouteEstimates || !this.toggle.checked) return;
        if (this._batchRun && this._matchesBatch(this._batchRun)) {
            this._renderBatch(this._batchRun);
            this._fillBatches(this._batchRun);
        } else {
            clearTimeout(this.timer);
            this.timer = setTimeout(() => this._run(this.version), 800);
        }
    },

    _useBatches() {
        return !!(
            BR.conf.useRouteBatches &&
            BR.conf.allowRouteEstimates &&
            this.toggle.checked &&
            !this.batchUnsupported
        );
    },

    _normalizedText() {
        const text = this.profile._currentText();
        return BR.RidingPreferences.build(text, BR.RidingPreferences.ratings(text));
    },

    _matchesBatch(run) {
        try {
            return (
                this._useBatches() &&
                !run.aborted &&
                this.profile._isParamsFormActive() &&
                this.profile._validateParams(false) &&
                run.text === this._normalizedText() &&
                JSON.stringify(run.urls) === JSON.stringify(this._routeUrls())
            );
        } catch (error) {
            return false;
        }
    },

    getRoute(latLngs, callback) {
        if (
            !this._useBatches() ||
            !BR.RouteBatch ||
            !this.profile._isParamsFormActive() ||
            !this.profile._validateParams(false) ||
            this.batchActive >= 6
        )
            return false;
        // Manual drafts must not silently change the profile selected for the map.
        const source = this.profile.cache[this.router.options.profile];
        if (!source) return false;
        const text = this._normalizedText();
        if (BR.RidingPreferences.build(source, BR.RidingPreferences.ratings(source)) !== text) return false;
        let run = this._batchRun;
        if (!run || !this._matchesBatch(run)) {
            this._cancelBatch();
            this._clearIndicators();
            run = this._createBatch(text, this._routeUrls(), this._targets());
            if (!run) return false;
            run.profileId = this.router.options.profile;
            run.uploaded = true;
        }
        const preview = L.bRouter(Object.assign({}, this.router.options, { profile: 'route_impact_preview' }));
        const url = preview.getUrl(latLngs, null, null, null, 'geojson');
        if (!run.urls.includes(url)) return false;
        clearTimeout(this.timer);
        const record = this._startBatch(run, url);
        const deliver = (error, route) => {
            if (error) callback(error);
            else {
                let layer;
                try {
                    layer = this.router.routeLayer(route);
                } catch (err) {
                    return callback(err);
                }
                callback(null, layer);
            }
        };
        if (record.route) deliver(null, record.route);
        else if (record.currentError) deliver(record.currentError);
        else if (record.fallback) this._singleFallback(latLngs, callback);
        else
            record.waiters.push({
                deliver,
                callback,
                latLngs,
                routeKey: this.router.getUrl(latLngs, null, null, null, 'geojson'),
            });
        this._fillBatches(run);
        return true;
    },

    _createBatch(text, urls, targets) {
        const scenarios = targets.map((target, index) => ({ id: 'p' + index, target }));
        // Build ratings from each actual variant, preserving all other draft values.
        scenarios.forEach((scenario) => {
            const variant = this.profile._buildCustomProfile(this.profile._getProfileText(), {
                [scenario.target.input.name]: scenario.target.value,
            });
            scenario.variant = BR.RidingPreferences.build(variant, BR.RidingPreferences.ratings(variant));
            scenario.overrides = this._profileOverrides(text, scenario.variant);
        });
        if (!urls.length || !targets.length || scenarios.length > 63 || scenarios.some((s) => s.overrides === null))
            return null;
        const run = {
            version: this.version,
            text,
            urls,
            scenarios,
            records: new Map(),
            handles: new Set(),
            profileId: 'custom_preview_' + Date.now() + '_' + Math.random().toString(36).slice(2),
        };
        run.done = new Promise((resolve) => {
            run.resolve = resolve;
        });
        this._batchRun = run;
        return run;
    },

    _startBatch(run, url) {
        if (run.records.has(url)) return run.records.get(url);
        const record = { stats: new Map(), errors: new Set(), waiters: [], done: false };
        run.records.set(url, record);
        this.batchActive++;
        record.promise = this._uploadBatchBase(run)
            .then(() => {
                if (run.aborted || run.version !== this.version) throw new Error('Superseded batch');
                const params = new URL(url, window.location.href).searchParams;
                params.set('profile', run.profileId);
                params.set('scenario.current', '');
                run.scenarios.forEach(({ id, overrides }) => params.set('scenario.' + id, overrides.replace(/^&/, '')));
                const handle = BR.RouteBatch.request(BR.conf.host + '/brouter/batch', params, (event) => {
                    if (run.aborted || run.version !== this.version) return;
                    if (event.type === 'result' || event.type === 'error') {
                        if (event.id !== 'current' && !run.scenarios.some(({ id }) => id === event.id))
                            throw new Error('Invalid scenario');
                        if (record.stats.has(event.id) || record.errors.has(event.id))
                            throw new Error('Duplicate scenario');
                        if (event.type === 'error') {
                            record.errors.add(event.id);
                            if (event.id === 'current') this._deliverCurrent(record, event.message || 'Routing failed');
                        } else {
                            if (!Number.isFinite(event.distance) || !Number.isFinite(event.time))
                                throw new Error('Invalid route totals');
                            if (event.id === 'current' && !event.route?.features?.length)
                                throw new Error('Missing current route');
                            record.stats.set(event.id, { distance: event.distance, time: event.time });
                            if (event.id === 'current') {
                                record.route = event.route;
                                this._deliverCurrent(record, null, event.route);
                            }
                        }
                    } else if (event.type === 'complete') {
                        if (
                            event.cancelled ||
                            event.completed !== run.scenarios.length + 1 ||
                            record.stats.size + record.errors.size !== run.scenarios.length + 1
                        )
                            throw new Error('Incomplete batch');
                    } else if (!['start', 'heartbeat'].includes(event.type)) throw new Error('Invalid batch event');
                    this._renderBatch(run);
                });
                this.requests.add(handle);
                run.handles.add(handle);
                return handle.promise.finally(() => {
                    this.requests.delete(handle);
                    run.handles.delete(handle);
                });
            })
            .catch((error) => {
                if (run.aborted || run.version !== this.version) return;
                if ([404, 405, 501].includes(error.status)) {
                    this.batchUnsupported = true;
                    // Preserve already displayed geometry while cancelling obsolete speculative work.
                    this._cancelBatch();
                    this.refresh();
                    return;
                }
                ['current', ...run.scenarios.map(({ id }) => id)].forEach((id) => {
                    if (!record.stats.has(id)) record.errors.add(id);
                });
                if (!record.route) {
                    record.fallback = true;
                    const waiters = record.waiters.splice(0);
                    waiters.forEach(({ callback, latLngs, routeKey }) =>
                        this._singleFallback(latLngs, callback, routeKey)
                    );
                }
            })
            .finally(() => {
                record.done = true;
                this.batchActive--;
                if (!run.aborted && run.version === this.version) {
                    this._renderBatch(run);
                    this._fillBatches(run);
                } else if (this._batchRun) {
                    this._fillBatches(this._batchRun);
                }
            });
        return record;
    },

    _deliverCurrent(record, error, route) {
        record.currentError = error;
        record.waiters.splice(0).forEach(({ deliver }) => deliver(error, route));
    },

    _fillBatches(run) {
        if (run.aborted || run.version !== this.version) return;
        for (const url of run.urls) {
            if (this.batchActive >= 2) break;
            if (!run.records.has(url)) this._startBatch(run, url);
        }
        if (run.urls.every((url) => run.records.get(url)?.done)) run.resolve();
    },

    async _uploadBatchBase(run) {
        if (run.uploaded) return;
        if (!run.uploading)
            run.uploading = this._request('POST', L.BRouter.URL_PROFILE_UPLOAD + '/' + run.profileId, run.text).then(
                (uploaded) => {
                    if (uploaded.error || !/^custom_[\w-]+$/.test(uploaded.profileid || ''))
                        throw new Error('Profile upload failed');
                    run.profileId = uploaded.profileid;
                    run.uploaded = true;
                }
            );
        return run.uploading;
    },

    _cancelBatch() {
        const run = this._batchRun;
        if (!run) return;
        run.aborted = true;
        run.resolve();
        run.records.forEach((record) => {
            record.waiters.splice(0).forEach(({ deliver, callback, latLngs, routeKey }) => {
                if (this._isCurrentLeg(latLngs, routeKey)) this._singleFallback(latLngs, callback, routeKey);
                else deliver(L.BRouter.ABORTED_ERROR);
            });
        });
        run.handles.forEach((handle) => {
            this.requests.delete(handle);
            handle.abort();
        });
        this._batchRun = null;
    },

    _isCurrentLeg(latLngs, routeKey) {
        const preview = L.bRouter(Object.assign({}, this.router.options, { profile: 'route_impact_preview' }));
        return (
            this.router.getUrl(latLngs, null, null, null, 'geojson') === routeKey &&
            this._routeUrls().includes(preview.getUrl(latLngs, null, null, null, 'geojson'))
        );
    },

    _singleFallback(latLngs, callback, routeKey = this.router.getUrl(latLngs, null, null, null, 'geojson')) {
        this.router.getSingleRoute(latLngs, (error, layer) => {
            if (!this._isCurrentLeg(latLngs, routeKey)) callback(L.BRouter.ABORTED_ERROR);
            else callback(error, layer);
        });
    },

    _renderBatch(run) {
        if (run.aborted || run.version !== this.version) return;
        if (run.scenarios.some(({ target }) => document.getElementById(target.output.id) !== target.output)) {
            const targets = this._targets();
            run.scenarios.forEach((scenario) => {
                scenario.target =
                    targets.find(({ output }) => output.id === scenario.target.output.id) || scenario.target;
            });
        }
        const total = (id) =>
            run.urls.reduce(
                (sum, url) => {
                    const stats = run.records.get(url)?.stats.get(id);
                    return stats && sum
                        ? { distance: sum.distance + stats.distance, time: sum.time + stats.time }
                        : null;
                },
                { distance: 0, time: 0 }
            );
        const baseline = total('current');
        let done = 0,
            failed = false;
        run.scenarios.forEach(({ id, target, variant }) => {
            const unavailable = run.urls.some(
                (url) => run.records.get(url)?.errors.has(id) || run.records.get(url)?.errors.has('current')
            );
            const stats = total(id);
            if (unavailable) {
                target.output.textContent = i18next.t('sidebar.profile.estimates-failed');
                done++;
                failed = true;
            } else if (baseline && stats) {
                const delta = this._formatDelta(stats.time - baseline.time, stats.distance - baseline.distance);
                target.output.textContent =
                    target.input.type === 'checkbox'
                        ? i18next.t('sidebar.profile.estimates-if-' + (target.value ? 'on' : 'off'), { delta })
                        : delta;
                this.cache.set(JSON.stringify([run.urls, variant]), stats);
                if (this.cache.size > 96) this.cache.delete(this.cache.keys().next().value);
                done++;
            }
        });
        this._status(done === run.scenarios.length ? (failed ? 'partial' : 'ready') : 'calculating', {
            done,
            total: run.scenarios.length,
        });
    },

    _status(key, args) {
        this.status.textContent = i18next.t('sidebar.profile.estimates-' + key, args);
    },

    _clearIndicators() {
        document.querySelectorAll('#profile_params [data-route-impact]').forEach((output) => output.remove());
        document.querySelectorAll('#profile_params input[aria-describedby]').forEach((input) => {
            const ids = input
                .getAttribute('aria-describedby')
                .split(' ')
                .filter((id) => !id.startsWith('route-impact-'));
            if (ids.length) input.setAttribute('aria-describedby', ids.join(' '));
            else input.removeAttribute('aria-describedby');
        });
    },

    _targets() {
        const names = [
            'prefer_forests',
            'consider_forest',
            'prefer_rivers',
            'consider_river',
            'ignore_cycleroutes',
            'stick_to_cycleroutes',
            'use_proposed_cycleroutes',
            'prefer_cycle_routes',
            'prefer_unpaved_paths',
            'avoid_noise',
            'consider_noise',
            'consider_traffic_estimate',
            'consider_traffic',
            'assume_wet_conditions',
            'avoid_steep_inclines',
            'consider_elevation',
            'avoid_towns',
            'consider_town',
            'allow_steps',
            'allow_ferries',
            'allow_motorways',
            'avoid_unsafe',
            'considerTurnRestrictions',
            'correctMisplacedViaPoints',
            'add_beeline',
            'avoid_toll',
            'avoid_unpaved',
            'avoid_motorways',
            'use_offroad',
        ];
        const targets = [];
        document.querySelectorAll('#profile_params input').forEach((input) => {
            const radio =
                input.type === 'radio' &&
                ['rider_pref_forest', 'rider_pref_water', 'rider_pref_unpaved', 'rider_pref_quiet'].includes(
                    input.name
                );
            const checkbox = input.type === 'checkbox' && names.includes(input.name);
            if (!radio && !checkbox) return;
            const output = document.createElement('span');
            output.className = 'route-impact-value';
            output.dataset.routeImpact = '';
            output.id = 'route-impact-' + input.name + (radio ? '-' + input.value : '');
            input.setAttribute(
                'aria-describedby',
                [input.getAttribute('aria-describedby'), output.id].filter(Boolean).join(' ')
            );
            (radio ? input.closest('label') : input.closest('.profile-toggle')).appendChild(output);
            if (radio && input.checked) {
                output.textContent = i18next.t('sidebar.profile.estimates-current');
                return;
            }
            output.textContent = '…';
            targets.push({ input, output, value: radio ? input.value : !input.checked });
        });
        return targets;
    },

    _routeUrls() {
        const points = this.routing.getWaypoints();
        const beelines = this.routing.getBeelineFlags();
        const preview = L.bRouter(Object.assign({}, this.router.options, { profile: 'route_impact_preview' }));
        const urls = [];
        for (let i = 0; i < points.length - 1; i++) {
            // Straight-line sections are fixed, so their contribution to each difference is zero.
            if (!beelines[i]) urls.push(preview.getUrl([points[i], points[i + 1]], null, null, null, 'geojson'));
        }
        return urls;
    },

    async _run(version) {
        if (version !== this.version || !BR.conf.allowRouteEstimates || !this.toggle.checked) return;
        if (this._batchRun && this._matchesBatch(this._batchRun)) {
            this._renderBatch(this._batchRun);
            this._fillBatches(this._batchRun);
            return this._batchRun.done;
        }
        if (!this.profile._isParamsFormActive()) return this._status('options');
        if (this.profile._applyInFlight || !this.router.queue.idle() || this.routing._routingAll) {
            this.timer = setTimeout(() => this._run(version), 500);
            return;
        }
        if (!this.profile._validateParams(false)) return this._status('invalid');
        const urls = this._routeUrls();
        if (!urls.length) return this._status('route-needed');
        const targets = this._targets();
        if (!targets.length) return this._status('unsupported');
        const normalize = (source) => BR.RidingPreferences.build(source, BR.RidingPreferences.ratings(source));
        const text = normalize(this.profile._currentText());
        const run = {
            version,
            text,
            // A separate namespace also avoids timestamp-ID collisions with real Apply uploads.
            profileId: 'custom_preview_' + Date.now() + '_' + Math.random().toString(36).slice(2),
        };
        if (this._useBatches() && BR.RouteBatch) {
            const batch = this._createBatch(text, urls, targets);
            if (batch) {
                this._fillBatches(batch);
                return batch.done;
            }
        }
        let failed = false;
        try {
            this._status('calculating', { done: 0, total: targets.length });
            const baseline = await this._measure(text, urls, run);
            let next = 0;
            let done = 0;
            const worker = async () => {
                while (next < targets.length) {
                    const target = targets[next++];
                    if (version !== this.version) return;
                    try {
                        const variant = normalize(
                            this.profile._buildCustomProfile(this.profile._getProfileText(), {
                                [target.input.name]: target.value,
                            })
                        );
                        const stats = await this._measure(variant, urls, run);
                        if (version !== this.version) return;
                        const delta = this._formatDelta(stats.time - baseline.time, stats.distance - baseline.distance);
                        target.output.textContent =
                            target.input.type === 'checkbox'
                                ? i18next.t('sidebar.profile.estimates-if-' + (target.value ? 'on' : 'off'), { delta })
                                : delta;
                    } catch (err) {
                        if (version !== this.version) return;
                        target.output.textContent = i18next.t('sidebar.profile.estimates-failed');
                        failed = true;
                    }
                    this._status('calculating', { done: ++done, total: targets.length });
                }
            };
            // Keep the private deployment's worker budget bounded; shared instances default to one.
            const configured = BR.conf.routeEstimateConcurrency;
            const concurrency = Number.isInteger(configured) ? Math.max(1, Math.min(32, configured)) : 1;
            await Promise.all(Array.from({ length: concurrency }, () => worker()));
            if (version !== this.version) return;
            this._status(failed ? 'partial' : 'ready');
        } catch (err) {
            if (version !== this.version) return;
            targets.forEach(({ output }) => (output.textContent = i18next.t('sidebar.profile.estimates-failed')));
            this._status('error');
        }
    },

    async _measure(text, urls, run) {
        const key = JSON.stringify([urls, text]);
        if (this.cache.has(key)) return this.cache.get(key);
        if (run.version !== this.version) throw new Error('Superseded preview');
        const overrides = this._profileOverrides(run.text, text);
        let profileId = run.profileId;
        if (overrides === null) {
            // Keep the batch's base immutable: concurrent Apply requests use another profile.
            const id = run.profileId + '_variant_' + (run.variantCount = (run.variantCount || 0) + 1);
            const uploaded = await this._request('POST', L.BRouter.URL_PROFILE_UPLOAD + '/' + id, text);
            if (uploaded.error || !/^custom_[\w-]+$/.test(uploaded.profileid || ''))
                throw new Error('Profile upload failed');
            profileId = uploaded.profileid;
        } else if (!run.uploaded) {
            if (!run.uploading) {
                run.uploading = this._request(
                    'POST',
                    L.BRouter.URL_PROFILE_UPLOAD + '/' + run.profileId,
                    run.text
                ).then((uploaded) => {
                    if (uploaded.error || !/^custom_[\w-]+$/.test(uploaded.profileid || ''))
                        throw new Error('Profile upload failed');
                    run.profileId = uploaded.profileid;
                    run.uploaded = true;
                });
            }
            await run.uploading;
            profileId = run.profileId;
        }
        const stats = { distance: 0, time: 0 };
        for (const url of urls) {
            if (run.version !== this.version) throw new Error('Superseded preview');
            const route = await this._request(
                'GET',
                url.replace('profile=route_impact_preview', 'profile=' + profileId) + (overrides || '')
            );
            const properties = route.features && route.features[0] && route.features[0].properties;
            const distance = properties && properties['track-length'];
            const time = properties && properties['total-time'];
            if (
                distance == null ||
                time == null ||
                !Number.isFinite(Number(distance)) ||
                !Number.isFinite(Number(time))
            )
                throw new Error('Missing route totals');
            stats.distance += Number(distance);
            stats.time += Number(time);
        }
        if (run.version !== this.version) throw new Error('Superseded preview');
        this.cache.set(key, stats);
        if (this.cache.size > 96) this.cache.delete(this.cache.keys().next().value);
        return stats;
    },

    _profileOverrides(base, variant) {
        // Only literal changes in the global context can safely use BRouter's profile: parameters.
        const read = (text) => {
            const values = new Map();
            let valid = true;
            const shape = text.replace(
                /(---context:global[^\n]*\n)([\s\S]*?)(?=---context:|$)/g,
                (match, context, body) =>
                    context +
                    body.replace(
                        /^(\s*assign\s+([\w]+)\s*=?\s*)(true|false|[-+]?(?:\d+(?:\.\d*)?|\.\d+))(\s*(?:#[^\n]*)?)$/gm,
                        (line, prefix, name, value, suffix) => {
                            if (values.has(name)) valid = false;
                            values.set(name, value);
                            return prefix + '@value' + suffix;
                        }
                    )
            );
            return { shape, values, valid };
        };
        const before = read(base);
        const after = read(variant);
        if (!before.valid || !after.valid || before.shape !== after.shape) return null;
        let query = '';
        after.values.forEach((value, name) => {
            if (before.values.get(name) !== value) {
                const numeric = value === 'true' ? '1' : value === 'false' ? '0' : value;
                query += '&profile:' + encodeURIComponent(name) + '=' + encodeURIComponent(numeric);
            }
        });
        return query;
    },

    _request(method, url, body) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            this.requests.add(xhr);
            const finish = (error, data) => {
                this.requests.delete(xhr);
                if (error) reject(error);
                else resolve(data);
            };
            xhr.open(method, url, true);
            xhr.timeout = 30000;
            if (method === 'POST') xhr.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
            xhr.onload = () => {
                try {
                    if (xhr.status !== 200) throw new Error('Routing request failed');
                    finish(null, JSON.parse(xhr.responseText));
                } catch (err) {
                    finish(err);
                }
            };
            xhr.onerror = xhr.ontimeout = xhr.onabort = () => finish(new Error('Routing request interrupted'));
            xhr.send(body === undefined ? null : body);
        });
    },

    _formatDelta(seconds, metres) {
        const signed = (value, divisor, precision) => {
            const rounded = Number((Math.abs(value) / divisor).toFixed(precision));
            const sign = rounded ? (value < 0 ? '−' : '+') : '';
            return sign + rounded.toLocaleString(undefined, { maximumFractionDigits: precision });
        };
        return i18next.t('sidebar.profile.estimates-delta', {
            time: signed(seconds, 60, 0),
            distance: signed(metres, 1000, 1),
        });
    },
});
