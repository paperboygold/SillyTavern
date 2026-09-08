/**
 * fold/observe.js: what the bounds actually did.
 *
 * Why this exists.
 *
 * fold carries twenty-two numeric constants. Every one arrived with a sentence explaining why it is
 * the right number, "generous enough for real play", "one scene's worth of lag", "largest plausible
 * single-turn change", and not one of them was measured. That is the defect the sanguine corpus
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
 * Two kinds of observation, deliberately distinguished.
 *
 *   `reject:<reason>`  a validator refused a proposed change. The model asked, fold said no.
 *   `cap:<rule>`       a bound silently dropped or hid something nobody proposed. This is the
 *                      dangerous kind, a rejection is at least visible in the rejects tally,
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
 * Record a high-water mark rather than a running total.
 *
 * The Count face answers "how often"; some bounds are only legible as "how far". A drift counter
 * that summed its gaps would grow with the length of the campaign and say nothing about severity,
 * forty ten-stone discrepancies and one of 2604 would read the same. `merge_max` is the other
 * idempotent merge the hash trinity already provides, so this is the same one-line insert with a
 * different monoid, and re-noting the same finding cannot inflate it.
 *
 * @param {string} rule The rule that fired, already namespaced.
 * @param {number} value The observed magnitude.
 */
export function noteMax(rule, value) {
    const key = String(rule ?? '').trim();
    if (!key || !Number.isFinite(value)) {
        return;
    }
    const table = load();
    insert_with(table, (nu, old) => Math.max(Number(nu) || 0, Number(old) || 0), key, Math.trunc(value));
    commit(OBSERVED_PATH, table);
}

/**
 * Record a batch of validator rejections.
 *
 * The tally (`reject:<reason>`) says how often a rule fired; this ALSO writes each refusal to the
 * diagnostics log (`log.js`), so the panel can show WHAT was refused, the raw proposal and the
 * window it was read from, not just that something was. The entry carries `mid`/`turn` when the
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
                // was reading. `raw` may be an object or a scalar, serialize for storage.
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
 *
 * `rule` is the SHORT name, because the calibration report prints it in a padded column and the
 * namespace is already carried by `kind`. `key` is the rule exactly as it was counted, the string
 * `KNOWN_RULES` lists and `load()` is keyed by. The Diagnostics tab renders `key`: two rules can
 * share a short name (`reject:threads-full` and `cap:threads-full` both read `threads-full`), and a
 * counter surface that cannot tell them apart is a counter surface that cannot be trusted.
 *
 * @returns {Array<{rule: string, key: string, count: number, kind: string}>} The observations.
 */
export function report() {
    return table_entries(load())
        .map(([rule, count]) => ({
            rule: rule.replace(/^(reject|cap|verdict|pressure|threads|review|lock|world):/, ''),
            key: rule,
            kind: kindOf(rule),
            count: Number(count) || 0,
        }))
        .sort((a, b) => b.count - a.count);
}

/**
 * Everything a cap has dropped or hidden in this chat, as one number.
 *
 * One definition, because two of them disagreed by 202.
 *
 * The rejections section in `overlay-diagnostics.js` needs this figure and cannot get it from the
 * rejects tally: a cap is not a rejection and never enters that table, which is the split this
 * file's opening docblock argues for. Its first cut read all four of its numbers off
 * `snapshot.rejects` and rendered "at a cap: 0" on a chat with 202 cap firings.
 *
 * `state.js` `acknowledge` now needs the same figure to write a baseline against. A second inline
 * `filter(kind === 'cap').reduce(...)` at the second call site is exactly how the first wrong
 * answer got written, so the definition lives here beside the counters it sums.
 *
 * @returns {number} Total `cap:*` firings.
 */
export function capTotal() {
    return report()
        .filter(rule => rule.kind === 'cap')
        .reduce((sum, rule) => sum + (Number(rule.count) || 0), 0);
}

/**
 * Which sort of observation a rule is, from its namespace.
 *
 * Why an unrecognised namespace is not a rejection.
 *
 * This fell through to `'reject'` for anything it did not recognise, which was invisible while the
 * only consumer was a console report that prints the same word for every unknown kind. Rendered as a
 * column in the Diagnostics tab it is a plain untruth: the live Raccoon City chat carries
 * `ledger:hydrated` 9,240 times, and that is a hydration counter, not nine thousand refusals. A
 * counters surface that mislabels the busiest row in it teaches the reader to distrust the column.
 *
 * So: an unrecognised namespace becomes its own kind, named after itself. Unprefixed rules and the
 * `reject:` namespace stay rejections, which is what they are.
 *
 * @param {string} rule The namespaced rule.
 * @returns {string} The kind.
 */
function kindOf(rule) {
    const at = rule.indexOf(':');
    const namespace = at > 0 ? rule.slice(0, at) : '';
    switch (namespace) {
        case '':
        case 'reject': return 'reject';
        case 'cap': return 'cap';
        case 'extract': return 'pass';
        case 'verdict': return 'verdict';
        case 'review':
        case 'lock': return 'review';
        case 'world': return 'world';
        case 'pressure':
        case 'threads': return 'pressure';
        default: return namespace;
    }
}

/*
 * Seven names retired, 2026-08-20.
 *
 * `extract:on-travel`, `cap:summary-truncated`, `cap:migrate-unowned`, `reject:clocks-full`,
 * `reject:unrooted-move`, `reject:negation`, `reject:not-an-item`.
 *
 * Each had NO PRODUCER left anywhere in the extension, not a condition that has not occurred, but
 * a name that outlived the code that raised it. `extract:on-travel` and `cap:summary-truncated`
 * never had one in any commit; `cap:migrate-unowned` counted a field (`counts.unowned`) the
 * migration report does not have; the other four went with the mechanisms they belonged to.
 *
 * `reject:clocks-full` is worth naming because the argument for keeping it was written down and was
 * wrong: it said live chats still carry counts under the old name. Measured across 21 chats under
 * BOTH metadata keys, including the six that still carry a legacy `fold` blob, none do.
 *
 * What did NOT go: every never-fired rule whose producer is intact and reachable. A gate that has
 * refused nothing in 21 campaigns by one player is a gate doing its job quietly, and 21 chats is not
 * a proof of deadness. `cap:stale-hidden` also stays, it is unreachable BY CONSTRUCTION and
 * `neverFired()` naming it is the success criterion, which is the note a few lines below.
 */
/**
 * The rules fold knows about, so the report can say which have NEVER fired.
 *
 * A silent zero is the finding, not the absence of one: a bound that has never bound in a long chat
 * is a number nobody needed. Listing them is what turns "no data" into "delete this".
 */
export const KNOWN_RULES = Object.freeze([
    // Validator rejections, the model proposed, fold refused.
    'reject:not-mentioned', 'reject:implausible-delta', 'reject:rate-limited',
    'reject:unusable-name', 'reject:no-change', 'reject:remove-unknown',
    'reject:inventory-full', 'reject:abilities-full', 'reject:clamped-underflow', 'reject:vitals-full',
    'reject:implausible-max', 'reject:flags-full',
    'reject:entities-full', 'reject:clock-reversed', 'reject:exposition',
    'reject:implausible-tick',
    // The double-billing gates. `already-recorded` is the backstop behind the window split: the
    // model was shown the line and proposed gaining it again anyway. `not-an-item` is the contacts
    // place the model invented for itself at mid 52 of the live Solo Leveling chat. Both are
    // expected to fire rarely once the split and the instruction are working, a count that keeps
    // climbing means the pinned ledger is not being read, which is a different bug from a leak.
    'reject:already-recorded',
    // The mark half of the same law. A condition already held, restated with nothing changed, is an
    // observation with zero residual and must be the identity, including on the row's recency,
    // which every staleness mechanism downstream reads. Raccoon City spent 38 events and 10.5% of
    // its blob re-asserting two conditions before this existed; a count that keeps climbing here
    // means the scene probe is being handed a window it keeps re-reading, which is a different bug.
    'reject:already-held',
    // A mark proposed for somebody fold has never heard of. An invented owner is worse than none,
    // an unowned mark lands on the point-of-view character, which is where the panel was silently
    // putting all of them anyway, while an invented one opens a person-shaped hole nothing will ever
    // close (`state-table.js` `resolveOwner`, `FOLD-REDESIGN.md` §3).
    'reject:unknown-owner',
    // The threads table's own refusals. `threads-full` replaces `clocks-full`: the cap now bounds
    // leads and dials together, and the old name is kept below because live chats already carry
    // counts under it and a renamed rule with no history reads as a rule that never fired.
    'reject:threads-full',
    // The demotion side of the same cap: a thread that gave up its slot was ARCHIVED to the cold
    // store, not deleted, `threads-archived` counts the demotions, `reject:threads-full` now only
    // the one case that still refuses (the table full of dial-bearing open threads). See
    // `cold-store.js` ([EVICT]: eviction is demotion, never a relevance-judged delete).
    'cap:threads-archived',
    // The staleness prune, which is a different event from the full-table shed above: `archived`
    // means the table ran out of slots, `pruned` means the story stopped touching a stake for twice
    // the hide threshold and it was retired to the cold store. Before it existed, nothing retired a
    // thread at all unless the table filled, the live My Hero Academia RP held three threads, none
    // of them rendered anywhere, all of them posed to the review forever (`review:kept` 53 against
    // `review:settled` 1). A zero here in a long chat now means every stake really was resolved.
    'cap:threads-pruned',
    // Messages below the first pass's reach, fold switched on partway through a chat. Zero in a
    // chat started with fold on, which is the common case; non-zero says the ledger begins life not
    // knowing what is in the messages before it, which explains a great deal that would otherwise
    // read as extraction failing.
    'cap:opening-unread',
    // The same demotion for the cast: a person nobody has mentioned for two stale windows moves to
    // the cold store instead of ceasing to exist, so they can be recalled the moment the story
    // returns to them. `cast-archived` counts those demotions.
    'cap:cast-archived',
    // Re-promotion by coverage: a cold row whose subject the window mentions is written back into
    // its hot table, a WRITE into the tracked state, never a paste into the window ([AC-PRODUCT]).
    // `threads:recalled`/`cast:recalled` count the homecomings; the archived-vs-recalled ratio is
    // the cold store's own throughput, the same way `events-evicted` measures the chronicle's.
    'threads:recalled', 'cast:recalled',
    // The gate admitting by a form of the name the proposal did not lead with.
    //
    // Coverage admits a proposal when the model's own `mentions` report names it, and that leaves
    // the two strings the model wrote in one call to agree. `coverage.js` `oneSpelling` asks it to
    // make them agree; `entity-table.js` `nameForms` is the floor for when it does not, splitting
    // `刘三（Liú Sān）` into the two writings of one name that fold's own `bilingual.js` rule 3 asked
    // the narrator for. This counts the admissions that floor granted.
    //
    // It is a calibration number, not a health number, and it reads in both directions. Zero in a
    // single-script campaign is expected and means nothing. Climbing in a bilingual one means the
    // probe is still answering `name` and `mentions` in different scripts and the structural split
    // is what is keeping the cast table populated, which is the evidence for whether the ask needs
    // strengthening again, and the only way to tell that from "the gate is simply never tested".
    'covered:by-form',
    // Prose the card wrote into a context field that shadows a structured table, refused by the
    // exposition gate during migration. Phase C raises it live; migration raises it once.
    'reject:block-shadow',
    // The world probe refusing a move that named no tracked actor (FOLD-REDESIGN.md §7.4).
    // The review pass: whether anything can close, and whether the model is being honest.
    //
    // `FOLD-REDESIGN.md` §12's first open question is whether a small model answers disposition
    // questions honestly or rubber-stamps `still: open`, and these are the instrument that settles
    // it: the `settled`/`kept` ratio on one real session. A review that only ever says `open` is a
    // review that has learned to agree, and the fallback §12 names, asking only about lines whose
    // subject appears in the new window, is already implemented (`review-table.js` `isTouched`) and
    // waiting for that measurement.
    //
    // `asked` counts LINES POSED, not passes, so it is the denominator for every other rule here.
    // `none` is the pass that posed nothing, which is a different fact from a pass that posed
    // questions and was ignored, the same split as `pressure:absent` versus `pressure:empty`.
    'review:asked', 'review:none', 'review:settled', 'review:moot', 'review:kept',
    'review:advanced', 'review:merged', 'review:different', 'review:placed', 'review:polarity',
    // Pairs the model volunteered, which no detector fold has could raise.
    //
    // `nearIdentity` is a token-subset test and raises ZERO pairs over the 231 available on the live
    // New Eldoria thread table, including two threads opened one turn apart. `suspected` counts the
    // model naming a pair unprompted (`review-table.js` `same_thread`/`same_person`); those become
    // ordinary `[same?]` questions on the next pass, so a rise here should show up as `merged` or
    // `different` a turn later. `suspected` climbing while both of those stay flat means the pairs
    // are not resolving to rows, which is a lookup defect and not a model one.
    'review:suspected',
    // Marks and adversaries closing, which nothing could do before Phase D.
    //
    // A wound's only exit used to be the `turns` guess made at write time, and `cap:condition-expired`
    // has never fired in any of the three chats, so in practice a wound never healed. `mark-cleared`
    // is the review reading the body back and saying it is over; `threat-cleared` is a fight ending.
    // §12.3 makes the second one the phase's open measurement: no live combat has run under this
    // schema, so a zero here after a real fight is the finding.
    'review:mark-cleared', 'review:threat-cleared',
    // The one table the review could not close. An item entered on a volunteered positive delta and
    // left only on a volunteered negative one, three of those in 143 messages of the live Wuxia
    // World RPG, all from one selling scene, while a sword the player laid on a corpse stayed on
    // his hip in every prompt thereafter. A zero here in a long chat means either a character who
    // never puts anything down or a question nobody is answering, and the two are worth telling
    // apart.
    'review:dropped',
    // The directed money question (§5 fix 1). `owed` is the trigger firing, a pass recorded a
    // purchase with nothing paid; `paid` is a debit landing from an answer; `unpaid` is the model
    // answering "nothing", which is a real answer and clears the question.
    //
    // The ratio between them is the whole judgement on the question. Before the trigger read the
    // model's `how`, the live Wuxia chat stood at owed 42, unpaid 15, paid 1, and the corpus-wide
    // figure was worse: 369 asks, 244 with no answer at all, 102 answered "nothing was paid", 19
    // amounts, six of which are documented double-bills. `unpaid` far above `paid` is not the
    // model being unhelpful, it is the trigger being wrong, and after the narrowing both should be
    // small numbers close together (`state-table.js` `creditsWithoutDebit`).
    'review:owed', 'review:paid', 'review:unpaid',
    // The self-audit for the `how` field, which is the only reason to trust the narrowing.
    //
    // A skipped field is invisible until someone counts it: `moves: []` came back empty 107/107 and
    // `drive_size: 0` 288/288, and both were found by hand. `acquired` is a gain the model placed
    // (found, taken, given, made), `bought` is one it called a purchase, `how-unsaid` is a gain that
    // arrived with no usable word, the status-block path and hand edits, which never carry one.
    // The corpus predicts about one `bought` per twenty `acquired`; `bought` climbing toward
    // `acquired` is the model calling everything a purchase, and `how-unsaid` climbing is the free
    // skip this enum was shaped to prevent. See `state.js` `tallyAcquisitions`.
    'money:acquired', 'money:bought', 'money:how-unsaid',
    // A locked field and the narrative disagreeing consistently. Sibling of `cap:field-locked`,
    // which counts every blocked write; this counts the ARGUMENTS, one per crossing of CONTEST_AT.
    // Seven blocked writes on the live chat would be one contest here (`FOLD-REDESIGN.md` §0.1-2).
    'lock:contested',
    // The review answering about an id it was never given, or filing an answer as a disposition.
    // Both are prompt defects rather than model failures, and neither should be repaired by
    // guessing what was meant.
    'reject:review-unknown-id', 'reject:review-wrong-shape', 'reject:review-unreadable-amount',
    'reject:review-unmergeable', 'reject:sheet-unnamed', 'reject:sheet-unknown-kind', 'review:classified',
    // Caps, nobody proposed anything; a bound simply dropped it.
    // `stale-hidden` is retired to ZERO by construction as of Phase C, `isFresh` is deleted and no
    // code path increments this any more (`state-table.js`, the retirement note). Kept in this list
    // deliberately: a bound that is gone is a finding, and a rule that quietly leaves the list
    // proves nothing. `neverFired()` naming it is the success criterion.
    'cap:stale-hidden', 'cap:events-evicted', 'cap:duplicate-suppressed',
    'cap:recall-budget', 'cap:keywords-dropped',
    'cap:condition-expired', 'cap:entities-pruned', 'cap:field-locked',
    'cap:leads-ungated', 'cap:threads-full',
    // Three consequence slots per person, and this counts the fourth wounds, each of which either
    // displaced the mildest mark or escalated it (`state-table.js` `placeMark`). Never a refusal: the
    // narrative did not propose a wound, it inflicted one. A zero across a campaign means MAX_MARKS
    // is above what play produces and the slot rule is decoration; a count that climbs during every
    // fight means three is the wrong number.
    'cap:marks-full',
    // Marks a migration lifted out of `state.context.conditions`/`health` onto the pov's row, and
    // block-only character truths (`rank`, `mana`) lifted onto `facts` where they stop aging. Both
    // are §9 rows that Phase B staged and Phase D executes.
    'cap:migrate-marks', 'cap:migrate-facts',
    // Block labels that qualified as facts but did not FIT, `facts` is capped at `MAX_DETAIL`
    // (120 chars) and a label that would overrun it keeps its context entry instead. Counted
    // because the alternative is what this replaced: the old code deleted every qualifying label
    // and then truncated the joined string, destroying five of Isekai RPG's twelve outright. A
    // non-zero count here is a chat whose card writes more block state than one `facts` line holds,
    // which is a finding about the cap, not a failure of the pass.
    'cap:migrate-facts-full',
    // What the v1 → v2 migration did, per chat.
    //
    // A migration runs once and leaves no trace anywhere else, which makes it the single easiest
    // thing in this codebase to get wrong invisibly. Counted like every other bound: `cast` and
    // `threads` say how much was carried, `reach` how many contact rows found their owner,
    // `unowned` how many did not (a phone number this file refuses to assign by inference),
    // `flagged` how many identity and polarity questions were left for the review pass rather than
    // guessed at.
    'cap:migrate-cast', 'cap:migrate-threads', 'cap:migrate-reach',
    'cap:migrate-flagged',
    // The prompt refusing to assert a scene the story has left. Counted because CONTEXT_DROP_AFTER
    // is unmeasured, and a threshold nobody can see is one nobody can retune.
    'cap:context-stale', 'cap:clock-fired', 'cap:event-unusable',
    // The clock advanced on the scene probe's comprehension answer, not on a player-typed elision
    // or a matched English phrase. Counting it is how the two paths are told apart.
    'clock:scene-elapsed',
    // Calendar fronts ticked in code, not by a model (FOLD-REDESIGN.md §7.3). The residency window's
    // "twelve months pass" could not fire before Phase W; counting it is how we know it now does.
    'cap:calendar-ticked', 'cap:calendar-anchored',
    // Flows: the rates that move a quantity with no model call.
    //
    // There is deliberately no `flow:paid` counter. A flow's contribution is a READ, recomputed
    // whole on every fold, so "how many times has it paid" is not a thing that happens, counting
    // it would count renders. What is worth counting is what a PERSON did to the table, and the two
    // arithmetic edges that mean a reading was refused rather than taken.
    'flow:added', 'flow:edited', 'flow:removed', 'flow:suspended', 'flow:resumed',
    'reject:flows-full', 'reject:flow-unusable',
    // A reply that ended before every probe was answered, and by how many probes. The casualties are
    // always the tail, because the model emits properties in schema order.
    'cap:probe-truncated',
    // An elapsed span too large to believe, clamped to `MAX_SKIP` rather than refused.
    'cap:span-clamped',
    // The extraction pass itself. Every one of these was previously a reason string handed to a
    // caller with no `else`: a decline that left no trace anywhere.
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
    // Two live counters the declaration could not see.
    //
    // `extract:on-unread` is the FIFTH-BUSIEST counter in the corpus at 688, and was undeclared,
    // so it counted into nothing and `neverFired()`'s denominator was wrong by its whole weight.
    // Both it and `extract:retry-<n>` are assembled from a template (`index.js` `extract:on-${why}`,
    // `extract.js` `extract:retry-${attempt}`), which the declaration gate's literal reader cannot
    // see. A rule raised through a template is still a rule; it just cannot announce itself, so it
    // has to be written down here by hand.
    //
    // `unread` is a real `why` (`index.js` returns `{ run: true, why: 'unread' }`); the retry
    // numbers are bounded by `MAX_EXTRACT_ATTEMPTS`.
    'extract:on-unread', 'extract:retry-1', 'extract:retry-2',
    // The caller's own gates. Without these, "the pass declined" and "the pass was never called"
    // look identical from the data, which is exactly the ambiguity that cost a diagnosis round.
    'extract:disabled', 'extract:waiting',
    // WHY a pass ran. A ceiling that fires every time means the change signals never do, and a
    // signal that never fires is one to delete.
    'extract:on-interval', 'extract:on-time-skipped',
    'extract:on-scene-break', 'extract:on-state-block',
    // Whether a delta was proposed at all. Without these, "the model said nothing changed" and
    // "the delta schema never reached the request" are the same silence.
    'extract:delta-empty', 'extract:delta-off',
    // The read mark named a message this chat no longer has.
    //
    // Deleting a message renumbers every mid above it, so a mark taken before the deletion points
    // past the end of the shortened chat. `resolveMark` answered null, `splitWindow` read that as
    // "never extracted", took the `FIRST_WINDOW` reach-back and BILLED all 24 messages, one pass in
    // Raccoon City wrote ten events at once, six of them restating beats already in the ledger. It
    // also wrote `all.length - 24` into `cap:opening-unread`, which is where 145 and 97 came from in
    // the only two chats that carry it, neither of which has ever had an unread opening.
    //
    // `readFrontier` (`extract-table.js`) recovers the frontier instead and this counts the
    // recovery. A number that keeps climbing means messages are being deleted often, which is a
    // fact about how the chat is played rather than a defect; a number that climbs while nothing is
    // deleted means something else is destroying the mark.
    'extract:mark-healed',
    // Backfill: reading a span the forward pass never reached.
    //
    // Explicitly invoked, priced before it spends, resumable per chunk (`extract.js` `runBackfill`).
    // `backfill:run` counts runs, not chunks, a run is what the owner authorised. The refusals are
    // the whole ceiling argument in counter form: `no-ceiling` means nothing recorded where the gap
    // ends and fold declined to guess, `nothing-to-backfill` means the span is already covered.
    'backfill:run', 'backfill:ok', 'backfill:no-events', 'backfill:failed',
    'backfill:no-ceiling', 'backfill:nothing-to-backfill', 'backfill:empty-chat',
    // Adjudication. The band distribution is the measurement that settles CLEAR_AT and SETBACK_AT:
    // a band that never fires is a threshold set wrong, and one that fires every time is worse.
    'verdict:clear', 'verdict:cost', 'verdict:setback',
    // The two axes, counted separately so play can settle them the way the old single-sum
    // thresholds never were, see `verdict-table.js`'s "a band that never fires is a band set wrong".
    'verdict:controlled', 'verdict:risky', 'verdict:desperate',
    'verdict:limited', 'verdict:standard', 'verdict:great', 'verdict:resisted', 'verdict:regard-spent',
    'verdict:unclassified', 'verdict:error', 'verdict:skipped', 'verdict:uncontested',
    // Verdicts writing state (§6, Phase E): `setback-aimed`: a setback ticked the thread it was
    // actually about rather than a random victim; `cost-note`: a COST verdict told the next
    // extraction to record the cost as a delta.
    'verdict:setback-aimed', 'verdict:cost-note',
    // Whether pressure was proposed at all. Without these, a campaign with no clocks and a probe
    // that never reached the model look identical.
    'pressure:ok', 'pressure:empty', 'pressure:absent',
    // The other half of the same probe: threads with no dial. Split from `pressure:ok` because a
    // campaign that opens threads and never ticks a dial is a real and different state from one
    // that does neither, Evil Hero Party is exactly that, 15 threads and zero clocks in 91 turns.
    'threads:ok',
    // The off-screen world-turn (FOLD-REDESIGN.md §7). `moved`/`idle` split an armed pass by whether
    // the world actually advanced; `unarmed` counts a conversational pass where the model proposed a
    // move anyway, the prompt said nothing, and the code gate refused it.
    'world:moved', 'world:idle', 'world:unarmed',
    // The place table's own bounds (Wave 1).
    //
    // Added late, and the lateness is the argument for `undeclared()` below: all four were firing in
    // live chats while this list said fold had never heard of them, so they showed up in no report
    // and in no silence. `places-full` is the map at its cap; `place-cycle` is a parent that would
    // put a place inside itself, kept as a place and refused as a parent (`place-table.js`
    // `foldPlace`); `places-archived` is the staleness prune demoting leaves to the cold store, and
    // `places-shed` is the metadata-budget pruner dropping the stalest leaves outright.
    'reject:places-full', 'reject:place-cycle',
    // The tiered asset model's own bounds (§7.2, 7.4).
    'reject:parts-full', 'reject:place-destroyed',
    'cap:parts-trimmed', 'cap:parts-shed',
    'cap:places-archived', 'cap:places-shed',
    // A cold place walked back into: the coverage report named it, so its row was written back into
    // the hot table. Sibling of `cast:recalled` and `threads:recalled`.
    'places:recalled',
    // The rules below were found by `undeclared()`, not by reading code.
    //
    // Every one of them was firing in live chats while this list had never heard of it, which made
    // each invisible in BOTH halves of the report: absent from the fired table under a name anybody
    // recognises, and absent from `neverFired()` too, because nothing knew it existed. A corpus
    // audit over 21 chats put the busiest counter in the whole corpus in this set,
    // `cap:mirror-shed` at 40,480. `tests/sanguine-observe.test.js` now fails the build on a call
    // site whose rule is not declared here, so this class of drift is closed rather than merely
    // corrected once.
    //
    // The declarations are grouped by the subsystem that raises them. The gloss on each says what a
    // zero would prove, because that is the only thing this list is for.

    // The ledger's own durability (`ledger.js`, `chronicle.js`).
    //
    // `hydrated` counts ops replayed from the campaign ledger at load; it is the busiest counter in
    // most chats and says nothing is wrong, it is the fold being rebuilt. `seeded` is the first
    // write of a chat's events into that ledger. `damaged` is the one to watch: a line the reader
    // could not parse in the MIDDLE of the file, meaning an acknowledged event is gone and the fold
    // cannot say which. `deferred` is the queue holding ops the server refused, so a zero there
    // across a long session is the write path working.
    'ledger:hydrated', 'ledger:seeded', 'ledger:damaged', 'ledger:deferred',
    // What the pinned block told the model about its own last answer (`state.js ledgerBlock`).
    //
    // `counted` is ledger rows printed with the `(counted)` marker, rows written from the newest
    // messages fold has read (`state-table.js recentlyRecorded`). It is the denominator for the
    // `reject:already-recorded` count: measured on the live Wuxia campaign, 21 of 21 recoverable
    // refusals were against a row the block HAD printed, so the block was showing the item and
    // hiding the beat. A zero here on a chat that is still recording means the mark or the
    // contributor trail is not reaching the renderer, and the marker silently does nothing.
    //
    // `refused` counts passes that carried the refused-debit note, a `remove-unknown` on a debit,
    // reported back to the model by name so it can answer with `same_as` instead of proposing the
    // same unmatched name again. Wuxia's `copper -500` was refused on three consecutive passes and
    // `fragment -1` on three more; the note is what makes the second and third of each avoidable.
    // A count that climbs while `reject:remove-unknown` climbs with it means the model is reading
    // the note and not acting on it, which is a different finding from never being told.
    'block:counted', 'block:refused',
    // The reconcile pass (`reconcile.js`).
    //
    // `asked` is lines posed and the denominator for the rest; `held` is rows the pass kept; a
    // `repairs` count is the pass proposing a correction, `applied` the player accepting one and
    // `declined` the player refusing. `applied` staying at zero while `repairs` climbs means a pass
    // whose proposals nobody trusts, which is a different finding from a pass that never proposes,
    // and it is the finding the corpus currently supports: across 22 chats the only reconcile
    // counters on disk anywhere are `asked: 80` and `declined: 2`, both on one campaign.
    //
    // `declined` NO LONGER HAS A PRODUCER: the confirm-or-forfeit modal it counted was deleted, on
    // the strength of the two counts it recorded. It is kept declared for the same reason
    // `cap:threads-full` is, live chats carry the number, and a rule that quietly leaves this list
    // makes its own history unreadable, showing up in neither the fired report nor `neverFired()`.
    // The retirement note above deletes names that never had a producer OR whose counts are gone
    // from every chat; this is neither.
    'reconcile:asked', 'reconcile:held', 'reconcile:repairs', 'reconcile:applied', 'reconcile:declined',
    // The two lanes, which are the successor design's own measurement.
    //
    // The modal is gone (`repair-table.js` argues the case from the three numbers above), and these
    // are what say whether replacing it worked. The tiering split the plan by whether a repair
    // CONSERVES the record's substance: `auto` counts the conserving half landing without being
    // asked about, `ask-applied` and `ask-dismissed` count the non-conserving half being answered.
    //
    // `applied` keeps its old meaning, a repair reached the record, by either route, so it stays
    // comparable to the 0 it has sat at across 22 campaigns, and `auto + ask-applied` should equal
    // it. What each zero would prove differs sharply: `auto` at zero means the pass proposes no
    // conserving repairs and the whole tiering argument is wrong; `ask-applied` AND `ask-dismissed`
    // both at zero while `auto` climbs is the design working exactly as intended, the feature
    // delivering value to a player who answers nothing, which is the success criterion the modal
    // could not meet.
    //
    // `undone` is a per-row inverse edit (rename back, move back, set the amount back);
    // `reverted` is a whole-pass snapshot restore. Split because they measure different failures: a
    // climbing `undone` says particular verdicts are wrong, a climbing `reverted` says whole passes
    // are, and the remedies are a better instruction versus a narrower auto lane.
    'reconcile:auto', 'reconcile:ask-applied', 'reconcile:ask-dismissed',
    'reconcile:undone', 'reconcile:reverted',
    // The reconcile pass's refusals, which arrive through a template.
    //
    // `reconcile.js` raises `` `reconcile:${rejection.reason}` ``, so not one of these is visible to
    // the literal reader in `tests/sanguine-observe.test.js`: the same blind spot the invariant
    // witnesses have, and it is why all six of the original reasons sat here undeclared while the
    // five counters above did not. `reconcile-table.js` `REJECTIONS` names them at the source and
    // `tests/sanguine-reconcile-table.test.js` holds this list to covering it.
    //
    // What a zero proves differs per reason. `unknown-id` and `duplicate-id` are the model failing
    // to answer the block it was given; `wrong-op` is a category error (a quantity on a thread);
    // `no-evidence` is the one safety gate refusing, and a climbing count there is the pass
    // proposing repairs it cannot justify. `no-change` and `unusable-amount` are restatements and
    // junk numbers. `unknown-target` is a merge onto a line that was never posed, `merge-conflict` a
    // chain or a cycle deferred to the next pass, `unusable-split` a parts list with a blank name or
    // a negative count.
    'reconcile:unknown-id', 'reconcile:duplicate-id', 'reconcile:wrong-op', 'reconcile:no-evidence',
    'reconcile:no-change', 'reconcile:unusable-amount', 'reconcile:unknown-target',
    'reconcile:merge-conflict', 'reconcile:unusable-split',
    // Parts past `MAX_SPLIT_PARTS` on one row. A zero is the bound never binding; a climbing count
    // says six is too few for the way this record actually goes wrong.
    'cap:reconcile-parts',
    // The audit pass (`audit.js`).
    //
    // `read` counts digest chunks that came back usable, `read-empty` and `read-failed` the two ways
    // a chunk did not. `findings` is what the report produced and `dropped` what the plan discarded.
    // A read that is mostly `read-failed` is a report built on a partial reading of the chat, and the
    // difference is invisible in the report itself.
    'audit:read', 'audit:read-empty', 'audit:read-failed', 'audit:findings', 'audit:dropped',
    // Hand edits (`edits.js`, `state.js`).
    //
    // Not bounds at all: these count the player correcting fold by hand. They belong in the same
    // table anyway, because a chat where the cast is edited constantly is a chat where extraction is
    // getting people wrong, and that is a measurement nothing else takes. `forgotten` counts events
    // erased by a minimal incision rather than whole.
    'edit:forgotten', 'edit:thread-deleted', 'edit:cast-edited', 'edit:cast-deleted', 'edit:cast-undone', 'edit:clock-set',
    // The inventory and body edits, which reach `note` as an ARGUMENT to `edits.js`'s own `append`
    // helper rather than as a literal at an `observe.note` call. That indirection is why all eight
    // stayed undeclared while four of their siblings above did not: a reader looking for
    // `observe.note('…')` cannot see them. `tests/sanguine-observe.test.js` reads rule literals in
    // any observe-importing file for exactly this shape.
    //
    // Together these are the measurement nothing else takes: how much of the record is the PLAYER's
    // rather than the model's. A chat where `item-qty` and `item-removed` climb is a chat where
    // extraction is getting the inventory wrong and being corrected by hand, which is a defect
    // report nobody has to file.
    'edit:item-added', 'edit:item-qty', 'edit:item-renamed', 'edit:item-moved',
    'edit:item-removed', 'edit:item-ranked', 'edit:vital-set', 'edit:mark-cleared',
    // `item-split` is the row that turned out to be several things, one `ammunition x28` that the
    // narration had described as three magazines, twenty-five buckshot shells and a box of birdshot.
    // A climbing count is the extraction summarising specifics into a category, which is a defect
    // report about the delta instruction and not about the player.
    'edit:item-split',
    // The capability edits, since abilities stopped being inventory (`state-table.js` `foldAbility`).
    // Counted apart from the item edits deliberately: they measure a different thing being got wrong.
    'edit:ability-added', 'edit:ability-removed', 'edit:ability-ranked', 'edit:ability-renamed',
    // The review pass's remaining answers (`review.js`).
    //
    // `item-same` is two inventory rows the review merged, the one merge that cannot go through
    // `clocks.merge`, because an item key would look up a thread that does not exist.
    // `currency-same` is the same for two currency tokens; `currency-unresolved` is the model naming
    // a pair that resolves to nothing, which distinguishes a lookup defect from an instruction one.
    'review:item-same', 'review:currency-same', 'review:currency-unresolved',
    // The world turn's arithmetic (`world.js`).
    //
    // `placed` and `ticked` count what an armed pass actually moved; `achieved` is a faction agenda
    // filling, which is a story beat rather than a table operation. `declined` is the model being
    // asked and answering that nothing moved, split from `idle` because 192 idles once covered 107
    // armed passes that returned nothing and 85 unarmed ones that were never meant to.
    'world:placed', 'world:ticked', 'world:achieved', 'world:declined',
    // The nomination half: fold shortlists, the model judges (`world-table.js`).
    //
    // `nominated` is how many agendas an armed pass put to the model; `sized` and `routine` split
    // the answers. They exist because the number they replaced was 0 on 165 of 165 cast rows in
    // every live chat, the entity probe was asked "how long is their ambition" at first sighting
    // and said 0 in 288 of 288 traced proposals, so the actor half of the world turn never had an
    // input at all.
    //
    // Read `sized` against `routine` rather than alone. The corpus says roughly a quarter of the
    // agendas a story tracks can actually complete, so a healthy pass returns mostly `routine`. All
    // `sized` would mean the model is rubber-stamping and every shopkeeper has a six-step drive;
    // all `routine` forever would mean it has reverted to the reflexive zero this replaced.
    'world:nominated', 'world:sized', 'world:routine', 'world:unsized',
    // Extraction and the tables it feeds (`index.js`, `chronicle.js`, `state.js`).
    //
    // `armed-by-elapsed` is a pass triggered by a time skip. `mirror-shed` is the event mirror
    // dropping its oldest rows to fit the metadata budget, the busiest counter in the corpus, and a
    // shed that runs constantly means the mirror is sized wrong. `baseline-carried` is a recurring
    // cost's baseline surviving an eviction that would otherwise have deleted the row it belongs to.
    'extract:armed-by-elapsed', 'cap:mirror-shed', 'cap:baseline-carried',
    // The rows fold (Phase 1): how many ops were applied, refused, and how many conservation diffs
    // a stated `set` produced against the accumulated fold. Capped (`cap:`) because each is a
    // running total across passes; a rate that stays flat while play continues means the fold is
    // not being fed.
    'cap:rows-applied', 'cap:rows-refused', 'cap:rows-conservation',
    // The deep audit (Phase 3): how many exact findings were posed, applied, refused, or lost to a
    // failed call; and how many were deferred past the one-call question cap. Both spellings of the
    // deferred counter are declared, the literal `audit:deferred` is what the source scan reads,
    // `cap:audit:deferred` is the capped fired form.
    'audit:posed', 'audit:applied', 'audit:rejected', 'audit:failed',
    'audit:deferred', 'cap:audit:deferred',
    // The worst money gap on record, as a high-water mark rather than a running total (`noteMax`):
    // forty ten-stone discrepancies and one of 2604 must not read the same.
    'money:drift-worst',
    // The audit witnesses, which arrive as rejections through a template.
    //
    // `state.js` turns each witness from `invariant-table.js` into a rejection named
    // `invariant:<kind>`, with two kinds renamed on the way through (`drift` -> `money:drift`,
    // `overdraw` -> `invariant:overdraw`). Nobody proposed any of these: they are the ledger
    // disagreeing with itself, so the fix is never a better prompt, it is an earlier event that was
    // never recorded. `reject:invariant:overdraw` and `reject:invariant:partition-contradiction`
    // were both firing on the live Raccoon City chat while declared nowhere.
    'reject:money:drift', 'reject:invariant:overdraw',
    'reject:invariant:negative-quantity', 'reject:invariant:split-name',
    'reject:invariant:split-currency', 'reject:invariant:unbacked-debit',
    'reject:invariant:partition-contradiction',
    // The reader saying "I have seen these", which is the only thing that clears the panel chip.
    //
    // `state.js` `acknowledge` writes a watermark mark; `MAX_ACK_MARKS` is 5 and the pruner at
    // `PRUNE_ACK_MARKS` sheds the oldest half when the blob is over budget. So the surviving history
    // is a FLOOR on how many times the reader has looked, never the count, and the difference is
    // the finding. This counter is the count. `ack:marked 31` against three marks on screen says the
    // pruner has been eating comparisons, which is invisible from the marks alone and is the one
    // thing that would make the rate view quietly stop answering the question it exists for.
    'ack:marked',
]);

/**
 * The rules that have never fired in this chat, as they are counted.
 *
 * The namespaced form, which is what a surface listing them beside the fired ones needs: two rules
 * can share a short name, and `neverFired()`'s stripped output collapses them into one line.
 *
 * @returns {string[]} Rule names, namespaced.
 */
export function silentRules() {
    const seen = load();
    return KNOWN_RULES.filter(rule => !seen.has(rule));
}

/**
 * The rules that have never fired in this chat.
 * @returns {string[]} Rule names, unprefixed.
 */
export function neverFired() {
    return silentRules().map(rule => rule.replace(/^(reject|cap|verdict|pressure|threads|world):/, ''));
}

/**
 * Rules that fired but that `KNOWN_RULES` does not list.
 *
 * The other half of the silence. `neverFired()` catches a declared bound that never bound; this
 * catches a bound that binds and was never declared, which is invisible in exactly the same way and
 * strictly worse, because an undeclared rule cannot appear in the never-fired list either, so
 * nothing anywhere says the word. Four of these were live when the Diagnostics tab was built
 * (the place table's, added above), found by rendering this list rather than by reading code.
 *
 * @returns {Array<{rule: string, count: number}>} The undeclared observations, busiest first.
 */
export function undeclared() {
    const known = new Set(KNOWN_RULES);
    return table_entries(load())
        .filter(([rule]) => !known.has(rule))
        .map(([rule, count]) => ({ rule, count: Number(count) || 0 }))
        .sort((a, b) => b.count - a.count);
}

/** Forget the observations, so a calibration run can start from zero. */
export function clear() {
    commit(OBSERVED_PATH, new Map());
}

/**
 * Put a counter table back, for a caller that restored a whole blob around it.
 *
 * The instrument must survive the undo it is measuring.
 *
 * `repairs.revertPass` restores a snapshot of the entire fold blob, and this table rides inside it,
 * so a revert would roll the counters back to before the pass, and `reconcile:auto` would end up
 * reporting fewer repairs than the pass actually applied. Both things are true and both are
 * measurements: the pass applied six, and then the player reverted. A design whose whole case rests
 * on `asked: 80 / applied: 0` cannot let its successor's numbers be quietly rewritten by an undo.
 *
 * @param {Map<string, number>} table A table from `load()`.
 */
export function restore(table) {
    commit(OBSERVED_PATH, table);
}
