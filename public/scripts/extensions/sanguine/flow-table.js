/**
 * sanguine/flow-table.js: the things that change on their own.
 *
 * Pure, and testable without touching storage.
 *
 * What this is for.
 *
 * Every writer in this extension is the model. Nothing in the ledger moves unless a language model
 * wrote prose that an extractor parsed, which is why a shop you bought stops existing the moment it
 * leaves the context window: it is a noun with no verb. Cultivation, survival and kingdom play are
 * all the same machine underneath, a stock and a rate, and a stock with a rate needs a number and
 * a clock, not a language model.
 *
 * A flow is that rate. It names a quantity, a signed change, and how long one period is. Nothing
 * here calls a model, and nothing here is scheduled: the contribution is computed from the row's
 * own position every time state is folded.
 *
 * Accrual is a READ, and that decision is load-bearing.
 *
 * The obvious design writes an event each time a period elapses. It was designed, and then killed
 * by three separate measurements against the shipped code:
 *
 *   the torn write   the flow position commits to `chat_metadata` while the accrual event goes to
 *                    `chronicle.saveEvents` -> `ledger.emit` -> an async `fetch`, and
 *                    `ledger.reset()` empties that queue unconditionally on CHAT_CHANGED. Commit
 *                    first and the money is lost; record first and it double-counts. There is no
 *                    ordering that is correct.
 *   eviction, twice  `carryForward` carried only losses, so a pure-debit stream inflated the
 *                    balance when history aged out (fixed, `state-table.js carriedBaseline`); and
 *                    `selectEvictions` scores a delta-bearing event at +100000, so accrual receipts
 *                    would pin above every narrative summary and the chronicle would shed the STORY
 *                    to keep the rent.
 *   the branch       `recordWorldEvent` anchors on `USER_ANCHOR`, which is live on every branch
 *                    forever. Swipe the message that declared "a month passes" and the clock does
 *                    not retreat, but the money would be a permanent, unretractable fact.
 *
 * The house already had the answer, written for the same problem one table over
 * (`state-table.js` `tickConditions`): *"Expiry is therefore a READ of the ledger, not a write to
 * it, which is what keeps it correct under swiping."* So nothing here appends anything. Delete a
 * flow and its entire history goes with it, because the history was never anywhere but arithmetic.
 * Idempotence is not a property this has to argue for, it is the absence of a write.
 *
 * One law, two coordinates.
 *
 * A rate is a step size and a position in some monotone coordinate:
 *
 *     steps = floor((now - from) / size)
 *
 * which is `tickCalendar`'s law (`thread-table.js`), and the coordinate is a parameter:
 *
 *   `per`   a span, "1 week", "6 hours", read against the narrative clock. What the fiction
 *           means: rent falls due weekly whether or not anybody rolls a die.
 *   `every` a whole number of exchanges, read against the clock's own `seen` counter. What the
 *           TABLE means: a cultivator gains per training session, and a session is a scene, not a
 *           date.
 *
 * Exactly one, never both. They are not two mechanisms; they are one law asked about two rulers,
 * and both rulers are monotone stored counters that do not retreat on a swipe, the same behaviour
 * the narrative clock already has by construction, so the two agree instead of disagreeing.
 *
 * Why both are needed is measured. Across the twenty live chats the narrative clock spans four
 * orders of magnitude: a `1 week` rate needs 475 messages of Raccoon City (four days across 271
 * messages) and fires 1,855 times in one turn of the Wuxia campaign (where thirty years genuinely
 * pass at message 377). Seven chats never reach day one at all. A span is right for rent and wrong
 * for a training montage; exchanges are the reverse.
 */

import { parseSpan } from './clock.js';
import { insert_with, lookup, merge_b, table_entries } from './lib/hash.js';
import {
    CARRIED,
    itemKey,
    maxQty,
    normalizeItemName,
    normalizeKey,
    normalizePlace,
    ownerKey,
    splitItemKey,
} from './state-table.js';

/**
 * How many flows one chat may hold.
 *
 * A serialisation guard on the 128 KiB metadata blob, not a play limit, and stated as UNMEASURED:
 * no chat in the corpus has a flow in it yet, because until now there was no such thing. The number
 * to replace this with comes from `tests/util/fold-calibrate.mjs` once there is something to
 * calibrate against.
 */
export const MAX_FLOWS = 16;

/**
 * Periods one flow may contribute, ever.
 *
 * Why there is a bound at all, and why it is this loose.
 *
 * `tickCalendar` refuses a bound on the argument that *"the dial's own size clamps the fill, which
 * is the only bound this needs"*, sound, because a dial has a `size`. A quantity does not:
 * `maxQty(MONEY)` is `Number.MAX_SAFE_INTEGER`.
 *
 * But the real guard is upstream and now exists: `advanceSceneClock` clamps a single reported span
 * at `MAX_SKIP`, so no one extraction can move the clock more than ten years. What is left is
 * legitimate accumulated time, and that SHOULD accrue, the Wuxia campaign genuinely reaches day
 * 12,985, and a shop earning weekly across thirty years really has earned it. Capping that would be
 * refusing the premise, which is the mistake `MAX_SKIP`'s own docblock records the first version of
 * it making.
 *
 * So this is a backstop against arithmetic nonsense rather than a play limit: a hundred thousand
 * periods is past any campaign and short of anything that overflows. What binds is reported, so a
 * flow that hits it says so instead of quietly flattening.
 */
export const MAX_PERIODS = 100_000;

/** The coordinate a flow is denominated in. A schema enum, not a reading of anything. */
export const BY_CLOCK = 'clock';
export const BY_TURN = 'turn';

/**
 * A flow's stable table key.
 * @param {string} label What the player calls it.
 * @returns {string} The key, or '' when the label is unusable.
 */
export function flowKey(label) {
    return normalizeKey(label) || '';
}

/**
 * Read a proposed flow into the row shape, or refuse it.
 *
 * The `per`/`every` union is enforced here rather than defaulted, because a row with both would be
 * a row with two rates and a row with neither would be a row that silently never fires. Both are
 * the kind of thing that looks saved and does nothing, which is the class `clocks.set` dropping
 * `per` already cost this codebase once.
 *
 * @param {object} raw The proposal.
 * @returns {object|null} A normalised row, or null when it names no rate.
 */
export function normalizeFlow(raw) {
    const label = String(raw?.label ?? '').replace(/\s+/g, ' ').trim();
    const key = flowKey(label);
    const named = normalizeItemName(raw?.item);
    if (!key || !named) {
        return null;
    }

    const dq = Math.trunc(Number(raw?.dq) || 0);
    const span = String(raw?.per ?? '').replace(/\s+/g, ' ').trim();
    const every = Math.trunc(Number(raw?.every) || 0);
    // The union. A span wins only if it parses; `every` only if it is a positive whole number.
    const byClock = !!span && Number.isFinite(parseSpan(span)) && parseSpan(span) > 0;
    const byTurn = every > 0;
    if (byClock === byTurn) {
        return null;
    }

    const from = Number(raw?.from);
    const until = Number(raw?.until);
    return {
        label,
        item: named.name,
        display: named.display || named.name,
        at: normalizePlace(raw?.at ?? CARRIED),
        who: ownerKey(raw?.who ?? ''),
        dq,
        ...(byClock ? { per: span } : { every }),
        // Written once, by whoever creates the row, at wherever its ruler stands then. That is what
        // stops a flow created today from billing for the whole history of the campaign, and it is
        // the only time this field is set by anything other than a resume.
        ...(Number.isFinite(from) ? { from } : {}),
        ...(Number.isFinite(until) ? { until } : {}),
        ...(Number.isFinite(Number(raw?.offAt)) ? { offAt: Number(raw.offAt) } : {}),
        on: raw?.on !== false,
        src: raw?.src === 'model' ? 'model' : 'player',
        ...(raw?.why ? { why: String(raw.why).slice(0, 240) } : {}),
    };
}

/**
 * Which ruler a flow is read against, and how long one period is on it.
 * @param {object} flow A row.
 * @returns {{coord: string, size: number}|null} The coordinate and period, or null.
 */
export function flowRuler(flow) {
    const span = parseSpan(flow?.per);
    if (Number.isFinite(span) && span > 0) {
        return { coord: BY_CLOCK, size: span };
    }
    const every = Math.trunc(Number(flow?.every) || 0);
    return every > 0 ? { coord: BY_TURN, size: every } : null;
}

/**
 * Write a flow into the table, refusing once it is full.
 * @param {Map<string, object>} table The flow table, mutated.
 * @param {object} proposed A row, already merged with whatever it is replacing.
 * @returns {{key: string}|null} What was written, or null.
 */
export function foldFlow(table, proposed) {
    const row = normalizeFlow(proposed);
    if (!row) {
        return null;
    }
    const key = flowKey(row.label);
    if (!table.has(key) && table.size >= MAX_FLOWS) {
        return null;
    }
    // Map face. Not `merge_thread`'s field-wise-last-write-over-non-empty: that face is exactly what
    // forces `tickCalendar` to restate `seen` and `name` defensively, because silence there means
    // "keep". Every writer of this table has the whole row in hand, so there is no field where
    // silence should mean anything at all.
    insert_with(table, merge_b, key, row);
    return { key };
}

/**
 * What every flow has accrued, coalesced per target.
 *
 * Coalesced BEFORE anything is clamped, and that is not tidiness.
 *
 * `+1000` and `-300` on one money row against a balance of zero yields 1000 or 700 depending on
 * which is applied first, because a floor applied per change is not associative. Flow rows enumerate
 * in `Map` order, so that would be a real order-dependence in the ledger. Summing per target kills
 * the class by construction, and it is the more honest reading anyway: rent and income falling in
 * the same period net out, they do not bounce off zero.
 *
 * @param {Map<string, object>} flows The flow table.
 * @param {object} at Where the two rulers stand.
 * @param {number} at.clock `clockScalar(day, minutes)`: the narrative clock.
 * @param {number} at.seen Exchanges counted, the clock's own turn counter.
 * @returns {{wants: Map<string, object>, anchors: Array<object>, behind: Array<object>}} What is
 *   owed per target, which rows need a starting position, and what the catch-up cap held back.
 */
export function accrue(flows, { clock = NaN, seen = NaN } = {}) {
    const wants = new Map();
    const capped = [];

    for (const [key, flow] of table_entries(flows ?? new Map())) {
        const steps = periodsOf(flow, { clock, seen });
        if (steps < 1 || !flow?.dq) {
            continue;
        }
        const paid = Math.min(steps, MAX_PERIODS);
        if (paid < steps) {
            capped.push({ key, label: flow.label, asked: steps });
        }

        const target = itemKey(flow.item, flow.at, flow.who);
        const held = lookup(wants, target, null);
        wants.set(target, {
            item: flow.item,
            display: flow.display || flow.item,
            at: flow.at,
            who: flow.who,
            want: (held?.want ?? 0) + paid * flow.dq,
            labels: [...(held?.labels ?? []), flow.label],
        });
    }

    return { wants, capped };
}

/**
 * How many whole periods a flow has run for.
 *
 * Nothing is advanced, and that is the whole safety property.
 *
 * The first version of this advanced each row's position as it paid, the way `tickCalendar` does.
 * That is right for a stored table ticked by a writer, and wrong here for a reason that only shows
 * up at the seam: this is read from `derive()`, which runs on every panel render and every prompt
 * build. A position that advances on read is a write on the read path, a commit per render, and a
 * torn write the first time one of those renders is interrupted.
 *
 * So `from` is written once, when the flow is created, and never again by this code. The
 * contribution is the WHOLE history recomputed from scratch every fold, which is what makes it a
 * pure function of the row and the clock: run it twice and it says the same thing, because there is
 * no state between the runs to disagree with.
 *
 * Everything that stops a flow is therefore one idea, a HORIZON, the earliest of:
 *
 *   `now`     where the ruler stands.
 *   `until`   an expiry the player set. A flow that ended three weeks ago still counts the weeks it
 *             was alive for, then stops forever, with no cleanup pass to run.
 *   `offAt`   where the ruler stood when it was suspended. Suspension is an expiry you can undo,
 *             which is why it needs no accumulator: while the row is off its contribution is frozen
 *             at exactly what it had earned, and resuming shifts `from` forward by the span it sat
 *             out so it picks up where it left off rather than billing for the gap.
 *
 * A ruler that has gone BACKWARDS, which `setClockByHand` can do deliberately, because a player
 * correcting a drift is often correcting it downwards, needs no special case. The subtraction goes
 * negative, the floor takes it below one, and nothing is owed. Correcting the clock re-prices the
 * entire accrual on the spot, forwards or backwards, because there is no stored position left over
 * to disagree with the correction.
 *
 * @param {object} flow A row.
 * @param {object} at Where the two rulers stand.
 * @param {number} at.clock The narrative clock as a scalar.
 * @param {number} at.seen Exchanges counted.
 * @returns {number} Whole periods, never negative.
 */
export function periodsOf(flow, { clock = NaN, seen = NaN } = {}) {
    const ruler = flowRuler(flow);
    if (!ruler || !Number.isFinite(flow?.from)) {
        return 0;
    }
    const now = ruler.coord === BY_CLOCK ? clock : seen;
    if (!Number.isFinite(now)) {
        return 0;
    }
    let horizon = now;
    if (Number.isFinite(flow.until)) {
        horizon = Math.min(horizon, flow.until);
    }
    if (!flow.on && Number.isFinite(flow.offAt)) {
        horizon = Math.min(horizon, flow.offAt);
    }
    // A suspended row with no recorded suspension point has never been able to earn anything, so it
    // contributes nothing rather than everything, the safe reading of a half-written row.
    if (!flow.on && !Number.isFinite(flow.offAt)) {
        return 0;
    }
    return Math.max(0, Math.floor((horizon - flow.from) / ruler.size));
}

/**
 * Where a flow's origin moves to when it is switched back on.
 *
 * Shifts `from` forward by exactly the span the row sat out, so the periods it had already earned
 * are preserved and the suspension itself is free. Pure, so the arithmetic is gated rather than
 * asserted; the storage half applies it.
 *
 * @param {object} flow A suspended row.
 * @param {number} now Where its ruler stands.
 * @returns {number} The new `from`.
 */
export function resumeFrom(flow, now) {
    const was = Number(flow?.from);
    const off = Number(flow?.offAt);
    if (!Number.isFinite(was)) {
        return Number.isFinite(now) ? now : 0;
    }
    if (!Number.isFinite(off) || !Number.isFinite(now) || now <= off) {
        return was;
    }
    return was + (now - off);
}

/**
 * Apply what the flows are owed to a folded inventory.
 *
 * The clamp lives HERE, not in `merge_qty`'s floor.
 *
 * This is the most consequential detail in the file. `deriveState` records an `overdrawn` entry
 * whenever a debit runs past what is held, and `invariant-table.js unbackedDebits` reads those as
 * *"a credit landed under another key, which funded row is it in?"*, handing the pair to the review
 * as an identity question. Expected arrears are not that. Letting rent through that channel would
 * manufacture a false merge hypothesis every period and refill the 120-slot diagnostics log that
 * `AUDITED_PATH` exists to protect.
 *
 * So a flow takes what is there and no more, and the remainder is reported as its own kind of thing.
 *
 * @param {Map<string, object>} inv The folded inventory, mutated.
 * @param {Map<string, object>} wants From `accrue`.
 * @returns {{shorts: Array<object>, overs: Array<object>}} What could not be paid, and what could
 *   not be received.
 */
export function applyFlows(inv, wants) {
    const shorts = [];
    const overs = [];

    for (const [key, want] of table_entries(wants ?? new Map())) {
        const have = Number(lookup(inv, key, { qty: 0 })?.qty) || 0;
        const ceiling = maxQty(splitItemKey(key).place);
        const dq = want.want < 0
            ? -Math.min(have, -want.want)
            : Math.min(want.want, Math.max(0, ceiling - have));

        if (want.want < 0 && dq > want.want) {
            shorts.push({ key, ...want, paid: dq, short: want.want - dq });
        }
        if (want.want > 0 && dq < want.want) {
            overs.push({ key, ...want, paid: dq, over: want.want - dq });
        }
        if (!dq) {
            continue;
        }
        const next = have + dq;
        if (next <= 0) {
            inv.delete(key);
            continue;
        }
        insert_with(inv, merge_b, key, { ...lookup(inv, key, {}), qty: next });
    }

    return { shorts, overs };
}

/**
 * The net rate on one target, in change per minute and per exchange.
 *
 * A rendering, never a stored number. Two rows on one target tick on different boundaries, a
 * weekly income and a monthly levy pay on different beats, so "the net rate" only means anything
 * as a rate, not as a settlement.
 *
 * @param {Map<string, object>} flows The flow table.
 * @param {string} target An `itemKey`.
 * @returns {{perMinute: number, perTurn: number, rows: Array<object>}} The sum and its contributors.
 */
export function netRate(flows, target) {
    let perMinute = 0;
    let perTurn = 0;
    const rows = [];
    for (const [, flow] of table_entries(flows ?? new Map())) {
        const ruler = flowRuler(flow);
        if (!ruler || !flow.on || !flow.dq) {
            continue;
        }
        if (itemKey(flow.item, flow.at, flow.who) !== target) {
            continue;
        }
        rows.push(flow);
        if (ruler.coord === BY_CLOCK) {
            perMinute += flow.dq / ruler.size;
        } else {
            perTurn += flow.dq / ruler.size;
        }
    }
    return { perMinute, perTurn, rows };
}

/**
 * How many periods of the current net drain a stock has left.
 *
 * The number the panel sorts on, because urgency is the only ordering that makes an inventory read
 * as a situation rather than as a list. A stock that is growing, or still, has no empty time.
 *
 * @param {number} qty What is held.
 * @param {number} rate Change per period. Negative to deplete.
 * @returns {number|null} Periods until empty, or null when it never empties.
 */
export function emptyIn(qty, rate) {
    const have = Number(qty) || 0;
    const drain = Number(rate) || 0;
    if (drain >= 0 || have <= 0) {
        return null;
    }
    return have / -drain;
}

/**
 * Read a rate out of fold's OWN printed face.
 *
 * Not a reading of narrative. This parses the string the panel wrote, a signed integer, a slash,
 * and either a span this codebase already parses or a count of exchanges, which is the same
 * licence `parseClock` takes on the panel's clock field and `parseSpan` takes on `per`. The rule is
 * that fold may read its own protocol; it may not judge prose.
 *
 * @param {string} text "+1000/week", "-2/day", "-1/8 turns", "".
 * @returns {{dq: number, per?: string, every?: number}|null} A partial row, or null.
 */
export function parseFlow(text) {
    const said = String(text ?? '').trim();
    if (!said) {
        return null;
    }
    // A minus sign the panel may have written as U+2212, which is what it renders.
    const at = said.indexOf('/');
    if (at < 0) {
        return null;
    }
    const dq = Math.trunc(Number(said.slice(0, at).replace(/−/g, '-').replace(/[+\s,]/g, '')) || 0);
    if (!dq) {
        return null;
    }
    const rest = said.slice(at + 1).trim();
    const turns = rest.match(/^(\d+)\s*(?:turns?|exchanges?)?$/i);
    if (turns) {
        return { dq, every: Math.max(1, Number(turns[1])) };
    }
    const span = parseSpan(rest);
    return Number.isFinite(span) && span > 0 ? { dq, per: rest } : null;
}

/**
 * The face `parseFlow` reads back.
 * @param {object} flow A row.
 * @returns {string} "+1000/1 week", or '' when the row names no rate.
 */
export function flowFace(flow) {
    const ruler = flowRuler(flow);
    if (!ruler || !flow?.dq) {
        return '';
    }
    const sign = flow.dq > 0 ? '+' : '−';
    const size = Math.abs(flow.dq);
    return ruler.coord === BY_CLOCK
        ? `${sign}${size}/${flow.per}`
        : `${sign}${size}/${flow.every} turns`;
}

/**
 * One bounded line naming what is moving, for the extractor's pinned block.
 *
 * Deliberately not for the narrator's block in this round: `renderState`'s own docblock is explicit
 * that changing the narrator's shape changes how every live chat gets written, and that it should
 * land with its own measurement.
 *
 * @param {Map<string, object>} flows The flow table.
 * @returns {string} A `Running:` line, or ''.
 */
export function renderFlows(flows) {
    const parts = [];
    for (const [, flow] of table_entries(flows ?? new Map())) {
        const face = flowFace(flow);
        if (!face || !flow.on) {
            continue;
        }
        parts.push(`${flow.display || flow.item} ${face}`);
    }
    return parts.length ? `Running: ${parts.join(' · ')}` : '';
}
