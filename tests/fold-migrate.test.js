import { describe, expect, test } from '@jest/globals';

import { migrate } from '../public/scripts/extensions/fold/migrate.js';
import { DOOM, threads } from '../public/scripts/extensions/fold/thread-table.js';

const NUL = '\u0000';

/**
 * A v1 blob shaped like the live Solo Leveling header, small enough to read.
 * @returns {object} The blob.
 */
function v1() {
    return {
        v: 1,
        state: {
            entities: {
                [`person${NUL}kang min-seo`]: {
                    kind: 'person', name: 'Kang Min-seo', aka: 'Kang, team leader',
                    detail: 'texted Solomon after the raid', place: 'elsewhere in Seoul',
                    status: 'remote', turn: 14, first: 1,
                },
                [`person${NUL}sung jin-woo`]: {
                    kind: 'person', name: 'Sung Jin-Woo', aka: 'Jin-Woo',
                    detail: 'reachable by email, sparring', place: 'hospital', status: 'remote', turn: 14, first: 1,
                },
                [`lead${NUL}hunter residency`]: {
                    kind: 'lead', name: 'Hunter residency: twenty D-rank raids',
                    detail: 'A D-10 visa needs twenty active D-rank raids inside twelve months.',
                    open: '1 of 20 logged. Nineteen to go.',
                    status: 'open', source: 'Association pamphlet', turn: 9, first: 1,
                },
                [`lead${NUL}kangs standing offer`]: {
                    kind: 'lead', name: 'Kang’s standing offer', detail: 'she would call when a slot opened',
                    open: '', status: 'closed', source: 'outside the Nowon gate', turn: 14, first: 7,
                },
            },
            clocks: {
                'the residency window closes': {
                    name: 'The residency window closes', filled: 1, size: 8,
                    about: 'twelve months pass with fewer than twenty raids logged and the sponsorship lapses',
                    seen: 'open', where: '', turn: 9,
                },
            },
            context: {
                location: { v: 'goshiwon room', t: 40, src: 'narrative' },
                rank: { v: 'E-Rank Hunter', t: 38, src: 'block' },
            },
            locks: { time: true },
        },
        chronicle: {
            events: {
                'a:0': {
                    s: 'Solomon obtains the numbers.', t: 1,
                    d: { inv: [
                        { item: 'kang\'s phone number', dq: 1, at: 'contacts' },
                        { item: 'jin-woo\'s phone number', dq: 1, at: 'contacts' },
                        { item: 'goblin knife', dq: 1, at: 'carried' },
                    ] },
                },
            },
        },
    };
}

/*
 * Non-negotiable: the live campaign, mid-flight, with hand repairs and a lock in it, must load
 * unchanged in MEANING. FOLD-REDESIGN.md §9.
 */
describe('v1 → v2, field-preserving', () => {
    test('person rows become cast rows under the same key, byte for byte', () => {
        const fold = v1();
        migrate(fold);
        expect(Object.keys(fold.state.cast).sort())
            .toEqual([`person${NUL}kang min-seo`, `person${NUL}sung jin-woo`]);
        expect(fold.state.cast[`person${NUL}kang min-seo`].aka).toBe('Kang, team leader');
    });

    test('lead rows and clocks become threads, and the count is leads + clocks', () => {
        const fold = v1();
        const report = migrate(fold);
        expect(Object.keys(fold.state.threads)).toHaveLength(3);
        expect(report.counts.threadsFromLeads).toBe(2);
        expect(report.counts.threadsFromClocks).toBe(1);
    });

    test('a clock keeps its fill, size, consequence and visibility, and defaults to doom', () => {
        const fold = v1();
        migrate(fold);
        const [dial] = threads(new Map(Object.entries(fold.state.threads)), 9).filter(t => t.dial);
        expect(dial.dial).toEqual({ filled: 1, size: 8, kind: DOOM });
        expect(dial.about).toContain('the sponsorship lapses');
        expect(dial.seen).toBe('open');
    });

    test('a full clock closes; a half-full one stays open', () => {
        const fold = v1();
        fold.state.clocks['the residency window closes'].filled = 8;
        migrate(fold);
        expect(fold.state.threads['the residency window closes'].status).toBe('closed');
    });

    test('a closed lead stays closed', () => {
        const fold = v1();
        migrate(fold);
        expect(fold.state.threads['kang’s standing offer'].status).toBe('closed');
    });

    test('locks survive verbatim, and so does the chronicle', () => {
        const fold = v1();
        const events = JSON.stringify(fold.chronicle.events);
        migrate(fold);
        expect(fold.state.locks).toEqual({ time: true });
        expect(JSON.stringify(fold.chronicle.events)).toBe(events);
    });

    test('the version is stamped only after the conversion ran', () => {
        const fold = v1();
        expect(migrate(fold).to).toBe(2);
        expect(fold.v).toBe(2);
    });
});

describe('contact details leave inventory and become reach', () => {
    test('a possessive names its owner and the row lands on that person', () => {
        const fold = v1();
        migrate(fold);
        expect(fold.state.cast[`person${NUL}kang min-seo`].reach).toBe('phone number');
        expect(fold.state.cast[`person${NUL}sung jin-woo`].reach).toContain('phone number');
    });

    test('an ordinary carried item is not touched', () => {
        const fold = v1();
        migrate(fold);
        expect(fold.chronicle.events['a:0'].d.inv.some(c => c.item === 'goblin knife')).toBe(true);
    });

    test('a contact row nobody owns is counted, never assigned by inference', () => {
        const fold = v1();
        fold.chronicle.events['a:0'].d.inv.push({ item: 'a scrap of paper', dq: 1, at: 'contacts' });
        const report = migrate(fold);
        expect(report.counts.unowned).toBe(1);
    });

    test('contact prose already in `detail` splits out of it', () => {
        const fold = v1();
        migrate(fold);
        const jinwoo = fold.state.cast[`person${NUL}sung jin-woo`];
        expect(jinwoo.detail).toBe('sparring');
        expect(jinwoo.reach).toContain('by email');
    });
});

/*
 * §9 forbids the auto-merge: "auto-merging on token overlap is exactly the guess this design
 * forbids". So the residency lead and the residency clock migrate to TWO threads and one question.
 */
describe('the residency pair is asked about, never merged', () => {
    test('two threads, not one', () => {
        const fold = v1();
        migrate(fold);
        expect(Object.keys(fold.state.threads)).toContain('hunter residency: twenty d-rank raids');
        expect(Object.keys(fold.state.threads)).toContain('the residency window closes');
    });

    test('and they are flagged as an identity question', () => {
        const { flags } = migrate(v1());
        const pair = flags.identity.find(q =>
            q.a === 'hunter residency: twenty d-rank raids' && q.b === 'the residency window closes');
        expect(pair).toBeDefined();
        expect(pair.why).toContain('residency');
    });

    test('every migrated dial is flagged for polarity rather than guessed at', () => {
        // §9 says a v1 clock whose `about` reads as the player WINNING is exactly what migration
        // must not guess. The alternative to guessing is not a cleverer word list; it is a
        // question, and the measured population is one clock across four live campaigns.
        const { flags } = migrate(v1());
        expect(flags.polarity).toHaveLength(1);
        expect(flags.polarity[0].why).toBe('predates-polarity');
    });
});

describe('block-shadow context routes into threads', () => {
    test('a card\'s prose leads field becomes threads, and the gate refuses the lore', () => {
        const fold = v1();
        fold.state.context.leads = {
            v: 'Nobody has searched the cellar; the northern road is paved in flagstones',
            t: 12, src: 'block',
        };
        const report = migrate(fold);
        expect(report.counts.threadsFromContext).toBe(1);
        expect(report.counts.blockShadow).toBe(1);
        expect(fold.state.context.leads).toBeUndefined();
    });

    test('what the gate refused is kept verbatim, not destroyed', () => {
        const fold = v1();
        fold.state.context.leads = {
            v: 'Nobody has searched the cellar; the northern road is paved in flagstones',
            t: 12, src: 'block',
        };
        migrate(fold);
        expect(fold.state.migrated.dropped[0].text).toBe('the northern road is paved in flagstones');
    });

    test('a field that produced nothing keeps its prose — it is the only record left', () => {
        // Raccoon City: extraction never ran, so the card's `leads` field is not a duplicate of a
        // structured row. It is the row.
        const fold = v1();
        fold.state.context.leads = { v: 'the northern road is paved in flagstones', t: 12, src: 'block' };
        migrate(fold);
        expect(fold.state.context.leads).toBeDefined();
    });

    test('Phase B staged marks and facts; Phase D executes them', () => {
        // The staging is on the record in `migrate.js`'s header: `conditions` → pov marks and
        // `rank` → pov facts waited for the phase that built marks and facts (FOLD-REDESIGN.md §9).
        const fold = v1();
        fold.state.context.pov = { v: 'Sung Jin-Woo', t: 40, src: 'narrative' };
        fold.state.context.conditions = { v: 'bandaged calf', t: 40, src: 'narrative' };
        migrate(fold);

        expect(fold.state.context.conditions).toBeUndefined();
        expect(fold.state.context.rank).toBeUndefined();
        const pov = fold.state.cast[`person${NUL}sung jin-woo`];
        // Severity is `moderate` for everything, and that is a refusal rather than a guess: ranking
        // a wound from its wording is the enumerated judgement §11 bans.
        expect(pov.marks).toEqual([expect.objectContaining({ phrase: 'bandaged calf', severity: 'moderate' })]);
        // The label survives inside the value, so a reader can see what was rescued and from where.
        expect(pov.facts).toBe('rank: E-Rank Hunter');
    });

    test('a card\'s own "Conditions:" heading is NOT a body, and provenance is what says so', () => {
        // Measured: Raccoon City's `conditions` reads "cool, dry night; dim CRT-lit apartment" — a
        // card's heading meaning the weather, which as marks would claim the protagonist is
        // suffering from a CRT. `src` separates the scene probe's field from a card's label; the
        // words never could (`migrate.js` BODY_LABEL).
        const fold = v1();
        fold.state.context.pov = { v: 'Sung Jin-Woo', t: 40, src: 'narrative' };
        fold.state.context.conditions = { v: 'cool, dry night; dim CRT-lit apartment', t: 56 };
        migrate(fold);

        expect(fold.state.context.conditions).toBeDefined();
        expect(fold.state.cast[`person${NUL}sung jin-woo`].marks).toBeUndefined();
    });

    test('a health label routes whatever wrote it — that set IS the structured domain', () => {
        const fold = v1();
        fold.state.context.pov = { v: 'Sung Jin-Woo', t: 40, src: 'narrative' };
        fold.state.context.health = { v: 'hangover faded; mild fatigue', t: 56 };
        migrate(fold);

        expect(fold.state.context.health).toBeUndefined();
        // Both clauses survive, and "hangover faded" surviving is deliberate rather than a miss:
        // `isNegation` treats only outright clearance ("gone", "healed") as the END of a condition
        // and excludes "eased", "better", "improving" because those describe something still
        // present. Widening that vocabulary is the enumerated judgement §11 bans; the review's
        // M-lines are what clears a faded hangover, on evidence.
        expect(fold.state.cast[`person${NUL}sung jin-woo`].marks.map(m => m.phrase))
            .toEqual(['hangover faded', 'mild fatigue']);
    });

    test('with no pov row to own them, marks are parked rather than dropped or invented onto somebody', () => {
        // Raccoon City: body-state prose and an empty entity table, because extraction never ran.
        // Inventing a cast row would break the invariant the replay checks hardest.
        const fold = v1();
        fold.state.entities = {};
        fold.state.context.health = { v: 'mild fatigue', t: 56 };
        const before = Object.keys(fold.state.entities).length;
        migrate(fold);

        expect(Object.keys(fold.state.cast)).toHaveLength(before);
        expect(fold.state.migrated.marks.map(m => m.phrase)).toEqual(['mild fatigue']);
    });
});

/*
 * Rollback safety: new keys beside the old, old ones deleted only once the new have come back off
 * disk. FOLD-REDESIGN.md §9.
 */
describe('staged and idempotent', () => {
    test('the old keys survive the first conversion', () => {
        const fold = v1();
        migrate(fold);
        expect(fold.state.entities).toBeDefined();
        expect(fold.state.clocks).toBeDefined();
        expect(fold.state.migrated.pending).toEqual(['entities', 'clocks']);
    });

    test('and are retired on a later load, once v2 has been read back', () => {
        const fold = v1();
        migrate(fold);
        // Round-tripped through JSON, which is what a chat file does.
        const reloaded = JSON.parse(JSON.stringify(fold));
        const report = migrate(reloaded);
        expect(report.retired).toEqual(['entities', 'clocks']);
        expect(reloaded.state.entities).toBeUndefined();
        expect(reloaded.state.cast).toBeDefined();
    });

    test('running it twice changes nothing the second time', () => {
        const fold = v1();
        migrate(fold);
        const after = JSON.parse(JSON.stringify(fold.state.threads));
        const report = migrate(fold);
        expect(report.counts.threadsFromLeads).toBe(0);
        expect(report.counts.cast).toBe(0);
        expect(JSON.parse(JSON.stringify(fold.state.threads))).toEqual(after);
    });

    test('a blob with no fold state at all converts without inventing tables', () => {
        const fold = { v: 1 };
        const report = migrate(fold);
        expect(report.counts.cast).toBe(0);
        expect(fold.v).toBe(2);
    });

    test('the counts reach the observe table, where every other bound is counted', () => {
        const fold = v1();
        migrate(fold);
        expect(fold.state.observed['cap:migrate-cast']).toBe(2);
        expect(fold.state.observed['cap:migrate-threads']).toBe(3);
        expect(fold.state.observed['cap:migrate-reach']).toBe(3);
    });
});
