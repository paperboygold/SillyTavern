import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import {
    MAX_MARKS,
    MINOR,
    MODERATE,
    SEVERE,
    deriveState,
    hurtOf,
    markKey,
    markPhrases,
    marksOf,
    povPhrases,
    povMarks,
    renderLedger,
    renderState,
    seedMarks,
    splitMarkKey,
    statusKeyFor,
    validateStatus,
} from '../public/scripts/extensions/fold/state-table.js';
import { PERSON, foldEntity, renderEntities } from '../public/scripts/extensions/fold/entity-table.js';
import { splitConditions } from '../public/scripts/extensions/fold/block-parse.js';

/**
 * An event carrying a delta, in the shape the chronicle stores.
 * @param {number} t Timestamp.
 * @param {object} d Delta.
 * @param {string} [s] Summary.
 * @returns {object} An event.
 */
const ev = (t, d, s = 'something happened') => ({ s, kw: [], t, src: 'llm', d });

/**
 * The cast the mid-30 fight actually had on record, as five rows.
 * @param {string[]} names People.
 * @returns {Map<string, object>} A cast table.
 */
function cast(names) {
    const table = new Map();
    for (const name of names) {
        foldEntity(table, { kind: PERSON, name, place: 'the Nowon gate site', status: 'present', turn: 30 });
    }
    return table;
}

/*
 * ── The measured defect this whole phase exists for ──
 *
 * `FOLD-RPG-GAP.md` §3, and the two events are still in the live Solo Leveling ledger at mid 30:
 *
 *   8901545669670294:1  "Lee gets raked across the ribs by a goblin…"   {"flag":"bleeding","on":true}
 *   8901545669670294:2  "Park's bandaged thigh wound re-opens…"          {"flag":"bleeding","on":true}
 *
 * One flat namespace, no subject, so the two events wrote each other's slot and the panel showed
 * SOLOMON bleeding for the rest of the session. Five people were wounded in that fight.
 */
describe('the mid-30 events, replayed with an owner', () => {
    const table = cast(['Lee', 'Park', 'Solomon Winters']);
    const window = 'Lee gets raked across the ribs by a goblin, stumbling and bleeding. '
        + 'Park\'s bandaged thigh wound re-opens, bleeding fresh during the fight.';

    const proposed = validateStatus({
        status: new Map(),
        deltas: [
            { who: 'Lee', flag: 'bleeding', on: true, severity: MODERATE, turns: 0 },
            { who: 'Park', flag: 'bleeding', on: true, severity: MODERATE, turns: 0 },
        ],
        windowText: window,
        cast: table,
        pov: 'Solomon Winters',
    });
    const { marks } = deriveState([ev(30, { st: proposed.accepted })]);

    test('both are accepted, each carrying whose it is', () => {
        expect(proposed.rejected).toEqual([]);
        expect(proposed.accepted.map(mark => mark.who)).toEqual(['Lee', 'Park']);
    });

    test('Lee and Park each carry one mark', () => {
        expect(markPhrases(marks, 'Lee')).toEqual(['bleeding']);
        expect(markPhrases(marks, 'Park')).toEqual(['bleeding']);
    });

    test('and the player is clean — the whole of the bug, in one assertion', () => {
        expect(povMarks(marks, 'Solomon Winters')).toEqual([]);
        expect(hurtOf(marks, 'Solomon Winters')).toBe(0);
        expect(renderState({ inv: new Map(), vitals: new Map(), marks, pov: 'Solomon Winters' }))
            .not.toContain('bleeding');
    });

    test('a legacy subjectless mark is the POV\'s, and lands on nobody else\'s row', () => {
        // The trap this nearly walked into: `renderEntities` asks for each person's marks in turn,
        // so a reader of the unowned bucket per person would put every pre-Phase-D wound on every
        // cast row — the mid-30 bug inverted and multiplied. `markPhrases` is strict; `povPhrases`
        // is the only reading entitled to the unowned bucket.
        const legacy = deriveState([ev(1, { st: [{ flag: 'bandaged left calf', on: true }] })]).marks;
        expect(povPhrases(legacy, 'Solomon Winters')).toEqual(['bandaged left calf']);
        expect(markPhrases(legacy, 'Lee')).toEqual([]);
        expect(renderEntities(table, 30, { at: 'the Nowon gate site', hurt: name => markPhrases(legacy, name) }))
            .not.toContain('bandaged left calf');
    });

    test('one flag name, two owners, two marks — not one slot fought over', () => {
        expect(marks.size).toBe(2);
        expect([...marks.keys()].map(key => splitMarkKey(key).who).sort()).toEqual(['lee', 'park']);
    });
});

/*
 * §10's Phase D gate: "a scripted raid fixture shows five wounded as five rows". Five was the real
 * count in the Nowon raid, and fold rendered one undifferentiated `Status:` line.
 */
describe('five wounded are five rows', () => {
    const names = ['Lee', 'Park', 'Kim', 'Kang Min-seo', 'Sung Jin-Woo'];
    const table = cast([...names, 'Solomon Winters']);
    const hurts = [
        ['Lee', 'raked ribs', MODERATE],
        ['Park', 're-opened thigh', SEVERE],
        ['Kim', 'cracked bracer arm', MINOR],
        ['Kang Min-seo', 'shallow cut across the brow', MINOR],
        ['Sung Jin-Woo', 'wrenched shoulder', MODERATE],
    ];
    const window = hurts.map(([who, flag]) => `${who} takes a ${flag}.`).join(' ');
    const { accepted, rejected } = validateStatus({
        status: new Map(),
        deltas: hurts.map(([who, flag, severity]) => ({ who, flag, on: true, severity, turns: 0 })),
        windowText: window,
        cast: table,
        pov: 'Solomon Winters',
    });
    const { marks } = deriveState([ev(30, { st: accepted })]);

    test('every one is accepted and owned', () => {
        expect(rejected).toEqual([]);
        expect(marks.size).toBe(5);
    });

    test('each mark is on its own owner and on nobody else', () => {
        for (const [who, flag] of hurts) {
            expect(markPhrases(marks, who).join(' ')).toContain(flag);
            for (const other of names.filter(name => name !== who)) {
                expect(markPhrases(marks, other).join(' ')).not.toContain(flag);
            }
        }
    });

    test('and the injected cast line carries each wound beside its own name', () => {
        const block = renderEntities(table, 30, {
            exclude: 'Solomon Winters',
            at: 'the Nowon gate site',
            hurt: name => markPhrases(marks, name),
        });
        expect(block).toContain('Lee (the Nowon gate site, hurt: raked ribs)');
        expect(block).toContain('hurt: re-opened thigh (severe)');
        // The pov is not in the list he is the centre of, so his row cannot pick up anyone else's.
        expect(block).not.toContain('Solomon Winters');
    });
});

/*
 * §0.1-4, both halves. The block line is verbatim from message 72 of the live chat.
 */
describe('reassurance and morphology, on the legacy-healing path', () => {
    test('"left arm heavily bruised but functional" is exactly one mark', () => {
        const phrases = splitConditions('left arm heavily bruised but functional');
        expect(phrases).toHaveLength(1);

        const { accepted } = validateStatus({
            status: new Map(),
            deltas: phrases.map(flag => ({ who: '', flag, on: true })),
            windowText: 'Health: left arm heavily bruised but functional',
        });
        const { marks } = deriveState([ev(1, { st: accepted })]);
        expect(marks.size).toBe(1);
        expect(markPhrases(marks, '')).toEqual(['left arm heavily bruised but functional']);
    });

    test('`fatigued` and `mild fatigue` on one owner fold to one mark', () => {
        // Two live flags in the live header for one tired man, because `contentTokens` has no
        // morphology: {fatigued} and {fatigue} share no member. The prefix rule closes it
        // structurally rather than with a suffix list (`state-table.js` `sameSubject`).
        const { marks } = deriveState([
            ev(1, { st: [{ who: 'Solomon', flag: 'fatigued', on: true }] }),
            ev(2, { st: [{ who: 'Solomon', flag: 'mild fatigue', on: true }] }),
        ]);
        expect(marks.size).toBe(1);
        expect(markPhrases(marks, 'Solomon')).toEqual(['mild fatigue']);
    });

    test('but two owners keep two marks, however alike the words', () => {
        const { marks } = deriveState([
            ev(1, { st: [{ who: 'Solomon', flag: 'fatigued', on: true }] }),
            ev(2, { st: [{ who: 'Kang Min-seo', flag: 'mild fatigue', on: true }] }),
        ]);
        expect(marks.size).toBe(2);
    });

    test('and the prefix rule needs a real stem, not a plural', () => {
        expect(statusKeyFor(new Map([[markKey('', 'arm'), { phrase: 'arm' }]]), 'arms', ''))
            .toBe(markKey('', 'arms'));
    });
});

/*
 * §3, Fate's consequence slots: three per row, and the fourth wound escalates rather than being
 * refused. A refused wound would be retraction-by-silence wearing a counter.
 */
describe('three consequence slots, and what the fourth wound does', () => {
    const three = who => [
        ev(1, { st: [{ who, flag: 'split lip', on: true, severity: MINOR }] }),
        ev(2, { st: [{ who, flag: 'bruised ribs', on: true, severity: MODERATE }] }),
        ev(3, { st: [{ who, flag: 'gashed thigh', on: true, severity: MODERATE }] }),
    ];

    test('a worse fourth wound displaces the mildest', () => {
        const { marks } = deriveState([
            ...three('Lee'),
            ev(4, { st: [{ who: 'Lee', flag: 'broken arm', on: true, severity: SEVERE }] }),
        ]);
        expect(marksOf(marks, 'Lee')).toHaveLength(MAX_MARKS);
        expect(markPhrases(marks, 'Lee').join(', ')).toContain('broken arm');
        expect(markPhrases(marks, 'Lee').join(', ')).not.toContain('split lip');
    });

    test('a milder fourth wound escalates the mildest instead of vanishing', () => {
        const { marks } = deriveState([
            ev(1, { st: [{ who: 'Lee', flag: 'bruised ribs', on: true, severity: MODERATE }] }),
            ev(2, { st: [{ who: 'Lee', flag: 'gashed thigh', on: true, severity: SEVERE }] }),
            ev(3, { st: [{ who: 'Lee', flag: 'broken arm', on: true, severity: SEVERE }] }),
            ev(4, { st: [{ who: 'Lee', flag: 'scraped knuckles', on: true, severity: MINOR }] }),
        ]);
        const held = marksOf(marks, 'Lee');
        expect(held).toHaveLength(MAX_MARKS);
        // Nothing new took a slot, and the mildest is worse than it was.
        expect(markPhrases(marks, 'Lee').join(', ')).not.toContain('scraped knuckles');
        expect(held[0][1].severity).toBe(SEVERE);
        expect(held[0][1].worsened).toBe('scraped knuckles');
    });

    test('the cap is per person, not per chat', () => {
        const { marks } = deriveState([...three('Lee'), ...three('Park')]);
        expect(marksOf(marks, 'Lee')).toHaveLength(MAX_MARKS);
        expect(marksOf(marks, 'Park')).toHaveLength(MAX_MARKS);
    });

    test('restating an existing mark is not a fourth wound', () => {
        const { marks } = deriveState([
            ...three('Lee'),
            ev(4, { st: [{ who: 'Lee', flag: 'split lip, still bleeding', on: true, severity: MODERATE }] }),
        ]);
        expect(marksOf(marks, 'Lee')).toHaveLength(MAX_MARKS);
        expect(markPhrases(marks, 'Lee').join(', ')).toContain('split lip, still bleeding');
    });

    test('and the write path counts the displacement where a pass can be measured', () => {
        const { marks } = deriveState(three('Lee'));
        const outcome = validateStatus({
            status: marks,
            deltas: [{ who: 'Lee', flag: 'broken arm', on: true, severity: SEVERE }],
            windowText: 'the cleaver takes Lee across the arm and breaks it',
            cast: cast(['Lee']),
            pov: 'Solomon Winters',
            // Coverage by the model's report, the way production passes it.
            mentioned: new Set(['broken arm']),
        });
        expect(outcome.capped).toBe(1);
        expect(outcome.rejected).toEqual([]);
    });
});

/*
 * §3: "Validation rejects a `who` matching no known cast row with a counted reason (an invented
 * owner is worse than none)."
 */
describe('an invented owner is worse than none', () => {
    const table = cast(['Lee', 'Park']);

    test('a named owner nobody has heard of is refused and counted', () => {
        const { accepted, rejected } = validateStatus({
            status: new Map(),
            deltas: [{ who: 'Gorbaz the Unwritten', flag: 'bleeding', on: true }],
            windowText: 'Gorbaz the Unwritten is bleeding',
            cast: table,
            pov: 'Solomon Winters',
        });
        expect(accepted).toEqual([]);
        expect(rejected).toEqual([expect.objectContaining({ item: 'Gorbaz the Unwritten', reason: 'unknown-owner' })]);
    });

    test('an EMPTY owner is never refused — it is the pov, which is what the panel always assumed', () => {
        const { accepted } = validateStatus({
            status: new Map(),
            deltas: [{ who: '', flag: 'bleeding', on: true }],
            windowText: 'he is bleeding',
            cast: table,
            pov: 'Solomon Winters',
        });
        expect(accepted[0].who).toBe('Solomon Winters');
    });

    test('and the pov resolves even when he has no cast row of his own', () => {
        // He is excluded from the list he is the centre of, and the scene probe can name him before
        // the cast probe has placed him anywhere.
        const { accepted, rejected } = validateStatus({
            status: new Map(),
            deltas: [{ who: 'Solomon Winters', flag: 'bleeding', on: true }],
            windowText: 'Solomon Winters is bleeding',
            cast: table,
            pov: 'Solomon Winters',
        });
        expect(rejected).toEqual([]);
        expect(accepted[0].who).toBe('Solomon Winters');
    });

    test('an owner named by an alias lands on the row, not beside it', () => {
        const table2 = new Map();
        foldEntity(table2, { kind: PERSON, name: 'Kang Min-seo', aka: 'Kang', turn: 1 });
        const { accepted } = validateStatus({
            status: new Map(),
            deltas: [{ who: 'Kang', flag: 'cut brow', on: true }],
            windowText: 'Kang takes a cut across the brow',
            cast: table2,
            pov: 'Solomon',
            mentioned: new Set(['cut brow']),
        });
        expect(accepted[0].who).toBe('Kang Min-seo');
    });
});

/*
 * §3: `standing.hurt` becomes the pov's marks weighted by severity, and other people's contribute
 * zero. `verdict.js` read `snapshot().status.length` before this.
 */
describe('verdict standing — one severe and one minor is 3', () => {
    const { marks } = deriveState([
        ev(1, { st: [{ who: 'Solomon Winters', flag: 'gashed calf', on: true, severity: SEVERE }] }),
        ev(2, { st: [{ who: 'Solomon Winters', flag: 'split lip', on: true, severity: MINOR }] }),
        ev(3, { st: [{ who: 'Lee', flag: 'raked ribs', on: true, severity: SEVERE }] }),
        ev(4, { st: [{ who: 'Park', flag: 're-opened thigh', on: true, severity: SEVERE }] }),
    ]);

    test('severe counts 2, everything else 1', () => {
        expect(hurtOf(marks, 'Solomon Winters')).toBe(3);
    });

    test('other people\'s marks contribute exactly zero', () => {
        const alone = deriveState([
            ev(1, { st: [{ who: 'Solomon Winters', flag: 'gashed calf', on: true, severity: SEVERE }] }),
            ev(2, { st: [{ who: 'Solomon Winters', flag: 'split lip', on: true, severity: MINOR }] }),
        ]).marks;
        expect(hurtOf(marks, 'Solomon Winters')).toBe(hurtOf(alone, 'Solomon Winters'));
    });

    test('and a pre-Phase-D subjectless mark still counts as his', () => {
        // §9's read-time healing: an `st` delta with no `who` folds into the unowned bucket, which
        // every consumer reads as the pov's. Rewriting the ledger to add a subject would destroy the
        // evidence of what was actually recorded.
        const legacy = deriveState([ev(1, { st: [{ flag: 'bandaged left calf', on: true }] })]).marks;
        expect(hurtOf(legacy, 'Solomon Winters')).toBe(1);
        expect(povPhrases(legacy, 'Solomon Winters')).toEqual(['bandaged left calf']);
    });
});

/*
 * Marks are events, and that is the swipe argument (`state-table.js` `deriveState`).
 */
describe('a mark is an event, so a swipe un-wounds', () => {
    const wounding = ev(30, { st: [{ who: 'Lee', flag: 'raked ribs', on: true, severity: MODERATE }] });
    const later = ev(31, { inv: [{ item: 'bandage', dq: -1 }] });

    test('with the causing turn live, the mark is there', () => {
        expect(markPhrases(deriveState([wounding, later]).marks, 'Lee')).toHaveLength(1);
    });

    test('without it — the swipe — there is nothing to overlay away', () => {
        expect(markPhrases(deriveState([later]).marks, 'Lee')).toHaveLength(0);
    });

    test('and healing is an append, not a deletion', () => {
        const healed = deriveState([
            wounding,
            ev(40, { st: [{ who: 'Lee', flag: 'raked ribs', on: false }] }),
        ]).marks;
        expect(markPhrases(healed, 'Lee')).toHaveLength(0);
        // Swipe the healing away and the wound is back, because the fold never edited anything.
        expect(markPhrases(deriveState([wounding]).marks, 'Lee')).toHaveLength(1);
    });
});

/*
 * The one thing the ledger cannot hold: a mark that predates it (§9, `migrate.js` `migrateBody`).
 */
describe('seeded marks — what migration parks on the row', () => {
    const seeds = [
        { who: 'Solomon Winters', phrase: 'calf scabbed and rebandaged', severity: MODERATE },
        { who: 'Solomon Winters', phrase: 'left arm bruised shoulder to elbow', severity: MODERATE },
    ];

    test('they fold as ordinary marks', () => {
        expect(povPhrases(seedMarks(seeds), 'Solomon Winters')).toHaveLength(2);
    });

    test('four seeded clauses present three, because the fold owns the slot rule', () => {
        // Migration deliberately does NOT truncate: the pre-repair2 header carries four clauses in
        // one `health` field, and cutting the fourth at write time would be the retraction-by-
        // silence this phase exists to delete. `placeMark` decides what the fourth does.
        const four = [
            'lacerations cleaned and bandaged',
            'left arm heavily bruised but functional',
            'mild fatigue',
            'possible infection monitored',
        ].map(phrase => ({ who: 'Solomon Winters', phrase, severity: MODERATE }));
        expect(marksOf(seedMarks(four), 'Solomon Winters')).toHaveLength(MAX_MARKS);
    });

    test('and any event about the same subject supersedes them, because they fold first', () => {
        const { marks } = deriveState(
            [ev(1, { st: [{ who: 'Solomon Winters', flag: 'calf healed', on: false }] })],
            { seeds });
        expect(povPhrases(marks, 'Solomon Winters')).toEqual(['left arm bruised shoulder to elbow']);
    });
});

/*
 * §3 and §0: the scene header renders where/when/weather and nothing about anybody's body. The
 * panel imports `script.js` and cannot be unit-tested, so this reads the source — the same
 * instrument Phase C used to prove `cap:stale-hidden` retired by construction.
 */
describe('the scene header no longer carries body-state', () => {
    const FOLD = path.join(process.cwd(), '..', 'public', 'scripts', 'extensions', 'fold');
    const panel = fs.readFileSync(path.join(FOLD, 'panel.js'), 'utf8');
    const scene = fs.readFileSync(path.join(FOLD, 'scene.js'), 'utf8');

    test('`conditions` is not a scene field any more', () => {
        const declared = String(panel.match(/const SCENE_FIELDS = \[(.*?)\];/)?.[1]);
        expect(declared).not.toContain('conditions');
        expect(declared).toContain('weather');
    });

    test('and the header reads the weather alone, where it used to join the two', () => {
        // The measured defect: `[conditions, weather].join('; ')` is why "Bandaged calf" rendered
        // as a property of the Goblin Market (FOLD-REDESIGN.md §0).
        expect(panel).not.toContain('[scene.get(\'conditions\'), scene.get(\'weather\')]');
        expect(panel).toContain('const conditions = scene.get(\'weather\')');
    });

    test('but the label is still claimed, so a v1 chat cannot resurrect it one heading lower', () => {
        expect(panel).toContain('const BODY_FIELDS = [\'conditions\', \'health\']');
        expect(panel).toContain('...BODY_FIELDS');
    });

    test('the scene probe writes marks rather than a context field', () => {
        expect(String(scene.match(/const FIELDS = \[(.*?)\];/)?.[1])).not.toContain('conditions');
        expect(scene).toContain('recordMarks(');
    });

    test('and the pov\'s bandaged calf renders under Condition, as a mark', () => {
        const { marks } = deriveState([ev(1, { st: [{ flag: 'bandaged left calf', on: true }] })]);
        const { lines } = renderLedger({ inv: new Map(), vitals: new Map(), marks, pov: 'Solomon Winters' });
        expect(lines).toContain('Condition: bandaged left calf');
    });
});
