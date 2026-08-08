/**
 * fold/review-table.js — extraction becomes review.
 *
 * ── The one retraction mechanism ──
 *
 * Everything in `FOLD-RPG-GAP.md` that cannot close fails for one reason: *the retraction event is
 * something a narrator never bothers to say.* Nobody writes "the gate is no longer uncleared". The
 * probes fold already had are **write-only** — they are asked what is true, and silence about a
 * tracked line means nothing. Measured across all four live chat files: 31 lead rows in three
 * campaigns, ~180 assistant turns, every single one `open`. Not one `closed`, not one `stalled`, in
 * a vocabulary that has offered both since the table existed (`entities.js` `LEAD` statuses, and the
 * instruction at `entities.js:154-171` that used to say "Mark a lead closed once it is resolved").
 *
 * The fix is the SOM-DST insight applied wholesale: **the pass reads the ledger back and returns a
 * disposition for every open line.** The pinned block the model already gets (`state.ledgerBlock`)
 * grows an id on each open line, and one more fragment on the SAME call answers, per id, whether it
 * is still open — plus answers to the questions code decided to ask. No second request:
 * `FOLD-REDESIGN.md` §11, "No second extraction call", and `extract.js` has served multiple probes
 * on one call since clocks were added.
 *
 * Why the model can answer: closure is a **reading-comprehension question about a named specific**,
 * which is the category this codebase already trusts it with (`trigger-table.js:158-169` — "reading
 * the narrative is never fold's job… ask it") as opposed to hoping it spontaneously re-reports an
 * absence. At message 62 of the live chat the question "is the weapon thread still open?" has its
 * answer in the same window: *"set aside for purchase… Eighty-five thousand for the pair."*
 *
 * ── Pure, and what that buys ──
 *
 * This file decides what to ASK and what an answer MEANS. `review.js` owns storage, the probe
 * registration and the writes. The split is Phase A's and Phase B's, for their reason: anything
 * importing `script.js` cannot be unit-tested, and the whole gate for this phase is canned answers
 * at the pure layer — code decides when to ask, the fixture supplies what the model would say.
 */

import { CONTEST_AT, MONEY, parseAmount } from './state-table.js';
import { CLOSED, DOOM, HIDDEN, MOOT, OPEN_STATUS, PROGRESS, normalizeThreadName } from './thread-table.js';

/**
 * What a review may say about an open line.
 *
 * Four values, and the fourth is the one the old vocabulary lacked. `open` and `settled` are the
 * obvious pair; `advanced` exists because a dial that moved and a dial that did not are different
 * facts and `foldTicks` refuses `tick === 0` as `no-change` (`thread-table.js`), so "it moved" had
 * no way to be said about a line the review was looking at anyway; `moot` exists because a threat
 * that stops existing is not a threat that was defeated. The live chat had two moot clocks squatting
 * in the table until the repair script deleted them by hand — the goblin nest counterattack and the
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
 * Id prefixes, one per question kind.
 *
 * Letters rather than a flat numbering, because the model has to answer a heterogeneous list and a
 * prefix is the cheapest way to keep "T3 is settled" from being read as an answer to a question
 * about a lock. They are also what the note in a `review` event cites, so they end up in the audit
 * trail a reader scrolls past.
 */
export const PREFIX = { thread: 'T', place: 'P', mark: 'M', adversary: 'A', lock: 'L', ask: 'Q' };

/**
 * How many DIRECTED questions one pass may carry.
 *
 * Threads are already bounded at MAX_THREADS = 24 and the largest live campaign has 15 open; the
 * questions have no such bound. A migration can flag a dozen at once and the near-identity detector
 * is deliberately loose, so without a ceiling the first pass of a converted chat is a wall of
 * interrogation — and `FOLD-REDESIGN.md` §12's first open question is whether a small model answers
 * dispositions honestly or rubber-stamps them. A list of thirty is a list that gets rubber-stamped.
 *
 * ── Measured, and the first number I wrote here was wrong ──
 *
 * The draft said "the largest question set any of the four live chats produces on its first pass is
 * five". Counted properly — migrate the pre-repair2 Solo Leveling header, run both detectors over
 * the result, dedupe with `outstanding` — it is **ten**: six identity pairs (the broker pair, the
 * squad/team pair, and four cross-table residency pairs the migration's own looser trigger raises),
 * two polarity flags, one lock contest, one money question. Evil Hero Party's first pass produces
 * four; Nora's and Raccoon City's produce none.
 *
 * ── Why the house convention (twice the observed maximum) does NOT apply here ──
 *
 * Every other bound in this codebase caps DATA, and the argument for two-times headroom is that a
 * cap inside the observed range silently destroys something. This one caps a QUEUE. Nothing is lost
 * when a question does not fit: the migration flags stay in `state.migrated`, the detectors re-raise
 * their pairs from the tables, and the money question stays in `state.owed`, so an unasked question
 * is asked on the next pass with nothing changed. The cost of a low ceiling is latency — ten
 * questions drain in two passes at eight — and the cost of a high one is the rubber-stamping §12
 * names, which is the failure that would make the whole mechanism worthless.
 *
 * Eight, therefore: it clears the eight identity-and-polarity questions of the worst observed first
 * pass in one go, leaves the lock and money questions for the pass immediately after, and keeps the
 * block short enough to read. It is the one number in this file set against an UNMEASURED risk, and
 * `review:kept` against `review:settled` on one real session is the instrument that will retune it.
 *
 * Ordering matters more than the ceiling and is not left to chance: locks first, then identity, then
 * polarity, then money (see `reviewBlock`). The two pairs Phase C's gate names — the broker pair and
 * `Kang's squad`/`Kang's team` — are the first two identity questions in every ordering the sources
 * produce, so they are asked on the first pass at any ceiling above two.
 */
export const MAX_QUESTIONS = 8;

/**
 * How many mark lines one review block may carry.
 *
 * `MAX_FLAGS = 32` bounds the marks TABLE (`state-table.js`) and would allow a block with
 * thirty-two bodies in it, which is the size discipline `FOLD-REDESIGN.md` §12.2 asks this renderer
 * to enforce rather than merely promise. Ten, by the house convention of twice the observed
 * maximum: the worst live moment is message 72 of the Solo Leveling chat, five simultaneous
 * conditions on one man after the Nowon raid, and the worst plausible moment is a fight in which
 * everyone present is hurt — six people at one mark each.
 *
 * Nothing is lost when a mark does not fit, for `MAX_QUESTIONS`' reason: this caps a QUEUE, not
 * data. The mark stays in the fold and is asked about next pass. Ordering puts the pov's own marks
 * first (`state.js` `markLines`), because his are the ones the adjudicator weighs.
 */
export const MAX_MARK_LINES = 10;

/**
 * Build the review section of the pinned ledger, and the index that reads its answers back.
 *
 * ── Ids are assigned deterministically, not incrementally ──
 *
 * "Stable" here means: the same ledger produces the same ids, and an id means one thing for the
 * whole round trip. Both fall out of sorting by table key within each kind rather than by whatever
 * order a Map happened to iterate. It deliberately does NOT mean an id survives a thread closing —
 * numbering is per-pass and the answers come back in the same response, so a persisted id table
 * would be a second source of truth about a list that is already derived.
 *
 * @param {object} params Everything the ledger currently believes that could close.
 * @param {object[]} [params.threads] Open threads, from `threads()`/`threadsByKind`.
 * @param {object[]} [params.unplaced] Cast rows whose whereabouts are unstated (`castAt`).
 * @param {object[]} [params.marks] Live marks: `{key, name, phrase, severity, mine}`.
 * @param {object[]} [params.threats] Cast rows carrying a threat: `{key, name, threat}`.
 * @param {object[]} [params.contests] Contested locks: `{field, locked, value, count}`.
 * @param {object[]} [params.identity] Identity pairs: `{a, b, why, kind, names}`.
 * @param {object[]} [params.polarity] Migrated dials awaiting a polarity: `{thread, name, about}`.
 * @param {object|null} [params.owed] The credits-without-debit question, or null.
 * @param {number} [params.budget] How many directed questions to ask this pass.
 * @returns {{text: string, index: Map<string, object>}} The block section and the id index.
 */
export function reviewBlock({
    threads = [], unplaced = [], marks = [], threats = [], contests = [], identity = [],
    polarity = [], owed = null, budget = MAX_QUESTIONS,
} = {}) {
    const index = new Map();
    const lines = [];

    const sorted = list => [...list].sort((a, b) => String(a?.key ?? a?.field ?? '').localeCompare(String(b?.key ?? b?.field ?? '')));

    sorted(threads).forEach((thread, at) => {
        const id = `${PREFIX.thread}${at + 1}`;
        index.set(id, { id, kind: 'thread', key: thread.key });
        // A dial prints its position, because "is this still open" and "how far has it got" are the
        // same question for a thread that has a measurable one, and the model cannot judge either
        // without the number. A dial-less thread prints what is unresolved about it — the `open`
        // field is the reason the thread is in the prompt at all (`thread-table.js` renderOpenThreads).
        // A hidden dial is named but never quantified, the same rule `renderPressure` keeps: the
        // narrator knows something is closing in and how near it is stays theirs to decide. The
        // review can still be asked whether it is moot — which is the exit a hidden threat most
        // needs, since nobody is watching it fill.
        const face = !thread.dial ? OPEN
            : thread.seen === HIDDEN ? 'closing in'
                : `${thread.dial.filled}/${thread.dial.size}`;
        const said = [thread.detail, thread.open, thread.about].filter(Boolean).join(' — ');
        lines.push(`  ${id} [${face}] ${thread.name}${said ? ` — ${said}` : ''}`);
    });

    sorted(unplaced).forEach((person, at) => {
        const id = `${PREFIX.place}${at + 1}`;
        index.set(id, { id, kind: 'place', key: person.key, name: person.name });
        // Not "is this person still here?" — that is the question `castAt` was answering by guessing
        // (`entity-table.js`, the three-valued note). The review asks where they ARE, which is the
        // dispatch law's third action: when the evidence cannot decide, ask rather than default.
        lines.push(`  ${id} [where now?] ${person.name}${person.place ? ` — last placed: ${person.place}` : ''}`);
    });

    // ── Marks close the way threads close ──
    //
    // `FOLD-REDESIGN.md` §2's table lists marks in its second row, and names what closed them before
    // this: "`turns` guess at write time only" — a duration the model invented on the turn the wound
    // was inflicted, which `cap:condition-expired` shows has never once fired in any of the three
    // chats. So a wound healed only if somebody remembered to narrate it healing AND the extraction
    // happened to phrase the negation in a way `isNegation` recognised. Here it is asked directly.
    // The owner is named in the line because a review that cannot tell Lee's ribs from Solomon's
    // calf is the subjectless flag table with extra steps.
    //
    // ── Settle and clear, but NOT merge, and the reason is that the question is unreachable ──
    //
    // `FOLD-REDESIGN.md` §3 makes same-owner near-duplicate marks "a standing review identity
    // target", and the honest reading of that, once the fold changed, is that there is nothing left
    // for a question to catch. Two duplicates on one owner have to survive `statusKeyFor` first, and
    // that now merges on a shared content word OR a shared stem (`state-table.js` `sameSubject`,
    // measured: it collapses the one live pair, `fatigued` / `mild fatigue`). Anything that gets
    // past it is a pair with NO shared word — and §2's detector needs a shared head token, so it
    // provably cannot see such a pair either. Worked through on the live examples: `cut left calf`
    // and `clawed left calf` agree on the last token and differ in the first, which is the
    // substitution branch's excluded case by its own docblock. Shipping a question that cannot fire
    // is worse than not shipping it: it costs a slot in a budget §12 says gets rubber-stamped when
    // it grows. The recovery for a genuine duplicate is to settle one of them, which these lines do.
    marks.slice(0, MAX_MARK_LINES).forEach((mark, at) => {
        const id = `${PREFIX.mark}${at + 1}`;
        index.set(id, { id, kind: 'mark', key: mark.key, phrase: mark.phrase, who: mark.who, name: mark.name });
        lines.push(`  ${id} [mark: ${mark.name}] ${mark.phrase}${mark.severity ? ` (${mark.severity})` : ''}`);
    });

    // One line per active adversary, and the disposition vocabulary already says what a fight ending
    // means: `settled` (beaten) or `moot` (they left, it stopped being a fight). §12.3 makes this the
    // measurement — no live combat has ever run under this schema — so it is deliberately the
    // smallest thing that can be asked and answered.
    threats.forEach((row, at) => {
        const id = `${PREFIX.adversary}${at + 1}`;
        index.set(id, { id, kind: 'adversary', key: row.key, name: row.name });
        lines.push(`  ${id} [threat ${row.threat}] ${row.name} — still fighting?`);
    });

    // `kind` is spread LAST, deliberately. It was written first and the migration's own pairs carry
    // a `kind` of their own (`migrate.js` `identityQuestions` tags them 'thread' or 'cast'), so the
    // spread overwrote the question kind with the table name and four of the ten questions on the
    // worst observed first pass rendered as blank lines. Caught by printing the real block rather
    // than by a test, which is why the block is printed in the gate.
    const asked = [];
    contests.forEach(contest => asked.push({ ...contest, kind: 'lock' }));
    identity.forEach(pair => asked.push({ ...pair, kind: 'identity' }));
    polarity.forEach(flag => asked.push({ ...flag, kind: 'polarity' }));
    if (owed) {
        asked.push({ ...owed, kind: 'money' });
    }

    // Locks first, then identity, then polarity, then money — most consequential first, because a
    // truncated list drops from the end. A lock contest is the panel actively showing something the
    // story contradicts; a money question is asked again next pass at no cost.
    asked.slice(0, Math.max(0, budget)).forEach((question, at) => {
        const id = `${question.kind === 'lock' ? PREFIX.lock : PREFIX.ask}${at + 1}`;
        index.set(id, { id, ...question });
        lines.push(`  ${id} ${questionText(question)}`);
    });

    if (!lines.length) {
        return { text: '', index };
    }
    return {
        text: ['Tracked now — say which of these are settled, and answer the questions:', ...lines].join('\n'),
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
        case 'lock':
            // The count is stated because it is the evidence for asking: one disagreement is the
            // narrator wandering, three consecutive ones is the story having moved.
            return `[pinned] "${question.field}" is pinned to "${question.locked}" but the narration keeps saying "${question.value}" (${question.count ?? CONTEST_AT} times). What does the story say it is now?`;
        case 'identity':
            // "One name containing another is not identity" (`FOLD-RPG-GAP.md` §4) is exactly why
            // this is a question rather than a merge. The detector is loose on purpose.
            return `[same?] Are "${question.names?.[0] ?? question.a}" and "${question.names?.[1] ?? question.b}" the same ${question.of === 'cast' ? 'person' : 'thing'}? Answer "${SAME}" or "${DIFFERENT}".`;
        case 'polarity':
            return `[good or bad?] For "${question.name}"${question.about ? ` (${question.about})` : ''} — is filling this bad for the characters ("${DOOM}") or good ("${PROGRESS}")?`;
        case 'money':
            return `[paid?] These were recorded as gained with nothing paid: ${question.items.join(', ')}. Balance on record: ${question.balance} ${question.currency}. What was paid, if anything? Answer with the amount, or "nothing".`;
        default:
            return '';
    }
}

/**
 * The probe's schema fragment.
 *
 * Two arrays rather than one, because they are two different acts. A disposition is a judgement
 * about a line fold is already tracking and has a closed vocabulary; an answer is a reply to a
 * question code chose to ask and is free text this file then interprets. Collapsing them would mean
 * one `enum` covering `settled` and `₩120,000`, which is a schema that teaches the model nothing.
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
                description: 'One entry for each T, M or A line you can judge from this excerpt. Omit any line the excerpt says nothing about.',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'The id exactly as listed, e.g. "T3", "M1", "A2".' },
                        still: {
                            type: 'string',
                            enum: STILL,
                            description: `${OPEN} if anything about it is still unsettled; ${ADVANCED} if it moved closer without finishing; ${SETTLED} if this excerpt resolved it; ${MOOT} if it stopped being about anything — the danger is gone, the errand no longer matters.`,
                        },
                        note: { type: 'string', description: 'Five words at most saying why, quoting the excerpt where you can. Empty if nothing to add.' },
                    },
                    required: ['id', 'still', 'note'],
                    additionalProperties: false,
                },
            },
            answers: {
                type: 'array',
                description: 'One entry for each L or P or Q question you can answer from this excerpt or from what you have read. Omit any you cannot.',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'The id exactly as listed, e.g. "Q1".' },
                        answer: { type: 'string', description: 'The answer in the form the question asks for: a place name, "same" or "different", "doom" or "progress", or an amount.' },
                        note: { type: 'string', description: 'Five words at most saying why. Empty if nothing to add.' },
                    },
                    required: ['id', 'answer', 'note'],
                    additionalProperties: false,
                },
            },
        },
        required: ['lines', 'answers'],
        additionalProperties: false,
    };
}

/** @returns {string} Prompt guidance for the probe. */
export function reviewInstruction() {
    return [
        'Read back the lines listed under "Tracked now" in the already-recorded block and say, for each one you can judge, whether it is still open.',
        'Judge from what the excerpt actually says. A thread the excerpt does not touch is still open — say nothing about it rather than guessing.',
        `A thread is ${SETTLED} when the thing it was waiting on has happened, whether or not anyone announced it: a purchase made, a question answered, a place entered.`,
        `It is ${MOOT} when it stopped being about anything — the danger was removed, the errand no longer matters, the person it concerned is gone. ${MOOT} is not failure and not success.`,
        `An M line is an injury somebody is carrying: ${SETTLED} once it has healed or been treated away, ${ADVANCED} while it is mending, ${OPEN} otherwise. Nobody announces that a bruise has faded, so judge it from time passing and from treatment, not from a sentence saying so.`,
        `An A line is somebody actively dangerous: ${SETTLED} once they are beaten, ${MOOT} once the fight stopped being a fight, ${OPEN} while it is still going.`,
        'Then answer the numbered questions. They were asked because something in the record is ambiguous, not because the answer is in doubt in the fiction.',
        'Never answer a question the excerpt and your reading cannot settle. An omitted answer is asked again; a wrong one is acted on.',
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
export function planReview(fragment, index) {
    const plan = {
        closures: [], advanced: [], kept: 0,
        places: [], merges: [], different: [], polarity: [], locks: [], money: null,
        cleared: [], disarmed: [],
        rejected: [],
    };
    const seen = new Map(index ?? []);

    for (const raw of Array.isArray(fragment?.lines) ? fragment.lines : []) {
        const question = seen.get(String(raw?.id ?? '').trim().toUpperCase());
        if (!question) {
            plan.rejected.push({ item: String(raw?.id ?? ''), reason: 'review-unknown-id' });
            continue;
        }
        const still = String(raw?.still ?? '').trim().toLowerCase();
        const note = String(raw?.note ?? '').trim().slice(0, 80);
        if (question.kind === 'mark') {
            // A mark has no `moot`/`closed` distinction worth keeping — a wound that stopped
            // mattering and a wound that healed are the same fact about a body — so both answers
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
        if (question.kind === 'adversary') {
            if (still === SETTLED || still === MOOT) {
                plan.disarmed.push({ key: question.key, name: question.name, note });
            } else {
                plan.kept++;
            }
            continue;
        }
        if (question.kind !== 'thread') {
            // A disposition against a question is a category error the schema cannot prevent
            // (`still` and `answer` are separate arrays, but a model may still misfile). Counted
            // rather than silently reinterpreted: guessing which array it meant is the kind of
            // repair that hides a prompt defect.
            plan.rejected.push({ item: question.id, reason: 'review-wrong-shape' });
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
            // What `advanced` buys is the measurement §12 asks for — a review that only ever says
            // `open` is rubber-stamping, and `review:advanced` beside `review:kept` is how that
            // shows up in the counters.
            plan.advanced.push({ key: question.key, note });
            continue;
        }
        plan.kept++;
    }

    for (const raw of Array.isArray(fragment?.answers) ? fragment.answers : []) {
        const question = seen.get(String(raw?.id ?? '').trim().toUpperCase());
        if (!question) {
            plan.rejected.push({ item: String(raw?.id ?? ''), reason: 'review-unknown-id' });
            continue;
        }
        const answer = String(raw?.answer ?? '').trim();
        const note = String(raw?.note ?? '').trim().slice(0, 80);
        if (!answer) {
            plan.kept++;
            continue;
        }
        switch (question.kind) {
            case 'place': {
                // "unknown" is a real answer and the right one when the story has not said. It must
                // not become a place name, or the cast row acquires a location called "unknown"
                // and the presence predicate starts comparing rooms to it.
                if (/^(unknown|unclear|unstated|nowhere|n\/a|none)\b/i.test(answer)) {
                    plan.kept++;
                    break;
                }
                plan.places.push({ key: question.key, name: question.name, place: answer.slice(0, 64), note });
                break;
            }
            case 'lock': {
                // The lock still wins; this only refreshes what the narrative is said to claim, so
                // the panel can offer a one-click accept with the model's reading rather than with
                // whichever blocked write happened to be last. See `FOLD-REDESIGN.md` §5.
                plan.locks.push({ field: question.field, value: answer.slice(0, 120), note });
                break;
            }
            case 'identity': {
                const said = answer.toLowerCase();
                if (said.startsWith(SAME) || said.startsWith('yes')) {
                    plan.merges.push({ of: question.of, a: question.a, b: question.b, note });
                } else if (said.startsWith(DIFFERENT) || said.startsWith('no')) {
                    // Remembered, not discarded. A pair the reader has separated must never be
                    // asked about again — the detector is loose by design, so a `different` that is
                    // forgotten is a question that returns every pass forever and trains the reader
                    // to ignore the whole mechanism.
                    plan.different.push({ of: question.of, a: question.a, b: question.b, note });
                } else {
                    plan.kept++;
                }
                break;
            }
            case 'polarity': {
                const said = answer.toLowerCase();
                if (said.startsWith(PROGRESS) || said.startsWith('good')) {
                    plan.polarity.push({ key: question.thread, kind: PROGRESS, note });
                } else if (said.startsWith(DOOM) || said.startsWith('bad')) {
                    plan.polarity.push({ key: question.thread, kind: DOOM, note });
                } else {
                    plan.kept++;
                }
                break;
            }
            case 'money': {
                if (/^(nothing|none|no|free|nil|0)\b/i.test(answer)) {
                    // A real answer: the items were a gift, a find, or loot. It clears the question
                    // rather than leaving it to be asked again next pass.
                    plan.money = { amount: 0, currency: question.currency, note };
                    break;
                }
                const amount = parseAmount(answer);
                if (amount === null) {
                    plan.rejected.push({ item: question.id, reason: 'review-unreadable-amount' });
                    break;
                }
                plan.money = { amount, currency: question.currency, at: MONEY, note };
                break;
            }
            default:
                plan.rejected.push({ item: question.id, reason: 'review-wrong-shape' });
        }
    }

    return plan;
}

/**
 * The key a pair of identity answers is remembered under.
 *
 * Order-independent, because the detector may present the same two rows in either order on
 * different passes — `identityPairs` walks the table and the table's order is a Map's, which changes
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
    // Any content token long enough to be discriminating — the same rule the cast's mention gate
    // uses (`entity-table.js` `mentions`), and looser than the inventory gate for the same reason:
    // a thread is referred to by its subject, not by its title.
    return String(thread?.name ?? '').toLowerCase().split(/[^\p{L}\p{N}'-]+/u)
        .some(token => token.length > 4 && haystack.includes(token));
}

/** Statuses a thread may be left in by a closure. Re-exported so `review.js` need not reach past. */
export { CLOSED, MOOT, OPEN_STATUS };

/**
 * Filter identity questions against what has already been answered and what still exists.
 *
 * ── Pure, because "never re-ask" is the half that is easy to get wrong invisibly ──
 *
 * Three ways a question stops being worth asking, and each was a real defect shape:
 *
 *   answered `same`       the rows are one row now, so the question cannot be regenerated — but the
 *                         answer is stored anyway, because a hand-split afterwards must not
 *                         resurrect it.
 *   answered `different`  BOTH rows still stand, so the detector raises the pair again on every
 *                         single pass forever unless this filter runs. The detector is loose by
 *                         design ("a trigger for a question, never a decision"), so false pairs are
 *                         expected — `Lord Everard` / `Lillian Everard` is the measured one — and a
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
