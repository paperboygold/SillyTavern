/**
 * fold/observe.js — what the bounds actually did.
 *
 * ── Why this exists ──
 *
 * fold carries twenty-two numeric constants. Every one arrived with a sentence explaining why it is
 * the right number — "generous enough for real play", "one scene's worth of lag", "largest plausible
 * single-turn change" — and not one of them was measured. That is the defect the sanguine corpus
 * gates against by name: `check-roots.py` fails a commit when "a gate's prose outran its behaviour",
 * and `whispering-tides/src/globe.slang` will not state a roughness exponent without ETOPO beside it
 * (H = 0.5240 against Earth's 0.5262, r² = 0.9999) or an open gap "named rather than papered over".
 *
 * A constant cannot be justified or deleted until it is known whether it ever binds. So every bound
 * that changes an outcome records that it did, into one Count table keyed by rule. Then:
 *
 *   · a rule that never fires is decoration, and gets deleted;
 *   · a rule that fires constantly is set wrong, and the count says so;
 *   · a rule that fires occasionally has earned its number, and the count is the evidence.
 *
 * This is measurement, not telemetry: it is per-chat, it stays in `chat_metadata`, and nothing
 * leaves the browser.
 *
 * ── Two kinds of observation, deliberately distinguished ──
 *
 *   `reject:<reason>`  a validator refused a proposed change. The model asked, fold said no.
 *   `cap:<rule>`       a bound silently dropped or hid something nobody proposed. This is the
 *                      dangerous kind — a rejection is at least visible in the rejects tally,
 *                      whereas a cap that truncates a summary or evicts an event leaves no trace
 *                      at all. Counting them is the whole point of the split.
 */

import { insert_with, merge_bu, table_entries } from './lib/hash.js';
import * as log from './log.js';
import { commit, loadTable } from './store.js';

const OBSERVED_PATH = 'state.observed';

/** @returns {Map<string, number>} rule -> times it bound. */
export function load() {
    return loadTable(OBSERVED_PATH);
}

/**
 * Record that a bound bound.
 *
 * The Count face, which is the whole mechanism: `merge_bu` is `+`, so this is one `insert_with` and
 * the table is a histogram by construction.
 *
 * @param {string} rule The rule that fired, already namespaced.
 * @param {number} [times] How many times, for a batch.
 */
export function note(rule, times = 1) {
    const key = String(rule ?? '').trim();
    if (!key || !Number.isFinite(times) || times <= 0) {
        return;
    }
    const table = load();
    insert_with(table, merge_bu, key, Math.trunc(times));
    commit(OBSERVED_PATH, table);
}

/**
 * Record a batch of validator rejections.
 *
 * The tally (`reject:<reason>`) says how often a rule fired; this ALSO writes each refusal to the
 * diagnostics log (`log.js`), so the panel can show WHAT was refused — the raw proposal and the
 * window it was read from — not just that something was. The entry carries `mid`/`turn` when the
 * caller knew them, for the cause-link jump.
 * @param {Array<{reason: string, item?: string, mid?: number, turn?: number, raw?: object, snippet?: string}>} rejections Rejections from a validator.
 */
export function noteRejections(rejections) {
    if (!rejections?.length) {
        return;
    }
    const table = load();
    for (const rejection of rejections) {
        const reason = String(rejection?.reason ?? '').trim();
        if (reason) {
            insert_with(table, merge_bu, `reject:${reason}`, 1);
            log.note({
                kind: 'reject',
                reason,
                item: rejection?.item,
                mid: rejection?.mid,
                turn: rejection?.turn,
                // The caret-level record: what the model literally proposed, and the window it
                // was reading. `raw` may be an object or a scalar — serialize for storage.
                raw: typeof rejection?.raw === 'object' && rejection.raw !== null
                    ? JSON.stringify(rejection.raw)
                    : String(rejection?.raw ?? ''),
                snippet: rejection?.snippet,
            });
        }
    }
    commit(OBSERVED_PATH, table);
}

/**
 * Record that a cap dropped or hid something.
 * @param {string} rule Short rule name.
 * @param {number} [times] How many were dropped.
 */
export function noteCap(rule, times = 1) {
    note(`cap:${rule}`, times);
}

/**
 * What every bound did in this chat, busiest first.
 * @returns {Array<{rule: string, count: number, kind: string}>} The observations.
 */
export function report() {
    return table_entries(load())
        .map(([rule, count]) => ({
            rule: rule.replace(/^(reject|cap|verdict|pressure|threads|review|lock|world):/, ''),
            kind: rule.startsWith('cap:') ? 'cap'
                : rule.startsWith('extract:') ? 'pass'
                    : rule.startsWith('verdict:') ? 'verdict'
                        : rule.startsWith('review:') || rule.startsWith('lock:') ? 'review'
                            : rule.startsWith('world:') ? 'world'
                                : rule.startsWith('pressure:') || rule.startsWith('threads:') ? 'pressure' : 'reject',
            count: Number(count) || 0,
        }))
        .sort((a, b) => b.count - a.count);
}

/**
 * The rules fold knows about, so the report can say which have NEVER fired.
 *
 * A silent zero is the finding, not the absence of one: a bound that has never bound in a long chat
 * is a number nobody needed. Listing them is what turns "no data" into "delete this".
 */
export const KNOWN_RULES = Object.freeze([
    // Validator rejections — the model proposed, fold refused.
    'reject:not-mentioned', 'reject:implausible-delta', 'reject:rate-limited',
    'reject:unusable-name', 'reject:no-change', 'reject:remove-unknown',
    'reject:inventory-full', 'reject:clamped-underflow', 'reject:vitals-full',
    'reject:implausible-max', 'reject:flags-full', 'reject:negation',
    'reject:entities-full', 'reject:clock-reversed', 'reject:exposition',
    'reject:implausible-tick', 'reject:clocks-full',
    // The double-billing gates. `already-recorded` is the backstop behind the window split: the
    // model was shown the line and proposed gaining it again anyway. `not-an-item` is the contacts
    // place the model invented for itself at mid 52 of the live Solo Leveling chat. Both are
    // expected to fire rarely once the split and the instruction are working — a count that keeps
    // climbing means the pinned ledger is not being read, which is a different bug from a leak.
    'reject:already-recorded', 'reject:not-an-item',
    // A mark proposed for somebody fold has never heard of. An invented owner is worse than none —
    // an unowned mark lands on the point-of-view character, which is where the panel was silently
    // putting all of them anyway, while an invented one opens a person-shaped hole nothing will ever
    // close (`state-table.js` `resolveOwner`, `FOLD-REDESIGN.md` §3).
    'reject:unknown-owner',
    // The threads table's own refusals. `threads-full` replaces `clocks-full` — the cap now bounds
    // leads and dials together, and the old name is kept below because live chats already carry
    // counts under it and a renamed rule with no history reads as a rule that never fired.
    'reject:threads-full',
    // The demotion side of the same cap: a thread that gave up its slot was ARCHIVED to the cold
    // store, not deleted — `threads-archived` counts the demotions, `reject:threads-full` now only
    // the one case that still refuses (the table full of dial-bearing open threads). See
    // `cold-store.js` ([EVICT]: eviction is demotion, never a relevance-judged delete).
    'cap:threads-archived',
    // The same demotion for the cast: a person nobody has mentioned for two stale windows moves to
    // the cold store instead of ceasing to exist, so they can be recalled the moment the story
    // returns to them. `cast-archived` counts those demotions.
    'cap:cast-archived',
    // Re-promotion by coverage: a cold row whose subject the window mentions is written back into
    // its hot table — a WRITE into the tracked state, never a paste into the window ([AC-PRODUCT]).
    // `threads:recalled`/`cast:recalled` count the homecomings; the archived-vs-recalled ratio is
    // the cold store's own throughput, the same way `events-evicted` measures the chronicle's.
    'threads:recalled', 'cast:recalled',
    // Prose the card wrote into a context field that shadows a structured table, refused by the
    // exposition gate during migration. Phase C raises it live; migration raises it once.
    'reject:block-shadow',
    // The world probe refusing a move that named no tracked actor (FOLD-REDESIGN.md §7.4).
    'reject:unrooted-move',
    // ── The review pass: whether anything can close, and whether the model is being honest ──
    //
    // `FOLD-REDESIGN.md` §12's first open question is whether a small model answers disposition
    // questions honestly or rubber-stamps `still: open`, and these are the instrument that settles
    // it: the `settled`/`kept` ratio on one real session. A review that only ever says `open` is a
    // review that has learned to agree, and the fallback §12 names — asking only about lines whose
    // subject appears in the new window — is already implemented (`review-table.js` `isTouched`) and
    // waiting for that measurement.
    //
    // `asked` counts LINES POSED, not passes, so it is the denominator for every other rule here.
    // `none` is the pass that posed nothing, which is a different fact from a pass that posed
    // questions and was ignored — the same split as `pressure:absent` versus `pressure:empty`.
    'review:asked', 'review:none', 'review:settled', 'review:moot', 'review:kept',
    'review:advanced', 'review:merged', 'review:different', 'review:placed', 'review:polarity',
    // ── Marks and adversaries closing, which nothing could do before Phase D ──
    //
    // A wound's only exit used to be the `turns` guess made at write time, and `cap:condition-expired`
    // has never fired in any of the three chats — so in practice a wound never healed. `mark-cleared`
    // is the review reading the body back and saying it is over; `threat-cleared` is a fight ending.
    // §12.3 makes the second one the phase's open measurement: no live combat has run under this
    // schema, so a zero here after a real fight is the finding.
    'review:mark-cleared', 'review:threat-cleared',
    // The directed money question (§5 fix 1). `owed` is the trigger firing — a pass credited items
    // with nothing paid; `paid` is a debit landing from an answer; `unpaid` is the model answering
    // "nothing", which is a real answer and clears the question. Money moved up and never down for
    // 40 turns of the live chat, so `paid` staying at zero is the finding, not the absence of one.
    'review:owed', 'review:paid', 'review:unpaid',
    // A locked field and the narrative disagreeing consistently. Sibling of `cap:field-locked`,
    // which counts every blocked write; this counts the ARGUMENTS, one per crossing of CONTEST_AT.
    // Seven blocked writes on the live chat would be one contest here (`FOLD-REDESIGN.md` §0.1-2).
    'lock:contested',
    // The review answering about an id it was never given, or filing an answer as a disposition.
    // Both are prompt defects rather than model failures, and neither should be repaired by
    // guessing what was meant.
    'reject:review-unknown-id', 'reject:review-wrong-shape', 'reject:review-unreadable-amount',
    // Caps — nobody proposed anything; a bound simply dropped it.
    // `stale-hidden` is retired to ZERO by construction as of Phase C — `isFresh` is deleted and no
    // code path increments this any more (`state-table.js`, the retirement note). Kept in this list
    // deliberately: a bound that is gone is a finding, and a rule that quietly leaves the list
    // proves nothing. `neverFired()` naming it is the success criterion.
    'cap:stale-hidden', 'cap:events-evicted', 'cap:duplicate-suppressed',
    'cap:recall-budget', 'cap:summary-truncated', 'cap:keywords-dropped',
    'cap:condition-expired', 'cap:entities-pruned', 'cap:field-locked',
    'cap:leads-ungated', 'cap:threads-full',
    // Three consequence slots per person, and this counts the fourth wounds — each of which either
    // displaced the mildest mark or escalated it (`state-table.js` `placeMark`). Never a refusal: the
    // narrative did not propose a wound, it inflicted one. A zero across a campaign means MAX_MARKS
    // is above what play produces and the slot rule is decoration; a count that climbs during every
    // fight means three is the wrong number.
    'cap:marks-full',
    // Marks a migration lifted out of `state.context.conditions`/`health` onto the pov's row, and
    // block-only character truths (`rank`, `mana`) lifted onto `facts` where they stop aging. Both
    // are §9 rows that Phase B staged and Phase D executes.
    'cap:migrate-marks', 'cap:migrate-facts',
    // ── What the v1 → v2 migration did, per chat ──
    //
    // A migration runs once and leaves no trace anywhere else, which makes it the single easiest
    // thing in this codebase to get wrong invisibly. Counted like every other bound: `cast` and
    // `threads` say how much was carried, `reach` how many contact rows found their owner,
    // `unowned` how many did not (a phone number this file refuses to assign by inference),
    // `flagged` how many identity and polarity questions were left for the review pass rather than
    // guessed at.
    'cap:migrate-cast', 'cap:migrate-threads', 'cap:migrate-reach',
    'cap:migrate-unowned', 'cap:migrate-flagged',
    // The prompt refusing to assert a scene the story has left. Counted because CONTEXT_DROP_AFTER
    // is unmeasured, and a threshold nobody can see is one nobody can retune.
    'cap:context-stale', 'cap:clock-fired', 'cap:event-unusable',
    // The clock advanced on the scene probe's comprehension answer, not on a player-typed elision
    // or a matched English phrase. Counting it is how the two paths are told apart.
    'clock:scene-elapsed',
    // Calendar fronts ticked in code, not by a model (FOLD-REDESIGN.md §7.3). The residency window's
    // "twelve months pass" could not fire before Phase W; counting it is how we know it now does.
    'cap:calendar-ticked', 'cap:calendar-anchored',
    // The extraction pass itself. Every one of these was previously a reason string handed to a
    // caller with no `else` — a decline that left no trace anywhere.
    'extract:ok', 'extract:no-events', 'extract:unparseable', 'extract:truncated',
    'extract:error', 'extract:busy', 'extract:empty-window', 'extract:chat-changed',
    'extract:sources-not-live', 'extract:no-probes',
    // Nothing has been said since the last look. Split from `empty-window` because they have
    // opposite remedies: an empty window means the chat has no readable messages at all, while
    // nothing-new means the cadence is running ahead of the conversation.
    'extract:nothing-new',
    // Budget failures, split from garbage because the remedy is different: raise the allowance
    // rather than change the model. `empty` is what an under-budgeted reasoning model returns.
    'extract:empty', 'extract:retry-empty', 'extract:retry-truncated',
    // The caller's own gates. Without these, "the pass declined" and "the pass was never called"
    // look identical from the data, which is exactly the ambiguity that cost a diagnosis round.
    'extract:disabled', 'extract:waiting',
    // WHY a pass ran. A ceiling that fires every time means the change signals never do, and a
    // signal that never fires is one to delete.
    'extract:on-interval', 'extract:on-time-skipped', 'extract:on-travel',
    'extract:on-scene-break', 'extract:on-state-block',
    // Whether a delta was proposed at all. Without these, "the model said nothing changed" and
    // "the delta schema never reached the request" are the same silence.
    'extract:delta-empty', 'extract:delta-off',
    // Adjudication. The band distribution is the measurement that settles CLEAR_AT and SETBACK_AT:
    // a band that never fires is a threshold set wrong, and one that fires every time is worse.
    'verdict:clear', 'verdict:cost', 'verdict:setback',
    'verdict:unclassified', 'verdict:error', 'verdict:skipped', 'verdict:uncontested',
    // Verdicts writing state (§6, Phase E): `setback-aimed` — a setback ticked the thread it was
    // actually about rather than a random victim; `cost-note` — a COST verdict told the next
    // extraction to record the cost as a delta.
    'verdict:setback-aimed', 'verdict:cost-note',
    // Whether pressure was proposed at all. Without these, a campaign with no clocks and a probe
    // that never reached the model look identical.
    'pressure:ok', 'pressure:empty', 'pressure:absent',
    // The other half of the same probe: threads with no dial. Split from `pressure:ok` because a
    // campaign that opens threads and never ticks a dial is a real and different state from one
    // that does neither — Evil Hero Party is exactly that, 15 threads and zero clocks in 91 turns.
    'threads:ok',
    // The off-screen world-turn (FOLD-REDESIGN.md §7). `moved`/`idle` split an armed pass by whether
    // the world actually advanced; `unarmed` counts a conversational pass where the model proposed a
    // move anyway — the prompt said nothing, and the code gate refused it.
    'world:moved', 'world:idle', 'world:unarmed',
]);

/**
 * The rules that have never fired in this chat.
 * @returns {string[]} Rule names, unprefixed.
 */
export function neverFired() {
    const seen = load();
    return KNOWN_RULES.filter(rule => !seen.has(rule)).map(rule => rule.replace(/^(reject|cap|verdict|pressure|threads|world):/, ''));
}

/** Forget the observations, so a calibration run can start from zero. */
export function clear() {
    commit(OBSERVED_PATH, new Map());
}
