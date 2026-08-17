import { describe, expect, test } from '@jest/globals';

import { FACTION, PERSON, foldEntity } from '../public/scripts/extensions/fold/entity-table.js';
import { HIDDEN, OPEN } from '../public/scripts/extensions/fold/thread-table.js';
import {
    MAX_WORLD_ASKS,
    MAX_WORLD_TICK,
    instruction,
    planWorld,
    renderWorldEvents,
    revealContract,
    schema,
    worldAsks,
    worldBlock,
} from '../public/scripts/extensions/fold/world-table.js';

/*
 * The off-screen world-turn: on a pass triggered by a declared time skip or scene break, the model
 * is asked which standing agendas advanced, and how. Each move must name a cast row fold already
 * tracks — the probe advances the world it knows about, never authors a new one. FOLD-REDESIGN.md
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
     * ── The measurement that replaced an invitation with a list ──
     *
     * A completed Xianxia campaign armed this probe 107 times on real elapsed spans. It returned an
     * empty `moves` array 107 times, with ZERO rejections — nothing was ever proposed for a gate to
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

    test('a tick beyond the cap is clamped — one step per span', () => {
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

    test('the queue drains — the most neglected agendas are asked first', () => {
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
 * know. A hidden world event whose place is not the current scene renders NAMED but unquantified —
 * `(off-screen: Kang Min-seo)` — and locality flips it to a full assertion when the scene reaches
 * its `where`. This is Gate 4 of Phase W.
 */
function worldEvent(src, who, what, where, seen, at) {
    return {
        src,
        s: `${who} ${what}`,
        d: { world: { who, where, seen } },
    };
}

describe('world reveal contract — discovery, not bulletins', () => {
    test('an open event is asserted in full', () => {
        const events = [worldEvent('world', 'Kang Min-seo', 'ran two D-rank raids', 'Eunpyeong', OPEN, 'Eunpyeong')];
        expect(renderWorldEvents(events, 'Seoul')).toContain('Kang Min-seo ran two D-rank raids');
    });

    test('a hidden event away from its place is named, never asserted', () => {
        // The content ("ran two D-rank raids") must NOT appear — the character could not know it.
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
        // narrator through `renderWorldEvents`, and — deliberately — still ticks. `seen` governs
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
