/**
 * sanguine/flows.js: where the rates live, and the only thing that writes one.
 *
 * The storage half of `flow-table.js`, mirroring `clocks.js` line for line: the pure module owns the
 * law, this owns the table and the counters.
 *
 * There is no tick in this file, and that is the design.
 *
 * `clocks.js` has `tickCalendar`, which advances a stored position and writes a chronicle event
 * when a dial fills. Nothing of the sort belongs here. A flow's contribution is recomputed from its
 * origin every time state is folded (`flow-table.js` `periodsOf`), so there is nothing to advance
 * and nothing to append, no scheduler, no catch-up pass, no torn write between a position and a
 * ledger entry, and no permanently-anchored event that a swipe cannot reach.
 *
 * `from` is therefore written exactly twice in a row's life: when it is created, and when it is
 * resumed after a suspension. Both are deliberate player actions on a stored table, one commit
 * each. Neither is on a read path.
 */

import { clockScalar } from './clock.js';
import {
    BY_CLOCK,
    accrue as accrueFlows,
    applyFlows,
    flowKey,
    flowRuler,
    foldFlow,
    normalizeFlow,
    periodsOf,
    resumeFrom,
} from './flow-table.js';
import { lookup, table_entries } from './lib/hash.js';
import * as observe from './observe.js';
import { commit, loadTable } from './store.js';

/** Where the rates live. */
const FLOWS_PATH = 'state.flows';

/** The flow table as stored. @returns {Map<string, object>} The table. */
export function load() {
    return loadTable(FLOWS_PATH);
}

/**
 * Where a row's own ruler stands.
 *
 * A flow denominated in narrative time reads the clock scalar; one denominated in exchanges reads
 * the clock's own `seen` counter. Both are monotone stored counters, which is what makes the two
 * agree about branch behaviour instead of disagreeing.
 *
 * @param {object} flow A row, or a proposal carrying `per`/`every`.
 * @param {object} clock The stored clock.
 * @returns {number} The reading, or NaN when the row names no ruler.
 */
export function rulerNow(flow, clock) {
    const ruler = flowRuler(flow);
    if (!ruler) {
        return NaN;
    }
    return ruler.coord === BY_CLOCK
        ? clockScalar(clock?.day, clock?.minutes)
        : (Number(clock?.seen) || 0);
}

/**
 * Create or edit a flow by hand.
 *
 * The one writer. A new row is stamped with its origin at wherever its ruler stands now, which is
 * what stops it billing for the history it was not present for; an edit keeps the origin it had,
 * because changing a rate is not the same as starting over.
 *
 * @param {string} label What the player calls it.
 * @param {object} changes The fields to set.
 * @param {object} clock The stored clock, for the origin.
 * @returns {boolean} Whether anything was written.
 */
export function set(label, changes, clock) {
    const table = load();
    const key = flowKey(label);
    if (!key) {
        return false;
    }
    const current = lookup(table, key, null);
    const merged = { ...current, ...changes, label: current?.label ?? label };
    // The origin belongs to the ROW's ruler, and an edit may have just changed which ruler that is.
    // Re-reading it here means switching a rate from "1 week" to "every 4 turns" re-bases onto the
    // counter it now reads, rather than carrying a position measured in the wrong unit.
    const ruled = normalizeFlow(merged);
    if (!ruled) {
        observe.noteRejections([{ item: label, reason: 'flow-unusable', raw: changes }]);
        return false;
    }
    const sameRuler = current && flowRuler(current)?.coord === flowRuler(ruled)?.coord;
    if (!sameRuler || !Number.isFinite(current?.from)) {
        merged.from = rulerNow(ruled, clock);
    }

    const written = foldFlow(table, merged);
    if (!written) {
        observe.noteRejections([{ item: label, reason: 'flows-full', raw: changes }]);
        return false;
    }
    commit(FLOWS_PATH, table);
    observe.note(current ? 'flow:edited' : 'flow:added');
    return true;
}

/**
 * Switch a flow off, or back on.
 *
 * Off records where the ruler stood, freezing the contribution at exactly what had been earned. On
 * shifts the origin forward by the span it sat out, so the gap is free and nothing already earned is
 * lost. Suspension is an expiry you can undo, which is why neither direction needs an accumulator.
 *
 * @param {string} key The table key.
 * @param {boolean} on The new state.
 * @param {object} clock The stored clock.
 * @returns {boolean} Whether anything changed.
 */
export function suspend(key, on, clock) {
    const table = load();
    const flow = lookup(table, key, null);
    if (!flow || !!flow.on === !!on) {
        return false;
    }
    const now = rulerNow(flow, clock);
    const next = on
        ? { ...flow, on: true, from: resumeFrom(flow, now), offAt: undefined }
        : { ...flow, on: false, offAt: now };
    if (on) {
        delete next.offAt;
    }
    table.set(key, next);
    commit(FLOWS_PATH, table);
    observe.note(on ? 'flow:resumed' : 'flow:suspended');
    return true;
}

/** Forget a flow, and with it everything it ever contributed. @returns {boolean} Whether it went. */
export function remove(key) {
    const table = load();
    if (!table.delete(key)) {
        return false;
    }
    commit(FLOWS_PATH, table);
    observe.note('flow:removed');
    return true;
}

/** Forget every flow. */
export function clear() {
    commit(FLOWS_PATH, new Map());
}

/**
 * Apply every flow's contribution to a folded inventory.
 *
 * Called from `state.derive()` after `deriveState` has folded the ledger, rather than from inside
 * it: `flow-table.js` imports `state-table.js` for the key algebra, so folding the other way would
 * be a cycle. The seam is also the honest one, the ledger is what was narrated, and this is what
 * time did to it.
 *
 * @param {Map<string, object>} inv The folded inventory, mutated.
 * @param {object} clock The stored clock.
 * @returns {{shorts: Array<object>, overs: Array<object>, capped: Array<object>, moved: number}}
 *   What could not be paid, what could not be received, what hit the arithmetic backstop, and how
 *   many rows moved at all.
 */
export function contribute(inv, clock) {
    const flows = load();
    if (!flows.size) {
        return { shorts: [], overs: [], capped: [], moved: 0 };
    }
    const { wants, capped } = accrueFlows(flows, {
        clock: clockScalar(clock?.day, clock?.minutes),
        seen: Number(clock?.seen) || 0,
    });
    const { shorts, overs } = applyFlows(inv, wants);
    return { shorts, overs, capped, moved: wants.size };
}

/**
 * Every flow with its current reading, for the panel.
 *
 * @param {object} clock The stored clock.
 * @returns {Array<object>} Rows carrying `periods` and `nextIn` in their own ruler's unit.
 */
export function list(clock) {
    const rows = [];
    for (const [key, flow] of table_entries(load())) {
        const ruler = flowRuler(flow);
        if (!ruler) {
            continue;
        }
        const now = rulerNow(flow, clock);
        const periods = periodsOf(flow, {
            clock: clockScalar(clock?.day, clock?.minutes),
            seen: Number(clock?.seen) || 0,
        });
        rows.push({
            ...flow,
            key,
            coord: ruler.coord,
            size: ruler.size,
            periods,
            // How far into the current period the ruler stands, so the panel can say "next in".
            nextIn: Number.isFinite(now) && Number.isFinite(flow.from) && flow.on
                ? Math.max(0, (flow.from + (periods + 1) * ruler.size) - now)
                : NaN,
        });
    }
    return rows;
}
