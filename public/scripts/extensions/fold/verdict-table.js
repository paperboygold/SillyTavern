/**
 * fold/verdict-table.js — deciding how an attempt goes, before anything narrates it.
 *
 * Pure, imports only ./lib/hash.js. Unit-testable.
 *
 * ── Why this exists, and why it is CODE ──
 *
 * Ask a language model whether the player succeeded and it will usually say yes. That is not a
 * prompt problem to be argued away: sycophancy is a training artefact, models have been observed
 * deliberately fudging outcomes because "bending rules keeps players entertained", and — the part
 * that settles the design — it gets WORSE as context grows. So "be a strict game master" decays
 * exactly when a long campaign needs it most. Every system that solved this put the decision
 * outside the model.
 *
 * The usual way to put it outside is dice. Dice are one way; they are not the mechanism. **The
 * mechanism is the ordering.** The outcome is decided first and handed over as a verdict the
 * narrator must honour, and the model is never asked "did this work?" — it is asked to narrate a
 * result it was given. That is `papers/RPG-Engine-Design.md:79-86` applied to play: pinch the
 * probabilistic model between oracles so it solves a constrained problem instead of guessing.
 *
 * Here the oracle is **precedent** — what this world has already established about difficulty,
 * about who is capable of what, and about who owes whom.
 *
 * ── Three bands, and why none of them is "nothing happens" ──
 *
 * PbtA's shape, because it is the one designed for a narrator rather than a simulator: one
 * decision, three outcomes, and the consequences pre-authored so the partial band is a licence to
 * make the situation worse rather than a request for another roll.
 *
 *   CLEAR    it works. Say so and move on.
 *   COST     it works, and something is spent, spoiled or noticed.
 *   SETBACK  it does not work, and the situation CHANGES — fail forward.
 *
 * A plain "you fail, nothing happens" is absent deliberately. It is the outcome that stalls a story
 * and the one an LLM handles worst; constraining *whether* it goes wrong in code while leaving
 * *how* to the model plays to what each is actually good at.
 *
 * ── Decided at the endpoints ──
 *
 * `SelectionDispatch.the_dispatch_law` (`:223`): dispatch on the interval's endpoints, never on the
 * point estimate, and where the interval straddles the threshold take a third action rather than a
 * default you have no warrant for. So the standing is scored as a RANGE — best case and worst case
 * given what is actually known — and a band is only awarded when even the pessimistic bound clears
 * it, or even the optimistic bound fails it. Everything in between is COST, which is the third
 * action: it neither grants nor refuses, it complicates.
 */

import { table_entries } from './lib/hash.js';
import { isFull } from './thread-table.js';

/** The outcome vocabulary. Constrained on purpose — three words a narrator cannot argue with. */
export const CLEAR = 'clear';
export const COST = 'cost';
export const SETBACK = 'setback';

/**
 * How favourable the standing must be before an attempt simply works, and how unfavourable before
 * it fails outright.
 *
 * `CLEAR_AT` is 1 rather than 2 for a reason the arithmetic forced: support is worth +2 and the
 * interval is ±1, so at 2 the pessimistic bound of a supported, unopposed, uninjured attempt still
 * lands at 1 and every single action in the game would cost something. A tracker that taxes
 * walking across a room is not simulationist, it is grinding. At 1, a straightforward action with
 * nothing against it simply works, and the moment anything opposes it the cost band takes over.
 *
 * ⚠ Otherwise unmeasured. There is no corpus of adjudicated attempts to fit these to yet, and
 * inventing a justification would be exactly the "gate's prose outran its behaviour" failure the
 * observe.js docstring cites. Both are counted (`verdict:clear`, `verdict:cost`, `verdict:setback`)
 * so play can settle them: a band that never fires is a band set wrong.
 */
export const CLEAR_AT = 1;
export const SETBACK_AT = -2;

/**
 * What good play banks.
 *
 * Ironsworn's momentum, without the dice: acting well accumulates standing that later rescues you,
 * which is the mechanical form of "play smart and you get smart rewards". One integer, because it
 * modulates everything and is the only number in this design worth its tracking cost.
 */
export const MOMENTUM_FLOOR = -6;
export const MOMENTUM_CEILING = 10;

/** What precedent the chronicle offers for an attempt like this one. */
export const UNTRIED = 'untried';
export const WORKED = 'worked';
export const FAILED = 'failed';

/**
 * Clamp momentum to its range.
 * @param {number} value Proposed momentum.
 * @returns {number} Momentum within bounds.
 */
export function clampMomentum(value) {
    const momentum = Number.isFinite(value) ? Math.round(value) : 0;
    return Math.max(MOMENTUM_FLOOR, Math.min(MOMENTUM_CEILING, momentum));
}

/**
 * Score how an attempt stands, as a RANGE rather than a number.
 *
 * The gap between `lo` and `hi` is the honest width of what is unknown. An attempt nobody opposes,
 * against no precedent, with a character in good condition, is not "definitely fine" — it is
 * somewhere between fine and unlucky, and the interval says so rather than picking a point and
 * pretending.
 *
 * @param {object} attempt The classified attempt.
 * @param {boolean} [attempt.supported] Does tracked state actually support this being possible?
 * @param {boolean} [attempt.opposed] Is someone or something actively resisting?
 * @param {boolean} [attempt.reckless] Does the attempt ignore something the character knows?
 * @param {object} standing What the world currently says.
 * @param {number} [standing.momentum] Banked standing from earlier play.
 * @param {number} [standing.hurt] How many consequences the character is carrying.
 * @param {number} [standing.regard] How whoever is involved regards the character: a `dispositionRank`, 0 hostile to 4 devoted.
 * @param {string} [standing.precedent] UNTRIED, WORKED or FAILED.
 * @returns {{lo: number, hi: number, why: string[]}} The interval and what moved it.
 */
export function standingRange(attempt = {}, standing = {}) {
    const why = [];
    let base = 0;

    // Support is the strongest single term, because it is the only one grounded in a fact the world
    // already established rather than in a judgement about this moment.
    if (attempt.supported) {
        base += 2;
        why.push('the world supports it');
    } else if (attempt.supported === false) {
        base -= 2;
        why.push('nothing established makes this possible');
    }

    if (attempt.opposed) {
        base -= 1;
        why.push('actively opposed');
    }
    if (attempt.reckless) {
        // The whole point of the exercise: playing badly has to cost something on its own account.
        base -= 2;
        why.push('ignores what the character knows');
    }

    // ── Sign matters, and it was wrong ──
    //
    // `regard` is a `dispositionRank`: 0 hostile, 2 neutral, 4 devoted — so it rises with goodwill
    // and the modifier is `regard - 2`. Written the other way round first, because the field was
    // called `hostility` while carrying a friendliness scale, and the unit tests agreed with the
    // mistake because they were written from the same wrong picture. What caught it was running the
    // thing on real scenes: asking a friendly innkeeper for a bath came back harder than asking a
    // hostile one.
    const regard = Number(standing.regard);
    if (Number.isFinite(regard) && regard !== 2) {
        const shift = regard - 2;
        base += shift;
        why.push(shift > 0 ? 'they are inclined to help' : 'they are inclined against it');
    }

    const hurt = Math.max(0, Number(standing.hurt) || 0);
    if (hurt) {
        base -= hurt;
        why.push(hurt === 1 ? 'carrying an injury' : `carrying ${hurt} injuries`);
    }

    if (standing.precedent === WORKED) {
        base += 1;
        why.push('this has worked before');
    } else if (standing.precedent === FAILED) {
        base -= 1;
        why.push('this has failed before');
    }

    // Momentum is spent as a floor, not added as a bonus: banked standing stops a disaster before
    // it turns a coin-flip into a certainty. That keeps good play protective rather than trivialising.
    const momentum = clampMomentum(standing.momentum);
    const cushion = momentum > 0 ? Math.min(2, Math.floor(momentum / 3)) : 0;
    if (cushion) {
        why.push('standing earned earlier');
    }

    // The interval. `hi` is what happens if the unknowns break well and `lo` if they break badly;
    // the width is fixed at one because a single attempt is one uncertainty, not a distribution.
    return { lo: base - 1 + cushion, hi: base + 1 + cushion, why };
}

/**
 * Decide the band from the interval's endpoints.
 *
 * Never reads a midpoint. `point_estimate_can_misdispatch` (`SelectionDispatch.lean:159`) shows a
 * sound interval whose expectation sits on the wrong side of the threshold by an order of
 * magnitude — so a summary of a bound carries none of the bound's warrant, and here the summary
 * would be the difference between a character walking away clean and taking a wound.
 *
 * @param {{lo: number, hi: number}} range The standing interval.
 * @returns {string} CLEAR, COST or SETBACK.
 */
export function bandOf({ lo, hi }) {
    if (lo >= CLEAR_AT) {
        return CLEAR;
    }
    if (hi <= SETBACK_AT) {
        return SETBACK;
    }
    // The straddle band. Neither endpoint decides, so the third action is taken: complicate rather
    // than grant or refuse.
    return COST;
}

/**
 * Adjudicate an attempt.
 *
 * @param {object} attempt The classified attempt.
 * @param {object} standing What the world currently says.
 * @returns {{band: string, lo: number, hi: number, why: string[], momentum: number}} The verdict.
 */
export function adjudicate(attempt = {}, standing = {}) {
    const range = standingRange(attempt, standing);
    const band = bandOf(range);
    return {
        band,
        lo: range.lo,
        hi: range.hi,
        why: range.why,
        // What the outcome does to banked standing. Clearing something hard earns it; a setback
        // spends it, which is what stops momentum ratcheting upward forever.
        momentum: clampMomentum((standing.momentum ?? 0) + (band === CLEAR ? 1 : band === SETBACK ? -2 : 0)),
    };
}

/**
 * What precedent the chronicle offers for an attempt.
 *
 * Deliberately crude — keyword overlap against past event summaries — because the alternative is
 * another model call to answer a question the chronicle already indexes. The signal is worth one
 * point either way and nothing more, so it does not need to be better than this.
 *
 * @param {Map<string, object>} events The chronicle.
 * @param {string[]} keywords Keywords describing the attempt.
 * @returns {string} UNTRIED, WORKED or FAILED.
 */
export function precedentFor(events, keywords) {
    const wanted = new Set((keywords ?? []).map(word => String(word ?? '').toLowerCase()).filter(Boolean));
    if (!wanted.size) {
        return UNTRIED;
    }

    let worked = 0;
    let failed = 0;
    for (const [, event] of table_entries(events ?? new Map())) {
        const overlap = (event?.kw ?? []).filter(word => wanted.has(String(word).toLowerCase())).length;
        if (overlap < 2) {
            continue;
        }
        // ── The outcome is STRUCTURE, not prose ──
        //
        // A verdict records its own result as `d.outcome` (`chronicle.recordVerdictEvent`), so a
        // past attempt's success is read as data, not guessed from the summary's English. The old
        // path regex-matched "fail|failed|refus|could not|unable|lost|denied" against the summary —
        // the same language-dependent guess the clock made before the scene probe reported
        // `elapsed`. An event with no recorded outcome contributes nothing; it cannot be the basis
        // for a guess. Only `worked` and `failed` count, so the overlap match is all that remains
        // of the old prose-reading.
        const outcome = event?.d?.outcome;
        if (outcome === 'worked') {
            worked++;
        } else if (outcome === 'failed') {
            failed++;
        }
    }

    if (!worked && !failed) {
        return UNTRIED;
    }
    return failed > worked ? FAILED : WORKED;
}

/**
 * The dial a setback should tick — the thread the attempt was actually about.
 *
 * ── Why this exists, and why a mis-aimed tick is worse than no tick ──
 *
 * Before Phase E, a SETBACK advanced the *globally first* non-full clock — in a multi-thread chat a
 * random victim, so the residency grind could tick down because the player botched a shopping
 * errand. §6: "SETBACK advances the dial of the thread the classifier's keywords/against actually
 * match, falling back to none." A setback with nothing to aim at lands as narrative consequence
 * only, and the world's pressure is not ticked at all — no tick is honest, a wrong tick is noise.
 *
 * Matching is keyword overlap against fold's OWN thread text — the same crude signal
 * `precedentFor` uses against the chronicle, deliberately: this is one point of placement evidence,
 * not a similarity metric (that is §11's ban on reading the narrative, and this reads thread state,
 * which is the sanctioned shape). The `against` name outweighs an ordinary keyword, because a stake
 * about the very person being fought is almost certainly the stake the attempt pushed.
 *
 * @param {object[]} threads Dial-bearing threads (the `snapshot` shape, flat `filled`/`size`/`kind`).
 * @param {object} attempt The classified attempt.
 * @param {string[]} [attempt.keywords] Lowercase keywords describing the attempt.
 * @param {string} [attempt.against] Who the attempt is aimed at, as the transcript names them.
 * @returns {object|null} The best-matching non-full thread, or null when nothing matches.
 */
export function matchThread(threads, { keywords = [], against = '' } = {}) {
    const wanted = new Set((keywords ?? []).map(kw => String(kw ?? '').toLowerCase()).filter(Boolean));
    const foe = String(against ?? '').toLowerCase().trim();
    let best = null;
    let bestScore = 0;

    for (const thread of Array.isArray(threads) ? threads : []) {
        if (isFull(thread)) {
            continue;
        }
        const haystack = [thread?.name, thread?.about, thread?.detail]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
        let score = 0;
        for (const keyword of wanted) {
            if (haystack.includes(keyword)) {
                score++;
            }
        }
        if (foe && haystack.includes(foe)) {
            score += 2;
        }
        if (score > bestScore) {
            best = thread;
            bestScore = score;
        }
    }

    return bestScore > 0 ? best : null;
}

/**
 * The line handed to the narrator.
 *
 * Written as an instruction rather than a description, because the model is being told what to
 * write and not informed of a fact it may weigh. The distinction is the whole feature: an insert
 * that reads as evidence gets argued with, and an insert that reads as a verdict gets narrated.
 *
 * @param {object} verdict The adjudicated verdict.
 * @param {string} [attempt] What the player was trying, in their own words.
 * @returns {string} A directive for the prompt.
 */
export function renderVerdict(verdict, attempt = '') {
    const what = String(attempt ?? '').trim();
    const subject = what ? `this attempt (${what})` : 'this attempt';

    switch (verdict?.band) {
        case CLEAR:
            return `[Outcome: ${subject} SUCCEEDS. Narrate it working. Do not introduce a complication.]`;
        case SETBACK:
            // Fail forward, stated as such — an LLM asked for failure will otherwise write a scene
            // where nothing happens, which is the one outcome that stalls a story.
            return `[Outcome: ${subject} FAILS. Narrate it not working, and change the situation for the worse as a result — a new problem, a lost chance, someone's attention. Never simply restate the status quo.]`;
        default:
            return `[Outcome: ${subject} SUCCEEDS AT A COST. Narrate it working, and make it cost something concrete — time, a resource, an injury, someone's trust, or being noticed.]`;
    }
}
