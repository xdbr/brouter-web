BR = {};
require('../../js/util/RidingPreferences.js');
const preferences = BR.RidingPreferences;
const gravel = require('./data/ridingProfile.js');
const ratings = (value) => ({ unpaved: value, forest: value, water: value, quiet: value });

// Evaluate generated arithmetic independently of the generator's string layout.
function evaluate(expression, variables) {
    const tokens = expression.replace(/[()]/g, ' ').trim().split(/\s+/);
    function next() {
        const token = tokens.shift();
        if (token === 'add') return next() + next();
        if (token === 'sub') return next() - next();
        if (token === 'multiply') return next() * next();
        if (token === 'max') return Math.max(next(), next());
        if (token === 'lesser') return next() < next();
        if (token === 'switch') {
            const condition = next(),
                yes = next(),
                no = next();
            return condition ? yes : no;
        }
        if (Object.prototype.hasOwnProperty.call(variables, token)) return variables[token];
        const value = Number(token);
        if (!Number.isFinite(value)) throw new Error('Unknown expression token: ' + token);
        return value;
    }
    const result = next();
    if (tokens.length) throw new Error('Trailing expression tokens');
    return result;
}

function forestCost(text, baseCost) {
    const assignment = text.match(/^assign noforestpenalty = (.*)$/m)[1];
    const strength = Number(text.match(/^assign rider_forest_strength = (.*)$/m)[1]);
    return evaluate(assignment, { noforestpenalty: baseCost, rider_forest_strength: strength });
}

test('detects gravel capabilities and maps existing switches to endpoint ratings', () => {
    expect(preferences.supported(gravel).map((item) => item.id)).toEqual(['unpaved', 'forest', 'water', 'quiet']);
    expect(preferences.ratings(gravel)).toEqual(ratings(1));
    expect(preferences.ratings(gravel.replace('prefer_forests = false', 'prefer_forests = true')).forest).toBe(5);
});

test.each([1, 2, 3, 4, 5])('rating %i gives the expected multiplicative forest penalty', (rating) => {
    const text = preferences.build(gravel, ratings(rating));
    expect(preferences.ratings(text)).toEqual(ratings(rating));
    expect(forestCost(text, 2.5)).toBeCloseTo(1 + ((rating - 1) / 4) * 1.5);
    expect(forestCost(text, 1)).toBe(1);
});

test('additive trekking penalties interpolate from zero rather than one', () => {
    const trekking = gravel
        .replace(/prefer_forests/g, 'consider_forest')
        .replace(/noforestpenalty/g, 'no_forest_penalty');
    const text = preferences.build(trekking, ratings(3));
    const expression = text.match(/^assign no_forest_penalty = (.*)$/m)[1];
    expect(evaluate(expression, { no_forest_penalty: 0.8, rider_forest_strength: 0.5 })).toBeCloseTo(0.4);
});

test('generation is idempotent and rating changes do not stack modifiers', () => {
    const first = preferences.build(gravel, ratings(3));
    expect(preferences.build(first, ratings(3))).toBe(first);
    const updated = preferences.build(first, ratings(5));
    expect(updated.match(/assign noforestpenalty =/g) || []).toHaveLength(1);
    expect(forestCost(updated, 2.5)).toBe(2.5);
    expect(preferences.build(updated, ratings(1))).toBe(preferences.build(gravel, ratings(1)));
});

test('unpaved strengths preserve neutral and full surface and track effects', () => {
    const expressions = preferences.unpavedRules.map((rule) => rule[1]);
    for (const isPaved of [0, 1]) {
        for (const strength of [0, 0.25, 0.5, 0.75, 1]) {
            const vars = { rider_unpaved_strength: strength, is_paved: isPaved, smoothnesspenalty: 1.2 };
            expect(evaluate(expressions[0], vars)).toBeCloseTo(1 + strength * 0.1);
            expect(evaluate(expressions[1], vars)).toBeCloseTo(1.1 - strength * 0.1);
            expect(evaluate(expressions[2], vars)).toBe(isPaved ? 1 + strength : 1);
            expect(evaluate(expressions[3], vars)).toBeCloseTo(1 - strength * 0.16);
        }
    }
});

test('unrecognized and non-bike profiles remain untouched', () => {
    const unrelated = '---context:global\nassign validForCars true\n---context:way\nassign costfactor 1\n';
    expect(preferences.build(unrelated, {})).toBe(unrelated);
    const modified = gravel.replace(
        'assign noisepenalty switch avoid_noise',
        'assign noisepenalty multiply avoid_noise'
    );
    expect(preferences.supported(modified).map((item) => item.id)).not.toContain('quiet');
    expect(preferences.ratings(undefined)).toEqual({});
});

test('invalid ratings fail rather than emitting invalid routing rules', () => {
    expect(() => preferences.build(gravel, ratings(6))).toThrow('Invalid riding preference rating');
});
