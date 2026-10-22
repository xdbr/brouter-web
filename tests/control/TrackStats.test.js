/**
 * @jest-environment jsdom
 */
BR = { Routing: { hasBeeline: () => false } };
$ = require('jquery');
require('leaflet');
require('../../js/control/TrackStats.js');
require('../../js/util/StdPath.js');

const fs = require('fs');
const page = new DOMParser().parseFromString(fs.readFileSync('index.html', 'utf8'), 'text/html');
const segment = (energy) => ({
    feature: {
        properties: {
            'track-length': '10000',
            'filtered ascend': '100',
            'plain-ascend': '90',
            'total-time': '1800',
            'total-energy': energy,
            cost: '15000',
        },
    },
});

beforeEach(() => {
    document.body = page.body.cloneNode(true);
});

test('converts mechanical joules to metabolic kcal once and sums route segments', () => {
    const stats = new BR.TrackStats();
    const segments = [segment('502080'), segment('502080')];
    stats.update(null, segments);
    expect(BR.TrackStats.estimateCalories(1004160)).toBeCloseTo(1000);
    expect(document.getElementById('calories').textContent).toBe('≈' + (1000).toLocaleString());
    expect(stats.calcStats(null, segments).totalEnergy).toBe(1004160);
    expect(segments[0].feature.properties['total-energy']).toBe('502080');
    expect(document.getElementById('totalenergy')).toBeNull();
});

test.each([undefined, null, '', 'broken', '-1', Infinity])(
    'missing or invalid energy %s does not show a misleading calorie estimate',
    (energy) => {
        new BR.TrackStats().update(null, [segment('1000'), segment(energy)]);
        expect(document.getElementById('calories').textContent).toBe('–');
    }
);

test('zero energy stays zero and clearing the route hides statistics', () => {
    const stats = new BR.TrackStats();
    stats.update(null, [segment('0')]);
    expect(document.getElementById('calories').textContent).toBe('≈0');
    stats.update(null, []);
    expect(document.getElementById('stats-container').style.display).toBe('none');
});

test('a heavier rider increases calories through the existing route energy model', () => {
    const calories = (totalMass) => {
        const rc = new BR.RoutingContext({ getProfileVar: (name) => ({ validForBikes: 1, totalMass }[name]) });
        const path = new BR.StdPath();
        path.computeKinematic(rc, 1000, 50, true);
        return BR.TrackStats.estimateCalories(path.getTotalEnergy());
    };
    expect(calories(110)).toBeGreaterThan(calories(80));
});
