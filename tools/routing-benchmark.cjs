// Benchmark the existing HTTP API before changing preview scheduling or graph caches.
// Node >= 22; no dependencies or changes to the running app are required.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function loadProfileTools() {
    const sandbox = { BR: {}, L: { Class: { extend: (definition) => definition } } };
    vm.createContext(sandbox);
    for (const file of ['js/util/RidingPreferences.js', 'js/control/RouteImpact.js']) {
        vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
    }
    return { preferences: sandbox.BR.RidingPreferences, impact: sandbox.BR.RouteImpact };
}

function replaceGlobal(text, name, value) {
    let changed = false;
    const result = text.replace(
        /(---context:global[^\n]*\n)([\s\S]*?)(?=---context:|$)/g,
        (_, header, body) =>
            header +
            body.replace(
                new RegExp('(^\\s*assign\\s+' + name + '\\s*=?\\s*)(true|false|0|1)\\b', 'm'),
                (match, prefix) => {
                    changed = true;
                    return prefix + value;
                }
            )
    );
    if (!changed) throw new Error('Profile does not support ' + name);
    return result;
}

function buildScenarios(source, settings) {
    const { preferences, impact } = loadProfileTools();
    const ratings = { ...preferences.ratings(source), ...settings.ratings };
    let base = source;
    for (const [name, value] of Object.entries(settings.booleans)) base = replaceGlobal(base, name, value);
    base = preferences.build(base, ratings);
    const scenarios = [{ id: 'current', text: base }];
    for (const name of Object.keys(settings.ratings)) {
        if (!preferences.supported(base).some(({ id }) => id === name)) throw new Error('Unsupported rating: ' + name);
        for (let value = 1; value <= 5; value++) {
            if (value !== ratings[name])
                scenarios.push({
                    id: name + '-' + value,
                    text: preferences.build(base, { ...ratings, [name]: value }),
                });
        }
    }
    for (const [name, value] of Object.entries(settings.booleans))
        scenarios.push({
            id: name + '-' + !value,
            text: preferences.build(replaceGlobal(base, name, !value), ratings),
        });
    return scenarios.map((scenario) => {
        const overrides = impact._profileOverrides(base, scenario.text);
        if (overrides === null) throw new Error('Scenario requires a structural profile change: ' + scenario.id);
        return { ...scenario, overrides };
    });
}

async function pool(items, concurrency, work) {
    let next = 0;
    let failure;
    const result = new Array(items.length);
    await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, async () => {
            while (!failure && next < items.length) {
                const index = next++;
                try {
                    result[index] = await work(items[index]);
                } catch (error) {
                    failure = error;
                }
            }
        })
    );
    if (failure) throw failure;
    return result;
}

function runtimeMetadata(container) {
    const revision = (directory) => {
        try {
            return execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        } catch {
            return null;
        }
    };
    const metadata = {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        hostCpuModel: os.cpus()[0]?.model,
        hostLogicalCpus: os.cpus().length,
        frontendRevision: revision(root),
        backendRevision: revision(path.resolve(root, '../backend')),
    };
    if (container) {
        const inspected = JSON.parse(
            execFileSync('docker', ['inspect', '--format', '{{json .}}', container], { encoding: 'utf8' })
        );
        metadata.container = {
            image: inspected.Config.Image,
            imageId: inspected.Image,
            startedAt: inspected.State.StartedAt,
            nanoCpus: inspected.HostConfig.NanoCpus,
            memoryLimitBytes: inspected.HostConfig.Memory,
            javaOptions: inspected.Config.Env.find((entry) => entry.startsWith('JAVA_OPTS=')),
            maxThreads: inspected.Config.Env.find((entry) => entry.startsWith('MAXTHREADS=')),
        };
    }
    const tiles = path.resolve(root, '../.local/brouter/segments4');
    if (fs.existsSync(tiles))
        metadata.tiles = fs
            .readdirSync(tiles)
            .filter((name) => name.endsWith('.rd5'))
            .map((name) => {
                const stat = fs.statSync(path.join(tiles, name));
                return { name, bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
            });
    return metadata;
}

function routeMetrics(geojson) {
    const p = geojson.features?.[0]?.properties;
    const result = { distanceM: Number(p?.['track-length']), timeS: Number(p?.['total-time']) };
    if (!p || p['track-length'] == null || p['total-time'] == null || !Object.values(result).every(Number.isFinite))
        throw new Error('Missing route totals');
    const geometry = geojson.features[0].geometry;
    result.geometrySha256 = crypto.createHash('sha256').update(JSON.stringify(geometry)).digest('hex');
    return result;
}

async function measureSchedule(mode, scenarios, concurrency, route) {
    const start = performance.now();
    const measure = async (scenario, role) => {
        const requestStart = performance.now();
        const metrics = await route(scenario);
        return {
            id: scenario.id,
            role,
            startedMs: requestStart - start,
            completedMs: performance.now() - start,
            ...metrics,
        };
    };
    let displayed;
    let baseline;
    let variants;
    if (mode === 'single') {
        displayed = await measure(scenarios[0], 'displayed');
        baseline = displayed;
        variants = [];
    } else if (mode === 'current') {
        // Matches the current dependency chain. UI debounce/polling and uploads are excluded.
        displayed = await measure(scenarios[0], 'displayed');
        baseline = await measure(scenarios[0], 'preview-baseline');
        variants = await pool(scenarios.slice(1), concurrency, (s) => measure(s, 'preview'));
    } else if (mode === 'overlap') {
        // A scheduling experiment using the existing API, not a new batch endpoint.
        const foreground = measure(scenarios[0], 'displayed');
        const background = pool(scenarios.slice(1), concurrency, (s) => measure(s, 'preview'));
        [displayed, variants] = await Promise.all([foreground, background]);
        baseline = displayed;
    } else throw new Error('Unknown schedule: ' + mode);
    return {
        mode,
        concurrency,
        foregroundMs: displayed.completedMs,
        allMs: performance.now() - start,
        requests: baseline === displayed ? [displayed, ...variants] : [displayed, baseline, ...variants],
        estimates: variants.map((v) => ({
            id: v.id,
            availableMs: Math.max(v.completedMs, baseline.completedMs),
            distanceDeltaM: v.distanceM - baseline.distanceM,
            timeDeltaS: v.timeS - baseline.timeS,
        })),
    };
}

async function* readBatchEvents(response) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '';
    for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (line.trim()) yield JSON.parse(line);
        }
    }
    pending += decoder.decode();
    if (pending.trim()) throw new Error('Truncated batch event');
}

async function measureBatch(scenarios, openEvents) {
    const start = performance.now();
    const expected = new Set(scenarios.map(({ id }) => id));
    const results = new Map();
    let complete = false;
    let firstEventMs;
    let graphCache;
    for await (const event of openEvents()) {
        if (firstEventMs === undefined) firstEventMs = performance.now() - start;
        if (complete) throw new Error('Event after batch completion');
        if (event.type === 'error') throw new Error('Batch ' + (event.id || '') + ': ' + event.message);
        if (event.type === 'result') {
            if (!expected.has(event.id) || results.has(event.id)) throw new Error('Unexpected or duplicate scenario');
            if (!Number.isFinite(event.distance) || !Number.isFinite(event.time))
                throw new Error('Invalid batch totals');
            const metrics =
                event.id === 'current' ? routeMetrics(event.route) : { distanceM: event.distance, timeS: event.time };
            if (metrics.distanceM !== event.distance || metrics.timeS !== event.time)
                throw new Error('Inconsistent route totals');
            results.set(event.id, {
                id: event.id,
                role: event.id === 'current' ? 'displayed' : 'preview',
                completedMs: performance.now() - start,
                ...metrics,
            });
        } else if (event.type === 'complete') {
            if (event.cancelled || event.completed !== expected.size || results.size !== expected.size)
                throw new Error('Incomplete batch');
            graphCache = event.graphCache;
            complete = true;
        } else if (!['start', 'heartbeat'].includes(event.type)) throw new Error('Unknown batch event');
    }
    if (!complete || !results.has('current')) throw new Error('Batch stream ended early');
    const current = results.get('current');
    return {
        mode: 'batch',
        concurrency: null,
        firstEventMs,
        ...(graphCache ? { graphCache } : {}),
        foregroundMs: current.completedMs,
        allMs: performance.now() - start,
        requests: [...results.values()],
        estimates: [...results.values()]
            .filter(({ id }) => id !== 'current')
            .map((variant) => ({
                id: variant.id,
                availableMs: Math.max(current.completedMs, variant.completedMs),
                distanceDeltaM: variant.distanceM - current.distanceM,
                timeDeltaS: variant.timeS - current.timeS,
            })),
    };
}

function counters(container) {
    if (!container) return null;
    const text = execFileSync(
        'docker',
        [
            'exec',
            container,
            'sh',
            '-c',
            'cat /sys/fs/cgroup/cpu.stat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.peak',
        ],
        { encoding: 'utf8' }
    );
    const lines = text.trim().split('\n');
    return {
        cpuUsec: Number(text.match(/^usage_usec (\d+)/m)[1]),
        memoryBytes: Number(lines.at(-2)),
        lifetimePeakMemoryBytes: Number(lines.at(-1)),
    };
}

async function request(url, options) {
    const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(300000) });
    const text = await response.text();
    if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + text.slice(0, 200));
    try {
        return JSON.parse(text);
    } catch {
        throw new Error('Non-JSON response: ' + text.slice(0, 200));
    }
}

function parseArgs(argv) {
    const options = {
        url: 'http://127.0.0.1:17777',
        repeats: 3,
        concurrency: [1, 4, 8],
        modes: ['single', 'current', 'overlap'],
        profile: 'trekking',
        cases: [],
        label: 'existing-jvm',
        output: path.resolve(root, '../.local/benchmarks', new Date().toISOString().replace(/[:.]/g, '-') + '.json'),
    };
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i];
        if (key === '--help') return { help: true };
        const value = argv[++i];
        if (value == null || value.startsWith('--')) throw new Error('Missing value for ' + key);
        if (key === '--url') options.url = value;
        else if (key === '--repeats') options.repeats = Number(value);
        else if (key === '--concurrency') options.concurrency = value.split(',').map(Number);
        else if (key === '--modes') options.modes = value.split(',');
        else if (key === '--case') options.cases.push(value);
        else if (key === '--profile') options.profile = value;
        else if (key === '--profile-file') options.profileFile = path.resolve(value);
        else if (key === '--container') options.container = value;
        else if (key === '--label') options.label = value;
        else if (key === '--output') options.output = path.resolve(value);
        else throw new Error('Unknown argument: ' + key);
    }
    const url = new URL(options.url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:')
        throw new Error('Benchmarks must target a local HTTP service');
    if (
        !Number.isInteger(options.repeats) ||
        options.repeats < 1 ||
        options.repeats > 100 ||
        !options.concurrency.length ||
        options.concurrency.some((n) => !Number.isInteger(n) || n < 1 || n > 32)
    )
        throw new Error('Use 1–100 repeats and 1–32 background workers');
    if (
        !options.modes.length ||
        options.modes.some((mode) => !['single', 'current', 'overlap', 'batch'].includes(mode))
    )
        throw new Error('Modes: single,current,overlap,batch');
    if (!/^[\w-]+$/.test(options.profile)) throw new Error('Invalid profile name');
    return options;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(
            'node tools/routing-benchmark.cjs [--case ID] [--repeats 3] [--concurrency 1,4,8]\n' +
                '  [--modes single,current,overlap] [--url http://127.0.0.1:17777]\n' +
                '  [--profile trekking | --profile-file FILE] [--container NAME] [--label TEXT] [--output FILE]'
        );
        return;
    }
    const suite = JSON.parse(fs.readFileSync(path.join(__dirname, 'routing-benchmark-cases.json'), 'utf8'));
    const cases = suite.cases.filter((c) => !options.cases.length || options.cases.includes(c.id));
    if (!cases.length || options.cases.some((id) => !cases.some((c) => c.id === id)))
        throw new Error('Unknown case ID');
    const source = options.profileFile
        ? fs.readFileSync(options.profileFile, 'utf8')
        : fs.readFileSync(path.resolve(root, '../backend/misc/profiles2', options.profile + '.brf'), 'utf8');
    const scenarios = buildScenarios(source, suite.settings);
    const profileId = 'custom_benchmark_' + crypto.randomUUID().replaceAll('-', '');
    const uploadStart = performance.now();
    const uploaded = await request(new URL('/brouter/profile/' + profileId, options.url), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: scenarios[0].text,
    });
    if (!/^custom_[\w-]+$/.test(uploaded.profileid || '') || uploaded.error) throw new Error('Profile upload failed');
    const report = {
        schema: 1,
        createdAt: new Date().toISOString(),
        options,
        runtime: runtimeMetadata(options.container),
        uploadMs: performance.now() - uploadStart,
        sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
        generatedProfile: scenarios[0].text,
        scenarios: scenarios.map(({ id, overrides }) => ({ id, overrides })),
        cases,
        runs: [],
        notes: [
            'HTTP timings include response transfer and JSON parsing; exclude upload, UI debounce and polling.',
            'current: displayed route -> duplicate baseline -> previews; overlap: displayed + previews.',
            'concurrency is background workers; overlap also has one foreground request.',
            'Existing browser preview-result cache is deliberately bypassed.',
            'First measured run is not guaranteed cold. JVM restart does not clear OS file cache.',
            'Memory peak is container lifetime peak, not a per-run peak; CPU is a cgroup counter delta.',
        ],
    };
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    const save = () => fs.writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n');
    save();
    const references = new Map();
    try {
        for (const testCase of cases) {
            for (const mode of options.modes) {
                for (const concurrency of mode === 'single' ? [1] : mode === 'batch' ? [null] : options.concurrency) {
                    for (let repeat = 0; repeat < options.repeats; repeat++) {
                        const before = counters(options.container);
                        const batchParams = new URLSearchParams({
                            lonlats: testCase.lonlats,
                            profile: uploaded.profileid,
                            alternativeidx: String(testCase.alternativeidx),
                        });
                        for (const scenario of scenarios)
                            batchParams.set('scenario.' + scenario.id, scenario.overrides.replace(/^&/, ''));
                        const result =
                            mode === 'batch'
                                ? await measureBatch(scenarios, async function* () {
                                      const response = await fetch(new URL('/brouter/batch', options.url), {
                                          method: 'POST',
                                          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                                          body: batchParams.toString(),
                                          redirect: 'error',
                                          signal: AbortSignal.timeout(300000),
                                      });
                                      if (!response.ok)
                                          throw new Error(
                                              'Batch HTTP ' + response.status + ': ' + (await response.text())
                                          );
                                      yield* readBatchEvents(response);
                                  })
                                : await measureSchedule(mode, scenarios, concurrency, async (scenario) => {
                                      const params = new URLSearchParams({
                                          lonlats: testCase.lonlats,
                                          profile: uploaded.profileid,
                                          alternativeidx: String(testCase.alternativeidx),
                                          format: 'geojson',
                                      });
                                      const geojson = await request(
                                          new URL('/brouter?' + params + scenario.overrides, options.url)
                                      );
                                      return routeMetrics(geojson);
                                  });
                        const after = counters(options.container);
                        for (const entry of result.requests) {
                            const key = testCase.id + '/' + entry.id;
                            const previous = references.get(key);
                            if (
                                previous &&
                                (previous.distanceM !== entry.distanceM ||
                                    previous.timeS !== entry.timeS ||
                                    (previous.geometrySha256 &&
                                        entry.geometrySha256 &&
                                        previous.geometrySha256 !== entry.geometrySha256))
                            )
                                throw new Error('Non-reproducible route: ' + key);
                            references.set(key, {
                                distanceM: entry.distanceM,
                                timeS: entry.timeS,
                                geometrySha256: entry.geometrySha256 || previous?.geometrySha256,
                            });
                        }
                        report.runs.push({
                            case: testCase.id,
                            repeat,
                            ...result,
                            resources: before && {
                                cpuMs: (after.cpuUsec - before.cpuUsec) / 1000,
                                memoryBeforeBytes: before.memoryBytes,
                                memoryAfterBytes: after.memoryBytes,
                                containerLifetimePeakBytes: after.lifetimePeakMemoryBytes,
                            },
                        });
                        save();
                        console.log(
                            testCase.id +
                                ' ' +
                                mode +
                                ' c=' +
                                concurrency +
                                ' #' +
                                (repeat + 1) +
                                ': route=' +
                                result.foregroundMs.toFixed(0) +
                                'ms all=' +
                                result.allMs.toFixed(0) +
                                'ms distance=' +
                                (result.requests.find(({ id }) => id === 'current').distanceM / 1000).toFixed(1) +
                                'km'
                        );
                    }
                }
            }
        }
    } catch (error) {
        report.error = error.message;
        save();
        throw error;
    }
    console.log('Saved ' + options.output);
}

module.exports = { buildScenarios, pool, measureSchedule, measureBatch, readBatchEvents, routeMetrics, parseArgs };
if (require.main === module)
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
