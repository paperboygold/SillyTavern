import { describe, expect, test } from '@jest/globals';

import { FACTION, PERSON, foldEntity } from '../public/scripts/extensions/fold/entity-table.js';
import { HIDDEN, OPEN } from '../public/scripts/extensions/fold/thread-table.js';
import {
    instruction,
    planWorld,
    renderWorldEvents,
    revealContract,
    schema,
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

describe('world probe — rooted moves only', () => {
    test('a move naming a tracked person is accepted, rooted at their key', () => {
        const entities = cast({ kind: PERSON, name: 'Kang Min-seo', wants: 'run profitable D-rank raids and bring her team home alive' });
        const out = planWorld(
            { moves: [{ who: 'Kang Min-seo', what: 'ran two D-rank raids', where: 'Eunpyeong', seen: OPEN }] },
            { entities },
        );
        expect(out.accepted).toHaveLength(1);
        expect(out.accepted[0].what).toBe('ran two D-rank raids');
        expect(out.accepted[0].seen).toBe(OPEN);
        expect(out.accepted[0].root).toContain('kang');
    });

    test('a move naming nobody tracked is refused as unrooted', () => {
        // The model may ADVANCE the world fold knows about, never AUTHOR a new one. A move citing no
        // cast row is the one thing this probe exists to stop (§7 anti-pattern: "rule hallucination").
        const entities = cast({ kind: PERSON, name: 'Kang Min-seo', wants: '...' });
        const out = planWorld(
            { moves: [{ who: 'a stranger', what: 'did something', where: '', seen: HIDDEN }] },
            { entities },
        );
        expect(out.accepted).toEqual([]);
        expect(out.rejected[0].reason).toBe('unrooted-move');
    });

    test('a move naming a tracked faction is accepted', () => {
        // `faction` is the third kind on the product key (§7.3) — White Tiger is an org, not a person.
        const entities = cast({ kind: FACTION, name: 'White Tiger', wants: 'expand its roster' });
        const out = planWorld(
            { moves: [{ who: 'White Tiger', what: 'recruited two C-ranks', where: '', seen: HIDDEN }] },
            { entities },
        );
        expect(out.accepted).toHaveLength(1);
    });

    test('a rooted move and an unrooted move in one pass split correctly', () => {
        const entities = cast(
            { kind: PERSON, name: 'Kang Min-seo', wants: 'run D-rank raids' },
            { kind: PERSON, name: 'Jin-Woo', wants: 'cover the bills' },
        );
        const out = planWorld(
            { moves: [
                { who: 'Kang Min-seo', what: 'ran a raid', where: '', seen: OPEN },
                { who: 'Jin-Woo', what: 'raided a gate', where: '', seen: OPEN },
                { who: 'the monster', what: 'stirred', where: '', seen: HIDDEN },
            ] },
            { entities },
        );
        expect(out.accepted).toHaveLength(2);
        expect(out.rejected).toHaveLength(1);
        expect(out.rejected[0].reason).toBe('unrooted-move');
    });

    test('a move missing who or what is no-change', () => {
        const entities = cast({ kind: PERSON, name: 'Kang Min-seo' });
        const out = planWorld(
            { moves: [
                { who: '', what: 'x', where: '', seen: OPEN },
                { who: 'Kang Min-seo', what: '', where: '', seen: OPEN },
            ] },
            { entities },
        );
        expect(out.accepted).toEqual([]);
        expect(out.rejected.every(r => r.reason === 'no-change')).toBe(true);
    });

    test('seen defaults to open unless the probe marks it hidden', () => {
        // The honest default for an off-screen event is hidden — but `apply` honours what the probe
        // returns, and `planWorld` keeps HIDDEN only when explicitly asserted (§7.5 reveal contract).
        const entities = cast({ kind: PERSON, name: 'Jin-Woo' });
        const hidden = planWorld({ moves: [{ who: 'Jin-Woo', what: 'raided', where: '', seen: HIDDEN }] }, { entities });
        expect(hidden.accepted[0].seen).toBe(HIDDEN);
        const defaulted = planWorld({ moves: [{ who: 'Jin-Woo', what: 'raided', where: '' }] }, { entities });
        expect(defaulted.accepted[0].seen).toBe(OPEN);
    });

    test('a missing or empty fragment accepts nothing and rejects nothing', () => {
        const empty = new Map();
        expect(planWorld(null, { entities: empty }).accepted).toEqual([]);
        expect(planWorld({ moves: [] }, { entities: empty }).accepted).toEqual([]);
        expect(planWorld({ moves: [] }, { entities: empty }).rejected).toEqual([]);
    });

    test('schema and instruction are present, and the instruction names the cast constraint', () => {
        expect(schema().properties.moves).toBeTruthy();
        // The cast constraint is the load-bearing rule; the prompt must state it, not hope it.
        expect(instruction()).toMatch(/cast above/i);
        expect(instruction()).toMatch(/never invent a new actor/i);
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
