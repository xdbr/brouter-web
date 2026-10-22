// Adapt known bicycle-profile preferences without replacing their routing rules.
BR.RidingPreferences = {
    definitions: [
        { id: 'unpaved', variants: [['prefer_unpaved_paths', null, 1]] },
        {
            id: 'forest',
            variants: [
                ['prefer_forests', 'noforestpenalty', 1],
                ['consider_forest', 'no_forest_penalty', 0],
            ],
        },
        {
            id: 'water',
            variants: [
                ['prefer_rivers', 'noriverpenalty', 1],
                ['consider_river', 'no_river_penalty', 0],
            ],
        },
        {
            id: 'quiet',
            variants: [
                ['avoid_noise', 'noisepenalty', 1],
                ['consider_noise', 'noise_penalty', 0],
            ],
        },
    ],

    // These four expressions are the unpaved switch's effects in gravel.brf.
    // Interpolate each effect so neutral really reproduces the disabled switch.
    unpavedRules: [
        [/switch\s+not\s+prefer_unpaved_paths\s+1\.0\s+1\.1/g, 'add 1.0 multiply rider_unpaved_strength 0.1'],
        [/switch\s+not\s+prefer_unpaved_paths\s+1\.1\s+1\.0/g, 'sub 1.1 multiply rider_unpaved_strength 0.1'],
        [
            /switch\s+and\s+prefer_unpaved_paths\s+is_paved\s+2\s+1/g,
            'switch is_paved ( add 1 rider_unpaved_strength ) 1',
        ],
        [
            /switch\s+and\s+prefer_unpaved_paths\s+\(\s*lesser\s+smoothnesspenalty\s+1\.6\s*\)\s+0\.84\s+1/g,
            'switch ( lesser smoothnesspenalty 1.6 ) ( sub 1 multiply 0.16 rider_unpaved_strength ) 1',
        ],
    ],

    strip(text) {
        return (text || '').replace(
            /^# brouter-web riding preferences:(global|way) begin\r?\n[\s\S]*?^# brouter-web riding preferences:\1 end\r?\n?/gm,
            ''
        );
    },

    supported(text) {
        const source = this.strip(text);
        const global = source.match(/---context:global[^\n]*\n([\s\S]*?)(?=---context:|$)/);
        const way = source.match(/---context:way[^\n]*\n([\s\S]*?)(?=---context:|$)/);
        if (!global || !way || !/^\s*assign\s+validForBikes\s*=?\s*(?:true|1)\b/m.test(global[1])) return [];
        const cost = way[1].match(/^\s*assign\s+costfactor\b/m);
        if (!cost) return [];
        return this.definitions.reduce((result, definition) => {
            const variant = definition.variants.find(([toggle, penalty]) => {
                if (!new RegExp('^\\s*assign\\s+' + toggle + '\\s*=?\\s*(true|false|0|1)\\b', 'm').test(global[1]))
                    return false;
                if (penalty) {
                    const beforeCost = way[1].slice(0, cost.index);
                    return (
                        new RegExp('^\\s*assign\\s+' + penalty + '\\s*=?\\s*switch\\s+' + toggle + '\\b', 'm').test(
                            beforeCost
                        ) && new RegExp('\\b' + penalty + '\\b').test(way[1].slice(cost.index))
                    );
                }
                return this.unpavedRules.every(
                    ([pattern, replacement]) => new RegExp(pattern.source).test(way[1]) || way[1].includes(replacement)
                );
            });
            if (variant)
                result.push({ id: definition.id, toggle: variant[0], penalty: variant[1], neutral: variant[2] });
            return result;
        }, []);
    },

    ratings(text) {
        const result = {};
        this.supported(text).forEach(({ id, toggle }) => {
            const stored = text.match(new RegExp('^assign rider_pref_' + id + ' = ([1-5])\\s*$', 'm'));
            const enabled = this.strip(text).match(
                new RegExp('^\\s*assign\\s+' + toggle + '\\s*=?\\s*(true|false|0|1)\\b', 'm')
            );
            result[id] = stored ? Number(stored[1]) : enabled && /^(true|1)$/.test(enabled[1]) ? 5 : 1;
        });
        return result;
    },

    build(text, ratings) {
        const supported = this.supported(text);
        if (!supported.length) return text;
        let source = this.strip(text);
        const globals = [];
        const modifiers = [];
        supported.forEach(({ id, toggle, penalty, neutral }) => {
            const rating = Number(ratings[id]);
            if (!Number.isInteger(rating) || rating < 1 || rating > 5)
                throw new Error('Invalid riding preference rating');
            const strength = (rating - 1) / 4;
            globals.push('assign rider_pref_' + id + ' = ' + rating);
            globals.push('assign rider_' + id + '_strength = ' + strength);
            source = source.replace(
                new RegExp('(^\\s*assign\\s+' + toggle + '\\s*=?\\s*)(true|false|0|1)\\b', 'm'),
                (match, prefix) => prefix + (rating > 1 ? 'true' : 'false')
            );
            if (penalty) {
                modifiers.push(
                    'assign ' +
                        penalty +
                        ' = add ' +
                        neutral +
                        ' multiply rider_' +
                        id +
                        '_strength sub ' +
                        penalty +
                        ' ' +
                        neutral
                );
            } else {
                this.unpavedRules.forEach(([pattern, replacement]) => {
                    source = source.replace(pattern, replacement);
                });
            }
        });
        const block = (context, lines) =>
            '# brouter-web riding preferences:' +
            context +
            ' begin\n' +
            lines.join('\n') +
            '\n# brouter-web riding preferences:' +
            context +
            ' end\n';
        source = source.replace(/(?=---context:way)/, block('global', globals));
        if (modifiers.length) {
            source = source.replace(
                /(---context:way[^\n]*\n)([\s\S]*?)(?=---context:|$)/,
                (match, context, body) =>
                    context + body.replace(/(?=^\s*assign\s+costfactor\b)/m, block('way', modifiers))
            );
        }
        return source;
    },
};
