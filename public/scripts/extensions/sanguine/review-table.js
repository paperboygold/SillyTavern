/**
 * fold/review-table.js: extraction becomes review.
 *
 * The one retraction mechanism.
 *
 * Everything in `FOLD-RPG-GAP.md` that cannot close fails for one reason: *the retraction event is
 * something a narrator never bothers to say.* Nobody writes "the gate is no longer uncleared". The
 * probes fold already had are **write-only**, they are asked what is true, and silence about a
 * tracked line means nothing. Measured across all four live chat files: 31 lead rows in three
 * campaigns, ~180 assistant turns, every single one `open`. Not one `closed`, not one `stalled`, in
 * a vocabulary that has offered both since the table existed (`entities.js` `LEAD` statuses, and the
 * instruction at `entities.js:154-171` that used to say "Mark a lead closed once it is resolved").
 *
 * The fix is the SOM-DST insight applied wholesale: **the pass reads the ledger back and returns a
 * disposition for every open line.** The pinned block the model already gets (`state.ledgerBlock`)
 * grows an id on each open line, and one more fragment on the SAME call answers, per id, whether it
 * is still open, plus answers to the questions code decided to ask. No second request:
 * `FOLD-REDESIGN.md` §11, "No second extraction call", and `extract.js` has served multiple probes
 * on one call since clocks were added.
 *
 * Why the model can answer: closure is a **reading-comprehension question about a named specific**,
 * which is the category this codebase already trusts it with (`trigger-table.js:158-169`: "reading
 * the narrative is never fold's job… ask it") as opposed to hoping it spontaneously re-reports an
 * absence. At message 62 of the live chat the question "is the weapon thread still open?" has its
 * answer in the same window: *"set aside for purchase… Eighty-five thousand for the pair."*
 *
 * Pure, and what that buys.
 *
 * This file decides what to ASK and what an answer MEANS. `review.js` owns storage, the probe
 * registration and the writes. The split is Phase A's and Phase B's, for their reason: anything
 * importing `script.js` cannot be unit-tested, and the whole gate for this phase is canned answers
 * at the pure layer, code decides when to ask, the fixture supplies what the model would say.
 */

import { table_entries } from './lib/hash.js';
import { windowSnippet } from './diag.js';
import { MONEY, itemKey, splitItemKey } from './state-table.js';
import { CLOSED, DOOM, HIDDEN, MOOT, OPEN_STATUS, PROGRESS, THREAD_STALE, normalizeThreadName } from './thread-table.js';

/**
 * What a review may say about an open line.
 *
 * Four values, and the fourth is the one the old vocabulary lacked. `open` and `settled` are the
 * obvious pair; `advanced` exists because a dial that moved and a dial that did not are different
 * facts and `foldTicks` refuses `tick === 0` as `no-change` (`thread-table.js`), so "it moved" had
 * no way to be said about a line the review was looking at anyway; `moot` exists because a threat
 * that stops existing is not a threat that was defeated. The live chat had two moot clocks squatting
 * in the table until the repair script deleted them by hand, the goblin nest counterattack and the
 * party being overwhelmed, both dead the moment the nest was routed and the gate sealed
 * (`FOLD-RPG-GAP.md` §0).
 */
export const OPEN = 'open';
export const ADVANCED = 'advanced';
export const SETTLED = 'settled';
export const STILL = [OPEN, ADVANCED, SETTLED, MOOT];

/** What an identity question may be answered with. */
export const SAME = 'same';
export const DIFFERENT = 'different';

/**
 * What a card's own status field IS, answered by the model rather than decided by fold.
 *
 * Why this is a schema enum and not a lookup table.
 *
 * A card invents its own stat line. `HP`, `MP`, `SAN`, `AC`, `BP`, `Corruption`, `Heat`,
 * `Reputation`, `Bonds`, `Battle Power`: fold has no idea what any of them mean, and the one thing
 * it must never do is carry a list saying `['hp','mp','health','mana']` are vitals. That list is
 * missing a word the moment somebody loads a different card, in a different genre, in a different
 * language, and RULE 1 bans it outright as an enumerated judgement about English.
 *
 * So fold asks. The model is already reading the block in the prompt; naming what a field is, is a
 * reading, and a reading is exactly what RULE 1 says to request through the schema rather than
 * derive. This is the same licence `same_currency` and `same_thread` are built on, and it arrives
 * on the pass that already runs.
 *
 * The set is deliberately small and each member earns a DISTINCT rendering, a kind that renders
 * the same as another kind is not a kind, it is a synonym, and it would only give the model a
 * coin-flip to get wrong:
 *
 *   · `identity`   what the character IS (class, title, ancestry)  -> a subtitle under their name
 *   · `gauge`      a pool with a current and a maximum             -> a bar, beside fold's vitals
 *   · `counter`    an unbounded quantity                           -> a value chip, or the money row
 *   · `condition`  a temporary state on the character              -> the Condition list
 *   · `capability` something they can DO                           -> the Abilities rows
 *   · `goal`       an objective                                    -> Threads
 *   · `rating`     a slow score or tier                            -> the sheet
 *   · `other`      the honest escape hatch                         -> the sheet, counted
 */
export const SHEET_KINDS = ['identity', 'gauge', 'counter', 'rating', 'condition', 'capability', 'goal', 'bond', 'other'];

/**
 * The kinds that are a stat: one label, one value.
 *
 * The split is scalar-versus-list, and it is not tempo.
 *
 * The first cut of this demoted everything `arc`-tempo below the fold, on the reasoning that a
 * level moves over a campaign and health moves in a scene. That is true and it is not what the
 * panel is being asked. `Level 1 (30/100 EXP)`, `Gold 15G`, `BP 10` and `Reputation 0 "Nobody"` are
 * the character sheet, the owner asked for exactly these "up the top next to name, time", and
 * routing them by tempo put them back at the bottom, which was the original complaint verbatim.
 *
 * What he did NOT want up there was `Abilities`, `Bonds`, `Skills` and `Quests`: and the thing
 * those four share is not their tempo either. They are LISTS. A stat is a number you read at a
 * glance; a list is content you read a line at a time, and four of them is most of a screen.
 *
 * So `gauge`, `counter` and `rating` ride at the top whatever their tempo, and `capability`,
 * `goal` and `bond` sit in the sheet whatever theirs. `tempo` stays in the schema because it is
 * real and cheap, and it orders the top grid, what can change this scene reads first.
 */
export const SHEET_STATS = ['gauge', 'counter', 'rating'];

/**
 * How fast a field moves, which is a different question from what it is.
 *
 * `Level 1 (30/100 EXP)` is structurally a gauge and belongs nowhere near the top of the panel;
 * `HP 100/100` is the same shape and belongs at the very top. What separates them is not their type
 * but their TEMPO, whether the number can plausibly change inside one scene. Multiplying this into
 * `SHEET_KINDS` would double the enum and ask the model to keep two ideas in one answer; asking it
 * twice is cheaper and the answers are independent.
 *
 * This is the axis that answers the owner's own complaint: "Abilities, bonds, skills, quests should
 * not be up the top like that unless it's like your currently active quest."
 */
export const SHEET_TEMPO = ['scene', 'arc'];

/**
 * Id prefixes, one per question kind.
 *
 * Letters rather than a flat numbering, because the model has to answer a heterogeneous list and a
 * prefix is the cheapest way to keep "T3 is settled" from being read as an answer to a question
 * about a lock. They are also what the note in a `review` event cites, so they end up in the audit
 * trail a reader scrolls past.
 */
export const PREFIX = { thread: 'T', place: 'P', mark: 'M', adversary: 'A', ask: 'Q', item: 'I' };

/**
 * How many DIRECTED questions one pass may carry.
 *
 * Threads are already bounded at MAX_THREADS = 24 and the largest live campaign has 15 open; the
 * questions have no such bound. A migration can flag a dozen at once and the near-identity detector
 * is deliberately loose, so without a ceiling the first pass of a converted chat is a wall of
 * interrogation: and `FOLD-REDESIGN.md` §12's first open question is whether a small model answers
 * dispositions honestly or rubber-stamps them. A list of thirty is a list that gets rubber-stamped.
 *
 * Measured, and the first number I wrote here was wrong.
 *
 * The draft said "the largest question set any of the four live chats produces on its first pass is
 * five". Counted properly, migrate the pre-repair2 Solo Leveling header, run both detectors over
 * the result, dedupe with `outstanding`: it is **ten**: six identity pairs (the broker pair, the
 * squad/team pair, and four cross-table residency pairs the migration's own looser trigger raises),
 * two polarity flags, one lock contest, one money question. Evil Hero Party's first pass produces
 * four; Nora's and Raccoon City's produce none.
 *
 * Why the house convention (twice the observed maximum) does NOT apply here.
 *
 * Every other bound in this codebase caps DATA, and the argument for two-times headroom is that a
 * cap inside the observed range silently destroys something. This one caps a QUEUE. Nothing is lost
 * when a question does not fit: the migration flags stay in `state.migrated`, the detectors re-raise
 * their pairs from the tables, and the money question stays in `state.owed`, so an unasked question
 * is asked on the next pass with nothing changed. The cost of a low ceiling is latency, ten
 * questions drain in two passes at eight, and the cost of a high one is the rubber-stamping §12
 * names, which is the failure that would make the whole mechanism worthless.
 *
 * Eight, therefore: it clears the eight identity-and-polarity questions of the worst observed first
 * pass in one go, leaves the lock and money questions for the pass immediately after, and keeps the
 * block short enough to read. It is the one number in this file set against an UNMEASURED risk, and
 * `review:kept` against `review:settled` on one real session is the instrument that will retune it.
 *
 * Ordering matters more than the ceiling and is not left to chance: locks first, then identity, then
 * polarity, then money (see `reviewBlock`). The two pairs Phase C's gate names, the broker pair and
 * `Kang's squad`/`Kang's team`: are the first two identity questions in every ordering the sources
 * produce, so they are asked on the first pass at any ceiling above two.
 */
export const MAX_QUESTIONS = 8;

/**
 * How many turns a thread may go unposed before the review must ask about it anyway.
 *
 * The safety valve on `[TLB]`'s touched-only posing (see `reviewableWindow`). A thread the window
 * never mentions is usually a thread that will answer "still open", but a thread that stops being
 * named is exactly the thread most likely to have been settled off-screen, and it must not be able
 * to sit unasked forever. Every REVIEW_EVERY turns, the untouched threads get one look. Set from
 * the cadence that matters: a couple of scenes' worth of turns, so the valve never floods a pass
 * (untouched threads are posed once per valve, not every pass) and never lets a thread rot either.
 */
export const REVIEW_EVERY = 8;

/**
 * How many mark lines one review block may carry.
 *
 * `MAX_FLAGS = 32` bounds the marks TABLE (`state-table.js`) and would allow a block with
 * thirty-two bodies in it, which is the size discipline `FOLD-REDESIGN.md` §12.2 asks this renderer
 * to enforce rather than merely promise. Ten, by the house convention of twice the observed
 * maximum: the worst live moment is message 72 of the Solo Leveling chat, five simultaneous
 * conditions on one man after the Nowon raid, and the worst plausible moment is a fight in which
 * everyone present is hurt, six people at one mark each.
 *
 * Nothing is lost when a mark does not fit, for `MAX_QUESTIONS`' reason: this caps a QUEUE, not
 * data. The mark stays in the fold and is asked about next pass. Ordering puts the pov's own marks
 * first (`state.js` `markLines`), because his are the ones the adjudicator weighs.
 */
export const MAX_MARK_LINES = 10;

/**
 * How many unclassified card fields one pass may pose.
 *
 * A card's whole stat line is bounded by the card, the live Isekai block carries eleven labels,
 * which is the largest in the corpus, and every one classified is one that never has to be asked
 * again. Twelve clears it, and a card with more simply finishes over two passes instead of one.
 */
export const MAX_SHEET_LINES = 12;

/**
 * How many turns an unanswered money question stays askable.
 *
 * Measured, not chosen.
 *
 * Every `[paid?]` question in the traced corpus, grouped by the item list it posed and spanned from
 * its first ask to its last, 271 distinct questions across nine campaigns, 369 asks:
 *
 *     gone within 0 turns   83.8%
 *     within 1 turn         94.1%
 *     within 2 turns        97.0%
 *     the remaining 3%      six questions, spanning 3 to 10 turns and 4 to 11 asks
 *
 * The distribution has no tail worth waiting for. A question either lands on the pass right after
 * it is raised, while the excerpt that named the purchase is still in the window, or it never lands
 * at all, 244 of the 369 asks came back with no answer row for exactly that reason, the model being
 * asked to price items it could no longer see. The six long ones are not slow answers, they are
 * questions nobody could answer being re-posed forever: a lone `torch` held a review slot for
 * eleven consecutive passes, and the worst re-asked a list of eight for ten.
 *
 * Two is therefore the bound that costs nothing measurable and stops all six. It is also the point
 * past which the question is misleading: `review.noteCredits` quotes the balance as it stood when
 * the items arrived, deliberately, and a purse two turns old is a number the model is being asked
 * to reason against and should not be.
 */
export const OWED_TURNS = 2;

/**
 * The stored money question, if it is still worth asking.
 *
 * A record with no `turn`, written before the stamp existed, is treated as fresh, which is the
 * fail-open every other horizon in this codebase takes: a bound that erases data on a missing field
 * is a bound that erases data during an upgrade.
 *
 * @param {object|null} stored The record as persisted, or null.
 * @param {number} now The turn to age it against.
 * @returns {object|null} The question, or null when there is none or it has expired.
 */
export function askableOwed(stored, now) {
    if (!stored || !Array.isArray(stored.items) || !stored.items.length) {
        return null;
    }
    const aged = Number.isFinite(stored.turn) && Number.isFinite(now) && now - stored.turn > OWED_TURNS;
    return aged ? null : stored;
}

/**
 * Build the review section of the pinned ledger, and the index that reads its answers back.
 *
 * Ids are assigned deterministically, not incrementally.
 *
 * "Stable" here means: the same ledger produces the same ids, and an id means one thing for the
 * whole round trip. Both fall out of sorting by table key within each kind rather than by whatever
 * order a Map happened to iterate. It deliberately does NOT mean an id survives a thread closing,
 * numbering is per-pass and the answers come back in the same response, so a persisted id table
 * would be a second source of truth about a list that is already derived.
 *
 * @param {object} params Everything the ledger currently believes that could close.
 * @param {object[]} [params.threads] Open threads, from `threads()`/`threadsByKind`.
 * @param {object[]} [params.unplaced] Cast rows whose whereabouts are unstated (`castAt`).
 * @param {object[]} [params.marks] Live marks: `{key, name, phrase, severity, mine}`.
 * @param {object[]} [params.carried] Items on the ledger: `{key, name, qty}`.
 * @param {object[]} [params.threats] Cast rows carrying a threat: `{key, name, threat}`.
 * @param {object[]} [params.identity] Identity pairs: `{a, b, why, kind, names}`.
 * @param {object[]} [params.polarity] Migrated dials awaiting a polarity: `{thread, name, about}`.
 * @param {object|null} [params.owed] The credits-without-debit question, or null.
 * @param {number} [params.budget] How many directed questions to ask this pass.
 * @returns {{text: string, index: Map<string, object>}} The block section and the id index.
 */
export function reviewBlock({
    threads = [], unplaced = [], marks = [], threats = [], identity = [],
    polarity = [], owed = null, carried = [], sheet = [], budget = MAX_QUESTIONS,
} = {}) {
    const index = new Map();
    // Two sections, rendered apart, because they want two different kinds of answer: everything
    // under `dispositions` is a T/M/A line judged with a `still` value, everything under `questions`
    // is a P/L/Q answered in the field its kind names.
    //
    // They no longer imply two DESTINATIONS, and that is the repair. The sections were added when
    // the schema had two arrays and the model was filing `[where now?]` answers into the
    // dispositions one, 19 refusals in the Time Stop chat, every one a P id. Splitting the block
    // did not close it; 7 more landed in New Eldoria. The array was the redundant half: the id
    // already names the kind, so `reviewSchema` now asks for one list and `planReview` routes.
    const dispositions = [];
    /** Stale lines, asked of the record rather than the excerpt. See the push site. */
    const forgotten = [];
    const questions = [];

    const sorted = list => [...list].sort((a, b) => String(a?.key ?? a?.field ?? '').localeCompare(String(b?.key ?? b?.field ?? '')));

    sorted(threads).forEach((thread, at) => {
        const id = `${PREFIX.thread}${at + 1}`;
        index.set(id, { id, kind: 'thread', key: thread.key });
        // A dial prints its position, because "is this still open" and "how far has it got" are the
        // same question for a thread that has a measurable one, and the model cannot judge either
        // without the number. A dial-less thread prints what is unresolved about it, the `open`
        // field is the reason the thread is in the prompt at all (`thread-table.js` renderOpenThreads).
        // A hidden dial is named but never quantified, the same rule `renderPressure` keeps: the
        // narrator knows something is closing in and how near it is stays theirs to decide. The
        // review can still be asked whether it is moot, which is the exit a hidden threat most
        // needs, since nobody is watching it fill.
        //
        // A stale line is asked a DIFFERENT question, because the excerpt cannot answer the old one.
        //
        // Past THREAD_STALE a dial-less thread has left the narrator's prompt (`threadsByKind`), so
        // the story stops touching it, so `[open]`, "did this excerpt settle it?", has exactly one
        // honest answer forever, and the instruction says so outright: "a thread the excerpt does
        // not touch is still open". Measured on the live My Hero Academia RP: review:kept 53 against
        // review:settled 1, with all three of the chat's threads stale at 26, 31 and 35 turns and
        // none of them rendered anywhere. One read "hero costume pickup, costume not yet picked up"
        // while the inventory two lines above it held the costume.
        //
        // "Is this still a stake at all" is answerable from the RECORD rather than the excerpt,
        // which is the same thing `same_currency` is answered from and the same licence: the model
        // is already reading this list. `moot` then retires it through the path that exists.
        //
        // Dialled threads keep their number and never reach this state, `threadsByKind` filters
        // only dial-less ones by staleness, because a countdown is not stale for going unmentioned.
        // A dial prints its number whatever its age, a countdown is not stale for going unmentioned,
        // and "still a thing?" invites a wrong moot on a live clock. Everything else asks of the
        // record exactly when the excerpt cannot answer, which `reviewableWindow` already decided.
        const face = thread.dial
            ? (thread.seen === HIDDEN ? 'closing in' : `${thread.dial.filled}/${thread.dial.size}`)
            : (thread.askedOfRecord || (thread.stale ?? 0) >= THREAD_STALE) ? STILL_A_THING : OPEN;
        const said = [thread.detail, thread.open, thread.about].filter(Boolean).join(', ');
        // A line asked of the RECORD does not belong in the list asked of the excerpt.
        //
        // Both kinds used to render in one block under one header, and the instruction had to carry
        // the contradiction: "a thread the excerpt does not touch is still open, say nothing about
        // it", then, one line later, "a line marked [still a thing?] is the exception… this is one
        // you should answer." The conservative rule wins that argument every time, because it is
        // stated first and covers every line the model can see.
        //
        // MEASURED, live Wuxia World RPG at 133 messages: 14 lines posed per pass, 7 of them
        // wearing the stale face, and 24 closures against 956 asks, a 2.5% closure rate, with
        // `find a blacksmith shop` still open beside `collect forged spear` (the blacksmith is
        // demonstrably found; he is forging the spear) and two duplicate spear-collection threads
        // both 26+ turns cold.
        //
        // Separating them is what `Unsorted` already does for the sheet: a different question gets
        // a different heading, so no line is under two instructions at once.
        (face === STILL_A_THING ? forgotten : dispositions)
            .push(`  ${id} [${face}] ${thread.name}${said ? `: ${said}` : ''}`);
    });

    sorted(unplaced).forEach((person, at) => {
        const id = `${PREFIX.place}${at + 1}`;
        index.set(id, { id, kind: 'place', key: person.key, name: person.name });
        // Not "is this person still here?", that is the question `castAt` was answering by guessing
        // (`entity-table.js`, the three-valued note). The review asks where they ARE, which is the
        // dispatch law's third action: when the evidence cannot decide, ask rather than default.
        questions.push(`  ${id} [where now?] ${person.name}${person.place ? `: last placed: ${person.place}` : ''}`);
    });

    // Marks close the way threads close.
    //
    // `FOLD-REDESIGN.md` §2's table lists marks in its second row, and names what closed them before
    // this: "`turns` guess at write time only", a duration the model invented on the turn the wound
    // was inflicted, which `cap:condition-expired` shows has never once fired in any of the three
    // chats. So a wound healed only if somebody remembered to narrate it healing AND the extraction
    // happened to phrase the negation in a way `isNegation` recognised. Here it is asked directly.
    // The owner is named in the line because a review that cannot tell Lee's ribs from Solomon's
    // calf is the subjectless flag table with extra steps.
    //
    // Settle and clear, but NOT merge, and the reason is that the question is unreachable.
    //
    // `FOLD-REDESIGN.md` §3 makes same-owner near-duplicate marks "a standing review identity
    // target", and the honest reading of that, once the fold changed, is that there is nothing left
    // for a question to catch. Two duplicates on one owner have to survive `statusKeyFor` first, and
    // that now merges on a shared content word OR a shared stem (`state-table.js` `sameSubject`,
    // measured: it collapses the one live pair, `fatigued` / `mild fatigue`). Anything that gets
    // past it is a pair with NO shared word, and §2's detector needs a shared head token, so it
    // provably cannot see such a pair either. Worked through on the live examples: `cut left calf`
    // and `clawed left calf` agree on the last token and differ in the first, which is the
    // substitution branch's excluded case by its own docblock. Shipping a question that cannot fire
    // is worse than not shipping it: it costs a slot in a budget §12 says gets rubber-stamped when
    // it grows. The recovery for a genuine duplicate is to settle one of them, which these lines do.
    marks.slice(0, MAX_MARK_LINES).forEach((mark, at) => {
        const id = `${PREFIX.mark}${at + 1}`;
        index.set(id, { id, kind: 'mark', key: mark.key, phrase: mark.phrase, who: mark.who, name: mark.name });
        dispositions.push(`  ${id} [mark: ${mark.name}] ${mark.phrase}${mark.severity ? ` (${mark.severity})` : ''}`);
    });

    // One line per active adversary, and the disposition vocabulary already says what a fight ending
    // means: `settled` (beaten) or `moot` (they left, it stopped being a fight). §12.3 makes this the
    // measurement, no live combat has ever run under this schema, so it is deliberately the
    // smallest thing that can be asked and answered.
    threats.forEach((row, at) => {
        const id = `${PREFIX.adversary}${at + 1}`;
        index.set(id, { id, kind: 'adversary', key: row.key, name: row.name });
        dispositions.push(`  ${id} [threat ${row.threat}] ${row.name}, still fighting?`);
    });

    // One line per carried item. The count rides along because "do you still have this" and "how
    // many" are the same question about a pack, exactly as a dial prints its position, and a model
    // that reads "spirit stones x8" and knows six were spent has somewhere to say so.
    //
    // `settled` and `moot` both drop it, and the vocabulary already means the right things: the
    // thing it was tracking is over. Given away, sold, left on a body, broken, eaten, a pack does
    // not distinguish those and neither does this.
    carried.slice(0, MAX_ITEM_LINES).forEach((row, at) => {
        const id = `${PREFIX.item}${at + 1}`;
        index.set(id, { id, kind: 'item', key: row.key, name: row.name, qty: row.qty ?? 1 });
        const count = (row.qty ?? 1) > 1 ? ` x${row.qty}` : '';
        dispositions.push(`  ${id} [still carrying?] ${row.name}${count}`);
    });

    // `kind` is spread LAST, deliberately. It was written first and the migration's own pairs carry
    // a `kind` of their own (`migrate.js` `identityQuestions` tags them 'thread' or 'cast'), so the
    // spread overwrote the question kind with the table name and four of the ten questions on the
    // worst observed first pass rendered as blank lines. Caught by printing the real block rather
    // than by a test, which is why the block is printed in the gate.
    const asked = [];
    identity.forEach(pair => asked.push({ ...pair, kind: 'identity' }));
    polarity.forEach(flag => asked.push({ ...flag, kind: 'polarity' }));
    if (owed) {
        asked.push({ ...owed, kind: 'money' });
    }

    // Identity, then polarity, then money, most consequential first, because a truncated list
    // drops from the end. Two names that may be one thing is the worst thing the record can be
    // wrong about; a money question is asked again next pass at no cost.
    //
    // Lock contests used to lead this list and are gone with the pinning mechanism: pinning a scene
    // field meant the narrator could not change it, which is not what pinning is for.
    asked.slice(0, Math.max(0, budget)).forEach((question, at) => {
        const id = `${PREFIX.ask}${at + 1}`;
        index.set(id, { id, ...question });
        questions.push(`  ${id} ${questionText(question)}`);
    });

    // The card fields nobody has classified yet.
    //
    // Posed by LABEL rather than by id: the answer is keyed on the label, the label is what the
    // card wrote, and it is stable across passes in a way an ordinal id is not. Only the unsorted
    // ones are shown, so a chat whose sheet is fully classified pays nothing at all for this, the
    // list is empty, the schema array comes back empty, and the section does not render.
    const unsorted = sheet.slice(0, MAX_SHEET_LINES).map(field => `  ${field.label}: ${field.value}`);

    const all = [...dispositions, ...forgotten, ...questions, ...unsorted];
    if (!all.length) {
        return { text: '', index };
    }
    return {
        // The section headers name the array each list feeds, so the model files a line where the
        // schema can read it. The header is the mechanism; a line under "Say which of these are
        // settled" is a disposition (fragment `lines`), a line under "Answer:" is a question
        // (fragment `answers`).
        text: [
            'Tracked now:',
            ...(dispositions.length
                ? ['Say which of these are settled, put your reading in the "lines" answers:', ...dispositions]
                : []),
            ...(forgotten.length
                ? ['Nothing has touched these in a long time. Answer EVERY one from the record, has it quietly been done, has it stopped mattering, or is it genuinely still outstanding? Put your reading in the "lines" answers:', ...forgotten]
                : []),
            ...(questions.length
                ? ['Answer these, put your reading in the "answers" list:', ...questions]
                : []),
            ...(unsorted.length
                ? ['Unsorted, say what each of these is, in the "sheet" list:', ...unsorted]
                : []),
        ].join('\n'),
        index,
    };
}

/**
 * One question, as the model reads it.
 * @param {object} question A question record.
 * @returns {string} The line body.
 */
function questionText(question) {
    switch (question.kind) {
        // The count is stated because it is the evidence for asking: one disagreement is the
        // narrator wandering, three consecutive ones is the story having moved.
        case 'identity':
            // "One name containing another is not identity" (`FOLD-RPG-GAP.md` §4) is exactly why
            // this is a question rather than a merge. The detector is loose on purpose.
            return `[same?] Are "${question.names?.[0] ?? question.a}" and "${question.names?.[1] ?? question.b}" the same ${question.of === 'cast' ? 'person' : 'thing'}? Answer "${SAME}" or "${DIFFERENT}".`;
        case 'polarity':
            return `[good or bad?] For "${question.name}"${question.about ? ` (${question.about})` : ''}, is filling this bad for the characters ("${DOOM}") or good ("${PROGRESS}")?`;
        case 'money':
            // The premise is quoted back, because the premise is now the model's own.
            //
            // It read "these were recorded as gained with nothing paid", which asserted a purchase
            // fold had inferred, and across 369 asks the model's commonest answer was to refuse the
            // premise outright (102 "nothing was paid" against 19 amounts). The trigger no longer
            // infers anything: this list is items the extraction itself marked `how: "bought"`, so
            // the question can say WHY it is being asked and the model is being held to its own
            // reading rather than argued with about fold's. "nothing" stays a real answer, it is
            // how the model retracts a `bought` it should not have written, but it is now a
            // correction rather than the expected reply.
            return `[paid?] You recorded these as BOUGHT and no payment was recorded: ${question.items.join(', ')}. Balance on record: ${question.balance} ${question.currency}. What was paid? Answer with the amount, or "nothing" if they were not bought after all.`;
        default:
            return '';
    }
}

/**
 * The probe's schema fragment.
 *
 * ONE array, because the second routing decision was the defect.
 *
 * This carried two: `lines` for dispositions and `answers` for questions. The stated reason was
 * that they are two different acts with two different vocabularies, and "collapsing them would mean
 * one `enum` covering `settled` and `₩120,000`, which is a schema that teaches the model nothing".
 * That argument is against merging the FIELDS, and nothing here does: `still` is still its own enum,
 * `amount` is still an integer, and each kind still fills exactly the field its question asks for,
 * which is how `answers` already worked with five of them.
 *
 * What is gone is the requirement to pick an ARRAY. The model has already copied an id; `index` maps
 * that id to its kind and `planReview` has always dispatched on it, so the array added a second
 * routing decision that carried no information fold did not already have. It was the one being got
 * wrong: `review-wrong-shape` fired 19 times in the Time Stop chat, every one a P id, and 7 more in
 * New Eldoria after the BLOCK had been split into two sections to make the two arrays visible. The
 * block split was a repair aimed at the symptom; twenty-six refusals say it did not reach the cause.
 *
 * And the misfiling was unrecoverable, which is why "read it from whichever array it arrives in"
 * was not the fix: the old `lines` item was `{id, still, note}` under `additionalProperties: false`,
 * so a `[where now?]` answer filed there had nowhere to put the place name. The answer was destroyed
 * by the shape before fold ever saw it. One list is the only version that keeps it.
 *
 * The block still renders two SECTIONS, because grouping by what kind of answer is wanted is worth
 * reading. It no longer implies two destinations.
 *
 * Every object carries `additionalProperties: false` and lists every property in `required`, because
 * OpenAI strict mode demands it on EVERY object and one omission fails the whole shared call for
 * every probe at once (`extract.js` buildSchema).
 *
 * @returns {object} A JSON Schema fragment.
 */
export function reviewSchema() {
    return {
        type: 'object',
        description: 'Your reading of the lines listed under "Tracked now" in the already-recorded block.',
        properties: {
            lines: {
                type: 'array',
                description: 'One entry for each id in the block you can judge or answer from this excerpt. Omit any the excerpt says nothing about. The id decides which field below to fill; the rest stay empty.',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'The id exactly as listed, e.g. "T3", "M1", "A2", "P1", "L1", "Q1".' },
                        // Each id's kind fills the field that names its answer shape; the others are
                        // empty. `still` and `answer` are closed protocol vocabularies (the same
                        // words the line itself offers), never free prose, language-independent.
                        still: {
                            type: 'string',
                            enum: ['', ...STILL],
                            description: `For a T, M or A line: ${OPEN} if still unsettled; ${ADVANCED} if it moved closer without finishing; ${SETTLED} if this excerpt resolved it; ${MOOT} if it stopped being about anything. Empty for P, L and Q ids.`,
                        },
                        answer: {
                            type: 'string',
                            enum: [SAME, DIFFERENT, PROGRESS, DOOM, ''],
                            description: `For an identity question: ${SAME} or ${DIFFERENT}. For a polarity question: ${PROGRESS} or ${DOOM}. Empty for other kinds.`,
                        },
                        place: { type: 'string', description: 'For a "where now?" question: the place name, as the excerpt words it. Empty for other kinds or when the excerpt does not say.' },
                        amount: { type: 'integer', description: 'For a "paid?" question: the amount paid, in the currency the question names. 0 for other kinds.' },
                        nothing: { type: 'boolean', description: 'For a "paid?" question: true only when the items were not bought at all, a gift, a find, loot, and the "bought" reading was wrong. False for other kinds.' },
                        note: { type: 'string', description: 'Five words at most saying why, quoting the excerpt where you can. Empty if nothing to add.' },
                    },
                    required: ['id', 'still', 'answer', 'place', 'amount', 'nothing', 'note'],
                    additionalProperties: false,
                },
            },
            same_currency: {
                type: 'array',
                // The one identity question fold cannot raise for itself.
                //
                // Threads and cast have tables a detector walks. Inventory is a fold over the
                // chronicle, so there is no table, and the structural substitutes are
                // script-dependent: a token overlap finds `silver wen` against `silver` and misses
                // `二十银两` against `银两`, because Han does not space its words. Arithmetic finds a
                // split only after it has already overdrawn a balance.
                //
                // The model has no such problem. The Money block is pinned in every prompt, it
                // reads it in whatever language it was written, and naming two lines as one
                // currency is a reading, which is what RULE 1 says to ask for rather than derive.
                // This is a field on the pass that already runs, never a new request.
                description: 'Look at the Money block above. If two of its entries are the same currency written two ways, "silver" and "silver wen", "copper" and "copper coins", list the pair. Give the CURRENCY NAME only, without the amount: for "20 silver wen · 30 silver" that is "silver wen" and "silver". Never pair an entry with itself. Empty when every entry is a distinct currency, which is the usual case and the usual answer.',
                items: {
                    type: 'object',
                    properties: {
                        a: { type: 'string', description: 'One money line, exactly as the block writes it.' },
                        b: { type: 'string', description: 'The other line naming the same currency.' },
                    },
                    required: ['a', 'b'],
                    additionalProperties: false,
                },
            },
            same_thread: {
                type: 'array',
                // The identity fold's own detector provably cannot raise.
                //
                // `nearIdentity` is a token-subset test over names, which is the right shape under
                // RULE 1, pure algebra on fold's own keys, no morphology, no threshold, and is
                // structurally incapable of pairing two names that share no token. Measured on the
                // live New Eldoria table at turn 90: 22 threads, 231 possible pairs, ZERO raised.
                // Among the ones it cannot see are "Musical language of the symbols" and "Musical
                // language hypothesis", opened one turn apart, and five separate threads about one
                // stone sphere. Two threads about one subject usually do not word it alike; that is
                // exactly why they became two.
                //
                // Same answer as `same_currency` above: the model is already reading this list in
                // this prompt, and "these two stakes are one stake" is a reading. A field on the
                // pass that already runs, never a new request.
                description: 'Look at the lines listed under "Say which of these are settled". If two of them are the same stake worded two ways, the same job, the same mystery, the same danger, list the pair by NAME, exactly as written above. Judge the stake, not the wording: two names that share no words can still be one thing. Never pair a line with itself. Empty when each is a distinct stake, which is the usual case.',
                items: {
                    type: 'object',
                    properties: {
                        a: { type: 'string', description: 'One thread name, exactly as the block writes it.' },
                        b: { type: 'string', description: 'The other name for the same stake.' },
                    },
                    required: ['a', 'b'],
                    additionalProperties: false,
                },
            },
            same_person: {
                type: 'array',
                // The cast half. `entities.questions()` walks the same token test and has the same
                // blind spot; measured live, `Grimble` and `Armorer` are one merged row and two
                // separate rows in the same chat, and no name-based test could raise either pair.
                description: 'Look at the People listed in the record above. If two entries are the same person under two names or descriptions, list the pair by NAME, exactly as written. Never pair an entry with itself. Empty when each is a distinct person, which is the usual case.',
                items: {
                    type: 'object',
                    properties: {
                        a: { type: 'string', description: 'One person, exactly as the record names them.' },
                        b: { type: 'string', description: 'The other name for the same person.' },
                    },
                    required: ['a', 'b'],
                    additionalProperties: false,
                },
            },
            sheet: {
                type: 'array',
                // The card's own stat line, sorted by the only reader that can read it.
                //
                // See `SHEET_KINDS`. fold parses a card's status block into labelled fields and has
                // no idea what any label means; the alternative to asking is a word list, which
                // RULE 1 bans and which would be wrong for the next card anyway.
                //
                // Answered from the RECORD, like `same_currency`: the block is pinned in this
                // prompt, so no new request and no dependence on the card emitting a fresh block.
                // That matters here: the live Isekai card only prints its block when the player
                // types "status", and absorb STRIPS the block once it has read it, so a
                // classification that waited for the next block would wait forever.
                description: 'Look at the "Unsorted" list above, if there is one. For each line, say what kind of thing it is and how fast it moves. "kind": "identity" for what the character IS (class, title, species); "gauge" for a pool with a current and a maximum that fills and empties (health, mana, sanity, corruption); "counter" for an unbounded quantity (coin, ammo, charges); "rating" for a single score, grade or tier (level, experience, an armour class, a reputation standing); "condition" for a temporary state on their body or mind; "capability" for a LIST of things they can do (skills, spells, techniques); "goal" for objectives or quests; "bond" for standing with people or factions; "other" when none of these fit, say "other" rather than guessing. The first four are single values you could read at a glance; the next four are lists or sets. Judge which by whether one entry would need its own line. "tempo" is "scene" if the value could plausibly change during a single scene, "arc" if it moves over a whole campaign: health is "scene", a level or a reputation is "arc". Judge the thing, not the label, a card may call anything anything. Answer every line once. Empty when there is no Unsorted list.',
                items: {
                    type: 'object',
                    properties: {
                        label: { type: 'string', description: 'The field label, exactly as the Unsorted list writes it.' },
                        kind: { type: 'string', enum: SHEET_KINDS, description: 'What this field is.' },
                        tempo: { type: 'string', enum: SHEET_TEMPO, description: 'Whether it can change within one scene.' },
                        same_as: { type: 'string', description: 'If this names the SAME fact as a row the State block above ALREADY tracks, give that row\'s name exactly as the State block writes it. Check every part of the State block, not only the gauges: a card field "Gold: 15G" and a "Stored (money): gold" row are one balance, and a card field "MP: 30/50" and an "mp" gauge are one pool. Only ever name a row that actually appears above, if nothing up there holds this fact, leave it empty, which is the usual answer.' },
                    },
                    required: ['label', 'kind', 'tempo', 'same_as'],
                    additionalProperties: false,
                },
            },
        },
        required: ['lines', 'same_currency', 'same_thread', 'same_person', 'sheet'],
        additionalProperties: false,
    };
}

/**
 * How many carried items one review block may pose.
 *
 * The list that had no question at all.
 *
 * Every other table fold keeps could be closed by the review; inventory could not. An item entered
 * when the model volunteered a positive delta and left only if it volunteered a negative one, and
 * the live Wuxia World RPG has THREE negative carried deltas in 143 messages, all from one selling
 * scene. Gains are salient to a narrator. Putting something down, giving it away, leaving it on a
 * body: none of those read as bookkeeping while you are writing them.
 *
 * What that cost: the Azure Dragon sword, taken off a dead disciple at mid 88 and laid down with him
 * at mid 92, stayed on the ledger. The pinned block kept telling the narrator it was on the player's
 * hip, and the village head asked "That's the sword you took off him, boy?", fold's own stale
 * record, read back to the player as an accusation.
 *
 * Ten, by the same house convention as `MAX_MARK_LINES`: twice the observed maximum. The live chats
 * hold 13-18 rows at their fullest, most of them inert (a bedroll, a straw hat, a map), and this
 * caps a QUEUE rather than the table, what does not fit is posed on a later pass.
 */
export const MAX_ITEM_LINES = 10;

/**
 * The face a stake wears once the story has stopped touching it.
 *
 * fold's own protocol vocabulary, in the block the model reads, the same category as `[open]` and
 * `[where now?]`, and English by the same licence.
 */
export const STILL_A_THING = 'still a thing?';

/** @returns {string} Prompt guidance for the probe. */
export function reviewInstruction() {
    return [
        'Read the tracked lines and say, for each you can judge, whether it is still open.',
        'Everything goes in ONE list, "lines", one entry per id, and the id decides which field to fill.',
        'Under "Say which of these are settled", the T, M and A lines, fill "still": whether it is open, advanced, settled or moot.',
        'Under "Answer these", the P, L and Q questions, fill the field that question asks for: an identity question answers "same" or "different" in "answer"; a polarity question answers "progress" or "doom" in "answer"; a "where now?" question puts the place in "place"; a "paid?" question puts the amount in "amount" or sets "nothing" true when nothing was paid. The other fields stay empty.',
        'Judge from what the excerpt says. A thread the excerpt does not touch is still open, say nothing about it rather than guessing.',
        `The lines under "Nothing has touched these in a long time" are the exception, and they are asked of the RECORD rather than the excerpt. That rule above does not apply to them: leaving one unanswered is not caution, it is the reason a finished errand is still on the list forty turns later. Read what each says it is waiting on and answer whether the story still has it outstanding. ${MOOT} if it stopped being about anything or was quietly overtaken, a task already done, a danger long past, an errand nobody is on any more, a place already reached. ${SETTLED} if it has in fact been resolved. ${OPEN} only if it is genuinely still pending and somebody would still act on it. Answer every one of them.`,
        `A thread is ${SETTLED} when the thing it was waiting on has happened, whether or not anyone announced it.`,
        `It is ${MOOT} when it stopped being about anything, the danger is gone, the errand no longer matters.`,
        `An M line is an injury: ${SETTLED} once healed or treated, ${ADVANCED} while mending, ${OPEN} otherwise. Nobody announces a bruise has faded, judge from time and treatment.`,
        `An A line is somebody dangerous: ${SETTLED} once beaten, ${MOOT} once the fight stopped being a fight, ${OPEN} while it continues.`,
        `An I line is something the record says the character is carrying: ${SETTLED} or ${MOOT} if this excerpt shows them without it, put down, given away, sold, spent, eaten, broken, left behind, and ${OPEN} while they still have it. Say nothing about the ones the excerpt does not touch. This is how something LEAVES the record; nothing else removes it, and a thing the character no longer has goes on being described as theirs until you say so.`,
        'The questions were asked because something is ambiguous in the record, not in the fiction.',
        'Never answer a question the excerpt and your reading cannot settle. An omitted answer is asked again; a wrong one is acted on.',
        'One more, and it is about the Money block rather than the excerpt: if two of its entries are the same currency written two ways, list the pair in "same_currency" by currency name, without the amounts. Leave it empty when they are genuinely different currencies, or when the block has only one entry. This is the one thing here you read from the record rather than from the story.',
        'Two more of the same kind, and they are also about the record rather than the excerpt: "same_thread" for two tracked lines that are one stake worded two ways, and "same_person" for two entries in the record that are one person. Judge the thing, not the wording, two names sharing no words can still be one stake. Both are usually empty; a pair you list is asked back for confirmation before anything is merged, so name one when you see it.',
    ].join(' ');
}

/**
 * Turn a review fragment into the writes it licenses.
 *
 * Nothing here touches storage: it returns a plan, and `review.js` applies it. That is what lets the
 * whole mechanism be tested with canned answers, which is the only honest way to test a step whose
 * other half is a language model.
 *
 * @param {any} fragment The probe's slice of the extraction.
 * @param {Map<string, object>} index The id index `reviewBlock` returned for this pass.
 * @returns {object} The plan: closures, merges, placements, polarity, contests, money, counters.
 */
export function planReview(fragment, index, { windowText = '' } = {}) {
    const plan = {
        closures: [], advanced: [], kept: 0,
        places: [], merges: [], different: [], polarity: [], locks: [], money: null, currency: [], suspected: [], sheet: [],
        dropped: [],
        cleared: [], disarmed: [],
        rejected: [],
    };
    const seen = new Map(index ?? []);
    // The window excerpt every refusal records, the same one the inventory and mark validators
    // attach. A rejection without it is a tally rather than a diagnostic: twenty-six
    // `review-wrong-shape` refusals were recorded across two chats and not one of them says what
    // the model sent, so the only way to read them was to reason about the schema.
    const snippet = windowSnippet(windowText);

    // One list, and the id routes it.
    //
    // `lines` used to be dispositions only, with a second `answers` array for questions. See
    // `reviewSchema`'s docblock: the split asked the model to choose a destination it had already
    // named by copying the id, and that choice was the thing being got wrong.
    for (const raw of Array.isArray(fragment?.lines) ? fragment.lines : []) {
        const question = seen.get(String(raw?.id ?? '').trim().toUpperCase());
        if (!question) {
            // The one refusal left in this loop, and it is unroutable by construction: an id fold
            // never minted maps to no kind. Everything else is dispatched.
            plan.rejected.push({ item: String(raw?.id ?? ''), reason: 'review-unknown-id', raw, snippet });
            continue;
        }
        const still = String(raw?.still ?? '').trim().toLowerCase();
        const note = String(raw?.note ?? '').trim().slice(0, 80);
        if (question.kind === 'mark') {
            // A mark has no `moot`/`closed` distinction worth keeping, a wound that stopped
            // mattering and a wound that healed are the same fact about a body, so both answers
            // clear it. `advanced` on a mark is the model saying it is getting better without being
            // gone, which is exactly the case `turns` was invented to guess at and is counted, not
            // acted on.
            if (still === SETTLED || still === MOOT) {
                plan.cleared.push({ key: question.key, phrase: question.phrase, who: question.who, name: question.name, note });
            } else if (still === ADVANCED) {
                plan.advanced.push({ key: question.key, note });
            } else {
                plan.kept++;
            }
            continue;
        }
        if (question.kind === 'item') {
            // The disposal the story already showed and nobody wrote down. `settled` and `moot`
            // both mean the pack no longer holds it; anything else leaves it exactly where it is.
            if (still === SETTLED || still === MOOT) {
                plan.dropped.push({ key: question.key, name: question.name, qty: question.qty, note });
            } else {
                plan.kept++;
            }
            continue;
        }
        if (question.kind === 'adversary') {
            if (still === SETTLED || still === MOOT) {
                plan.disarmed.push({ key: question.key, name: question.name, note });
            } else {
                plan.kept++;
            }
            continue;
        }
        if (question.kind !== 'thread') {
            // A P, L or Q id. Not a misfiling any more and not a category error, the id says what
            // kind of answer this is, so it is routed to the handler for that kind. This is where
            // the twenty-six refusals went; `planAnswer` is the same code that used to read the
            // second array, moved rather than rewritten.
            planAnswer(plan, question, raw, note, snippet);
            continue;
        }
        if (still === SETTLED || still === MOOT) {
            plan.closures.push({ key: question.key, status: still === MOOT ? MOOT : CLOSED, note });
            continue;
        }
        if (still === ADVANCED) {
            // Counted, and deliberately NOT turned into a tick. The dial probe rides the same call
            // and is the thing that reports how far something moved, with `MAX_TICK` bounding it;
            // synthesising a tick from a word would be a second, unbounded writer on the same field.
            // What `advanced` buys is the measurement §12 asks for, a review that only ever says
            // `open` is rubber-stamping, and `review:advanced` beside `review:kept` is how that
            // shows up in the counters.
            plan.advanced.push({ key: question.key, note });
            continue;
        }
        plan.kept++;
    }

    // The model's currency reading, taken as a PAIR and not as a merge.
    //
    // Same discipline as every other identity answer: this names two lines it believes are one
    // currency, and fold turns it into a question-shaped record. It is not applied here, inventory
    // is a fold over the chronicle, so merging two keys means relabelling the event stream, which
    // wants a persisted crosswalk (`KeyResolution.relabel`, sound by `accum_append` because
    // quantities sum). What it does now is become a witness, which is what the resolver is short of.
    //
    // Self-pairs are dropped: a model naming one line twice has said nothing.
    for (const raw of Array.isArray(fragment?.same_currency) ? fragment.same_currency : []) {
        const a = String(raw?.a ?? '').trim();
        const b = String(raw?.b ?? '').trim();
        if (!a || !b) {
            plan.rejected.push({ item: `${a}${b}`, reason: 'review-wrong-shape', raw, snippet });
            continue;
        }
        if (a.toLowerCase() === b.toLowerCase()) {
            continue;
        }
        plan.currency.push({ a, b });
    }

    // Volunteered pairs are SUSPICIONS, and the asymmetry with currency is deliberate.
    //
    // A currency answer writes a witness into `state.answers`; the crosswalk relabels on it and
    // nothing is destroyed. A thread or cast answer REWRITES a stored table, and `entities.js` says
    // why that is a different risk: "a wrong merge cannot be undone by silence". So these do not
    // become `plan.merges`. They are carried out as candidates, stored, and asked back with an id on
    // the next pass, where the confirmed-merge path that already exists does the write. Two
    // independent readings before a destructive one, at no extra request.
    // The model answers with the LABEL fold printed, and fold has to read its own label.
    //
    // Every review line is rendered `T3 [open] Reach the capital city`, so when the model volunteers
    // a pair it names them the way it saw them, `"T3 [open] Reach the capital city"`, or just
    // `"M3"`. `suspectedPairs` then resolved that whole string as a thread NAME, found nothing, and
    // dropped the pair without a word.
    //
    // MEASURED in the live Isekai RPG chat, against the shipped resolver:
    //
    //   DROPPED  "T3 [open] Reach the capital city" -> null  |  "travel to capital" -> ok
    //   DROPPED  "M3" -> null                                |  "M4" -> null
    //   ASKED    "Reach the capital city" -> ok               |  "travel to capital" -> ok
    //
    // Three pairs volunteered, `review:merged` 1, and that one came from a different path. The
    // panel still shows `travel to capital` beside `Reach the capital city`, and `deal with wolves`
    // beside `Wolves east pastures`, because the confirmations were never asked.
    //
    // The prefix is fold's OWN protocol (`PREFIX`, and the `[open]`/`[still a thing?]` faces), so
    // reading it back is token algebra on fold's own keys, RULE 1's STRUCTURE clause, the same
    // permission every other id lookup in this file relies on.
    const lineFor = (said) => {
        const at = String(said).match(/^([A-Za-z])(\d+)\b/);
        return at ? (index.get(`${at[1].toUpperCase()}${at[2]}`) ?? null) : null;
    };
    // Which table a line belongs to. A `mark`, `item`, `lock` or `ask` line has no merge path at
    // all, so a pair naming one is refused loudly rather than stored to be dropped later.
    const MERGEABLE = { thread: 'thread', place: 'cast', adversary: 'cast' };
    for (const [field, of] of [['same_thread', 'thread'], ['same_person', 'cast']]) {
        for (const raw of Array.isArray(fragment?.[field]) ? fragment[field] : []) {
            const a = String(raw?.a ?? '').trim();
            const b = String(raw?.b ?? '').trim();
            if (!a || !b) {
                plan.rejected.push({ item: `${a}${b}`, reason: 'review-wrong-shape', raw, snippet });
                continue;
            }
            // A model naming one line twice has volunteered nothing, `same_currency`'s rule.
            if (a.toLowerCase() === b.toLowerCase()) {
                continue;
            }
            const rowA = lineFor(a);
            const rowB = lineFor(b);
            // A side the model named by id becomes the key that id stands for; a side it named in
            // words is passed through for the caller's name resolver, exactly as before.
            const keyA = rowA?.key ?? a;
            const keyB = rowB?.key ?? b;
            if (keyA.toLowerCase() === keyB.toLowerCase()) {
                continue;
            }
            // When both sides resolved, the LINES say which table this is about, the model put a
            // pair of marks in `same_thread` and fold would otherwise hunt for threads by that name
            // on every pass forever.
            const settled = rowA && rowB && rowA.kind === rowB.kind ? MERGEABLE[rowA.kind] : of;
            if (!settled) {
                plan.rejected.push({ item: `${a} / ${b}`, reason: 'review-unmergeable', raw, snippet });
                continue;
            }
            plan.suspected.push({ of: settled, a: keyA, b: keyB });
        }
    }

    // What each card field IS, as the model read it.
    //
    // Keyed on the label because that is what the card wrote and what the panel will look up. A
    // classification is permanent until the card renames the field, so a label answered once is
    // never posed again, which is why the cost of this decays to nothing.
    for (const raw of Array.isArray(fragment?.sheet) ? fragment.sheet : []) {
        const label = String(raw?.label ?? '').trim().toLowerCase();
        const kind = String(raw?.kind ?? '').trim().toLowerCase();
        const tempo = String(raw?.tempo ?? '').trim().toLowerCase();
        if (!label) {
            plan.rejected.push({ item: '', reason: 'sheet-unnamed', raw, snippet });
            continue;
        }
        // An answer outside the enum is the model inventing a category. Refused with the word it
        // invented, so the reason says WHICH rather than only how often.
        if (!SHEET_KINDS.includes(kind) || !SHEET_TEMPO.includes(tempo)) {
            plan.rejected.push({ item: `${label}: ${kind || '?'}/${tempo || '?'}`, reason: 'sheet-unknown-kind', raw, snippet });
            continue;
        }
        plan.sheet.push({ label, kind, tempo, same_as: String(raw?.same_as ?? '').trim().toLowerCase() });
    }

    return plan;
}

/**
 * Apply one answer to a P, L or Q question.
 *
 * Extracted from the second loop `planReview` used to run, unchanged apart from the refusals now
 * carrying their raw. Its caller is the single list: the id names the kind, this routes on it.
 *
 * @param {object} plan The plan being built, mutated.
 * @param {object} question The question this id was minted for.
 * @param {object} raw The entry the model sent.
 * @param {string} note The trimmed note.
 * @param {string} snippet The window excerpt, for the diagnostics log.
 */
function planAnswer(plan, question, raw, note, snippet) {
    switch (question.kind) {
        case 'place': {
            // An empty place is "the excerpt does not say", asked again next pass, never turned
            // into a location named after a refusal word. The model writes the place name, not a
            // judgement about it; the schema's free-text field is a name, not an interpretation.
            const place = String(raw?.place ?? '').trim();
            if (!place) {
                plan.kept++;
                break;
            }
            plan.places.push({ key: question.key, name: question.name, place: place.slice(0, 64), note });
            break;
        }
        case 'lock': {
            // The lock still wins; this only refreshes what the narrative is said to claim, so
            // the panel can offer a one-click accept with the model's reading rather than with
            // whichever blocked write happened to be last. See `FOLD-REDESIGN.md` §5.
            const value = String(raw?.place ?? '').trim();
            if (!value) {
                plan.kept++;
                break;
            }
            plan.locks.push({ field: question.field, value: value.slice(0, 120), note });
            break;
        }
        case 'identity': {
            // The schema's `answer` is the closed protocol vocabulary, SAME or DIFFERENT, so
            // no English synonym needs to be recognised here. A model that answers anything else
            // leaves the pair outstanding, which is the safe failure.
            if (String(raw?.answer ?? '').trim().toLowerCase() === SAME) {
                plan.merges.push({ of: question.of, a: question.a, b: question.b, note });
            } else if (String(raw?.answer ?? '').trim().toLowerCase() === DIFFERENT) {
                // Remembered, not discarded. A pair the reader has separated must never be
                // asked about again, the detector is loose by design, so a `different` that is
                // forgotten is a question that returns every pass forever and trains the reader
                // to ignore the whole mechanism.
                plan.different.push({ of: question.of, a: question.a, b: question.b, note });
            } else {
                plan.kept++;
            }
            break;
        }
        case 'polarity': {
            // Same closed vocabulary: PROGRESS or DOOM, answered directly. No "good"/"bad".
            const said = String(raw?.answer ?? '').trim().toLowerCase();
            if (said === PROGRESS) {
                plan.polarity.push({ key: question.thread, kind: PROGRESS, note });
            } else if (said === DOOM) {
                plan.polarity.push({ key: question.thread, kind: DOOM, note });
            } else {
                plan.kept++;
            }
            break;
        }
        case 'money': {
            // A real answer either way: "nothing" clears the question, an amount debits it. The
            // model states the amount as a number or sets `nothing`; no amount word-list.
            if (raw?.nothing === true) {
                plan.money = { amount: 0, currency: question.currency, note };
                break;
            }
            const amount = Number(raw?.amount);
            if (!Number.isInteger(amount) || amount <= 0) {
                plan.rejected.push({ item: question.id, reason: 'review-unreadable-amount', raw, snippet });
                break;
            }
            plan.money = { amount, currency: question.currency, at: MONEY, note };
            break;
        }
        default:
            // A kind with no handler. Unreachable while every kind `reviewBlock` mints has a
            // case above; kept so adding a question kind without an answer path is loud.
            plan.rejected.push({ item: question.id, reason: 'review-wrong-shape', raw, snippet });
    }
}

/**
 * Resolve a currency NAME the model volunteered to the ledger row it names.
 *
 * Why this is a lookup and not an assumption.
 *
 * `same_currency` reports names, not keys. The first version of the consumer assumed both names were
 * money-place, because the `Money:` block only renders money-place rows. Two live measurements say
 * that assumption is unsafe:
 *
 *   · The model answered `{"a":"silver wen","b":"silver"}` on a pass whose prompt contained no Money
 *     line at all, only `Carrying: dagger, bow`. It answered from the story. The answer was right;
 *     the inferred place was invented.
 *   · Wuxia's real split is cross-place: `silver wen` at `carried`, `silver` at `money`. Forcing both
 *     to `money` built `money␀silver wen`, a key the ledger never held, and the crosswalk's `known`
 *     filter then discarded a correct answer without a trace.
 *
 * So the name is matched against fold's own key space by EXACT equality on the normalized item name.
 * No tokenizing, no substring, no morphology, the same operation in every script. `money` wins a tie
 * because that is where a currency belongs and it is a protocol place, not an English word being
 * interpreted. A name held at two or more non-money places is ambiguous and returns '': fold has no
 * way to choose, and guessing would turn an unresolvable answer into a confident merge.
 *
 * @param {string} name The name as the model wrote it, possibly with a leading amount.
 * @param {Set<string>} keys Inventory keys the ledger holds.
 * @returns {string} The resolved inventory key, or '' when it cannot be resolved.
 */
export function resolveCurrencyKey(name, keys) {
    // The block renders "20 silver wen", so a model quoting it "exactly as written" returns the
    // amount too, measured, on the run where a one-entry block produced the self-pair
    // `20 silver wen` / `silver wen`. Stripping a leading count is number parsing: STRUCTURE, and
    // the same meaning in every language.
    const wanted = String(name ?? '').trim().replace(/^[0-9.,\s]+/, '').trim().toLowerCase();
    if (!wanted || !keys?.size) {
        return '';
    }
    if (keys.has(itemKey(wanted, MONEY))) {
        return itemKey(wanted, MONEY);
    }
    const held = [...keys].filter(key => splitItemKey(key).name === wanted);
    return held.length === 1 ? held[0] : '';
}

/**
 * The key a pair of identity answers is remembered under.
 *
 * Order-independent, because the detector may present the same two rows in either order on
 * different passes, `identityPairs` walks the table and the table's order is a Map's, which changes
 * when a row is written. A pair remembered as `a\0b` and re-asked as `b\0a` is a `different` answer
 * that was never recorded.
 *
 * @param {string} a One key.
 * @param {string} b Another.
 * @returns {string} The pair key.
 */
export function pairKey(a, b) {
    return [String(a ?? ''), String(b ?? '')].sort().join('');
}

/**
 * A one-line summary for the ledger event a plan produces.
 *
 * The audit trail is the point of recording closures as events at all, so the summary has to name
 * what changed in words a reader scrolling the chronicle can use.
 *
 * @param {object} plan A plan from `planReview`.
 * @param {Map<string, object>} names Thread key -> display name.
 * @returns {string} A summary, or '' when the plan changes nothing worth recording.
 */
export function describePlan(plan, names = new Map()) {
    const said = key => names.get(key) ?? key;
    const parts = [];
    for (const closure of plan.closures ?? []) {
        parts.push(`${said(closure.key)} ${closure.status === MOOT ? 'is moot' : 'is settled'}${closure.note ? ` (${closure.note})` : ''}`);
    }
    for (const merge of plan.merges ?? []) {
        parts.push(`${said(merge.a)} and ${said(merge.b)} are one ${merge.of === 'cast' ? 'person' : 'thread'}`);
    }
    for (const row of plan.disarmed ?? []) {
        parts.push(`${row.name} is no longer a threat${row.note ? ` (${row.note})` : ''}`);
    }
    return parts.join('; ').slice(0, 200);
}

/**
 * Is this thread one the review should be asked about?
 *
 * The pre-filter `FOLD-REDESIGN.md` §12 names as the fallback if the model rubber-stamps: only ask
 * about lines whose subject appears in the new half of the window. Implemented now and applied only
 * when the list is over budget, because asking about everything is the honest default and a filter
 * that runs unconditionally would hide the rubber-stamp measurement §12 wants.
 *
 * @param {object} thread A thread record.
 * @param {string} windowText The new half of the window.
 * @returns {boolean} True when the excerpt could plausibly settle it.
 */
export function isTouched(thread, windowText) {
    const haystack = String(windowText ?? '').toLowerCase();
    if (!haystack) {
        return false;
    }
    const parsed = normalizeThreadName(thread?.name);
    if (parsed && haystack.includes(parsed.key)) {
        return true;
    }
    // Any content token long enough to be discriminating, the same rule the cast's mention gate
    // uses (`entity-table.js` `mentions`), and looser than the inventory gate for the same reason:
    // a thread is referred to by its subject, not by its title.
    return String(thread?.name ?? '').toLowerCase().split(/[^\p{L}\p{N}'-]+/u)
        .some(token => token.length > 4 && haystack.includes(token));
}

/**
 * The threads the review should pose this pass.
 *
 * [TLB]: the hot set must be proportional to the window.
 *
 * STATE-ARCHIVE.md [TLB] measured what a fixed hot set costs: at constant slots, misses grow ~3x
 * per doubling of context, so the resident set has to scale with the window or it spends everything
 * re-reading what it already knows. The review's hot set used to be "every open thread, every
 * pass", measured in the Royal Succession chat at ~24 lines per pass, 1473 lines total, with 78%
 * of them answered "still open" or not at all. The window can only settle threads it touches, so
 * posing a thread the window never mentions is paying tokens to hear "still open".
 *
 * "Touched" is the model's own coverage report, the `mentions` the thread probe answered for the
 * PREVIOUS pass (`coverage.js`). The window only shifts a little between passes, and the model
 * already read it; admission by that report is coverage, never a substring test of the prose
 * ([ROUTER]). `windowText` is accepted only for the block path and tests that carry no report.
 *
 * The rule: pose a thread when the coverage report names it (it might change this pass) OR when it
 * has not been posed for REVIEW_EVERY turns (the safety valve, a thread nothing touches still
 * deserves a regular look, because a thread that stopped being named is exactly the thread most
 * likely to have been settled off-screen).
 *
 * @param {object[]} reviewable The open threads (already status/full-filtered).
 * @param {Set<string>|string} coveredOrText The model's reported names, or the window text when no
 *   report exists.
 * @param {number} turn Current turn.
 * @param {number} [every] How many turns a thread may go unposed before it must be asked again.
 * @returns {object[]} The threads to pose, touched-first.
 */
export function reviewableWindow(reviewable, coveredOrText, turn = 0, every = REVIEW_EVERY) {
    const list = Array.isArray(reviewable) ? reviewable : [];
    const isSet = coveredOrText instanceof Set;
    const touched = [];
    const stale = [];
    for (const thread of list) {
        const key = normalizeThreadName(thread?.name)?.key ?? String(thread?.name ?? '').toLowerCase().trim();
        if (isSet ? coveredOrText.has(key) : isTouched(thread, coveredOrText)) {
            touched.push(thread);
        } else if ((turn - (thread?.turn ?? 0)) >= every) {
            stale.push(thread);
        }
    }
    // One threshold decides both "pose it" and "ask it of the record".
    //
    // A thread reaches the second list precisely because the excerpt does NOT touch it. That is the
    // same fact the review instruction turns into "say nothing about it rather than guessing", so
    // every line here is one the excerpt cannot settle, and asking about the excerpt is the wrong
    // question for all of them.
    //
    // The block used to decide that separately, from `stale >= THREAD_STALE` (20), while this list
    // is built at `REVIEW_EVERY` (8). Everything between the two was posed under a rule that told
    // the model to stay silent about it: posed, never answerable, never closed.
    //
    // MEASURED in the live Wuxia chat twice. First pass: seven finished stakes sitting at ages
    // 4-12, crystal taken, cave found, bear killed and butchered, cores refined, level fifty
    // reached. Closed by hand; the story ran on; and the band refilled with four more, the
    // Earth-Spiritual Liquid drunk at mid 205 and still open at stale 12, Blazing Sun City reached
    // at mid 216 and still open at stale 8, the mission taken at mid 220, the Lava Scorpion slain
    // at mid 226. The dead zone is not an edge case; it is where finished threads go.
    //
    // So the tag travels with the row instead of being recomputed from a second number. Subtraction:
    // `THREAD_STALE` keeps its own job (hiding a cold thread from the narrator's prompt) and stops
    // being consulted about a question it was never about.
    return [...touched, ...stale.map(thread => ({ ...thread, askedOfRecord: true }))];
}

/** Statuses a thread may be left in by a closure. Re-exported so `review.js` need not reach past. */
export { CLOSED, MOOT, OPEN_STATUS };

/**
 * Filter identity questions against what has already been answered and what still exists.
 *
 * Pure, because "never re-ask" is the half that is easy to get wrong invisibly.
 *
 * Three ways a question stops being worth asking, and each was a real defect shape:
 *
 *   answered `same`       the rows are one row now, so the question cannot be regenerated, but the
 *                         answer is stored anyway, because a hand-split afterwards must not
 *                         resurrect it.
 *   answered `different`  BOTH rows still stand, so the detector raises the pair again on every
 *                         single pass forever unless this filter runs. The detector is loose by
 *                         design ("a trigger for a question, never a decision"), so false pairs are
 *                         expected, `Lord Everard` / `Lillian Everard` is the measured one, and a
 *                         mechanism that re-asks them teaches the reader to ignore all of them.
 *   a row is gone         merged, hand-edited or pruned. Asking whether a row that no longer exists
 *                         is the same as one that does produces an answer nothing can act on.
 *
 * @param {object[]} pairs Candidate pairs from the detectors and the migration.
 * @param {object} params Parameters.
 * @param {Map<string, object>} params.answers Pair key -> `{answer}`.
 * @param {(pair: object, side: string) => boolean} params.exists Does this side's row still exist?
 * @returns {object[]} The pairs still worth asking, deduplicated.
 */
/**
 * The pairs the model volunteered, resolved into fold's own key space.
 *
 * Pure, and here rather than in `review.js`, for this file's standing reason: the resolution rule is
 * the interesting part and a rule that cannot be replayed cannot be argued with. The caller supplies
 * `resolve`, because only it holds the thread and cast tables.
 *
 * The model names each side the way the block PRINTS it, a display name, not a key, so each is
 * looked up through the same one-hop alias resolution every other consumer uses. Three ways a pair
 * is dropped rather than asked, and all three are the rule `resolveCurrencyKey` already keeps: a
 * side that resolves to nothing, a pair whose sides resolve to the SAME row (already merged, or the
 * model naming one thing twice in two spellings), and a side whose kind has no resolver.
 * An unresolvable answer must not become a confident question.
 *
 * @param {Map<string, {of: string, a: string, b: string}>} stored The suspected table.
 * @param {Function} resolve `(of, name) => key|null`, over the caller's tables.
 * @returns {Array<{a: string, b: string, of: string, why: string}>} Pairs, ready for `outstanding`.
 */
export function suspectedPairs(stored, { resolve = () => null } = {}) {
    const out = [];
    for (const [, pair] of table_entries(stored ?? new Map())) {
        const of = pair?.of === 'cast' ? 'cast' : 'thread';
        const a = resolve(of, pair?.a) ?? null;
        const b = resolve(of, pair?.b) ?? null;
        if (!a || !b || a === b) {
            continue;
        }
        out.push({ a, b, of, why: 'the model reports these are one' });
    }
    return out;
}

export function outstanding(pairs, { answers = new Map(), exists = () => true } = {}) {
    const seen = new Set();
    const out = [];
    for (const pair of Array.isArray(pairs) ? pairs : []) {
        const id = pairKey(pair?.a, pair?.b);
        if (seen.has(id) || answers.has(id)) {
            continue;
        }
        if (!exists(pair, 'a') || !exists(pair, 'b')) {
            continue;
        }
        seen.add(id);
        out.push(pair);
    }
    return out;
}
