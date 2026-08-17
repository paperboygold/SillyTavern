/**
 * fold/crosswalk.js — the relabel that turns two names for one thing into one row.
 *
 * Pure, like every table module: a fold over the answer table and the event stream, no storage and
 * no app graph.
 *
 * ── What it is ──
 *
 * `KeyResolution.relabel : K → K` from the sanguine corpus, made concrete. Identity verdicts arrive
 * as pairs (`state.answers`), the ledger is keyed by `itemKey(name, place)`, and until now a `same`
 * verdict on two ITEM keys had nowhere to go: cast and thread merges rewrite a stored table, but
 * inventory has no table to rewrite — it is a fold over the chronicle. So merging two item keys means
 * relabelling the event stream, which is this module, applied inside `deriveState`.
 *
 * ── Why late relabel is sound, and exactly where it stops being sound ──
 *
 * `KeyResolution.accum_append` licenses resolving a key AFTER the events were written precisely when
 * the merge is a commutative monoid. Inventory's `dq` path is addition, so it qualifies: folding
 * `a+=20` then `b+=30` and relabelling `b→a` gives 50, and so does relabelling first. Order cannot
 * matter for a sum.
 *
 * `IncrementalResolution.relabelInc_const` adds the condition this module is built to satisfy: a
 * resolver that reads the PREFIX of the stream it is resolving breaks the split even at a commutative
 * monoid, and a pass that reads no prefix IS `relabel` and is therefore sound. So `aliasMap` is a
 * pure function of the answer table — it never consults the partially-folded inventory. This is not a
 * theoretical nicety; `canonicalItemName` in `state-table.js` does read the accumulating `inv`, which
 * is why it is left alone here rather than extended.
 *
 * The `set` path is NOT a commutative monoid — an absolute restatement is last-write-wins, and
 * `KeyResolution.resolution_breaks_key_independence` is about exactly that. If two keys in one
 * component each carry a `set`, the merged result depends on their order and the relabel is not
 * licensed. `unsoundComponents` reports those instead of silently picking a winner. Measured over the
 * corpus the day this was written: 5 `set` deltas exist in total, all in Royal Succession, on `coin`
 * and `marks` — two currencies nothing proposes to merge. So the hazard is real, currently unhit,
 * and reported rather than assumed away.
 *
 * ── The duplicate guard lives here too, and that is not scope creep ──
 *
 * Relabelling alone makes the ledger WORSE, which is worth stating plainly:
 *
 *   Wuxia, before          carried/silver wen 21   money/silver 76     (split, two rows)
 *   Wuxia, relabel only    money/silver 97                             (one row, wrong number)
 *   Wuxia, this module     money/silver 77                             (one row, right number)
 *
 * Read that table as conditional, not as a report: it is what the fold produces GIVEN a `same`
 * verdict for the pair. No such verdict exists in any live chat — persisted answers across nine
 * campaigns are 21 cast, 48 thread, zero item — so live Wuxia is still two rows today. The numbers
 * were measured by seeding the verdict and on a duplicated chat. Mechanism verified; live effect not.
 *
 * The reason is that the split and the double-count are the same incident. The model reported one
 * transfer twice — `carried/silver wen +20` at mid 46 and `money/silver +20` at mid 48 — and the two
 * reports landed on different keys, so nothing could see they were one event. Merging the keys is
 * what makes the duplicate VISIBLE. A crosswalk that merged without deduping would turn an obviously
 * broken ledger into a confidently wrong one, which is the worse failure for a year-long campaign.
 *
 * `chronicle-table.js` already dedups, by exact keyword-set equality inside `DUPLICATE_WINDOW`. It
 * missed every one of these because the keyword sets drift between readings of the same message —
 * one case is a strict subset of the other:
 *
 *   mid 36  ["sol","spear","smith","purchase","silver"]
 *   mid 38  ["spear","smith","purchase","silver"]        same event, different signature
 *
 * That guard is about EVENTS. This one is about DELTAS, downstream of the relabel, and the two do not
 * substitute for each other.
 *
 * ── DUP_GAP is read off a distribution, not dialed ──
 *
 * Every pair of inventory deltas in the corpus sharing a key and a signed quantity, by mid gap:
 *
 *   gap  1   Isekai      money/copper +8        "received eight copper coins" / "sold ... for eight"
 *   gap  1   Time Stop   locket −1              "gave the locket back" / "returns his silver moon locket"
 *   gap  1   Time Stop   money/silver −2        the same room at the Spear & Thistle, twice
 *   gap  1   Time Stop   money/silver −12       the same pack from Oda, twice
 *   gap  2   Time Stop   money/silver −10       the same spear from the smith, twice
 *   gap  2   Wuxia       money/silver +20       the same fee from Shen Yue, twice   [needs the relabel]
 *   ── nothing between 3 and 51 ──
 *   gap 52   Solo Lev.   darkwood staff +1      bought at mid 63, RETURNED by Kang at mid 115
 *
 * Six duplicates, one genuine recurrence, and an empty band of forty-nine mids between them. `2` is
 * where the data says the boundary is; there is no observation to dial it against inside that band.
 * The gap-52 pair is the control — a real second acquisition of a real object, correctly kept.
 *
 * Deltas sharing a mid are never compared. One event legitimately reports one item twice (a gain and
 * an offsetting loss in the same beat), and the corpus contains no same-mid duplicate to justify
 * touching them.
 *
 * ── Two write paths reach this module, and they cover different splits ──
 *
 * Both land in `state.answers` and neither is preferred; they are listed because each is blind to the
 * other's case and a reader will otherwise assume one of them is redundant.
 *
 *   `plan.currency`   The model volunteers, reading the pinned `Money:` line (`review-table.js`
 *                     `same_currency`). `renderLedger` builds that line from `place === MONEY` rows
 *                     ONLY, so both sides are money-place by construction and `review.js` keys them
 *                     that way. Covers the SAME-PLACE split — Isekai's `money/copper coins` against
 *                     `money/copper`. Costs no question slot, because it was never asked.
 *
 *   `itemQuestions`   `invariant-table.js` raises a witness from the ledger itself and the review
 *                     asks it as an `of: 'item'` pair. The keys are real ledger keys, so this is the
 *                     path that reaches CROSS-PLACE splits — Wuxia's `carried/silver wen` against
 *                     `money/silver`, which never appears in the Money block at all and which the
 *                     volunteered field therefore cannot name.
 *
 * The `known` filter in `aliasMap` is what keeps a verdict naming a key the ledger does not hold from
 * doing anything, silently and safely, whichever path wrote it.
 *
 * ── RULE 1 ──
 *
 * Nothing here reads narrative text. The relabel is a lookup on fold's own keys; the duplicate guard
 * compares fold's own numbers and message indices. The identity verdicts it consumes are the model's
 * answers, arriving through the schema on the pass that already runs. No word list, no stoplist, no
 * substring test on prose, and every rule states the same thing in every language.
 */

import { MONEY, itemKey, normalizeItemName, splitItemKey } from './state-table.js';
import { SAME } from './review-table.js';
import { table_entries } from './lib/hash.js';

/**
 * How far apart two identical deltas can be and still be one event read twice.
 *
 * See the distribution in the module docblock: six duplicates at gap ≤ 2, the next observation at
 * gap 52 and genuine. Expressed in message indices because that is what an overlapping extraction
 * window slides over.
 */
export const DUP_GAP = 2;

/** The separator `pairKey` joins an answered pair with. */
const PAIR_SEP = String.fromCharCode(1);

/**
 * Union-find, iterative. The components are tiny (two or three keys) but a campaign accumulates
 * verdicts for a year, so the structure is the one that stays flat rather than the one that reads
 * prettily.
 */
function findRoot(parent, key) {
    let node = key;
    while (parent.get(node) !== node) {
        parent.set(node, parent.get(parent.get(node)));
        node = parent.get(node);
    }
    return node;
}

/**
 * Choose the surviving name for a merged component.
 *
 * Two requirements, both structural:
 *
 *   · DETERMINISTIC and prefix-independent, or `relabelInc_const` does not apply. So it is a pure
 *     function of the member key set — not of arrival order, not of which row happens to be larger,
 *     and not of which verdict landed last. `resolution_max_converges` is the reminder that
 *     last-write is the thing that fails here.
 *   · A currency belongs at `money`. That is a PROTOCOL token — one of the four values the delta
 *     schema tells the model to write in `at` — not an English word fold is interpreting. Wuxia's
 *     split is `carried/silver wen` against `money/silver`, so a crosswalk that could not move place
 *     would not heal the only real case the corpus contains.
 *
 * Lexicographic minimum breaks the remaining ties. It carries no meaning and is not claimed to pick
 * the better name; it is picked because it is stable under re-derivation, which is the property that
 * matters. (It does land correctly on Isekai's `money/copper` over `money/copper coins`, by prefix.)
 *
 * @param {string[]} keys Member keys of one component.
 * @returns {string} The surviving key.
 */
export function canonicalKey(keys) {
    const sorted = [...keys].sort();
    const atMoney = sorted.filter(key => splitItemKey(key).place === MONEY);
    return (atMoney.length ? atMoney : sorted)[0];
}

/**
 * Build the relabel map from stored identity verdicts.
 *
 * Restricted to keys the ledger actually holds, which is what keeps the cast namespace out. Entity
 * keys (`person␀elspeth`) and inventory keys (`money␀silver`) share a separator and a shape, so
 * `person` would otherwise read as a place. Rather than test the place against the string "person" —
 * a word, and places can legitimately BE people, as Royal Succession's `lisandra␀written commission`
 * shows — the map only admits keys observed in the event stream. A verdict about two people is inert
 * because neither side is ever an inventory key.
 *
 * @param {Map<string, {answer?: string}>|object} answers The `state.answers` table.
 * @param {Set<string>} known Inventory keys observed in the event stream.
 * @returns {Map<string, string>} alias -> canonical. Identity entries are omitted.
 */
export function aliasMap(answers, known) {
    const entries = answers instanceof Map ? table_entries(answers) : Object.entries(answers ?? {});
    const parent = new Map();
    const add = (key) => { if (!parent.has(key)) parent.set(key, key); };

    for (const [pair, value] of entries) {
        if (value?.answer !== SAME) continue;
        const [a, b] = String(pair).split(PAIR_SEP);
        // `pairKey` sorts and joins, so a pair is exactly two sides. Anything else is not one.
        if (!a || !b || !known.has(a) || !known.has(b)) continue;
        add(a);
        add(b);
        const rootA = findRoot(parent, a);
        const rootB = findRoot(parent, b);
        if (rootA !== rootB) parent.set(rootA, rootB);
    }

    const members = new Map();
    for (const key of parent.keys()) {
        const root = findRoot(parent, key);
        members.set(root, [...(members.get(root) ?? []), key]);
    }

    const map = new Map();
    for (const group of members.values()) {
        const canonical = canonicalKey(group);
        for (const key of group) {
            if (key !== canonical) map.set(key, canonical);
        }
    }
    return map;
}

/**
 * Every inventory key the event stream mentions, and which of them carry an absolute restatement.
 *
 * One pass, before the fold, so the alias map can be restricted to real keys without consulting a
 * partially-built inventory — the prefix-independence `relabelInc_const` requires.
 *
 * ── It must key EXACTLY as `deriveState` keys, so it calls the same function ──
 *
 * This began as `String(item).trim().toLowerCase()`, which looked equivalent and is not.
 * `normalizeItemName` also strips decoration, lifts a quantity out of the name (`20 silver wen` →
 * `silver wen`), drops trailing punctuation, truncates at `MAX_ITEM_NAME` and refuses `UNSAFE_KEYS`.
 * The divergence was silent and total: the fold keyed `carried␀silver wen`, this keyed
 * `carried␀20 silver wen`, so `known` never contained the real row and `aliasMap` dropped every
 * verdict about it. Not a crash — just a crosswalk that never fired.
 *
 * That is the same mistake that produced the `−11` and the `marks −8500`: reimplementing a shipped
 * fold because the reimplementation looked obviously equivalent. The instrument has to BE the
 * shipped one. `tests/fold-crosswalk.test.js` pins it with a decorated name.
 *
 * @param {Array<{d?: object}>} events Events.
 * @returns {{keys: Set<string>, setKeys: Set<string>}} Observed keys, and those with a `set`.
 */
export function observedKeys(events) {
    const keys = new Set();
    const setKeys = new Set();
    for (const event of events ?? []) {
        for (const change of event?.d?.inv ?? []) {
            const name = normalizeItemName(change?.item)?.name ?? '';
            if (!name) continue;
            const key = itemKey(name, change?.at);
            keys.add(key);
            if (Number.isFinite(change?.set)) setKeys.add(key);
        }
    }
    return { keys, setKeys };
}

/**
 * Components the relabel is NOT licensed to merge.
 *
 * A component with two or more members carrying an absolute restatement is the
 * `resolution_breaks_key_independence` case: `set` is last-write, the merged stream's last `set`
 * depends on the order the two rows interleave, and no choice of representative repairs that. Fold
 * reports the component and leaves it split, because a split ledger is visibly wrong while a merged
 * one is invisibly wrong.
 *
 * @param {Map<string, string>} map alias -> canonical.
 * @param {Set<string>} setKeys Keys carrying a `set` delta.
 * @returns {Array<{canonical: string, keys: string[]}>} Components that must not be merged.
 */
export function unsoundComponents(map, setKeys) {
    const groups = new Map();
    for (const [alias, canonical] of map) {
        groups.set(canonical, [...(groups.get(canonical) ?? [canonical]), alias]);
    }
    const unsound = [];
    for (const [canonical, keys] of groups) {
        if (keys.filter(key => setKeys.has(key)).length > 1) {
            unsound.push({ canonical, keys: [...keys].sort() });
        }
    }
    return unsound;
}

/**
 * The crosswalk for one event stream: a relabel, plus what it refused to relabel.
 *
 * The consumer is `deriveState`, which receives this object rather than importing this module: the
 * crosswalk needs `itemKey` and `MONEY` from `state-table.js`, so importing it back would make a
 * cycle. `state.js` builds it and passes it in, the same way `seeds` and `reachKeys` already arrive.
 *
 * `deduper()` hands out a FRESH duplicate filter per fold. The suppression window is state, and state
 * shared between two derivations of the same events would make the second disagree with the first —
 * so it is owned by the fold, never by the crosswalk.
 *
 * ── The baseline's keys count as observed, and forgetting that fossilizes them ──
 *
 * `aliasMap` admits only keys the ledger demonstrably holds, which it learns from the event stream.
 * Once eviction carries a row into `state.baseline`, the events that named it are gone — so the key
 * stops being "observed" and every verdict about it is silently dropped, exactly the failure mode
 * the `known` filter exists to prevent for cast keys. The row would then sit outside the crosswalk
 * forever, under whatever name it had when it was shed, and a later merge would leave a permanent
 * orphan beside the row it belongs to. So the baseline's own keys are unioned in: they are ledger
 * keys with no live event, which is precisely what a baseline IS.
 *
 * @param {Array<object>} events Events, live ones only.
 * @param {Map<string, object>|object} answers The `state.answers` table.
 * @param {Iterable<string>} [carried] Keys held only by the baseline, with no live event left.
 * @returns {{relabel: (key: string) => string, deduper: () => Function, map: Map<string, string>, unsound: Array<object>}} The crosswalk.
 */
export function buildCrosswalk(events, answers, carried = []) {
    const { keys, setKeys } = observedKeys(events);
    for (const key of carried ?? []) {
        keys.add(key);
    }
    const map = aliasMap(answers, keys);
    const unsound = unsoundComponents(map, setKeys);
    // A refused component is dropped wholesale: every member goes back to standing alone, so the
    // ledger shows the split it actually has rather than a partial merge nothing argued for.
    for (const component of unsound) {
        for (const key of component.keys) map.delete(key);
    }
    return {
        map,
        unsound,
        relabel: (key) => map.get(key) ?? key,
        deduper: () => {
            const seen = new Map();
            return (key, dq, mid) => isDuplicateDelta(seen, key, dq, mid);
        },
    };
}

/**
 * Has this exact delta already been folded, near enough to be the same event read twice?
 *
 * Compares the relabelled key, the signed quantity and the message index — fold's own numbers, in
 * every language. Stateful across a single fold by design: `seen` is the caller's, one per
 * `deriveState`, never persisted, so a re-derivation reaches the same answer from the same events.
 *
 * @param {Map<string, Array<{mid: number, dq: number}>>} seen Per-key history, mutated.
 * @param {string} key The relabelled inventory key.
 * @param {number} dq The signed change.
 * @param {number|null} mid The message index this delta came from.
 * @returns {boolean} True when this delta is a duplicate and must not be folded.
 */
export function isDuplicateDelta(seen, key, dq, mid) {
    // A delta with no message index cannot be placed in the window, so it is never suppressed:
    // an unanchored event is usually a migration seed or a review closure, not a re-reading.
    if (!Number.isFinite(mid) || !dq) return false;
    const history = seen.get(key) ?? [];
    // Same mid is the same reading reporting one item twice, which is legitimate and left alone.
    const duplicate = history.some(prior => prior.dq === dq && prior.mid !== mid && Math.abs(mid - prior.mid) <= DUP_GAP);
    if (!duplicate) {
        history.push({ mid, dq });
        seen.set(key, history);
    }
    return duplicate;
}
