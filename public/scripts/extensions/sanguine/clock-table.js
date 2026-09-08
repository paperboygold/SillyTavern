/**
 * fold/clock-table.js: the clock vocabulary, forwarded to the table that absorbed it.
 *
 * Why this file is now a shim.
 *
 * Clocks were never a separate kind of thing from leads. They are threads that happen to have a
 * measurable position, and the live chat proved the cost of the split: the Solo Leveling campaign
 * carried the residency obligation as a lead AND as a clock, two tables holding one stake, neither
 * able to close (`FOLD-REDESIGN.md` §4). `thread-table.js` is that one table.
 *
 * The names below survive because deleting them would be a rename dressed up as a redesign: every
 * word here, the Count face on `filled`, `MAX_TICK`, hidden dials named but never quantified,
 * locality by `where`: was measured and kept. What changed is where they live and that a dial now
 * carries a polarity. `renderClocks` forwards to `renderPressure`, which renders DOOM dials only;
 * a progress dial rendered under `Pressure:` was the defect that made polarity a stored field, and
 * the forwarding is the guarantee that no old caller can reintroduce it.
 *
 * New code should import `./thread-table.js` directly. This file exists so that the callers and
 * the test suite written against the clock vocabulary keep working unchanged, which is the only
 * way to know the absorption preserved behaviour rather than merely resembling it.
 */

export {
    CLOCK_SIZES,
    DEFAULT_CLOCK_SIZE,
    HIDDEN,
    MAX_TICK,
    MAX_THREADS as MAX_CLOCKS,
    MAX_THREAD_NAME as MAX_CLOCK_NAME,
    MAX_THREAD_TEXT as MAX_CLOCK_ABOUT,
    OPEN,
    foldThread as foldClock,
    foldTicks as foldClocks,
    isFull,
    merge_thread as merge_clock,
    normalizeSize,
    normalizeThreadName as normalizeClockName,
    renderPressure as renderClocks,
    threads as clocks,
} from './thread-table.js';
