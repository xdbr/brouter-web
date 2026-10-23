const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    buildScenarios,
    pool,
    measureSchedule,
    measureBatch,
    readBatchEvents,
    routeMetrics,
    parseArgs,
} = require('./routing-benchmark.cjs');

test('eleven scenarios use the production profile generator and change one control each', () => {
    const source = require('../tests/util/data/ridingProfile.js').replace(
        '---context:way',
        'assign stick_to_cycleroutes = false\nassign consider_town = false\n---context:way'
    );
    const settings = {
        ratings: { forest: 3, water: 3 },
        booleans: { stick_to_cycleroutes: false, consider_town: false },
    };
    const scenarios = buildScenarios(source, settings);
    assert.equal(scenarios.length, 11);
    assert.equal(new Set(scenarios.map(({ text }) => text)).size, 11);
    assert.equal(scenarios[0].overrides, '');
    for (const scenario of scenarios.slice(1)) {
        const params = new URLSearchParams(scenario.overrides.slice(1));
        const names = [...params.keys()];
        const expected = scenario.id.startsWith('forest-')
            ? ['profile:rider_pref_forest', 'profile:rider_forest_strength']
            : scenario.id.startsWith('water-')
            ? ['profile:rider_pref_water', 'profile:rider_water_strength']
            : ['profile:' + scenario.id.replace(/-true$/, '')];
        // Rating 1 also disables the corresponding legacy switch.
        if (scenario.id === 'forest-1') expected.push('profile:prefer_forests');
        if (scenario.id === 'water-1') expected.push('profile:prefer_rivers');
        assert.deepEqual(names.sort(), expected.sort());
    }
    assert.throws(() => buildScenarios(source, { ratings: { unknown: 3 }, booleans: {} }), /Unsupported/);
});

test('worker pool bounds active work and preserves input ordering', async () => {
    let active = 0;
    let peak = 0;
    const result = await pool([1, 2, 3, 4, 5], 2, async (value) => {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        return value * 2;
    });
    assert.equal(peak, 2);
    assert.deepEqual(result, [2, 4, 6, 8, 10]);
});

test('a failed worker stops new work and waits for already active work', async () => {
    const started = [];
    let finished = false;
    await assert.rejects(
        pool([1, 2, 3, 4], 2, async (value) => {
            started.push(value);
            if (value === 1) throw new Error('backend failed');
            await new Promise((resolve) => setImmediate(resolve));
            finished = true;
        }),
        /backend failed/
    );
    assert.deepEqual(started, [1, 2]);
    assert.equal(finished, true);
});

test('overlap starts previews before foreground completion and uses its baseline', async () => {
    const starts = [];
    let release;
    const foreground = new Promise((resolve) => {
        release = resolve;
    });
    const done = measureSchedule('overlap', [{ id: 'current' }, { id: 'forest-5' }], 1, async ({ id }) => {
        starts.push(id);
        if (id === 'current') await foreground;
        return { distanceM: id === 'current' ? 1000 : 1200, timeS: id === 'current' ? 100 : 150 };
    });
    assert.deepEqual(starts, ['current', 'forest-5']);
    release();
    const result = await done;
    assert.equal(result.requests.length, 2);
    assert.equal(result.estimates[0].distanceDeltaM, 200);
    assert.equal(result.estimates[0].timeDeltaS, 50);
    assert.ok(result.estimates[0].availableMs >= result.foregroundMs);
});

test('current schedule retains the duplicate baseline and sequential dependencies', async () => {
    const starts = [];
    let release;
    const foreground = new Promise((resolve) => {
        release = resolve;
    });
    const done = measureSchedule('current', [{ id: 'current' }, { id: 'forest-5' }], 2, async ({ id }) => {
        starts.push(id);
        if (starts.length === 1) await foreground;
        return { distanceM: 1000, timeS: 100 };
    });
    assert.deepEqual(starts, ['current']);
    release();
    const result = await done;
    assert.deepEqual(starts, ['current', 'current', 'forest-5']);
    assert.equal(result.requests.length, 3);
    assert.equal(result.requests[1].role, 'preview-baseline');
});

test('missing route totals and unsafe benchmark targets are rejected', () => {
    assert.throws(() => routeMetrics({ features: [{ properties: { 'track-length': '1' } }] }), /Missing/);
    assert.throws(() => parseArgs(['--url', 'https://brouter.de']), /local/);
    assert.throws(() => parseArgs(['--concurrency', '0,40']), /workers/);
    assert.throws(() => parseArgs(['--repeats', '0']), /repeats/);
    assert.throws(() => parseArgs(['--case']), /Missing value/);
});

test('batch reader handles split UTF-8 and split events, and rejects truncated streams', async () => {
    const payload = Buffer.from('{"type":"start","message":"München"}\n{"type":"heartbeat"}\n');
    const split = payload.indexOf(Buffer.from('ü')) + 1;
    const response = {
        body: (async function* () {
            yield payload.subarray(0, split);
            yield payload.subarray(split, split + 3);
            yield payload.subarray(split + 3);
        })(),
    };
    const events = [];
    for await (const event of readBatchEvents(response)) events.push(event);
    assert.equal(events[0].message, 'München');
    assert.equal(events[1].type, 'heartbeat');
    await assert.rejects(async () => {
        for await (const event of readBatchEvents({
            body: (async function* () {
                yield Buffer.from('{"type":');
            })(),
        }))
            void event;
    }, /Truncated/);
});

test('batch accounting permits previews before the current route and rejects incomplete batches', async () => {
    const current = {
        type: 'result',
        id: 'current',
        distance: 1000,
        time: 100,
        route: {
            features: [
                {
                    properties: { 'track-length': '1000', 'total-time': '100' },
                    geometry: {
                        type: 'LineString',
                        coordinates: [
                            [11, 48],
                            [11.1, 48.1],
                        ],
                    },
                },
            ],
        },
    };
    const scenarios = [{ id: 'current' }, { id: 'forest5' }];
    const events = [
        { type: 'start', scenarios: 2 },
        { type: 'result', id: 'forest5', distance: 1200, time: 150 },
        current,
        { type: 'complete', completed: 2, cancelled: false, graphCache: { hits: 12, retainedBytes: 1024 } },
    ];
    const result = await measureBatch(scenarios, async function* () {
        yield* events;
    });
    assert.deepEqual(result.graphCache, { hits: 12, retainedBytes: 1024 });
    assert.equal(result.requests[0].id, 'forest5');
    assert.equal(result.estimates[0].distanceDeltaM, 200);
    assert.ok(result.estimates[0].availableMs >= result.foregroundMs);
    await assert.rejects(
        measureBatch(scenarios, async function* () {
            yield current;
        }),
        /ended early/
    );
    await assert.rejects(
        measureBatch(scenarios, async function* () {
            yield current;
            yield current;
        }),
        /duplicate/
    );
    await assert.rejects(
        measureBatch(scenarios, async function* () {
            yield { type: 'complete', completed: 0, cancelled: true };
        }),
        /Incomplete/
    );
});
