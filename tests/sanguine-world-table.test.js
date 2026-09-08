import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import { FACTION, MAX_DRIVE, MIN_DRIVE, PERSON, foldEntity } from '../public/scripts/extensions/sanguine/entity-table.js';
import { HIDDEN, OPEN } from '../public/scripts/extensions/sanguine/thread-table.js';
import { MAX_NOMINATIONS, MAX_WORLD_ASKS, MAX_WORLD_TICK, NO_LINES, instruction, nominationAsks, planNominations, planWorld, renderWorldEvents, revealContract, schema, worldAsks, worldBlock } from '../public/scripts/extensions/sanguine/world-table.js';

/*
 * The off-screen world-turn: on a pass triggered by a declared time skip or scene break, the model
 * is asked which standing agendas advanced, and how. Each move must name a cast row fold already
 * tracks: the probe advances the world it knows about, never authors a new one. FOLD-REDESIGN.md
 * §7.4; this is Gate 1 of Phase W.
 */
function cast(...rows) {
    const table = new Map();
    for (const row of rows) {
        foldEntity(table, row);
    }
    return table;
}

describe('the off-screen turn is a form, not an open question', () => {
    /*
     * The measurement that replaced an invitation with a list.
     *
     * A completed Xianxia campaign armed this probe 107 times on real elapsed spans. It returned an
     * empty `moves` array 107 times, with ZERO rejections, nothing was ever proposed for a gate to
     * refuse. On the very same passes, the review's numbered disposition lines drew 3319 answers
     * from the same model. `moves: []` was always schema-valid and the instruction spent two of its
     * six clauses granting permission to use it.
     *
     * So the probe is handed lines with ids now, and answers them one by one.
     */
    const agendas = () => cast(
        { kind: FACTION, name: '万通商行', wants: 'corner the Rank-4 pill trade', drive: 2, driveSize: 6, turn: 1 },
        { kind: PERSON, name: 'Kang Min-seo', wants: 'run profitable D-rank raids', drive: 0, driveSize: 4, turn: 1 },
        { kind: PERSON, name: 'innkeeper', wants: 'earning silver from lodgers', turn: 1 },
    );

    test('one line per agenda, and none for an actor without one', () => {
        const { text, index } = worldBlock({ asks: worldAsks({ entities: agendas() }), elapsed: '14 days' });
        expect(text).toContain('WHAT MOVED WHILE YOU WERE AWAY (14 days)');
        expect(text).toContain('万通商行');
        expect(text).toContain('Kang Min-seo');
        // The innkeeper is not pursuing anything across scenes and is not asked about.
        expect(text).not.toContain('innkeeper');
        expect(index.size).toBe(2);
    });

    test('the line shows the position, which is what makes an advance legible', () => {
        const { text } = worldBlock({ asks: worldAsks({ entities: agendas() }) });
        expect(text).toMatch(/\[drive 2\/6\].*万通商行/);
    });

    test('a campaign with no agendas asks nothing at all', () => {
        // Every chat written before drives existed. The block is empty and the probe is silent.
        const quiet = cast({ kind: PERSON, name: 'innkeeper', wants: 'earning silver', turn: 1 });
        const { text, index } = worldBlock({ asks: worldAsks({ entities: quiet }) });
        expect(text).toBe('');
        expect(index.size).toBe(0);
    });

    test('an answered line advances the agenda it was posed from', () => {
        const { index } = worldBlock({ asks: worldAsks({ entities: agendas() }) });
        const id = [...index.keys()][0];
        const out = planWorld({ advances: [{ id, tick: 1, what: 'bought out the eastern pill stalls', where: '烈阳城', seen: OPEN }] }, { index });
        expect(out.rejected).toEqual([]);
        expect(out.accepted).toEqual([expect.objectContaining({
            id, kind: 'actor', root: index.get(id).key, tick: 1, seen: OPEN, where: '烈阳城',
        })]);
    });

    test('tick 0 is a real answer, counted rather than inferred from silence', () => {
        // The whole defect was that "nothing moved" and "I did not consider it" were the same
        // empty array. Now they are distinguishable, which is what makes the counter honest.
        const { index } = worldBlock({ asks: worldAsks({ entities: agendas() }) });
        const ids = [...index.keys()];
        const out = planWorld({ advances: ids.map(id => ({ id, tick: 0, what: '', where: '', seen: HIDDEN })) }, { index });
        expect(out.accepted).toEqual([]);
        expect(out.rejected).toEqual([]);
        expect(out.declined).toBe(2);
    });

    test('an unrooted advance is unsayable, not refused', () => {
        // `unrooted-move` retired with the shape that needed it: the model no longer NAMES an actor,
        // so it cannot name one fold does not have. An id it invented is a narrower failure.
        const { index } = worldBlock({ asks: worldAsks({ entities: agendas() }) });
        const out = planWorld({ advances: [{ id: 'W99', tick: 1, what: 'did something', where: '', seen: HIDDEN }] }, { index });
        expect(out.accepted).toEqual([]);
        expect(out.rejected[0].reason).toBe('unknown-id');
    });

    test('a line answered twice counts once', () => {
        // Otherwise one agenda outruns the per-pass cap by repetition.
        const { index } = worldBlock({ asks: worldAsks({ entities: agendas() }) });
        const id = [...index.keys()][0];
        const out = planWorld({ advances: [
            { id, tick: 1, what: 'moved', where: '', seen: OPEN },
            { id, tick: 1, what: 'moved again', where: '', seen: OPEN },
        ] }, { index });
        expect(out.accepted).toHaveLength(1);
        expect(out.rejected[0].reason).toBe('duplicate-id');
    });

    test('a tick beyond the cap is clamped, one step per span', () => {
        // Off-screen has no mention gate, so the elapsed span is the only evidence and it cannot
        // tell one step from five.
        const { index } = worldBlock({ asks: worldAsks({ entities: agendas() }) });
        const id = [...index.keys()][0];
        const out = planWorld({ advances: [{ id, tick: 99, what: 'moved', where: '', seen: OPEN }] }, { index });
        expect(out.accepted[0].tick).toBe(MAX_WORLD_TICK);
    });

    test('a tick with nothing to say is refused', () => {
        const { index } = worldBlock({ asks: worldAsks({ entities: agendas() }) });
        const id = [...index.keys()][0];
        const out = planWorld({ advances: [{ id, tick: 1, what: '  ', where: '', seen: OPEN }] }, { index });
        expect(out.accepted).toEqual([]);
        expect(out.rejected[0].reason).toBe('no-change');
    });

    test('hidden is kept only when asserted; anything else is open', () => {
        const { index } = worldBlock({ asks: worldAsks({ entities: agendas() }) });
        const id = [...index.keys()][0];
        const hidden = planWorld({ advances: [{ id, tick: 1, what: 'x', where: '', seen: HIDDEN }] }, { index });
        const defaulted = planWorld({ advances: [{ id, tick: 1, what: 'x', where: '' }] }, { index });
        expect(hidden.accepted[0].seen).toBe(HIDDEN);
        expect(defaulted.accepted[0].seen).toBe(OPEN);
    });

    test('a dial-bearing thread is posed beside the actors', () => {
        // Passive income and off-screen economics are the same mechanism as a faction advancing:
        // an integer that moves while the camera is away. The block does not care which table.
        const threads = [{ key: 'estate production', name: 'estate production', kind: 'progress', size: 10, filled: 3, stale: 4 }];
        const { text, index } = worldBlock({ asks: worldAsks({ entities: agendas(), threads }) });
        expect(text).toContain('estate production');
        expect([...index.values()].some(ask => ask.kind === 'thread')).toBe(true);
    });

    test('the queue drains, the most neglected agendas are asked first', () => {
        const many = new Map();
        for (let n = 0; n < MAX_WORLD_ASKS + 3; n++) {
            foldEntity(many, { kind: FACTION, name: `house ${n}`, driveSize: 4, turn: n });
        }
        const asks = worldAsks({ entities: many, turn: 100 });
        expect(asks).toHaveLength(MAX_WORLD_ASKS);
        // Oldest-touched first, so the ones that keep missing the cut come up next time.
        expect(asks[0].age).toBeGreaterThanOrEqual(asks[asks.length - 1].age);
    });

    test('nothing is proposed when the fragment is empty or absent', () => {
        const { index } = worldBlock({ asks: worldAsks({ entities: agendas() }) });
        expect(planWorld(null, { index }).accepted).toEqual([]);
        expect(planWorld({ advances: [] }, { index }).accepted).toEqual([]);
        expect(planWorld({ advances: [] }, { index }).rejected).toEqual([]);
        expect(planWorld({ advances: [] }, { index }).declined).toBe(0);
    });

    test('schema and instruction ask for every line, not for whatever comes to mind', () => {
        expect(schema().properties.advances).toBeTruthy();
        expect(schema().properties.moves).toBeUndefined();
        expect(instruction()).toMatch(/answer every line/i);
        // The two clauses that made saying nothing free are gone.
        expect(instruction()).not.toMatch(/nothing plausibly advanced/i);
        expect(instruction()).not.toMatch(/an agenda with no advance contributes no move/i);
    });
});


/*
 * The reveal contract (§7.5, Gate 4): the pinned block never asserts what the character could not
 * know. A hidden world event whose place is not the current scene renders NAMED but unquantified,
 * `(off-screen: Kang Min-seo)`: and locality flips it to a full assertion when the scene reaches
 * its `where`. This is Gate 4 of Phase W.
 */
function worldEvent(src, who, what, where, seen, at) {
    return {
        src,
        s: `${who} ${what}`,
        d: { world: { who, where, seen } },
    };
}

describe('world reveal contract, discovery, not bulletins', () => {
    test('an open event is asserted in full', () => {
        const events = [worldEvent('world', 'Kang Min-seo', 'ran two D-rank raids', 'Eunpyeong', OPEN, 'Eunpyeong')];
        expect(renderWorldEvents(events, 'Seoul')).toContain('Kang Min-seo ran two D-rank raids');
    });

    test('a hidden event away from its place is named, never asserted', () => {
        // The content ("ran two D-rank raids") must NOT appear, the character could not know it.
        // Only the actor is named, so the narrator knows the world is moving without leaking how.
        const events = [worldEvent('world', 'Kang Min-seo', 'ran two D-rank raids', 'Eunpyeong', HIDDEN, 'Seoul')];
        const line = renderWorldEvents(events, 'Seoul');
        expect(line).toContain('(off-screen: Kang Min-seo)');
        expect(line).not.toContain('ran two D-rank raids');
    });

    test('locality flips a hidden event assertable at its where', () => {
        // Walk back to the Nowon gate site and the block may now assert what changed there (§7.5).
        const events = [worldEvent('world', 'Kang Min-seo', 'ran two D-rank raids', 'Eunpyeong', HIDDEN, 'Eunpyeong')];
        expect(renderWorldEvents(events, 'Eunpyeong')).toContain('Kang Min-seo ran two D-rank raids');
        expect(renderWorldEvents(events, 'Eunpyeong')).not.toContain('(off-screen');
    });

    test('only recent world events are carried', () => {
        const events = Array.from({ length: 6 }, (_, i) => worldEvent('world', `Actor ${i}`, 'stirred', '', OPEN, 'anywhere'));
        const line = renderWorldEvents(events, 'anywhere');
        expect(line).toContain('Actor 5 stirred');
        expect(line).not.toContain('Actor 0 stirred');
    });

    test('non-world events never appear in the world line', () => {
        const events = [
            { src: 'llm', s: 'Solomon kills a goblin' },
            worldEvent('world', 'Jin-Woo', 'raided a gate', '', OPEN, 'Seoul'),
        ];
        expect(renderWorldEvents(events, 'Seoul')).not.toContain('Solomon kills a goblin');
        expect(renderWorldEvents(events, 'Seoul')).toContain('Jin-Woo raided a gate');
    });

    test('nothing world renders an empty line', () => {
        expect(renderWorldEvents([], 'Seoul')).toBe('');
        expect(renderWorldEvents(null, 'Seoul')).toBe('');
    });

    test('the reveal contract names the constraint for the narrator', () => {
        expect(revealContract()).toMatch(/does not know them/);
        expect(revealContract()).toMatch(/could perceive/);
    });
});

describe('what an accepted advance gives the state write', () => {
    const posed = () => worldBlock({
        asks: worldAsks({
            entities: cast({ kind: PERSON, name: 'Kang Min-seo', wants: 'run raids', driveSize: 4, turn: 1 }),
        }),
    });

    test('an advance carries the cast KEY, not the name the model typed', () => {
        // `world.js` writes `entities.setPlace(move.root, move.where)` and
        // `entities.advanceDrive(move.root, move.tick)`. Both need a resolved key or they would
        // create a row instead of moving one. Pinned here because those writes live in an
        // app-coupled module this suite cannot reach.
        const { index } = posed();
        const id = [...index.keys()][0];
        const out = planWorld({ advances: [{ id, tick: 1, what: 'travelled north', where: 'Eunpyeong', seen: OPEN }] }, { index });
        expect(out.accepted).toHaveLength(1);
        const [move] = out.accepted;
        expect(move.root).toContain('kang');
        expect(move.where).toBe('Eunpyeong');
        expect(move.seen).toBe(OPEN);
        // And the tick, which is the half that accumulates rather than merely being narrated.
        expect(move.tick).toBe(1);
        expect(move.kind).toBe('actor');
    });

    test('a HIDDEN advance keeps its seen value, which is what withholds the place write', () => {
        // The reveal contract, and the reason the place write is gated rather than unconditional: a
        // hidden move whose destination landed on the cast row would show up in the panel the player
        // reads and the block the narrator writes from. It is still recorded, still reaches the
        // narrator through `renderWorldEvents`, and, deliberately, still ticks. `seen` governs
        // what may be ASSERTED, not whether the world is allowed to happen.
        const { index } = posed();
        const id = [...index.keys()][0];
        const out = planWorld({ advances: [{ id, tick: 1, what: 'slipped away', where: 'the border', seen: HIDDEN }] }, { index });
        expect(out.accepted[0].seen).toBe(HIDDEN);
        expect(out.accepted[0].tick).toBe(1);
    });

    test('an unknown seen value is treated as OPEN, never as hidden by accident', () => {
        const { index } = posed();
        const id = [...index.keys()][0];
        const out = planWorld({ advances: [{ id, tick: 1, what: 'moved', where: 'north', seen: 'whatever' }] }, { index });
        expect(out.accepted[0].seen).toBe(OPEN);
    });
});

/*
 * The thread half of the world block, which had never once been given its input.
 *
 * `worldAsks` guards with `Array.isArray(threads) ? threads : []`, and `world.js` handed it
 * `clocks.view()`: a Map. The guard was false on every call the feature has ever made, so the
 * thread half was skipped silently for its whole life. Measured across 21 chats and 293 traced
 * passes: the block's row marker `W1 [` appears in zero prompts.
 *
 * The existing suite passed `entities` only, which is exactly why the mismatch survived: a guard
 * that silently yields nothing looks identical to a feature with nothing to say.
 */
describe('worldAsks reads the threads it is given', () => {
    /** A dial-bearing thread in the shape `thread-table.threads()` produces. */
    const dialThread = (over = {}) => ({
        key: 'the siege tightens',
        name: 'the siege tightens',
        about: 'the walls are breached',
        kind: 'doom',
        filled: 2,
        size: 6,
        seen: 'open',
        turn: 3,
        ...over,
    });

    test('a dial-bearing thread becomes an ask', () => {
        const asks = worldAsks({ entities: new Map(), threads: [dialThread()], turn: 5 });
        const thread = asks.filter(ask => ask.kind === 'thread');
        expect(thread).toHaveLength(1);
        expect(thread[0]).toMatchObject({ key: 'the siege tightens', filled: 2, size: 6 });
    });

    test('a Map of the same threads yields nothing, the defect, pinned', () => {
        const asMap = new Map([['the siege tightens', dialThread()]]);
        expect(worldAsks({ entities: new Map(), threads: asMap, turn: 5 })
            .filter(ask => ask.kind === 'thread')).toHaveLength(0);
    });

    test('a thread with no dial is not an ask, there is nothing to advance', () => {
        const flat = dialThread({ kind: undefined, filled: undefined, size: undefined });
        expect(worldAsks({ entities: new Map(), threads: [flat], turn: 5 })
            .filter(ask => ask.kind === 'thread')).toHaveLength(0);
    });

    test('and the block actually renders a row for it', () => {
        const asks = worldAsks({ entities: new Map(), threads: [dialThread()], turn: 5 });
        const { text } = worldBlock({ asks });
        expect(text).not.toBe('');
        // `W1 [` is the marker that appears in zero of the 293 traced prompts on disk.
        expect(text).toContain('W1 [');
    });
});

/*
 * The actor half, which had never once had an eligible row.
 *
 * `worldAsks` gates on `driveSize > 0`, and that number used to come from the entity probe being
 * asked "how many steps does their standing ambition take" on a sighting. MEASURED: 0 in 288 of 288
 * traced proposals; `driveSize > 0` on 0 of 165 cast rows across all 17 live chats, 40 of them
 * storing an explicit 0. So the gate never admitted anybody, and once the thread half's own
 * Map/Array defect was fixed the threads were the entire feature.
 *
 * The repair after that was to DERIVE the size from the row's history. It was measured too, against
 * a hand label of every distinct `wants` in the corpus scored by whether the agenda can complete:
 * 28% precision against a 25% baseline, which is to say it selected nothing. It admitted eleven
 * Wuxia shopkeepers and missed `open the sealed door`.
 *
 * So the size is authored now. `nominationAsks` shortlists, the model judges on the same armed pass,
 * and `world.js` writes the answer. `worldAsks` went back to reading the stored field only.
 */
describe('worldAsks reads a stored size and nothing cleverer', () => {
    const sized = (over = {}) => ({
        kind: PERSON, name: 'Ada Wong', wants: 'find Ben Bertolucci', turn: 60, ...over,
    });

    test('a row with a judged size becomes an ask', () => {
        const table = cast(sized({ driveSize: 6, drive: 2 }));
        const asks = worldAsks({ entities: table, turn: 60 });
        expect(asks).toHaveLength(1);
        expect(asks[0]).toMatchObject({ kind: 'actor', name: 'Ada Wong', size: 6, filled: 2 });
    });

    test('a long-held agenda with no judged size is NOT an ask', () => {
        // The row is a strong nomination candidate and still has nothing to advance. Until the
        // model has said the agenda completes and how long it is, there is no dial to move.
        const table = cast(sized({ turn: 4 }), sized());
        expect(worldAsks({ entities: table, turn: 60 })).toHaveLength(0);
    });

    test('a stored literal 0 is skipped here and still re-nominated, the 40-row corpus case', () => {
        // Written by the retired sighting probe. `worldAsks` correctly has nothing to advance;
        // `nominationAsks` correctly asks the question again, because absence of a judgement lives
        // in `driveAsked` rather than being inferred from the size.
        const table = cast(sized({ turn: 4, driveSize: 0 }), sized({ driveSize: 0 }));
        expect(worldAsks({ entities: table, turn: 60 })).toHaveLength(0);
        expect(nominationAsks({ entities: table, turn: 60 })).toHaveLength(1);
    });
});

/*
 * Arithmetic nominates, the model adjudicates.
 *
 * The measured reason: no rule over fold's own fields separates an agenda that can complete from a
 * routine. Against a 25% baseline, `knows` scored 27%, `reach` 43% at 19% recall, mobility 30%, the
 * stability derivation 28%, and the best combination found 39%. The property is semantic, is there
 * a state of the world where the actor stops, and reading it out of the phrase would mean reading
 * prose in an arbitrary language.
 *
 * So `nominates` optimises for recall and hands a shortlist to the model with evidence attached.
 */
describe('nominationAsks, the shortlist, and what it puts on the line', () => {
    const candidate = (over = {}) => ({
        kind: PERSON, name: 'Ma', wants: 'Run her inn', turn: 60, ...over,
    });
    /* `first` is stamped from `turn` and merged under `min`, so a span needs two sightings. */
    const twice = (row, first = 4) => cast({ ...row, turn: first }, row);

    test('a long-held agenda is nominated whether or not it looks like an ambition', () => {
        // Both of these are posed. Separating them is the model's job, and the table above is why.
        const table = twice(candidate());
        const other = twice(candidate({ name: '青云子', wants: 'win the Foundation Building Pill' }));
        expect(nominationAsks({ entities: table, turn: 60 })).toHaveLength(1);
        expect(nominationAsks({ entities: other, turn: 60 })).toHaveLength(1);
    });

    test('somebody the story met once is not nominated', () => {
        expect(nominationAsks({ entities: cast(candidate()), turn: 60 })).toHaveLength(0);
    });

    test('a judged row leaves the queue', () => {
        const table = twice(candidate({ driveAsked: 55 }));
        expect(nominationAsks({ entities: table, turn: 60 })).toHaveLength(0);
    });

    test('the ask carries the evidence, not just the name', () => {
        const [ask] = nominationAsks({ entities: twice(candidate()), turn: 60 });
        expect(ask).toMatchObject({ kind: 'nomination', name: 'Ma', about: 'Run her inn', span: 56, steady: true });
    });

    test('capped per pass, most-neglected first, so a big cast drains', () => {
        const many = new Map();
        for (let n = 0; n < MAX_NOMINATIONS + 4; n++) {
            foldEntity(many, { kind: PERSON, name: `merchant ${n}`, wants: `sell wares ${n}`, turn: 0 });
            foldEntity(many, { kind: PERSON, name: `merchant ${n}`, wants: `sell wares ${n}`, turn: 20 + n });
        }
        const asks = nominationAsks({ entities: many, turn: 100 });
        expect(asks).toHaveLength(MAX_NOMINATIONS);
        expect(asks[0].age).toBeGreaterThanOrEqual(asks[asks.length - 1].age);
    });

    test('and the budget is a parameter, so the cap is testable rather than assumed', () => {
        const many = new Map();
        for (let n = 0; n < 5; n++) {
            foldEntity(many, { kind: PERSON, name: `merchant ${n}`, wants: `sell wares ${n}`, turn: 0 });
            foldEntity(many, { kind: PERSON, name: `merchant ${n}`, wants: `sell wares ${n}`, turn: 30 });
        }
        expect(nominationAsks({ entities: many, turn: 60, budget: 2 })).toHaveLength(2);
        expect(nominationAsks({ entities: many, turn: 60, budget: 0 })).toHaveLength(0);
    });

    test('a row with no agenda text is never posed, there would be nothing to judge', () => {
        expect(nominationAsks({ entities: twice(candidate({ wants: '' })), turn: 60 })).toHaveLength(0);
    });
});

describe('the nomination block and its answers', () => {
    const twice = (row, first = 4) => cast({ ...row, turn: first }, row);
    const posed = (over = {}) => {
        const table = twice({ kind: PERSON, name: 'Ma', wants: 'Run her inn', turn: 60, ...over });
        return worldBlock({ nominations: nominationAsks({ entities: table, turn: 60 }) });
    };

    test('the line names the agenda and the evidence that makes it answerable', () => {
        const { text } = posed();
        expect(text).toContain('STANDING AGENDAS, DOES THIS COMPLETE?');
        expect(text).toContain('N1 Ma, "Run her inn" (held unchanged for 56 turns)');
    });

    test('a re-worded agenda says so rather than claiming it held', () => {
        // `agendaStable` retired as a gate and earns its keep here: printing "held unchanged" over a
        // trail that contradicts it would be handing the model false evidence.
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'Ma', wants: 'run the inn', turn: 4 });
        foldEntity(table, { kind: PERSON, name: 'Ma', wants: 'buy out the rival inn', turn: 60 });
        const { text } = worldBlock({ nominations: nominationAsks({ entities: table, turn: 60 }) });
        expect(text).toContain('restated since');
        expect(text).not.toContain('held unchanged');
    });

    test('both sections render together, with their own prefixes', () => {
        const table = cast(
            { kind: PERSON, name: 'Ada Wong', wants: 'find Ben', driveSize: 6, drive: 1, turn: 60 },
            { kind: PERSON, name: 'Ma', wants: 'Run her inn', turn: 4 },
            { kind: PERSON, name: 'Ma', wants: 'Run her inn', turn: 60 },
        );
        const { text, index } = worldBlock({
            asks: worldAsks({ entities: table, turn: 60 }),
            nominations: nominationAsks({ entities: table, turn: 60 }),
        });
        expect(text).toContain('WHAT MOVED WHILE YOU WERE AWAY');
        expect(text).toContain('STANDING AGENDAS');
        expect(index.get('W1').name).toBe('Ada Wong');
        expect(index.get('N1').name).toBe('Ma');
    });

    /*
     * The absent section is what the model answered with invention.
     *
     * MEASURED over 1855 traced world fragments: with both sections on the page, 19 passes and ZERO
     * cross-filed ids. With the STANDING AGENDAS section absent, 13 of 69 passes answered
     * `nominations` anyway, 38 phantom answers, 20 inventing `N` ids and 18 copying the `W` ids
     * down. That is every world `unknown-id` on record, including all 16 in the live Wuxia chat.
     *
     * The array is `required` and the instruction describes both blocks on every pass, so a model
     * that cannot find a block it was told to answer answers it with the ids in front of it. The
     * cure is that the block is always there.
     */
    test('a section with no rows still prints, with the marker naming its empty array', () => {
        const { text } = posed();
        expect(text).toContain('STANDING AGENDAS, DOES THIS COMPLETE?');
        expect(text).toContain('WHAT MOVED WHILE YOU WERE AWAY');
        expect(text).toContain(`(${NO_LINES}, "advances" is [])`);
        expect(text).not.toContain('"nominations" is []');
    });

    test('the marker sits under the heading it belongs to, so the empty block reads as a block', () => {
        const table = cast({ kind: PERSON, name: 'Ada Wong', wants: 'find Ben', driveSize: 6, drive: 1, turn: 60 });
        const { text } = worldBlock({ asks: worldAsks({ entities: table, turn: 60 }) });
        expect(text).toContain(`STANDING AGENDAS, DOES THIS COMPLETE?\n  (${NO_LINES}, "nominations" is [])`);
        expect(text).toContain('W1 [drive 1/6] Ada Wong');
    });

    test('a marker never lands in the index, there is no id to answer', () => {
        // The whole point: the section is visible and unanswerable. If a marker ever earned an id
        // the model could quote it and `planNominations` would have to refuse that too.
        expect([...posed().index.keys()]).toEqual(['N1']);
    });

    test('with nothing on either side the probe is silent, no headings, no markers', () => {
        // 1765 of the 1855 traced passes. The markers are paid only where a question is asked.
        expect(worldBlock({}).text).toBe('');
        expect(worldBlock({}).index.size).toBe(0);
    });

    test('both the schema and the instruction grant the empty array to BOTH halves', () => {
        // The defect in one line: "use an empty array only when the block listed no lines" was
        // stated among the advance clauses, so `advances` had the permission and `nominations` did
        // not, and the phantom rate was 0 on one side and 13 of 69 passes on the other.
        const { advances, nominations } = schema().properties;
        expect(advances.description).toContain(NO_LINES);
        expect(nominations.description).toContain(NO_LINES);
        expect(instruction()).toContain(NO_LINES);
        expect(instruction()).toMatch(/answers into its OWN array/);
    });

    test('a judgement that the agenda completes carries its size', () => {
        const { index } = posed();
        const out = planNominations({ nominations: [{ id: 'N1', completes: true, steps: 6 }] }, { index });
        expect(out.rejected).toEqual([]);
        expect(out.accepted).toEqual([expect.objectContaining({ id: 'N1', completes: true, size: 6 })]);
        expect(out.accepted[0].key).toContain('ma');
    });

    test('a routine is ACCEPTED with no size, a negative verdict is a result', () => {
        // Recorded so the same shopkeeper stops being posed on every skip. The caller acts on
        // `size`, not on acceptance.
        const { index } = posed();
        const out = planNominations({ nominations: [{ id: 'N1', completes: false, steps: 0 }] }, { index });
        expect(out.rejected).toEqual([]);
        expect(out.accepted).toEqual([expect.objectContaining({ completes: false, size: 0 })]);
    });

    test('an oversized answer is clamped, not refused', () => {
        // Answering the question right and overshooting the scale is a different failure from a 0.
        const { index } = posed();
        const out = planNominations({ nominations: [{ id: 'N1', completes: true, steps: 400 }] }, { index });
        expect(out.accepted[0].size).toBe(MAX_DRIVE);
    });

    /*
     * An undersized answer is clamped too, and refusing it rotted the queue.
     *
     * Measured over 143 nomination answers on record: seven had `completes: true` with steps under
     * two, and all seven fall in THREE consecutive passes (mids 246, 248, 250) against slots
     * N1/N2/N3. That is not seven judgements, it is two or three rows asked over and over, a
     * refusal never reaches `entities.judgeDrive`, so `driveAsked` is never stamped and
     * `needsDriveJudgement` answers true again on the next armed pass, forever.
     */
    test('an undersized answer is clamped to the floor, the same way an oversized one is capped', () => {
        const { index } = posed();
        const out = planNominations({ nominations: [{ id: 'N1', completes: true, steps: 1 }] }, { index });
        expect(out.rejected).toEqual([]);
        expect(out.accepted[0]).toEqual(expect.objectContaining({ completes: true, size: MIN_DRIVE }));
    });

    test('"it completes" with no length at all is a contradiction, recorded as a routine', () => {
        // The schema spends 0 on "does not complete", so the two fields disagree. No drive is
        // invented out of that, but it IS recorded, which is what stops the row being re-asked for
        // the life of the campaign.
        const { index } = posed();
        const out = planNominations({ nominations: [{ id: 'N1', completes: true, steps: 0 }] }, { index });
        expect(out.rejected).toEqual([]);
        expect(out.accepted[0]).toEqual(expect.objectContaining({ completes: false, size: 0, contradictory: true }));
    });

    test('an invented id, and a `W` id answered as a nomination, are both refused', () => {
        // The prefix is what makes answering the wrong question detectable rather than plausible.
        const table = cast(
            { kind: PERSON, name: 'Ada Wong', wants: 'find Ben', driveSize: 6, turn: 60 },
            { kind: PERSON, name: 'Ma', wants: 'Run her inn', turn: 4 },
            { kind: PERSON, name: 'Ma', wants: 'Run her inn', turn: 60 },
        );
        const { index } = worldBlock({
            asks: worldAsks({ entities: table, turn: 60 }),
            nominations: nominationAsks({ entities: table, turn: 60 }),
        });
        const out = planNominations({ nominations: [
            { id: 'N9', completes: true, steps: 4 },
            { id: 'W1', completes: true, steps: 4 },
        ] }, { index });
        expect(out.accepted).toEqual([]);
        expect(out.rejected.map(r => r.reason)).toEqual(['unknown-id', 'unknown-id']);
    });

    test('a line answered twice counts once', () => {
        const { index } = posed();
        const out = planNominations({ nominations: [
            { id: 'N1', completes: true, steps: 4 },
            { id: 'N1', completes: true, steps: 9 },
        ] }, { index });
        expect(out.accepted).toHaveLength(1);
        expect(out.accepted[0].size).toBe(4);
        expect(out.rejected[0].reason).toBe('duplicate-id');
    });

    test('nothing is judged from an empty or absent fragment', () => {
        const { index } = posed();
        expect(planNominations(null, { index }).accepted).toEqual([]);
        expect(planNominations({ nominations: [] }, { index }).accepted).toEqual([]);
        expect(planNominations({ nominations: [] }, { index }).rejected).toEqual([]);
    });

    test('the advance half ignores nomination answers and vice versa', () => {
        // One index, two questions. `planWorld` reading an `N` line would advance a drive nobody
        // said had moved.
        const { index } = posed();
        expect(planWorld({ advances: [{ id: 'N1', tick: 1, what: 'x', where: '', seen: OPEN }] }, { index }).accepted).toEqual([]);
    });

    test('the schema and instruction ask for the judgement in the terms the corpus taught', () => {
        const shape = schema().properties.nominations.items.properties;
        expect(shape.completes.type).toBe('boolean');
        expect(shape.steps.type).toBe('integer');
        expect(schema().required).toContain('nominations');
        // `false` must read as the ordinary answer, or this regresses into reflexive zeros from the
        // other direction, a six-step drive on every shopkeeper.
        expect(instruction()).toMatch(/false is the ordinary answer/i);
        expect(instruction()).toMatch(/roles and conditions the actor MAINTAINS/);
        expect(instruction()).toMatch(/stops pursuing it/);
    });
});

/*
 * The player is not part of the world that moves while the player is away.
 *
 * The pov character's row is on the cast with a `wants` and, in the live corpus, a span of up to
 * 192 turns. Unfiltered it sorts near the front of both queues: the world turn would ask what the
 * player did off-screen, and the nomination half would judge the protagonist's own quest, which is
 * the most quest-shaped string on the cast, and then start advancing it without them.
 */
describe('both queues skip the point-of-view character', () => {
    const players = () => cast(
        { kind: PERSON, name: 'Solomon', aka: 'the Hero', wants: 'find out what happened', driveSize: 6, turn: 4 },
        { kind: PERSON, name: 'Solomon', aka: 'the Hero', wants: 'find out what happened', driveSize: 6, turn: 140 },
        { kind: PERSON, name: 'Ada Wong', wants: 'find Ben Bertolucci', driveSize: 4, turn: 4 },
        { kind: PERSON, name: 'Ada Wong', wants: 'find Ben Bertolucci', driveSize: 4, turn: 140 },
    );

    test('with no pov given, both rows are asked about, the defect, pinned', () => {
        const names = worldAsks({ entities: players(), turn: 140 }).map(ask => ask.name);
        expect(names).toEqual(expect.arrayContaining(['Solomon', 'Ada Wong']));
    });

    test('naming the pov removes exactly that row', () => {
        const names = worldAsks({ entities: players(), turn: 140, pov: 'Solomon' }).map(ask => ask.name);
        expect(names).toEqual(['Ada Wong']);
    });

    test('matched on the canonical key, so the persona casing does not decide it', () => {
        expect(worldAsks({ entities: players(), turn: 140, pov: '  solomon ' }).map(a => a.name)).toEqual(['Ada Wong']);
    });

    test('and on the aliases, because the pov row is the one most likely to have collected them', () => {
        expect(worldAsks({ entities: players(), turn: 140, pov: 'the Hero' }).map(a => a.name)).toEqual(['Ada Wong']);
    });

    test('a pov nobody on the cast answers to removes nothing', () => {
        expect(worldAsks({ entities: players(), turn: 140, pov: 'Jill Valentine' })).toHaveLength(2);
    });

    test('the nomination queue skips the pov too, on the same match', () => {
        const unjudged = cast(
            { kind: PERSON, name: 'Solomon', aka: 'the Hero', wants: 'find out what happened', turn: 4 },
            { kind: PERSON, name: 'Solomon', aka: 'the Hero', wants: 'find out what happened', turn: 140 },
            { kind: PERSON, name: 'Ada Wong', wants: 'find Ben Bertolucci', turn: 4 },
            { kind: PERSON, name: 'Ada Wong', wants: 'find Ben Bertolucci', turn: 140 },
        );
        expect(nominationAsks({ entities: unjudged, turn: 140 }).map(a => a.name).sort())
            .toEqual(['Ada Wong', 'Solomon']);
        expect(nominationAsks({ entities: unjudged, turn: 140, pov: 'the Hero' }).map(a => a.name))
            .toEqual(['Ada Wong']);
    });

    test('the ids renumber around the removal, which is why both rebuilds need the same pov', () => {
        // `world.js` renders the block from one call and resolves the answered ids from a second.
        // Filter one and not the other and `W1` names a different row coming back than it did going
        // out, every answer past the player's row lands on its neighbour.
        //
        // Solomon is stale here and Ada is fresh, so the queue's most-neglected-first ordering puts
        // the player FIRST, which is the live shape, since the pov's own row is refreshed by the
        // scene rather than by being sighted.
        const queue = () => cast(
            { kind: PERSON, name: 'Solomon', wants: 'find out what happened', driveSize: 6, turn: 4 },
            { kind: PERSON, name: 'Solomon', wants: 'find out what happened', driveSize: 6, turn: 100 },
            { kind: PERSON, name: 'Ada Wong', wants: 'find Ben Bertolucci', driveSize: 4, turn: 4 },
            { kind: PERSON, name: 'Ada Wong', wants: 'find Ben Bertolucci', driveSize: 4, turn: 140 },
        );
        const posedWith = worldBlock({ asks: worldAsks({ entities: queue(), turn: 140, pov: 'Solomon' }) });
        const unfiltered = worldBlock({ asks: worldAsks({ entities: queue(), turn: 140 }) });
        expect(unfiltered.index.get('W1').name).toBe('Solomon');
        expect(posedWith.index.get('W1').name).toBe('Ada Wong');
        expect(unfiltered.index.get('W1').key).not.toBe(posedWith.index.get('W1').key);
    });
});

/*
 * The two halves of the size read have to be the same read.
 *
 * `worldAsks` poses a line from `stored || driveOf(row)`; `entities.advanceDrive` is what actually
 * moves the position when the model answers it, and it read `Number(row?.driveSize) || 0`. With the
 * stored field at 0 on all 165 live cast rows, that disagreement is silent in the worst direction:
 * the block poses the line, the model ticks it, `planWorld` accepts it, `world.js` writes the
 * chronicle event, and then `advanceDrive` returns null because the row has no stored size. The
 * record would hold a summary with no state under it, which is exactly the failure the drive exists
 * to end, and `world:ticked` would sit at zero looking like a model that never answers.
 *
 * `advanceDrive` lives in an app-coupled module this suite cannot import (`entities.js` reaches
 * `store.js` and `script.js`), so the agreement is pinned by reading the source. A weaker test than
 * calling it, and much stronger than nothing: the whole class here is two expressions that used to
 * match and quietly stopped.
 */
describe('the world turn advances what it asked about', () => {
    const source = name => fs.readFileSync(
        path.join(process.cwd(), '..', 'public', 'scripts', 'extensions', 'sanguine', name), 'utf8');

    test('`advanceDrive` reads the size exactly as `worldAsks` does', () => {
        // Both read the stored field and nothing else. They were briefly allowed to differ, one
        // deriving, one not, and that disagreement is silent in the worst direction: the block
        // poses a line, the model ticks it, the chronicle event is written, and the position never
        // moves.
        const advance = source('entities.js').split('export function advanceDrive')[1].split('\n}')[0];
        expect(advance).toMatch(/const size = Number\(row\?\.driveSize\) \|\| 0;/);
        expect(advance).not.toMatch(/driveOf/);
    });

    test('and an advance does not author a size, only `judgeDrive` does', () => {
        // `advanceDrive` briefly stamped a derived size to freeze it. There is no derived size to
        // freeze now, and a tick that could invent a length would be the world turn deciding an
        // agenda exists on the strength of having advanced it.
        const advance = source('entities.js').split('export function advanceDrive')[1].split('\n}')[0];
        expect(advance).not.toMatch(/driveSize:/);
    });

    test('`judgeDrive` records the question even when the answer is "this is a routine"', () => {
        // Without an unconditional `driveAsked`, a `false` verdict is forgotten and the same
        // shopkeeper is re-posed on every time skip for the life of the campaign.
        const judge = source('entities.js').split('export function judgeDrive')[1].split('\n}')[0];
        expect(judge).toMatch(/driveAsked: asked,/);
        expect(judge).toMatch(/steps > 0 \? \{ driveSize:/);
    });

    test('and `world.js` threads one pov through both rebuilds', () => {
        // Pose the block with a pov and resolve the answers without one, and every id past the
        // player's row addresses its neighbour.
        const world = source('world.js');
        expect(world).toMatch(/export function context\(pov = ''\)/);
        expect(world.split('export function context')[1]).toMatch(/worldAsks\(\{[^}]*pov[^}]*\}\)/);
        expect(world.split('export function applyExtraction')[1]).toMatch(/worldAsks\(\{[^}]*pov[^}]*\}\)/);
    });

    test('and the entity probe no longer asks for a size it cannot know', () => {
        // 0 in 288 of 288 traced proposals. The schema is strict, so the property and its `required`
        // entry are one edit, dropping either alone fails the whole shared call for every probe.
        const entities = source('entities.js');
        expect(entities).not.toMatch(/^\s*drive_size: \{/m);
        expect(entities).not.toMatch(/'drive_size'/);
    });
});

/*
 * The index the model was shown is the index its answer is read against.
 *
 * `world.applyExtraction` used to rebuild the ask list from the live tables and trust `worldAsks`
 * to be deterministic across the round trip. Deterministic over the SAME inputs it is; the inputs
 * are what move.
 *
 *   · The turn. `context()` orders by `entities.turn()`; `extract.js:587` runs
 *     `const turn = entities.advanceTurn()` AFTER the model call and hands that to every `apply`.
 *     Actor age is `turn - row.turn` and thread age is `thread.stale`, which does not move with the
 *     turn: so the +1 lifts actors past threads they were tied with.
 *   · The table. The cast probe is registered before the world probe (`index.js`), so
 *     `entities.applyExtraction` has folded this pass's sightings first; `merge_entity` last-writes
 *     `turn`, resetting a sighted row's age to 0, and a widened `agendaSpan` can add rows to
 *     `nominationAsks` that were not posed.
 *
 * A shifted index refuses nothing, every id still resolves, so the tick lands on the neighbouring
 * actor in silence. That is worse than the `unknown-id` this probe was being blamed for. These pin
 * the hazard so it cannot come back as "just rebuild it, it is deterministic".
 */
describe('worldAsks is stable over its inputs and only over its inputs', () => {
    // A thread's age is `stale` and an actor's is `turn - row.turn`. Ada is 5 turns unseen at turn
    // 60 and 6 at turn 61, so the two fixtures below straddle her from opposite sides, which is
    // the whole point: the two ages are measured in different units against the same sort.
    const siege = (stale = 5) => ({
        key: 'the siege tightens', name: 'the siege tightens', about: 'the wall holds',
        kind: 'threat', filled: 2, size: 6, stale, seen: 'open', turn: 3,
    });
    const mixed = (stale = 5) => ({
        entities: cast(
            { kind: PERSON, name: 'Ada Wong', wants: 'find Ben', driveSize: 6, drive: 1, turn: 55 },
            { kind: FACTION, name: '万通商行', wants: 'corner the pill trade', driveSize: 6, drive: 2, turn: 52 },
        ),
        threads: [siege(stale)],
    });

    test('two calls with identical inputs give identical ids, the easy half', () => {
        const input = { ...mixed(), turn: 60, pov: 'Solomon' };
        const first = worldBlock({ asks: worldAsks(input), nominations: nominationAsks(input) });
        const second = worldBlock({ asks: worldAsks(input), nominations: nominationAsks(input) });
        expect(second.text).toBe(first.text);
        expect([...second.index].map(([id, ask]) => [id, ask.key]))
            .toEqual([...first.index].map(([id, ask]) => [id, ask.key]));
    });

    test('advance the turn by one and the ids name different rows, the defect, pinned', () => {
        // Actor age moves with the turn and thread age does not, so one increment re-sorts a mixed
        // queue. This is exactly the increment `extract.js` performs between pose and apply: the
        // siege outranks Ada by 6 to 5 when the block is posed and ties her at 6 when the answer is
        // read back, where the name tiebreak puts her first. W2 and W3 swap rows.
        const input = mixed(6);
        const at = turn => worldAsks({ ...input, turn }).map(ask => ask.name);
        expect(at(60).indexOf('the siege tightens')).toBeLessThan(at(60).indexOf('Ada Wong'));
        expect(at(61).indexOf('the siege tightens')).toBeGreaterThan(at(61).indexOf('Ada Wong'));
        expect(at(60)).not.toEqual(at(61));
    });

    test('and folding this pass sighting resets a row age, moving it to the back', () => {
        // What `entities.applyExtraction` does to the table before the world probe reads it.
        const input = mixed();
        const before = worldAsks({ ...input, turn: 60 }).map(ask => ask.key);
        const after = cast(
            { kind: PERSON, name: 'Ada Wong', wants: 'find Ben', driveSize: 6, drive: 1, turn: 55 },
            { kind: FACTION, name: '万通商行', wants: 'corner the pill trade', driveSize: 6, drive: 2, turn: 52 },
            { kind: PERSON, name: 'Ada Wong', wants: 'find Ben', driveSize: 6, drive: 1, turn: 60 },
        );
        const names = worldAsks({ entities: after, threads: [siege()], turn: 60 }).map(ask => ask.key);
        expect(names).not.toEqual(before);
    });

    test('so world.js holds the posed index instead of rebuilding it', () => {
        const world = fs.readFileSync(
            path.join(process.cwd(), '..', 'public', 'scripts', 'extensions', 'sanguine', 'world.js'), 'utf8');
        // Stashed by the call that rendered the block…
        expect(world.split('export function context')[1].split('\n}')[0]).toMatch(/posed = \{ index/);
        // …and read by the call that resolves the answers, before any rebuild.
        const apply = world.split('export function applyExtraction')[1];
        expect(apply).toMatch(/let index = posed\?\.index;/);
        expect(apply.indexOf('posed?.index')).toBeLessThan(apply.indexOf('worldAsks('));
    });
});

/*
 * Both plan halves refuse the other's ids, and that gate is not what was broken.
 *
 * It refused 16 answers in the live Wuxia chat, 31% of that chat's refusals, and all 16 were
 * phantoms from passes that posed no nomination rows. There is nothing there to recover, so the
 * gate stays exactly this strict while the block upstream stops provoking it.
 */
describe('an answer filed into the wrong array is refused, both directions', () => {
    const both = () => {
        const table = cast(
            { kind: PERSON, name: 'Ada Wong', wants: 'find Ben', driveSize: 6, drive: 1, turn: 60 },
            { kind: PERSON, name: 'Ma', wants: 'Run her inn', turn: 4 },
            { kind: PERSON, name: 'Ma', wants: 'Run her inn', turn: 60 },
        );
        return worldBlock({
            asks: worldAsks({ entities: table, turn: 60 }),
            nominations: nominationAsks({ entities: table, turn: 60 }),
        });
    };

    test('an advance quoting an N id ticks nothing', () => {
        // Taking it would advance a drive on the strength of a judgement about whether that drive
        // should exist at all.
        const { index } = both();
        const out = planWorld({ advances: [{ id: 'N1', tick: 1, what: 'ran two raids', where: '', seen: OPEN }] }, { index });
        expect(out.accepted).toEqual([]);
        expect(out.rejected.map(r => r.reason)).toEqual(['unknown-id']);
    });

    test('a nomination quoting a W id sizes nothing', () => {
        const { index } = both();
        const out = planNominations({ nominations: [{ id: 'W1', completes: true, steps: 6 }] }, { index });
        expect(out.accepted).toEqual([]);
        expect(out.rejected.map(r => r.reason)).toEqual(['unknown-id']);
    });

    test('the exact phantom shapes the corpus produced are all refused', () => {
        // 20 invented `N` ids and 18 copied `W` ids across 13 passes, every one on a pass that
        // posed no nomination rows at all. Reproduced against a block whose nomination half is the
        // printed marker rather than absent, which is the shape the model now sees.
        const table = cast({ kind: PERSON, name: 'Ada Wong', wants: 'find Ben', driveSize: 6, drive: 1, turn: 60 });
        const { text, index } = worldBlock({ asks: worldAsks({ entities: table, turn: 60 }) });
        expect(text).toContain(`(${NO_LINES}, "nominations" is [])`);
        const out = planNominations({ nominations: [
            { id: 'N1', completes: false, steps: 0 },
            { id: 'W1', completes: true, steps: 3 },
        ] }, { index });
        expect(out.accepted).toEqual([]);
        expect(out.rejected.map(r => r.reason)).toEqual(['unknown-id', 'unknown-id']);
    });
});
