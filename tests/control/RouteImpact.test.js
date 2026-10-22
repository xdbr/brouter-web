/**
 * @jest-environment jsdom
 */
BR = { conf: { host: 'http://localhost', profiles: ['trekking'] } };
$ = require('jquery');
async = require('async');
i18next = require('i18next');
require('leaflet');
require('../../js/router/BRouter.js');
require('../../js/util/RidingPreferences.js');
require('../../js/control/Profile.js');
require('../../js/control/RouteImpact.js');

const fs = require('fs');
const page = new DOMParser().parseFromString(fs.readFileSync('index.html', 'utf8'), 'text/html');
const gravel = require('../util/data/ridingProfile.js').replace(
    '---context:way',
    `
assign prefer_cycle_routes = false # %prefer_cycle_routes% | Cycle routes | boolean
assign use_proposed_cycleroutes = false # %use_proposed_cycleroutes% | Proposed | boolean
---context:way`
);
CodeMirror = {
    fromTextArea() {
        const listeners = [];
        return {
            value: '',
            on(event, fn) {
                if (event === 'change') listeners.push(fn);
            },
            setValue(value) {
                this.value = value;
                listeners.forEach((fn) => fn(this, { origin: 'setValue' }));
            },
            getValue() {
                return this.value;
            },
            isClean() {
                return true;
            },
            markClean() {},
        };
    },
};
BR.Message = jest.fn();
let profile, routing, router, impact;

beforeEach(() => {
    jest.useFakeTimers();
    document.body = page.body.cloneNode(true);
    localStorage.clear();
    BR.conf = { host: 'http://localhost', profiles: ['trekking'], allowRouteEstimates: true };
    i18next.init({
        lng: 'en',
        initImmediate: false,
        resources: { en: { translation: require('../../locales/en.json') } },
    });
    profile = new BR.Profile();
    profile._setValue(gravel);
    routing = new L.Evented();
    routing.getWaypoints = jest.fn(() => [L.latLng(48.12, 11.57), L.latLng(48.04, 11.56)]);
    routing.getBeelineFlags = jest.fn(() => []);
    router = L.bRouter({ profile: 'trekking', alternative: 0 });
    impact = new BR.RouteImpact(profile, routing, router);
    let text;
    impact._request = jest.fn(async (method, url, body) => {
        if (method === 'POST') {
            text = body;
            return { profileid: 'custom_preview' };
        }
        let effective = text;
        new URL(url, 'http://localhost').searchParams.forEach((value, key) => {
            if (key.startsWith('profile:')) {
                const name = key.slice(8);
                effective = effective.replace(new RegExp('(assign ' + name + ' = )[^\\s]+'), '$1' + value);
            }
        });
        const ratings = BR.RidingPreferences.ratings(effective);
        const cycle = /assign prefer_cycle_routes = (true|1)\b/.test(effective) ? 1 : 0;
        return {
            features: [
                {
                    properties: {
                        'track-length': String(
                            10000 + (ratings.forest - 1) * 1000 + (ratings.water - 1) * 100 + cycle * 2000
                        ),
                        'total-time': String(
                            1800 + (ratings.forest - 1) * 300 + (ratings.water - 1) * 60 - cycle * 120
                        ),
                    },
                },
            ],
        };
    });
});

afterEach(() => {
    clearTimeout(impact.timer);
    jest.restoreAllMocks();
    jest.useRealTimers();
});

async function run() {
    clearTimeout(impact.timer);
    await impact._run(impact.version);
}

test('shows one-option differences for all riding preferences and signed cycle routes', async () => {
    const initial = profile._getFormValues();
    const storage = localStorage.getItem(profile.libraryKey);
    const update = jest.fn();
    profile.on('update', update);
    await run();
    expect(document.getElementById('route-impact-rider_pref_forest-1').textContent).toBe('Current');
    expect(document.getElementById('route-impact-rider_pref_forest-2').textContent).toBe('+5 min, +1 km');
    expect(document.getElementById('route-impact-rider_pref_water-5').textContent).toBe('+4 min, +0.4 km');
    expect(document.getElementById('route-impact-prefer_cycle_routes').textContent).toBe(
        'If switched on: −2 min, +2 km'
    );
    expect(document.querySelectorAll('[id^="route-impact-rider_pref_quiet"]')).toHaveLength(5);
    expect(document.querySelectorAll('[id^="route-impact-rider_pref_unpaved"]')).toHaveLength(5);
    expect(profile._getFormValues()).toEqual(initial);
    expect(profile.editor.getValue()).toBe(gravel);
    expect(router.options.profile).toBe('trekking');
    expect(impact._request.mock.calls[0][1]).toContain('/profile/custom_preview_');
    expect(localStorage.getItem(profile.libraryKey)).toBe(storage);
    expect(update).not.toHaveBeenCalled();
    expect(impact._request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
    expect(impact._request.mock.calls.filter(([method]) => method === 'GET')).toHaveLength(19);
});

test('previews change one option while retaining all other draft values', async () => {
    document.querySelector('[name="bikerPower"]').value = '175';
    document.querySelector('[name="rider_pref_forest"][value="3"]').checked = true;
    await run();
    const sources = impact._request.mock.calls.filter(([method]) => method === 'POST').map(([, , text]) => text);
    expect(sources.every((text) => text.includes('assign bikerPower = 175'))).toBe(true);
    expect(document.getElementById('route-impact-rider_pref_forest-1').textContent).toBe('−10 min, −2 km');
    expect(document.getElementById('route-impact-rider_pref_water-5').textContent).toBe('+4 min, +0.4 km');
    expect(document.querySelector('[name="rider_pref_forest"]:checked').value).toBe('3');
});

test('routing switches get on/off estimates while export-only switches are excluded', async () => {
    const names = [
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
    const excluded = ['turnInstructionRoundabouts', 'processUnusedTags'];
    const controls = [...names, ...excluded]
        .map((name) => `assign ${name} = true # %${name}% | ${name} | boolean`)
        .join('\n');
    profile._setValue(gravel.replace('---context:way', controls + '\n---context:way'));
    await run();
    for (const name of names) {
        expect(document.getElementById('route-impact-' + name).textContent).toBe('If switched off: 0 min, 0 km');
        expect(
            impact._request.mock.calls.some(
                ([method, url]) => method === 'GET' && url.includes('&profile:' + name + '=0')
            )
        ).toBe(true);
    }
    for (const name of excluded) expect(document.getElementById('route-impact-' + name)).toBeNull();
    expect(impact._request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
    expect(names.every((name) => document.querySelector('[name="' + name + '"]').checked)).toBe(true);
});

test('identical contexts use cached results; alternatives and avoidance areas invalidate them', async () => {
    await run();
    impact._request.mockClear();
    impact.schedule();
    await run();
    expect(impact._request).not.toHaveBeenCalled();
    router.options.alternative = 1;
    impact.schedule();
    await run();
    expect(impact._request).toHaveBeenCalled();
    expect(impact._request.mock.calls.some(([, url]) => url.includes('alternativeidx=1'))).toBe(true);
    impact._request.mockClear();
    router.options.nogos = [L.circle([48.1, 11.6], { radius: 50 })];
    impact.schedule();
    await run();
    expect(impact._request.mock.calls.some(([, url]) => url.includes('nogos=11.6,48.1,50'))).toBe(true);
});

test('sums all routed segments and excludes fixed straight-line sections', async () => {
    routing.getWaypoints.mockReturnValue([L.latLng(48.12, 11.57), L.latLng(48.08, 11.6), L.latLng(48.04, 11.56)]);
    await run();
    expect(document.getElementById('route-impact-rider_pref_forest-2').textContent).toBe('+10 min, +2 km');
    impact.schedule();
    routing.getBeelineFlags.mockReturnValue([false, true]);
    await run();
    expect(document.getElementById('route-impact-rider_pref_forest-2').textContent).toBe('+5 min, +1 km');
});

test('waits for real routing and profile uploads before starting previews', async () => {
    profile._applyInFlight = true;
    await run();
    expect(impact._request).not.toHaveBeenCalled();
    profile._applyInFlight = false;
    router.queue.idle = () => false;
    await run();
    expect(impact._request).not.toHaveBeenCalled();
});

test('rapid form edits debounce previews and route clearing removes stale indicators', async () => {
    document.querySelector('[name="bikerPower"]').dispatchEvent(new Event('input', { bubbles: true }));
    jest.advanceTimersByTime(500);
    document.querySelector('[name="bikerPower"]').dispatchEvent(new Event('input', { bubbles: true }));
    jest.advanceTimersByTime(799);
    expect(impact._request).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(impact._request).toHaveBeenCalled();
    routing.getWaypoints.mockReturnValue([]);
    routing.fire('routing:cleared');
    expect(document.querySelectorAll('[data-route-impact]')).toHaveLength(0);
    impact._request.mockClear();
    await run();
    expect(impact._request).not.toHaveBeenCalled();
    expect(impact.status.textContent).toContain('at least two');
});

test('off invalidates an in-flight response, clears indicators, and persists the choice', async () => {
    let resolveUpload;
    impact._request.mockImplementation(() => new Promise((resolve) => (resolveUpload = resolve)));
    const pending = impact._run(impact.version);
    clearTimeout(impact.timer);
    impact.toggle.click();
    resolveUpload({ profileid: 'custom_obsolete' });
    await pending;
    expect(impact._request).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('[data-route-impact]')).toHaveLength(0);
    expect(impact.status.textContent).toBe('');
    expect(localStorage.getItem('routingprofile.routeEstimates')).toBe('false');
});

test('a changed route cannot receive results from an earlier preview', async () => {
    let resolveUpload;
    impact._request.mockImplementation(() => new Promise((resolve) => (resolveUpload = resolve)));
    const pending = impact._run(impact.version);
    routing.fire('routing:rerouteSegmentStart');
    resolveUpload({ profileid: 'custom_old_route' });
    await pending;
    expect(impact._request).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('[data-route-impact]')).toHaveLength(0);
    expect(impact.status.textContent).toContain('Waiting');
});

test('missing time data are unavailable rather than a misleading zero-minute difference', async () => {
    impact._request.mockImplementation(async (method) =>
        method === 'POST' ? { profileid: 'custom_preview' } : { features: [{ properties: { 'track-length': '1000' } }] }
    );
    await run();
    expect(document.getElementById('route-impact-rider_pref_forest-2').textContent).toBe('Unavailable');
    expect(impact.status.textContent).toContain('Could not calculate');
    expect(impact.cache.size).toBe(0);
});

test('one failed candidate does not hide the other successful comparisons', async () => {
    const backend = impact._request.getMockImplementation();
    impact._request.mockImplementation(async (method, url, text) => {
        if (method === 'GET' && url.includes('profile:rider_pref_forest=3')) throw new Error('No route');
        return backend(method, url, text);
    });
    await run();
    expect(document.getElementById('route-impact-rider_pref_forest-3').textContent).toBe('Unavailable');
    expect(document.getElementById('route-impact-rider_pref_water-5').textContent).toBe('+4 min, +0.4 km');
    expect(impact.status.textContent).toContain('Some options');
});

test('shared backends and invalid forms do not send speculative requests', async () => {
    document.querySelector('[name="bikerPower"]').value = '';
    await run();
    expect(impact._request).not.toHaveBeenCalled();
    BR.conf.allowRouteEstimates = false;
    impact.schedule();
    jest.advanceTimersByTime(2000);
    expect(impact._request).not.toHaveBeenCalled();
    expect(impact.status.textContent).toContain('not enabled');
});

test('transport aborts in-flight requests and uses a timeout', async () => {
    const xhr = {
        open: jest.fn(),
        send: jest.fn(),
        abort() {
            this.onabort();
        },
    };
    jest.spyOn(global, 'XMLHttpRequest').mockImplementation(() => xhr);
    const pending = BR.RouteImpact.prototype._request.call(impact, 'GET', '/preview');
    expect(xhr.timeout).toBe(30000);
    impact.toggle.checked = false;
    impact.schedule();
    await expect(pending).rejects.toThrow('interrupted');
    expect(impact.requests.size).toBe(0);
});

test('signed formatting rounds without showing negative zero', () => {
    expect(impact._formatDelta(-120, 1000)).toBe('−2 min, +1 km');
    expect(impact._formatDelta(-1, -1)).toBe('0 min, 0 km');
});

test.each([2, 32, 100])('private previews bound %i workers and share one immutable upload', async (concurrency) => {
    BR.conf.routeEstimateConcurrency = concurrency;
    const targets = impact._targets.bind(impact);
    // Supply enough comparisons to exercise the full thirty-two-request budget.
    impact._targets = () => [...targets(), ...targets(), ...targets(), ...targets()];
    const backend = impact._request.getMockImplementation();
    let active = 0;
    let peak = 0;
    impact._request.mockImplementation(async (...args) => {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        const result = await backend(...args);
        active--;
        return result;
    });
    await run();
    expect(peak).toBe(Math.min(concurrency, 32));
    expect(impact._request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
    expect(document.getElementById('route-impact-rider_pref_water-5').textContent).toBe('+4 min, +0.4 km');
    // A cached baseline must not let both workers upload a new base independently.
    const baseline = impact.cache.entries().next().value;
    impact.cache.clear();
    impact.cache.set(...baseline);
    impact._request.mockClear();
    impact.schedule();
    await run();
    expect(impact._request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
});

test('turning estimates off aborts every parallel request', async () => {
    const requests = [];
    jest.spyOn(global, 'XMLHttpRequest').mockImplementation(() => {
        const xhr = { open() {}, send() {}, abort: jest.fn(() => xhr.onabort()) };
        requests.push(xhr);
        return xhr;
    });
    const pending = [1, 2].map(() => BR.RouteImpact.prototype._request.call(impact, 'GET', '/preview'));
    const settled = Promise.allSettled(pending);
    impact.toggle.checked = false;
    impact.schedule();
    expect((await settled).every((result) => result.status === 'rejected')).toBe(true);
    expect(requests.every((xhr) => xhr.abort.mock.calls.length === 1)).toBe(true);
    expect(impact.requests.size).toBe(0);
});

test('parameter optimization rejects changes to routing expressions or duplicate assignments', () => {
    const base =
        '---context:global\nassign flag = false # flag\nassign strength = 0\n---context:way\nassign costfactor = 1\n';
    expect(
        impact._profileOverrides(base, base.replace('false', 'true').replace('strength = 0', 'strength = 0.75'))
    ).toBe('&profile:flag=1&profile:strength=0.75');
    expect(impact._profileOverrides(base, base.replace('costfactor = 1', 'costfactor = 2'))).toBeNull();
    expect(impact._profileOverrides(base, base.replace('strength = 0', 'strength = add 1 2'))).toBeNull();
    const duplicate = base.replace('assign strength', 'assign flag = true\nassign strength');
    expect(impact._profileOverrides(duplicate, duplicate)).toBeNull();
});

test('structural profile changes fall back to a separate upload without overwriting the batch base', async () => {
    const baseline = BR.RidingPreferences.build(gravel, BR.RidingPreferences.ratings(gravel));
    const run = { version: impact.version, text: baseline, profileId: 'custom_base' };
    const urls = impact._routeUrls();
    await impact._measure(baseline, urls, run);
    await impact._measure(baseline + '\n# structural change\n', urls, run);
    const posts = impact._request.mock.calls.filter(([method]) => method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[1][1]).toBe(L.BRouter.URL_PROFILE_UPLOAD + '/custom_preview_variant_1');
    expect(run.profileId).toBe('custom_preview');
});
