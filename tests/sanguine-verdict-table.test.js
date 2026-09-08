import { describe, expect, test } from '@jest/globals';

import {
    AGAINST_GRAIN,
    BESIDE_GRAIN,
    CLEAR,
    CONTROLLED,
    GRAINS,
    STANDARD,
    WITH_GRAIN,
    COST,
    DESPERATE,
    EFFECTS,
    GREAT,
    LIMITED,
    POSITIONS,
    RISKY,
    FAILED,
    SETBACK,
    UNTRIED,
    WORKED,
    adjudicate,
    matchThread,
    harmSteps,
    precedentFor,
    renderVerdict,
    standingRange,
} from '../public/scripts/extensions/sanguine/verdict-table.js';

/*
 * Phase E, the judge plays. Two bodies of work: a SETBACK no longer ticks a random clock (it ticks
 * the thread the attempt was actually about, or none), and the bands are deterministic arithmetic on
 * the standing the classifier returns, so the §6 fixtures can be asserted offline, without a model.
 */
describe('matchThread, a setback ticks the thread it was about', () => {
    // The `snapshot` shape: flat filled/size/kind plus name/about/detail.
    const dials = [
        { name: 'the residency window closes', about: 'twelve months pass with fewer than twenty raids logged', filled: 1, size: 8, kind: 'doom' },
        { name: 'Kang\'s standing offer', detail: 'they run D-rank raids almost daily', filled: 2, size: 6, kind: 'doom' },
        { name: 'the missing hunter in Busan', filled: 0, size: 6, kind: 'doom' },
    ];

    test('keywords pick the thread they describe', () => {
        const hit = matchThread(dials, { keywords: ['busan'], against: '' });
        expect(hit?.name).toBe('the missing hunter in Busan');
    });

    test('the against name outweighs an ordinary keyword', () => {
        // "Kang" appears only in Kang's own thread; the weight lifts it over the residency window
        // even though both share the "raids" keyword.
        const hit = matchThread(dials, { keywords: ['raids'], against: 'kang' });
        expect(hit?.name).toBe('Kang\'s standing offer');
    });

    test('no match returns null, a mis-aimed tick is worse than none', () => {
        expect(matchThread(dials, { keywords: ['cooking', 'noodles'], against: '' })).toBeNull();
    });

    test('a full dial is never the victim', () => {
        const full = [{ name: 'the doom done', filled: 6, size: 6, kind: 'doom' }, ...dials];
        const hit = matchThread(full, { keywords: ['busan'], against: '' });
        expect(hit?.name).toBe('the missing hunter in Busan');
        expect(hit?.name).not.toBe('the doom done');
    });

    test('empty inputs return null', () => {
        expect(matchThread([], { keywords: [], against: '' })).toBeNull();
        expect(matchThread(null, {})).toBeNull();
    });
});

describe('the bands on the fixtures §6 names', () => {
    test('the mid-35 leap, an E-rank with a wounded calf vaults a rank of goblins, is not CLEAR', () => {
        // Nothing on record makes vaulting a charging rank possible, the goblins resist, and the
        // leap ignores a wound the ledger carries: opposed-and-reckless, exactly the §6 example.
        const verdict = adjudicate(
            { supported: false, opposed: true, reckless: true, keywords: ['vault', 'goblins'] },
            { momentum: 0, hurt: 1, precedent: 'untried' },
        );
        expect(verdict.band).not.toBe(CLEAR);
        expect(verdict.band).toBe(SETBACK);
    });

    test('the crate-kill, supported by the crate, opposed by the goblin, is not CLEAR', () => {
        // The crate is on record (support), but the goblin resists: the interval straddles, so the
        // partial band is the third action, it works, and it costs something.
        const verdict = adjudicate(
            { supported: true, opposed: true, reckless: false, keywords: ['crush', 'crate'] },
            { momentum: 0, hurt: 0, precedent: 'untried' },
        );
        expect(verdict.band).not.toBe(CLEAR);
        expect(verdict.band).toBe(COST);
    });

    test('an unopposed, supported, uncomplicated action clears', () => {
        const verdict = adjudicate(
            { supported: true, opposed: false, reckless: false, keywords: ['pick up'] },
            { momentum: 0, hurt: 0, precedent: 'untried' },
        );
        expect(verdict.band).toBe(CLEAR);
    });

    test('precedent on record moves the interval, worked before lifts, failed before sinks', () => {
        const worked = standingRange(
            { supported: false, opposed: true, reckless: false },
            { momentum: 0, hurt: 0, precedent: 'worked' },
        );
        const failed = standingRange(
            { supported: false, opposed: true, reckless: false },
            { momentum: 0, hurt: 0, precedent: 'failed' },
        );
        expect(worked.lo).toBeGreaterThan(failed.lo);
    });

    test('precedentFor reads recorded outcomes, never the summary\'s English', () => {
        // The chronicle's summaries are model-written prose; a past attempt's result is decided in
        // code and recorded as `d.outcome` (chronicle.recordVerdictEvent). The old path regex-matched
        // "fail|refused|could not" against the summary, the same language-dependent guess the clock
        // used to make. Only the structured outcome counts now.
        const events = new Map([
            ['a', { kw: ['vault', 'goblins'], s: 'The hero vaulted the rank of goblins.', d: { outcome: 'worked' } }],
            ['b', { kw: ['vault', 'goblins'], s: 'Another goblin rank repulsed the attempt.', d: { outcome: 'failed' } }],
            // Overlapping keywords but no recorded outcome: no vote, whatever the summary says.
            ['c', { kw: ['vault', 'goblins'], s: 'The vault was refused outright and utterly lost.' }],
            ['d', { kw: ['vault', 'goblins'], s: 'The second rank threw them back.', d: { outcome: 'failed' } }],
        ]);
        expect(precedentFor(events, ['vault', 'goblins'])).toBe(FAILED);
        // A summary that LOOKS like a failure but was never adjudicated contributes nothing.
        expect(precedentFor(new Map([['c', events.get('c')]]), ['vault', 'goblins'])).toBe(UNTRIED);
        // One clean worked, nothing failed.
        expect(precedentFor(new Map([['a', events.get('a')]]), ['vault', 'goblins'])).toBe(WORKED);
        // No keyword overlap at all.
        expect(precedentFor(events, ['bargain', 'market'])).toBe(UNTRIED);
    });
});

describe('the two axes: there is no state from which nothing can be attempted', () => {
    // The spiral this replaces.
    //
    // MEASURED, live Wuxia World RPG at 57 messages: 16 adjudicated attempts, 1 clear, 11 cost,
    // 4 setback, the last four consecutive, against the same boar. Standing `[-8, -6]` against a
    // `SETBACK_AT` of -2, from "actively opposed; carrying 5 injuries; this has failed before".
    // Six points underwater with a maximum reachable bonus of +4. Momentum sat at -6, the floor.
    //
    // Asked for a failure every turn, the narrator ran out of plausible ones and buried the
    // player's legs under rubble in the middle of a boar fight.
    //
    // Blades' rule is that position and effect are separate, and the roll decides what an attempt
    // COSTS and how much it GETS, never whether anything happens. These pin that.

    const brutal = {
        attempt: { opposed: true, reckless: true, supported: false },
        standing: { hurt: 99, momentum: -6, regard: 0, precedent: 'failed' },
    };

    test('the worst input reachable still accomplishes something', () => {
        const v = adjudicate(brutal.attempt, brutal.standing);
        expect(EFFECTS).toContain(v.effect);
        expect(POSITIONS).toContain(v.position);
        // `limited` is a foothold, not a refusal. There is no fourth, emptier value.
        expect(v.effect).toBe(LIMITED);
        expect(v.position).toBe(DESPERATE);
    });

    test('and its directive tells the narrator what LANDS, never that it failed', () => {
        const text = renderVerdict(adjudicate(brutal.attempt, brutal.standing), 'kick the boar\'s legs out');
        expect(text).toContain('accomplishes only PART');
        expect(text).not.toMatch(/FAILS|not working/);
        // The rubble clause. A desperate cost must come from the scene, not from invention.
        expect(text).toContain('Never invent a new hazard that was not already present');
    });

    test('harm saturates instead of accumulating without bound', () => {
        // `hurtOf` has no ceiling and reached 5 live. Blades harm has three levels and stops.
        expect(harmSteps(0)).toBe(0);
        expect(harmSteps(3)).toBe(1);
        expect(harmSteps(4)).toBe(2);
        expect(harmSteps(99)).toBe(2);
        // So a fifth wound cannot make an attempt worse than a fourth one did.
        const four = adjudicate({ opposed: true }, { hurt: 4, momentum: 0 });
        const many = adjudicate({ opposed: true }, { hurt: 40, momentum: 0 });
        expect(many).toMatchObject({ position: four.position, effect: four.effect });
    });

    test('momentum is spent, never drained, the floor stops being an attractor', () => {
        // The old rule took 2 on every setback and gave 1 only on a clear, and the clear was the
        // thing injuries made unreachable. A bad outcome must not deepen the hole.
        const bad = adjudicate({ opposed: true, reckless: true }, { hurt: 5, momentum: 0 });
        expect(bad.momentum).toBe(0);
        const worse = adjudicate({ opposed: true, reckless: true }, { hurt: 5, momentum: -6 });
        expect(worse.momentum).toBe(-6);
    });

    test('banked standing buys back the worst step, and says it did', () => {
        // Badly hurt and fighting: exposure 2, which is desperate. Standing pays one step of it.
        const withOut = adjudicate({ opposed: true }, { hurt: 5, momentum: 0 });
        const withIn = adjudicate({ opposed: true }, { hurt: 5, momentum: 6 });
        expect(withOut.position).toBe(DESPERATE);
        expect(withIn.position).toBe(RISKY);
        expect(withIn.why.join(' ')).toContain('standing earned earlier');
        // Spent, not free: the resist deducts what it used.
        expect(withIn.momentum).toBe(3);
    });

    test('one step of resist does not rescue a genuinely reckless act', () => {
        // Opposed AND reckless is exposure 3. Resistance in Blades reduces a consequence; it does
        // not talk you out of the position you put yourself in.
        const v = adjudicate({ opposed: true, reckless: true }, { hurt: 0, momentum: 10 });
        expect(v.position).toBe(DESPERATE);
    });

    test('being hurt costs EFFECT first and exposure only when it is serious', () => {
        // Blades harm reduces what you accomplish. A character with scratches is not thereby in a
        // desperate spot, that was the conflation that made every wound a step toward failure.
        const scratched = adjudicate({ opposed: true }, { hurt: 1, momentum: 0 });
        expect(scratched.position).toBe(RISKY);
        expect(scratched.effect).toBe(LIMITED);
        const mauled = adjudicate({ opposed: true }, { hurt: 5, momentum: 0 });
        expect(mauled.position).toBe(DESPERATE);
    });

    test('an uninjured, supported, proven action is still clean and free', () => {
        // The other end has to stay intact: a tracker that taxes walking across a room is grinding.
        const v = adjudicate({ supported: true }, { hurt: 0, momentum: 0, precedent: 'worked' });
        expect(v.position).toBe(CONTROLLED);
        expect(v.effect).toBe(GREAT);
        expect(renderVerdict(v, 'open the door')).toContain('costs nothing');
    });
});

describe('`wants` is an adjudication axis, the question a social contest turns on', () => {
    // Why disposition alone was the wrong question.
    //
    // Standing read `feels` and nothing else, so the only social fact that could move a verdict was
    // whether somebody LIKED you. That is not how negotiation works: a merchant who dislikes you
    // will still sell you a horse, and a friend will still refuse to hand over his brother. What
    // decides it is whether the ask runs with or against what that person is already chasing.
    //
    // `wants` is on every cast row and in the prompt the classifier reads, so this is a reading
    // over fold's own state answered through a schema enum, never a word list on prose.

    test('running with what they want lifts what you get', () => {
        const beside = adjudicate({ grain: BESIDE_GRAIN }, { hurt: 0, momentum: 0 });
        const with_ = adjudicate({ grain: WITH_GRAIN }, { hurt: 0, momentum: 0 });
        expect(beside.effect).toBe(STANDARD);
        expect(with_.effect).toBe(GREAT);
        expect(with_.why.join(' ')).toContain('runs with what they want');
    });

    test('cutting against it exposes you, whatever they think of you', () => {
        const against = adjudicate({ grain: AGAINST_GRAIN }, { hurt: 0, momentum: 0 });
        expect(against.position).toBe(RISKY);
        expect(against.why.join(' ')).toContain('cuts against what they want');
    });

    test('a friendly person still costs you when the ask takes what they want', () => {
        // `feels: devoted` is regard 4, which improves position by one; running against their want
        // takes it back. Being liked is not the same as being willing.
        const liked = adjudicate({ grain: BESIDE_GRAIN }, { hurt: 0, momentum: 0, regard: 4 });
        const askedTooMuch = adjudicate({ grain: AGAINST_GRAIN }, { hurt: 0, momentum: 0, regard: 4 });
        expect(liked.position).toBe(CONTROLLED);
        expect(askedTooMuch.position).toBe(CONTROLLED);
        // …and a merely neutral one is exposed by the same ask.
        expect(adjudicate({ grain: AGAINST_GRAIN }, { hurt: 0, momentum: 0, regard: 2 }).position).toBe(RISKY);
    });

    test('beside the grain is inert, which is the usual answer', () => {
        const plain = adjudicate({}, { hurt: 0, momentum: 0 });
        const beside = adjudicate({ grain: BESIDE_GRAIN }, { hurt: 0, momentum: 0 });
        expect(beside).toMatchObject({ position: plain.position, effect: plain.effect });
    });

    test('every grain the schema offers is a grain the adjudicator reads', () => {
        // A schema enum the engine ignores is a field that costs tokens and does nothing.
        for (const grain of GRAINS) {
            expect(() => adjudicate({ grain }, { hurt: 0, momentum: 0 })).not.toThrow();
        }
        const [w, a, b] = GRAINS.map(grain => adjudicate({ grain }, { hurt: 0, momentum: 0 }));
        expect(w.effect).not.toBe(b.effect);
        expect(a.position).not.toBe(b.position);
    });
});
