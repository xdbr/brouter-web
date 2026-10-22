// Speculative requests have their own profiles and never update the map or library.
BR.RouteImpact = L.Class.extend({
    initialize(profile, routing, router) {
        this.profile = profile;
        this.routing = routing;
        this.router = router;
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
            'routing:routeWaypointStart routing:routeWaypointEnd routing:rerouteSegmentStart routing:rerouteSegmentEnd ' +
                'routing:rerouteAllSegmentsStart routing:rerouteAllSegmentsEnd routing:setWaypointsStart routing:setWaypointsEnd ' +
                'routing:cleared waypoint:click waypoint:dragstart',
            this.schedule,
            this
        );
        if (routing._waypoints) routing._waypoints.on('layeradd layerremove', this.schedule, this);
        this.schedule();
    },

    schedule() {
        const version = ++this.version;
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
        if (version !== this.version) return;
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
