/**
 * fold/thread-table.js — one table for everything that is at stake.
 *
 * Pure, imports ./lib/hash.js and one judgement from ./entity-table.js. Unit-testable.
 *
 * ── Why leads, clocks and progress tracks became one table ──
 *
 * They were three, and the live chat showed the cost. The Solo Leveling campaign carried the
 * residency obligation twice: an entity row `lead␀hunter residency` whose `open` field read
 * "1 of 20 logged. Nineteen to go", and a clock `the residency window closes` at 1/8 whose `about`
 * read "twelve months pass with fewer than twenty raids logged and the sponsorship lapses". One
 * stake, two tables, two lifecycles, two renderings — and the campaign's actual spine, *twenty
 * raids in twelve months*, was expressible in neither, so the count lived as prose inside a lead.
 *
 * A lead and a clock differ in exactly one respect: whether the stake has a measurable position.
 * That is a field, not a table. So:
 *
 *     no dial          → a Mythic thread (today's lead): something open, no way to say how far
 *     dial, doom       → a Blades clock: 4/6/8 segments, filling is BAD
 *     dial, progress   → an Ironsworn track: up to 20 segments, filling is GOOD
 *
 * ── Polarity is a stored kind, and the first draft got it wrong ──
 *
 * The redesign's first draft discriminated a track from a clock by SIZE — 4/6/8 meant clock, 20
 * meant track. The second hand repair of the live chat produced the counter-example that killed
 * it: two dials coexisted for the residency stake, `the residency window closes` (fills = the
 * sponsorship lapses) and `Residency in Korea` (`about: "Solomon completes 20 D-rank raids and
 * gains residency"` — fills = you win), and `renderClocks` printed both under `Pressure:`
 * — the `renderClocks` this file absorbs, now the shim in `clock-table.js` forwarding to
 * `renderPressure` below. Size cannot carry that
 * distinction: a four-segment "finish the ritual" is progress and an eight-segment doom is doom.
 *
 * A dial that fills on success narrated to the model as mounting threat is not a display bug. It
 * is the injection steering the narrator to treat the player's own progress as danger, and it is
 * the mechanism behind the one `reject:clock-reversed` in the live counters. So polarity is an
 * explicit `kind`, asked of the probe when a dial is first established, and *advancing* means the
 * `filled` direction whichever way the stakes point.
 *
 * ── Why the dial is stored FLAT and read as an object ──
 *
 * The schema this table implements says `dial?: {filled, size, kind}`, and it is tempting to store
 * that nesting. Rejected: the Count face is defined on a FIELD (`filled` accumulates under `+`
 * while everything describing the dial is field-wise last-write — the split in
 * `merge_thread` below is what stops a tick that says only "+1" from erasing what the clock is
 * about, and it is the one line of the absorbed `merge_clock` that had to survive verbatim). A merge that must reach through a nested object to add one number is precisely the shape
 * that made whole-record `merge_b` wrong in the first place. So the record stores `filled`, `size`
 * and `kind` flat, `kind` is present exactly when the thread has a dial, and `threads()` attaches
 * the `dial` object for readers. The stored form serves the merge; the read form serves the schema.
 *
 * ── What is deliberately not here ──
 *
 * No dice, unchanged from the clock table this absorbs: the dial records that something advanced;
 * what advanced it is the fiction's business. And no automatic merge of two threads that look
 * alike — `nearIdentity` below only raises a question (§2 of FOLD-REDESIGN.md), because
 * "one name containing another is not identity" and a metric that DECIDES has to be right, while
 * a detector that ASKS only has to be right often enough that the question budget stays small.
 */

import { parseSpan } from './clock.js';
import { windowSnippet } from './diag.js';
import { isExposition } from './entity-table.js';
import { insert_with, lookup, table_entries } from './lib/hash.js';

/**
 * Dial polarity. Two, and the enum is the whole point — see the header.
 *
 * `doom` fills toward something the characters do not want; `progress` fills toward something they
 * do. Nothing else about a dial changes with polarity: the same tick, the same accumulation, the
 * same bound. Only what the reader is told it means.
 */
export const DOOM = 'doom';
export const PROGRESS = 'progress';
export const DIAL_KINDS = [DOOM, PROGRESS];

/**
 * What has become of a thread.
 *
 * `moot` is new beside `open`/`closed`, and it is not a synonym for either. The Nowon
 * counterattack clock after the nest was routed was not COMPLETED — it stopped being about
 * anything. Conflating "it fired" with "it no longer applies" is how a ledger loses the
 * difference between a consequence and an irrelevance, which is the difference a campaign
 * archive exists to preserve.
 *
 * The vocabulary `entities.js` shipped for leads was `{open, stalled, closed}` and, counted across
 * all four live chat files, has never once been written as anything but `open` by the model — the
 * one `closed` in the Solo Leveling header was typed by the hand-repair script. `stalled` is
 * dropped here rather than carried: a blocked thread is still open, and the review pass (Phase C)
 * is the thing that will ever write a non-open value.
 */
export const OPEN_STATUS = 'open';
export const CLOSED = 'closed';
export const MOOT = 'moot';
export const THREAD_STATUSES = [OPEN_STATUS, CLOSED, MOOT];

/**
 * Segment counts a doom dial may have.
 *
 * Four for something imminent, six for ordinary trouble, eight for a slow catastrophe. The whole
 * range is deliberately small: Cowan's working-memory limit is about four chunks, and every
 * compressed tabletop system respects it — Blades' 4–8 segments, ICRPG's d4 timer, Ironsworn's
 * four ticks to a box.
 */
export const CLOCK_SIZES = [4, 6, 8];
export const DEFAULT_CLOCK_SIZE = 6;

/**
 * The ceiling on a progress track.
 *
 * Twenty because that is what the live campaign needed and nothing needed more: the D-10 visa in
 * the Solo Leveling chat wants "twenty active D-rank-or-higher raids inside twelve months", and
 * fold had to file the count as prose inside a lead's `open` field because no face could hold it.
 * A track is furniture in the way a twelve-segment CLOCK is furniture — nobody watches it tick —
 * which is exactly why it renders as a bar rather than as a dial (§8) and never as pressure.
 */
export const MAX_TRACK_SIZE = 20;
export const DEFAULT_TRACK_SIZE = 10;

/** Bounds, matching the rest of fold: generous for play, tight enough to bound the blob. */
export const MAX_THREAD_NAME = 64;
export const MAX_THREAD_TEXT = 120;

/**
 * How many threads the table holds.
 *
 * The old clock table stopped at twelve (`MAX_CLOCKS`), and `FOLD-RPG-GAP.md` §7 recorded what
 * that bound actually did: "dead pressure accumulates and eventually refuses live pressure",
 * because nothing could close. Threads can close, so the eviction pressure mostly dissolves and
 * the cap goes back to being a safety.
 *
 * Twenty-four, measured rather than chosen: the largest live campaign (Evil Hero Party, 171
 * messages) holds 15 lead rows and no clocks; Solo Leveling holds 10 leads and 1 clock. Twenty-four
 * is about 1.5× the largest thing the corpus has ever produced, and every refusal is counted
 * (`reject:threads-full`) so the number can be judged rather than trusted.
 */
export const MAX_THREADS = 24;

/**
 * The largest single tick accepted from one event.
 *
 * Blades ticks one to three segments for a complication and fills a clock outright only when the
 * fiction is unambiguous. A model that proposes eight in one turn has skipped the story, which is
 * the thing this bound exists to catch.
 */
export const MAX_TICK = 3;

/**
 * How many turns a dial-less thread survives unmentioned before it stops being rendered.
 *
 * Carried over unchanged from `ENTITY_STALE`, which is what governed leads before they moved here,
 * and applied to dial-less threads ONLY — a clock was never hidden by age and must not start being,
 * since a danger nobody has mentioned for twenty turns is the one you most need to be reminded of.
 *
 * It is a hide, not a delete, and it is on borrowed time: FOLD-REDESIGN.md §11 rules out decay, and
 * Phase C's review is the designed replacement — a thread should close because the narrative
 * settled it, not because nobody said its name. Kept here so this phase changes what it claims to
 * change and nothing else.
 */
export const THREAD_STALE = 20;

/**
 * Block labels that name the pressure domain.
 *
 * The sibling of `LEAD_LABELS` (`entity-table.js`) and `HEALTH_LABELS` (`state-table.js`), and it
 * lives here because pressure is what this table is for. A card that writes
 * `Pressure: goblin nest counterattacks 1/4` is writing a dial in prose, and parking it in context
 * puts one stake in two representations with the prose copy outranking the structured one on trust
 * (`FOLD-REDESIGN.md` §5). Measured: the live Solo Leveling header carried the residency stake in
 * THREE representations at once — a lead, a clock, and a `pressure` context field reading
 * "19 raids remaining in twelve-month window".
 */
export const PRESSURE_LABELS = ['pressure', 'threats', 'threat', 'dangers', 'clocks', 'countdown'];

/**
 * Whether a thread is something the point-of-view character could perceive.
 *
 * The rule from practice: show the pressure the character could plausibly see, and for the rest,
 * show that something EXISTS without its fill. Knowing something is closing in without knowing how
 * close is its own kind of pressure, and it is honest.
 */
export const OPEN = 'open';
export const HIDDEN = 'hidden';

/**
 * Normalize a thread name for keying.
 *
 * Deliberately NOT `normalizeEntityName`'s rule, which also strips a leading article so "the Hero"
 * and "Hero" key together. A thread's name is a sentence about an outcome — "The residency window
 * closes" — and its article is part of the phrase rather than a title's decoration. Keeping it
 * also keeps every clock key already written into the live chats readable without a rewrite.
 *
 * @param {string} raw Raw name.
 * @returns {{key: string, display: string}|null} Parts, or null if unusable.
 */
export function normalizeThreadName(raw) {
    const display = String(raw ?? '')
        .replace(/[*_`~]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[.,;:]+$/, '')
        .trim()
        .slice(0, MAX_THREAD_NAME);
    if (!display || /^(none|nothing|n\/a|unknown)\b/i.test(display)) {
        return null;
    }
    // ── A review label is not a name ──
    //
    // The review section lists every open thread as "T6 [open] Geldfurt funding — ...", and the
    // model has echoed that label back as a new thread name ("T6 Geldfurt funding"), opening a
    // duplicate of a thread it was literally told was already recorded. Stripping a leading
    // `T\d+` means such an echo lands on the canonical key instead of creating a twin row. The
    // label is pure review-bookkeeping, never a name — "T1 Karr..." is the same stake as
    // "Karr of the Red Hand gathers strength".
    const stripped = display.replace(/^T\s*\d+(?:\s+[-–—:]\s*|\s+|$)/i, '').trim();
    const name = stripped || display;
    return { key: name.toLowerCase(), display: name };
}

/**
 * Round a proposed size to one its polarity has.
 *
 * A doom rounds to the Blades vocabulary; a progress track is any whole number of steps up to
 * MAX_TRACK_SIZE, because "twenty raids" means twenty and rounding it to eight would be fold
 * inventing a different obligation from the one the fiction stated.
 *
 * @param {number} raw Proposed size.
 * @param {string} [kind] Dial polarity.
 * @returns {number} A usable size.
 */
export function normalizeSize(raw, kind = DOOM) {
    const size = Number(raw);
    if (kind === PROGRESS) {
        if (!Number.isFinite(size)) {
            return DEFAULT_TRACK_SIZE;
        }
        return Math.max(2, Math.min(MAX_TRACK_SIZE, Math.round(size)));
    }
    if (!Number.isFinite(size)) {
        return DEFAULT_CLOCK_SIZE;
    }
    return CLOCK_SIZES.reduce((best, candidate) =>
        Math.abs(candidate - size) < Math.abs(best - size) ? candidate : best);
}

/**
 * Round a proposed polarity to one the vocabulary has.
 * @param {string} raw Proposed kind.
 * @returns {string} DOOM or PROGRESS.
 */
export function normalizeKind(raw) {
    return String(raw ?? '').trim().toLowerCase() === PROGRESS ? PROGRESS : DOOM;
}

/**
 * Round a proposed status to one the vocabulary has.
 * @param {string} raw Proposed status.
 * @returns {string} A member of THREAD_STATUSES.
 */
export function normalizeStatus(raw) {
    const word = String(raw ?? '').trim().toLowerCase();
    if (word === CLOSED || word === 'resolved' || word === 'done') {
        return CLOSED;
    }
    if (word === MOOT || word === 'irrelevant') {
        return MOOT;
    }
    return OPEN_STATUS;
}

/**
 * Does this thread carry a dial?
 *
 * A size counts as evidence of one even without a `kind`, and that is not laxity: every clock ever
 * written into a live chat predates polarity, so a record with segments and no polarity is exactly
 * what a v1 clock looks like. Reading it as a doom here is the same rule the migration applies
 * (`migrate.js`, the `state.clocks` step) and means a table that was never migrated still renders
 * rather than silently losing its dials.
 *
 * @param {object} thread A thread record.
 * @returns {boolean} True when it has a measurable position.
 */
export function hasDial(thread) {
    return DIAL_KINDS.includes(String(thread?.kind ?? '')) || Number.isFinite(thread?.size);
}

/**
 * The dial as the schema describes it, or null.
 * @param {object} thread A thread record.
 * @returns {{filled: number, size: number, kind: string}|null} The dial.
 */
export function dialOf(thread) {
    if (!hasDial(thread)) {
        return null;
    }
    const kind = normalizeKind(thread.kind);
    return { filled: thread?.filled ?? 0, size: normalizeSize(thread?.size, kind), kind };
}

/**
 * Merge a thread record.
 *
 * The fill accumulates — Count face on one field — while everything describing the thread is
 * field-wise last-write, like `merge_entity` (`entity-table.js:275-334`). Splitting them matters:
 * a tick that says only "+1" must not erase what the thread is about, and a re-description must
 * not reset the fill to zero.
 *
 * Ordered by turn for the same reason entities are. Extraction is async and fire-and-forget, so
 * two ticks can land in either order; `resolution_max_converges` is the repair, and the fill is
 * order-independent anyway because addition is commutative.
 *
 * `steps` and `per` ride as ordinary versioned fields in this phase. Phase W wires their
 * behaviour (named dial segments make a Dungeon World front; `per` lets a calendar front tick from
 * elapsed time with no model call); carrying them now means a chat that records one does not lose
 * it waiting for the code that reads it.
 *
 * @param {object} nu Incoming record.
 * @param {object} old Existing record.
 * @returns {object} Merged record.
 */
export const merge_thread = (nu, old) => {
    if (!old) {
        const kind = hasDial(nu) ? normalizeKind(nu.kind) : '';
        return kind
            ? { ...nu, filled: clamp(nu?.filled ?? 0, nu?.size, kind) }
            : { ...nu };
    }

    const older = (nu?.turn ?? 0) < (old?.turn ?? 0);
    const [newer, earlier] = older ? [old, nu] : [nu, old];

    const merged = { ...earlier };
    for (const [field, value] of Object.entries(newer ?? {})) {
        if (field !== 'filled' && value !== undefined && value !== null && value !== '') {
            merged[field] = value;
        }
    }

    // First-seen is the earliest claim, not the latest — the same rule cast rows use
    // (`entity-table.js:314-320`). Under plain field-wise last-write every re-report would reset
    // it and nothing would ever read as new for more than one tick.
    const firsts = [earlier?.first, newer?.first, earlier?.turn, newer?.turn]
        .filter(value => Number.isFinite(value));
    if (firsts.length) {
        merged.first = Math.min(...firsts);
    }

    // ── Aliases are the one Set-face field, and threads finally have one ──
    //
    // `next raid with Kang's squad` and `next raid with Kang's team` opened as two threads in the
    // live chat because leads had no `aka` at all — the alias resolution that half-works for
    // people did not exist here (FOLD-REDESIGN.md §0.1-6). A name a thread was once called does
    // not stop having been used for it, so `merge_nb`'s "once in, always in" is exactly right.
    const names = new Set([...aliasKeys(earlier), ...aliasKeys(newer)]);
    names.delete(normalizeThreadName(merged.name)?.key);
    const written = new Map();
    for (const raw of [earlier?.name, newer?.name, earlier?.aka, newer?.aka]) {
        for (const part of String(raw ?? '').split(/[,;/|]/)) {
            const parsed = normalizeThreadName(part);
            if (parsed && names.has(parsed.key)) {
                written.set(parsed.key, parsed.display);
            }
        }
    }
    merged.aka = [...written.values()].join(', ').slice(0, MAX_THREAD_TEXT);

    // The Count face on one field. `old` and `nu` are added rather than ordered, so two ticks that
    // land out of order still total the same — which they will, since extraction is async.
    if (hasDial(merged)) {
        merged.filled = clamp((old?.filled ?? 0) + (nu?.filled ?? 0), merged.size, merged.kind);
    }
    return merged;
};

/**
 * Every name a thread answers to, normalised.
 * @param {object} thread A thread record.
 * @returns {string[]} Normalised keys.
 */
export function aliasKeys(thread) {
    return [thread?.name, ...String(thread?.aka ?? '').split(/[,;/|]/)]
        .map(name => normalizeThreadName(name)?.key)
        .filter(Boolean);
}

/**
 * The key an observation should be written to, following aliases.
 *
 * The same one-hop, first-match resolution cast rows use (`entity-table.js:370-388`), and the same
 * warning applies: `KeyResolution.lean`'s `resolution_breaks_key_independence` says every merge
 * puts previously independent writes into competition, so a transitive alias graph would need
 * cycle detection and a merge order this table has no way to choose.
 *
 * @param {Map<string, object>} table Thread table.
 * @param {string} nameKey Normalised incoming name.
 * @param {string} [aka] Aliases the observation itself declares.
 * @returns {string} The table key to write.
 */
export function canonicalThreadKey(table, nameKey, aka = '') {
    if (table.has(nameKey)) {
        return nameKey;
    }
    const incoming = new Set([nameKey, ...aliasKeys({ aka })]);
    for (const [key, value] of table_entries(table)) {
        if (aliasKeys(value).some(alias => incoming.has(alias))) {
            return key;
        }
    }
    return nameKey;
}

/**
 * The row a name refers to, following aliases, or null.
 *
 * `canonicalThreadKey` answers "where should a write go", which for an unknown name is "a new row
 * under its own key" — the right answer for the write path and a trap for a reader, because it
 * returns a key that is not in the table. The world probe needs the reader's question: *does fold
 * already know this front?* A move naming a front that does not exist is exactly the unrooted
 * invention §7.4 refuses.
 *
 * @param {Map<string, object>} table Thread table.
 * @param {string} raw A name as the model wrote it.
 * @returns {{key: string, thread: object}|null} The row, or null when there is none.
 */
export function resolveThread(table, raw) {
    const parsed = normalizeThreadName(raw);
    if (!parsed) {
        return null;
    }
    const key = canonicalThreadKey(table, parsed.key);
    const thread = lookup(table, key, null);
    return thread ? { key, thread } : null;
}

/**
 * Clamp a fill to its dial.
 * @param {number} value Proposed fill.
 * @param {number} size Segment count.
 * @param {string} [kind] Dial polarity.
 * @returns {number} A fill within the dial.
 */
function clamp(value, size, kind = DOOM) {
    const filled = Number.isFinite(value) ? value : 0;
    return Math.max(0, Math.min(Math.round(filled), normalizeSize(size, kind)));
}

/**
 * Fold one observed thread into a table.
 *
 * @param {Map<string, object>} table Thread table, mutated.
 * @param {object} observed The observation.
 * @param {string} observed.name What the thread is called.
 * @param {number} [observed.tick] Segments to add; may be negative for a dial that unwinds.
 * @param {number} [observed.size] Segment count, when newly established.
 * @param {string} [observed.kind] Dial polarity, when newly established.
 * @param {string} [observed.open] What is still unsettled — a dial-less thread's whole content.
 * @param {string} [observed.detail] The specifics: who, where, when.
 * @param {string} [observed.about] What happens when a dial completes.
 * @param {string} [observed.status] open, closed or moot.
 * @param {string} [observed.seen] OPEN or HIDDEN.
 * @param {number} [observed.turn] Turn counter.
 * @returns {string|null} The key written, or null if unusable.
 */
/**
 * Fold one proposed thread into the table.
 *
 * ── Eviction is a return, not a delete ──
 *
 * When the table is full, the stalest expendable thread must make room — but that row is not
 * destroyed, it is RETURNED as `evicted` so the caller can demote it to the cold store. The
 * selection stays pure (this function does no I/O); the storage layer decides what the returned
 * row means. See `cold-store.js` ([EVICT]: selection cannot bound a store, so eviction is
 * demotion, never a relevance-judged delete).
 *
 * @param {Map<string, object>} table Thread table, mutated.
 * @param {object} params Proposed thread fields.
 * @returns {object|null} `{ key, evicted }` where `evicted` is the row that gave up its slot
 *   (`null` when the table had room), or null when the thread was unusable.
 */
export function foldThread(table, {
    name, tick = 0, size, kind, aka = '', open = '', detail = '', about = '', steps, per = '',
    status = '', seen = OPEN, where = '', source = '', deadline = NaN, turn = 0, ticked,
} = {}) {
    const parsed = normalizeThreadName(name);
    if (!parsed) {
        return null;
    }
    const key = canonicalThreadKey(table, parsed.key, aka);
    let evicted = null;
    if (!table.has(key) && table.size >= MAX_THREADS) {
        // ── The table is full; the stalest expendable thread must make room ──
        //
        // `reject:threads-full` measured 8 in the Royal Succession chat because the table never
        // prunes: every thread stays `open` until the review happens to settle it, so a campaign
        // with a long tail fills the cap and then refuses every genuinely new development — a
        // courier's death, a new conspiracy, all rejected because a 28-turn-old tolls petition
        // still sits open. A thread with a DIAL is preserved (its fill is progress the story
        // measured); among open dial-less threads the one nobody has touched the longest is the
        // most likely settled, so it gives up its slot. The row is RETURNED, not deleted — the
        // caller demotes it to the cold store, so a courier's death that lost its slot is still
        // there to be recalled the moment the story returns to it.
        const candidate = [...table_entries(table)]
            .filter(([, row]) => row?.status === OPEN_STATUS && !hasDial(row))
            .sort((a, b) => (a[1]?.turn ?? 0) - (b[1]?.turn ?? 0))[0];
        if (candidate) {
            evicted = { key: candidate[0], row: candidate[1] };
            table.delete(candidate[0]);
        } else {
            return null;
        }
    }

    const held = lookup(table, key, {});
    // A dial exists once anything has established one, and a later mention that omits `kind` must
    // not silently demote a clock to a lead — the same asymmetry the field-wise merge applies
    // everywhere else: silence is not retraction.
    const polarity = kind !== undefined && kind !== null && kind !== ''
        ? normalizeKind(kind)
        : (hasDial(held) ? normalizeKind(held.kind) : (Number.isFinite(size) || tick ? DOOM : ''));

    insert_with(table, merge_thread, key, {
        name: parsed.display,
        // The turn this first appeared, so the panel can tell NEW from UPDATED.
        first: turn,
        aka: String(aka ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_THREAD_TEXT),
        // What acting would settle. The gate `isExposition` reads, and the reason a thread is in
        // the prompt at all: without it the model reads back a statement and has nothing to push
        // against.
        open: String(open ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_THREAD_TEXT),
        // The specifics — who, where, when. Carried from v1 leads' `detail`.
        detail: String(detail ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_THREAD_TEXT),
        // What actually happens when a dial completes. Kept SEPARATE from `detail` rather than
        // folded into it: for a doom, "the sponsorship lapses" is the consequence, not a
        // description of the thread, and a renderer that cannot tell them apart writes the
        // consequence as though it had already occurred.
        about: String(about ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_THREAD_TEXT),
        ...(polarity ? { kind: polarity, filled: Number.isFinite(tick) ? tick : 0, size: normalizeSize(size ?? held?.size, polarity) } : {}),
        // Named dial segments (a Dungeon World front) and a calendar cadence. Phase B carried them
        // inert; `tickCalendar` below is the code that reads `per`.
        ...(Array.isArray(steps) && steps.length ? { steps: steps.map(step => String(step).slice(0, MAX_THREAD_NAME)).slice(0, MAX_TRACK_SIZE) } : {}),
        ...(per ? { per: String(per).replace(/\s+/g, ' ').trim().slice(0, MAX_THREAD_NAME) } : {}),
        // Where the narrative clock stood when this front last ticked from the calendar. See
        // `tickCalendar`: it is a POSITION, not an accumulator, and that is what makes the tick
        // idempotent.
        ...(Number.isFinite(ticked) ? { ticked } : {}),
        status: normalizeStatus(status || held?.status),
        seen: seen === HIDDEN ? HIDDEN : OPEN,
        // Where this applies. A goblin nest counterattacks in the dungeon it lives in; it does not
        // follow you to a noodle shop. Same shape as entity presence — the thread is not deleted,
        // it stops being HERE.
        where: String(where ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_THREAD_NAME),
        source: String(source ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_THREAD_TEXT),
        // Minutes since midnight the excerpt scheduled this by, when the model reported one.
        // Rendered as a countdown; fold never reads a scheduling time out of prose.
        ...(Number.isInteger(Number(deadline)) && Number(deadline) >= 0 ? { deadline: Number(deadline) } : {}),
        turn,
    });
    return { key, evicted };
}

/**
 * Does the new window mention a dial — by its name, its subject, or the place it applies?
 *
 * The window names the dial as often as it names an entity, but the gates that licence each kind
 * disagree about how to read a match: the entity gate heads on a single discriminating token
 * (`entity-table.js` `mentions`), and a dial should be read the same way — "the Blight" in the
 * window is still the "the Blight reaches Briarwood" dial. The name is matched first, then its
 * `about` (what completing it does) and `where` (where it applies), because a dial is referred to
 * by its consequence at least as often as by its label.
 *
 * @param {string} windowText The narrative window.
 * @param {object} observed The proposed tick.
 * @returns {boolean} True if the window mentions the dial or its subject.
 */
function mentionsDial(windowText, observed) {
    const haystack = String(windowText ?? '').toLowerCase();
    const needles = [observed?.name, observed?.about, observed?.where];
    return needles.some((raw) => {
        const needle = String(raw ?? '').toLowerCase().trim();
        if (!needle) {
            return false;
        }
        if (haystack.includes(needle)) {
            return true;
        }
        return needle.split(/[^a-z0-9']+/)
            .filter(token => token.length > 3)
            .some(token => haystack.includes(token));
    });
}

/**
 * Fold a batch of dial ticks, refusing the ones the narrative does not support.
 *
 * The gate is COVERAGE BY THE MODEL'S REPORT when one exists (`mentioned`): a Set of the names
 * the model says the new excerpt actually uses. A dial is admitted to advance only when its name,
 * outcome, or subject is in that set ([ROUTER]: coverage, not a substring proxy). The block path
 * (`absorb-table.js`) carries no report and falls back to the structural mention test.
 *
 * @param {Map<string, object>} table Thread table, mutated.
 * @param {object[]} observations Proposed ticks.
 * @param {object} [options] Options.
 * @param {number} [options.turn] Turn counter.
 * @param {string} [options.windowText] Narrative window, for the diagnostics record.
 * @param {Set<string>} [options.mentioned] Names the model reports the excerpt uses.
 * @returns {{accepted: number, rejected: object[], fired: object[]}} What happened.
 */
export function foldTicks(table, observations, { turn = 0, windowText = '', mentioned = null } = {}) {
    const rejected = [];
    const fired = [];
    let accepted = 0;
    // The window excerpt every rejection records, for the caret-level diagnostics log.
    const snippet = windowSnippet(windowText);

    for (const observed of Array.isArray(observations) ? observations : []) {
        const parsed = normalizeThreadName(observed?.name);
        if (!parsed) {
            rejected.push({ item: String(observed?.name ?? ''), reason: 'unusable-name', raw: observed, snippet });
            continue;
        }
        // ── The mention gate, symmetric with the entity probe's ──
        //
        // The entity probe refuses people the window never names, and a dial should be held to the
        // same evidence: a dial can only advance when the new excerpt mentions it — its outcome,
        // or the thing that moves it. Without this, a dial proposed with a non-zero tick for
        // something the window never touched was ACCEPTED (a hallucinated advance); only a zero
        // tick got caught, and only as `no-change`. A tick for an unmentioned dial is
        // `not-mentioned`, the same refusal an unmentioned person gets.
        const covered = mentioned
            ? [parsed.key, observed?.about, observed?.where]
                .map(raw => String(raw ?? '').toLowerCase().trim())
                .filter(Boolean)
                .some(key => mentioned.has(key))
            : !windowText || mentionsDial(windowText, observed);
        if (!covered) {
            rejected.push({ item: parsed.display, reason: 'not-mentioned', raw: observed, snippet });
            continue;
        }
        const tick = Number(observed?.tick);
        if (!Number.isFinite(tick) || tick === 0) {
            rejected.push({ item: parsed.display, reason: 'no-change', raw: observed, snippet });
            continue;
        }
        // A dial that leaps in one turn has skipped the story it was supposed to measure.
        if (Math.abs(tick) > MAX_TICK) {
            rejected.push({ item: parsed.display, reason: 'implausible-tick', raw: observed, snippet });
            continue;
        }

        const before = lookup(table, canonicalThreadKey(table, parsed.key, observed?.aka), null);
        const written = foldThread(table, { ...observed, tick, turn });
        if (!written) {
            rejected.push({ item: parsed.display, reason: 'threads-full', raw: observed, snippet });
            continue;
        }
        const key = written.key;
        accepted++;

        // Firing is the whole point of a dial, and it happens exactly once — on the tick that
        // completes it. Reporting it here rather than leaving the panel to notice means the caller
        // can act on it in the turn it occurred. The fired record carries its key so the caller can
        // close it the same way a review closure would.
        const after = lookup(table, key, null);
        if (isFull(after) && !isFull(before)) {
            fired.push({ ...after, key });
        }
    }

    return { accepted, rejected, fired };
}

/**
 * The cadence a calendar front ticks on, in minutes, or null when it has none.
 * @param {object} thread A thread record.
 * @returns {number|null} Minutes per step.
 */
export function perMinutes(thread) {
    const span = parseSpan(thread?.per);
    return Number.isFinite(span) && span > 0 ? span : null;
}

/**
 * Advance every calendar front the narrative clock has run past — in code, with no model involved.
 *
 * ── The stake this exists for is sitting in the live data with no engine under it ──
 *
 * The Solo Leveling campaign's one live clock is *the residency window closes*, and its firing
 * condition is "twelve months pass with fewer than twenty raids logged". That is a pure calendar
 * condition. Ticks arrived only from on-screen extraction, so nothing in fold could ever tick it:
 * a front whose whole point is that it advances while you are not looking could only advance while
 * you were (FOLD-REDESIGN.md §7.1). Asking a model to count months instead would be trading
 * arithmetic fold can do for a hallucination surface — `dispositionRank` of judgement to code,
 * again (§7.3).
 *
 * ── A POSITION, not an accumulator, and the difference is three bugs ──
 *
 * The obvious shape is a `since` field that sums elapsed minutes and resets on each tick. It has
 * three failure modes and this shape has none of them:
 *
 *   double-tick   the pass is async and fire-and-forget, so it can run twice against the same
 *                 elapse. An accumulator ticks twice; a position is idempotent, because
 *                 `floor((now - ticked) / per)` is zero the second time.
 *   drift         an accumulator reset to zero on each tick loses the remainder. Three ten-day
 *                 skips against `per: "1 month"` must tick ONCE and keep ten days in hand
 *                 (§7.3); advancing `ticked` by exactly `steps × per` keeps the remainder by
 *                 construction, because it is never touched.
 *   disagreement  an accumulator is a second, independent record of how much time has passed. This
 *                 one is read off the clock the panel shows, so the front and the clock cannot
 *                 disagree about what month it is.
 *
 * ── What this does NOT do, and the swipe argument ──
 *
 * It is not branch-aware, and it is honest about why: the thread table is stored, not derived
 * (`overlayClosures` above carries the full argument for why threads stayed stored in Phase C), and
 * so is the narrative clock (`state.js` `saveClock`). Swipe the message that declared "one week
 * later" and the clock does not retreat either — so the front stays exactly consistent with the
 * clock that moved it, which is the invariant that matters. The audit event `clocks.tickCalendar`
 * records IS content-keyed and does die with the swipe, so the trail says the tick is no longer
 * attributable while the arithmetic remains checkable against the clock. Making the fill itself
 * branch-aware means deriving dials from the ledger, which is Phase C's explicitly rejected
 * alternative 2 and would rewrite `merge_thread`, the migration and every consumer.
 *
 * ── MAX_TICK is deliberately not applied ──
 *
 * `MAX_TICK = 3` catches a MODEL that skipped the story ("a dial that leaps in one turn has skipped
 * the story it was supposed to measure"). Arithmetic over a player-declared elapse has no such
 * failure mode: if the player says a year passed, a `per: "1 month"` front really has had twelve
 * boundaries cross it, and refusing them would be fold contradicting the fiction it was told. The
 * dial's own size clamps the fill (`clamp`), which is the only bound this needs.
 *
 * @param {Map<string, object>} table Thread table, mutated.
 * @param {object} params Parameters.
 * @param {number} params.now The narrative clock as a scalar (`clock.js` `clockScalar`).
 * @param {number} [params.turn] Turn counter.
 * @returns {{ticked: object[], anchored: string[], fired: object[]}} What advanced, what was seen
 *   for the first time (anchored, never ticked), and what filled.
 */
export function tickCalendar(table, { now, turn = 0 } = {}) {
    const ticked = [];
    const anchored = [];
    const fired = [];
    if (!Number.isFinite(now)) {
        return { ticked, anchored, fired };
    }

    for (const [key, row] of table_entries(table)) {
        const per = perMinutes(row);
        if (!per || !hasDial(row) || normalizeStatus(row.status) !== OPEN_STATUS || isFull(row)) {
            continue;
        }
        // A front met for the first time is anchored to NOW and never ticked. The alternative —
        // treating an absent position as zero — would read the whole history of the campaign as
        // elapsed and fill the dial on sight, which is what a front carrying `per` written by hand
        // into an old chat would do on its first pass.
        if (!Number.isFinite(row.ticked)) {
            insert_with(table, merge_thread, key, { ticked: now, turn: row?.turn ?? turn });
            anchored.push(key);
            continue;
        }
        const steps = Math.floor((now - row.ticked) / per);
        if (steps < 1) {
            continue;
        }
        // `seen` and `name` are restated because `foldThread` writes both unconditionally and
        // `merge_thread` is field-wise last-write over non-empty values: letting `seen` default
        // would quietly reopen a hidden front every time the calendar moved it, which is the one
        // thing a hidden front must never do.
        const written = foldThread(table, {
            name: row.name,
            tick: steps,
            seen: row.seen,
            ticked: row.ticked + steps * per,
            turn,
        });
        if (!written) {
            continue;
        }
        const after = lookup(table, written.key, null);
        ticked.push({ key, name: row.name, steps, per, from: row.ticked, to: row.ticked + steps * per });
        if (isFull(after) && !isFull(row)) {
            fired.push({ ...after, key });
        }
    }

    return { ticked, anchored, fired };
}

/**
 * Fold a batch of dial-less thread proposals, rejecting exposition.
 *
 * `isExposition` (`entity-table.js:556-563`) is imported rather than copied. The sibling rule
 * `samePlace` IS copied below, and the difference is deliberate: `samePlace` is six lines of
 * equality, while this is a judgement about English that took a measurement to tune
 * (`reject:exposition` 7 in the Evil Hero Party chat), and two copies of a judgement diverge.
 *
 * @param {Map<string, object>} table Thread table, mutated.
 * @param {object[]} observations Proposed threads.
 * @param {object} [options] Options.
 * @param {number} [options.turn] Turn counter.
 * @param {string} [options.windowText] Narrative window, for the diagnostics record.
 * @returns {{accepted: number, rejected: object[], evicted: Array<{key: string, row: object}>}}
 *   What happened: accepted count, refusals, and the rows that gave up their slots when the table
 *   was full — the caller demotes those to the cold store rather than losing them.
 */
export function foldThreads(table, observations, { turn = 0, windowText = '' } = {}) {
    const rejected = [];
    const evicted = [];
    let accepted = 0;
    // The window excerpt every rejection records, for the caret-level diagnostics log.
    const snippet = windowSnippet(windowText);

    for (const observed of Array.isArray(observations) ? observations : []) {
        const parsed = normalizeThreadName(observed?.name);
        if (!parsed) {
            rejected.push({ item: String(observed?.name ?? ''), reason: 'unusable-name', raw: observed, snippet });
            continue;
        }
        // The gate stays exactly where it was and does exactly what it did: a "lead" with nothing
        // unsettled in it is lore, and a panel full of lore is a panel nobody reads. Dial-bearing
        // threads skip it — a clock IS its own open question.
        if (!hasDial(observed) && isExposition(observed)) {
            rejected.push({ item: parsed.display, reason: 'exposition', raw: observed, snippet });
            continue;
        }
        const outcome = foldThread(table, { ...observed, turn });
        if (outcome) {
            accepted++;
            if (outcome.evicted) {
                evicted.push(outcome.evicted);
            }
        } else {
            rejected.push({ item: parsed.display, reason: 'threads-full', raw: observed, snippet });
        }
    }

    return { accepted, rejected, evicted };
}

/**
 * Has this dial filled?
 * @param {object} thread A thread record.
 * @returns {boolean} True when every segment is filled.
 */
export function isFull(thread) {
    if (!thread || !hasDial(thread)) {
        return false;
    }
    return (thread.filled ?? 0) >= normalizeSize(thread.size, thread.kind);
}

/**
 * Read the threads, most urgent first.
 *
 * Urgency is proportion filled rather than segments remaining: a 4-dial at 3 is closer to firing
 * than an 8-dial at 3, and it is the fraction that tells you how worried to be. Dial-less threads
 * have no proportion at all and sort after, by recency.
 *
 * @param {Map<string, object>} table Thread table.
 * @param {number} [turn] Current turn, for staleness.
 * @param {object} [options] Options.
 * @param {string} [options.at] The scene's location, for locality.
 * @returns {object[]} Threads with `dial`, `pressure`, `local` and `stale` attached.
 */
export function threads(table, turn = 0, { at = '' } = {}) {
    return table_entries(table)
        .map(([key, value]) => ({
            ...value,
            key,
            dial: dialOf(value),
            stale: Math.max(0, turn - (value?.turn ?? 0)),
            pressure: hasDial(value) ? (value?.filled ?? 0) / normalizeSize(value?.size, value?.kind) : 0,
            // Pressure that applies HERE. A thread with no place applies everywhere — a debt, a
            // deadline, a rumour spreading — and one bound to a place applies only there.
            local: !value?.where || !at || samePlace(value.where, at),
        }))
        .sort((a, b) => b.pressure - a.pressure || a.stale - b.stale);
}

/**
 * Do these two place names refer to the same place?
 *
 * Exact equality, and deliberately nothing more. This used to be a token-subset test ("the dining
 * hall" and "the great hall" stay apart because neither set contains the other) built on an English
 * stopword list — a string algebra deciding locality in exactly one language. The model is told to
 * word a place exactly as the narration words it (the entities probe: "a differently-worded place
 * makes a person vanish from the room"), so fold compares what the model reported, exactly. Whether
 * two spellings name one place is the model's reading, resolved by the review probe's `[same?]` and
 * `[where now?]` questions — never a fold guess from words.
 *
 * @param {string} a One place.
 * @param {string} b Another.
 * @returns {boolean} True only if they are the same string.
 */
export function samePlace(a, b) {
    return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

/**
 * The content tokens of a thread name.
 *
 * Possessives are kept whole ("kang's" stays one token) because dropping the apostrophe-s would
 * make "Kang's squad" and "Kang squad" differ in token COUNT, and the substitution test below
 * counts tokens.
 *
 * @param {string} raw A name.
 * @returns {string[]} Content tokens, lowercased, in order.
 */
export function nameTokens(raw) {
    return String(raw ?? '').toLowerCase()
        .split(/[^\p{L}\p{N}'-]+/u)
        .filter(word => word.length > 0);
}

/**
 * Might these two names be the same thing?
 *
 * ── A trigger for a question, never a decision ──
 *
 * FOLD-REDESIGN.md §11 bans similarity metrics for identity, and this is not one. A metric that
 * DECIDES identity has to be right, because a wrong merge is unrecoverable without a hand repair;
 * a detector that ASKS only has to be right often enough that the question budget stays small, and
 * every miss is recoverable by a hand merge. This function returns a reason for asking and never
 * merges anything.
 *
 * The rule is: strict containment, OR same first token with one substitution. Both halves were
 * forced by measured pairs:
 *
 *   subset        `person␀broker` (turn 11) and `person␀scarred broker` (turn 10) are one man
 *                 behind one counter; "broker" ⊂ "scarred broker".
 *   substitution  `next raid with Kang's squad` and `next raid with Kang's team` opened as two
 *                 threads. Neither token set contains the other, so a subset test alone —
 *                 which is what `samePlace` uses and what the first draft proposed — CANNOT
 *                 catch it. One substitution can.
 *
 * ── Subset needs no shared head token, and the measured duplicates said so ──
 *
 * The earlier rule required a shared first OR last token before the subset check ran, so a name
 * that REFINED another at neither end was never asked about. An echoed review label breaks both
 * ends at once: "T1 Karr of the Red Hand gathers strength — the east falls to rai" is a strict
 * superset of "Karr of the Red Hand gathers strength" (the `T1` is a block id the model copied and
 * the tail is the dial's own `about` restated), and it sat as a duplicate dial — one at 1/6, one
 * filled to 6/6 and still open — until a hand merge. A name fully inside another IS "one refines
 * the other" whether or not the refinement lands at an end, and a detector that ASKS costs a
 * question slot, never a wrong merge.
 *
 * The substitution branch keeps a first-token gate, and the measured false pairs are all
 * substitutions, not subsets: `Lord Everard` / `Lillian Everard` agree on a surname in final
 * position and differ in one token; `the dining hall` / `the great hall` share a last noun and
 * differ in the adjective. Neither is a subset, so neither is touched by relaxing the subset gate.
 *
 * Measured result across all four live chats: three questions, all three genuine — two Evil Hero
 * Party splits (`Paulette` / `Paulette Le Maltildis`, `Lillian` / `Lillian Everard`) and, through
 * the migration's own cross-table rule, the residency pair.
 *
 * @param {string} a One name.
 * @param {string} b Another.
 * @returns {string|null} 'subset', 'substitution', or null when there is no question to ask.
 */
export function nearIdentity(a, b) {
    const [left, right] = [nameTokens(a), nameTokens(b)];
    if (!left.length || !right.length) {
        return null;
    }
    const [smallArr, largeArr] = left.length <= right.length ? [left, right] : [right, left];
    const small = new Set(smallArr);
    const large = new Set(largeArr);
    // Identical token sets. Not a question — either the keys already collapsed or the names differ
    // only in noise words, and asking "are these two the same?" about one thing is a question that
    // erodes trust in every other question.
    if (small.size === large.size && [...small].every(token => large.has(token))) {
        return null;
    }
    // Strict containment is the refinement signal, and it needs no shared head token.
    //
    // "T1 Karr of the Red Hand gathers strength — the east falls to rai" contains every token of
    // "Karr of the Red Hand gathers strength": the `T1` is a review-block label the model echoed
    // into the name and the tail is the dial's own `about` restated. A head-token gate checks the
    // FIRST or LAST position, and an echoed prefix defeats both — this pair sat unreconciled as a
    // duplicate dial in the Royal Succession chat, one at 1/6 and one filled to 6/6 and still open.
    //
    // The spurious pairs the head gate was added to exclude — Lord Everard / Lillian Everard, the
    // dining hall / the great hall — are SUBSTITUTIONS (same size, disagree in one position), and
    // the substitution branch below keeps its own gate. A name fully inside another is "one refines
    // the other" whether or not the refinement lands at an end.
    if ([...small].every(token => large.has(token))) {
        return 'subset';
    }
    // One substitution: the sets are the same size and differ in exactly one member each way.
    // First token only — agreement in final position with disagreement before it is what a surname
    // looks like (the Everards), and only a shared first token licenses that question.
    if (left[0] === right[0] && small.size === large.size) {
        const missing = [...small].filter(token => !large.has(token));
        if (missing.length === 1) {
            return 'substitution';
        }
    }
    return null;
}

/**
 * Every pair of records whose names raise the identity question.
 *
 * Returned rather than stored as a merge: the answer is the model's or the reader's (§2), and this
 * phase only supplies the question. Quadratic in the table size, which is fine at MAX_THREADS = 24
 * and is checked nowhere hotter than a migration and a panel repaint.
 *
 * @param {Array<{key: string, name: string}>} records Records with names.
 * @returns {Array<{a: string, b: string, why: string}>} Pairs, by key.
 */
export function identityPairs(records) {
    const rows = Array.isArray(records) ? records : [];
    const pairs = [];
    for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
            const why = nearIdentity(rows[i]?.name, rows[j]?.name);
            if (why) {
                pairs.push({ a: rows[i].key, b: rows[j].key, why });
            }
        }
    }
    return pairs;
}

/**
 * Threads that are still live, in the order the reader should meet them.
 * @param {Map<string, object>} table Thread table.
 * @param {number} turn Current turn.
 * @param {object} [options] Options.
 * @param {string} [options.at] Scene location.
 * @returns {{pressure: object[], progress: object[], open: object[], done: object[]}} The split.
 */
export function threadsByKind(table, turn = 0, { at = '' } = {}) {
    const all = threads(table, turn, { at });
    const live = all.filter(thread => thread.status === OPEN_STATUS && thread.local && !isFull(thread));
    return {
        pressure: live.filter(thread => thread.dial?.kind === DOOM),
        progress: live.filter(thread => thread.dial?.kind === PROGRESS),
        open: live.filter(thread => !thread.dial && thread.stale < THREAD_STALE),
        // Closed, moot and filled, kept one turn so the completion is witnessed rather than
        // silently vanishing — the mechanism `entitiesOfKind` already implements for GONE
        // (`entity-table.js:610-613`).
        done: all.filter(thread => (thread.status !== OPEN_STATUS || isFull(thread)) && thread.stale === 0),
    };
}

/**
 * Every thread the review must be able to close.
 *
 * ── Deliberately NOT `threadsByKind`, and the hand-check against the live logs is why ──
 *
 * `threadsByKind` is the PROMPT's and the panel's view, and its two extra filters are right there
 * and wrong here:
 *
 *   `local`   a goblin nest counterattacks in the dungeon it lives in; it does not follow anyone to
 *             a noodle shop, so it is not pressure in the noodle shop. But a thread that is never on
 *             the review block can never be asked about, and a stake bound to a place you have left
 *             is exactly the stake most likely to have been settled off-screen. The measured case is
 *             the Goblin Market gear trip, which "sat open while the player stood inside it"
 *             (`FOLD-REDESIGN.md` §2) and would have dropped off this list the moment he walked out.
 *   `stale`   THREAD_STALE hides a thread nobody has named for twenty turns. Its own docblock calls
 *             that "a hide, not a delete, and on borrowed time: §11 rules out decay, and Phase C's
 *             review is the designed replacement". A hide that also prevents the replacement from
 *             running is not borrowed time, it is a deadlock. The hiding survives for the prompt one
 *             more phase; it no longer decides what can close.
 *
 * What stays: `status` and `isFull`. A thread already closed or already fired is not an open line,
 * and asking about it is how a review learns that most of its questions have no answer.
 *
 * @param {Map<string, object>} table Thread table — the overlaid view, so live closures count.
 * @param {number} [turn] Current turn.
 * @returns {object[]} Threads to put on the review block, most urgent first.
 */
export function reviewable(table, turn = 0) {
    return threads(table, turn)
        .filter(thread => thread.status === OPEN_STATUS && !isFull(thread));
}

/**
 * Render the doom dials for the prompt.
 *
 * A hidden dial is named but not quantified. The narrator knows something is closing in and how
 * near it is stays theirs to decide — the difference between a tracker that helps a GM and one
 * that spoils its own surprises.
 *
 * @param {Map<string, object>} table Thread table.
 * @param {number} [turn] Current turn.
 * @param {object} [options] Options.
 * @param {string} [options.at] Scene location.
 * @returns {string} A line for the injected block, or ''.
 */
export function renderPressure(table, turn = 0, { at = '' } = {}) {
    const live = threadsByKind(table, turn, { at }).pressure;
    if (!live.length) {
        return '';
    }
    return `Pressure: ${live.map(thread => {
        const body = thread.seen === HIDDEN
            ? `${thread.name} (closing in)`
            : `${thread.name} ${thread.filled}/${thread.dial.size}`;
        return thread.about ? `${body} — ${thread.about}` : body;
    }).join('; ')}`;
}

/**
 * Render the progress tracks for the prompt.
 *
 * ── Never under `Pressure:` ──
 *
 * This is the whole reason polarity exists. Two dials for the residency stake were both printed as
 * pressure by the code this replaces, one of which filled toward *"Solomon completes 20 D-rank
 * raids and gains residency"*. Telling a narrator that the player's own achievement is a mounting
 * threat is an instruction to write against the player, and the model followed it.
 *
 * @param {Map<string, object>} table Thread table.
 * @param {number} [turn] Current turn.
 * @param {object} [options] Options.
 * @param {string} [options.at] Scene location.
 * @returns {string} A line for the injected block, or ''.
 */
export function renderProgress(table, turn = 0, { at = '' } = {}) {
    const live = threadsByKind(table, turn, { at }).progress;
    if (!live.length) {
        return '';
    }
    return `Progress: ${live.map(thread => {
        const body = thread.seen === HIDDEN
            ? `${thread.name} (underway)`
            : `${thread.name} ${thread.filled}/${thread.dial.size}`;
        return thread.about ? `${body} — ${thread.about}` : body;
    }).join('; ')}`;
}

/**
 * Render the dial-less threads for the prompt.
 *
 * Named `Threads:` rather than the `Leads:` this replaces. The label is the one the design uses at
 * every altitude (§8), and it is the honest one now that the same table holds dials: a lead was
 * only ever a thread nobody could measure.
 *
 * @param {Map<string, object>} table Thread table.
 * @param {number} [turn] Current turn.
 * @returns {string} A line for the injected block, or ''.
 */
export function renderOpenThreads(table, turn = 0) {
    const live = threadsByKind(table, turn).open;
    if (!live.length) {
        return '';
    }
    return `Threads: ${live.map(thread => {
        let body = thread.detail ? `${thread.name} — ${thread.detail}` : thread.name;
        // The unresolved part is the reason the thread is in the prompt at all; without it the
        // model reads back a statement and has nothing to push against.
        if (thread.open) {
            body += `; ${thread.open}`;
        }
        return thread.source ? `${body} (${thread.source})` : body;
    }).join('; ')}`;
}

/**
 * Render every live thread for the prompt, each under its own heading.
 * @param {Map<string, object>} table Thread table.
 * @param {number} [turn] Current turn.
 * @param {object} [options] Options.
 * @param {string} [options.at] Scene location.
 * @returns {string} Lines for the injected block, or ''.
 */
export function renderThreads(table, turn = 0, { at = '' } = {}) {
    return [
        renderPressure(table, turn, { at }),
        renderProgress(table, turn, { at }),
        renderOpenThreads(table, turn),
    ].filter(Boolean).join('\n');
}

/**
 * Apply live closure events over the stored thread table.
 *
 * ── The shape decision, and the swipe scenario that forced it ──
 *
 * `FOLD-REDESIGN.md` §2 promises three things at once: closures land as ledger events, nothing is
 * deleted in place, and swiping away the closing turn un-closes the thread. Threads are a *stored*
 * table (Phase B kept the entities pattern, because a thread is a standing fact a turn revealed
 * rather than the result of an event), so those three cannot all hold by writing `status: closed`
 * into the row. Three shapes were considered:
 *
 *   1. **Write the status into the row.** Simplest, and it fails the third promise outright. The
 *      user swipes the closing reply away; the fiction it contained never happened on this branch;
 *      the thread stays closed and there is no record anywhere of why. Worse, it fails silently —
 *      the panel shows a settled stake and nothing distinguishes that from a stake the story really
 *      settled. This is `merge_NB`'s monotonicity problem wearing different clothes
 *      (`FOLD-RPG-GAP.md` §1), and the design's whole complaint is that nothing in fold can retract.
 *
 *   2. **Move threads into the ledger entirely**, deriving the table the way state is derived.
 *      Honest, and much too large for this phase: it would rewrite `foldThread`, `merge_thread`, the
 *      migration and every consumer, and it would lose the field-wise merge that lets a tick which
 *      says only "+1" leave `about` alone. Phase B measured that merge into place across four chats.
 *
 *   3. **Stored table, read-time overlay.** The closure is an event carrying `d.threads:
 *      [{key, status}]`; the stored row keeps whatever the extraction pass last said; every READ
 *      path composes the two. Chosen. It is not a new mechanism — it is exactly how `deriveState`
 *      makes state branch-aware (`state-table.js`, folding only `chronicle.liveEvents()`), and how
 *      `chronicle.js` decides which events exist at all: content-key liveness, `chronicle.js:59-84`.
 *
 * The swipe scenario, spelled out. Message 62 settles the weapon thread; the review pass records an
 * event whose `k` is message 62's content key and whose delta is `{threads: [{key: 'a weapon that
 * is not a goblin's knife', status: 'closed'}]}`. The panel and the prompt read the thread through
 * this function and see `closed`. The user swipes message 62; SillyTavern replaces its text, so its
 * content key changes; `liveHashes()` no longer contains the old key; `liveEvents()` drops the
 * closure; this function receives an empty list and the stored row — still `open`, never edited —
 * reads open again. Swipe back and it closes again. No third state, no repair, no per-message
 * snapshot (`FOLD-REDESIGN.md` §11 rules those out, and this is why they are not needed).
 *
 * Order matters and is chronological: `liveEvents()` sorts by `t`, so a thread closed at turn 40 and
 * re-opened by a later review at turn 44 reads open. Last writer wins, within the branch.
 *
 * @param {Map<string, object>} table The stored thread table.
 * @param {Array<{key: string, status: string}>} closures Closure records, oldest first.
 * @returns {Map<string, object>} A new table with the closures applied. Never mutates the input.
 */
export function overlayClosures(table, closures) {
    const list = Array.isArray(closures) ? closures : [];
    if (!list.length) {
        return table;
    }
    const out = new Map(table);
    for (const closure of list) {
        const raw = String(closure?.key ?? '');
        if (!raw) continue;
        // Aliases are followed, because a merge confirmed by one review pass renames the row a
        // later closure event still refers to by its old key. `canonicalThreadKey` is the same
        // one-hop resolution the write path uses, so a closure and a tick agree about what they
        // are talking about.
        const key = out.has(raw) ? raw : canonicalThreadKey(out, normalizeThreadName(raw)?.key ?? raw);
        const row = out.get(key);
        if (!row) continue;
        out.set(key, { ...row, status: normalizeStatus(closure?.status) });
    }
    return out;
}

/**
 * Merge two threads the review has confirmed are one stake.
 *
 * Same argument as `mergeEntities` (`entity-table.js`) for why this is a write rather than an
 * overlay: `merge_thread`'s alias set is the Set face, and a name a stake was once called does not
 * stop having been used for it. `next raid with Kang's squad` and `next raid with Kang's team`
 * opened as two threads in the live chat because leads had no `aka` at all
 * (`FOLD-REDESIGN.md` §0.1-6); accumulating the loser's name into the keeper's `aka` is what stops
 * the next mention of either wording opening a third.
 *
 * ── The dial does not add up, and that is not an oversight ──
 *
 * A confirmed merge says these were one stake counted twice, so the fills are two readings of one
 * position, not two positions to sum. `merge_thread` accumulates `filled` because ticks accumulate;
 * a merge is not a tick. The residency pair is the measured case: a dial-less lead reading "1 of 20
 * logged" and a `doom` clock at 1/8 (`FOLD-REDESIGN.md` §4). Adding those would produce a
 * meaningless 2, and averaging them would invent a number nobody wrote. So the dial-bearing record's
 * dial survives whole — `kind`, `size` and `filled` together, because a fill is only meaningful
 * against the size it was measured on — and if both bear dials the keeper's wins, with the loser's
 * name preserved in `aka` so a hand correction can find it.
 *
 * The keeper is the dial-bearing row when exactly one bears a dial, since a measurable position is
 * strictly more than none; otherwise the longer name, for `mergeEntities`' reason.
 *
 * @param {Map<string, object>} table Thread table, mutated.
 * @param {string} left One table key.
 * @param {string} right Another.
 * @returns {{key: string, dropped: string}|null} What survived and what was folded into it.
 */
export function mergeThreads(table, left, right) {
    if (!left || !right || left === right) {
        return null;
    }
    const a = lookup(table, left, null);
    const b = lookup(table, right, null);
    if (!a || !b) {
        return null;
    }
    // The keeper is the dial-bearing row when exactly one bears a dial, since a measurable position
    // is strictly more than none; when both bear dials, the one with MORE FILL is the position the
    // story has actually reached, and the duplicate's less-advanced reading must not erase it.
    // "T1 Karr of the Red Hand gathers strength — the east falls to rai" was kept over its own
    // canonical name purely because the name was longer — and its dial read 1/6 while the canonical
    // row was at 7/8, so the merge moved the Karr clock BACKWARDS. A longer name is a cosmetic tie
    // break, never a reason to lose progress; the fill is not.
    const [dialled] = hasDial(a) !== hasDial(b)
        ? [hasDial(a) ? left : right]
        : hasDial(a)
            ? [normalizeSize(a.size, a.kind) - (a.filled ?? 0) <= normalizeSize(b.size, b.kind) - (b.filled ?? 0) ? left : right]
            : [null];
    const longer = String(a.name ?? '').length >= String(b.name ?? '').length ? left : right;
    const keepKey = dialled ?? longer;
    const dropKey = keepKey === left ? right : left;
    const keep = lookup(table, keepKey, {});
    const drop = lookup(table, dropKey, {});

    const merged = { ...drop };
    for (const [field, value] of Object.entries(keep)) {
        if (value !== undefined && value !== null && value !== '') {
            merged[field] = value;
        }
    }
    merged.name = keep.name;
    merged.aka = [keep.aka, drop.name, drop.aka]
        .flatMap(part => String(part ?? '').split(/[,;/|]/))
        .map(part => normalizeThreadName(part))
        .filter(parsed => parsed && parsed.key !== normalizeThreadName(keep.name)?.key)
        .map(parsed => parsed.display)
        .filter((name, index, all) => all.indexOf(name) === index)
        .join(', ')
        .slice(0, MAX_THREAD_TEXT);
    merged.first = Math.min(...[keep.first, drop.first, keep.turn, drop.turn].filter(Number.isFinite));
    merged.turn = Math.max(keep.turn ?? 0, drop.turn ?? 0);
    // The dial survives whole or not at all; see the docblock. `filled` is never a sum here.
    const dial = hasDial(keep) ? keep : (hasDial(drop) ? drop : null);
    if (dial) {
        merged.kind = normalizeKind(dial.kind);
        merged.size = normalizeSize(dial.size, merged.kind);
        merged.filled = clamp(dial.filled ?? 0, merged.size, merged.kind);
    }

    table.set(keepKey, merged);
    table.delete(dropKey);
    return { key: keepKey, dropped: dropKey };
}
