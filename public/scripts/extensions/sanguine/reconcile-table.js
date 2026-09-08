/**
 * sanguine/reconcile-table.js: the reconcile pass, as data (pure half).
 *
 * The app half is `reconcile.js`; nothing here touches storage, the chronicle or the DOM.
 *
 * Why a pass, when every write is already gated.
 *
 * The gates added alongside this file close WRITING: a mark already held is refused, a place already
 * on record is not a sighting, a vital invents no ceiling. None of them repairs a record that is
 * already wrong, and two measurements say the record goes wrong in ways no per-turn mechanism
 * reaches:
 *
 *     messages that produced no event      95 of 171   (56%)
 *     review closure rate                   4 of 2,840 (0.14%), 16 of 16 threads still open
 *
 * That is the shape of the repair the player had to do by hand on the Raccoon City campaign: nine
 * cast deletions, plus a scripted correction of the ammunition, the conditions and the clock.
 *
 * The mechanism is the review's, because the review's is the one that works.
 *
 * `reviewBlock` returns `{text, index}` and `planReview` routes an answer back through it. Measured
 * across the Xianxia campaign: 3,319 answers filed against numbered lines, against 0 moves for the
 * world-turn's open invitation with an always-valid empty array. Give the model a line with an id on
 * it and it fills the line in. Same ids, same index, same routing here.
 *
 * What differs is the prior, and that is the reason this is a separate pass.
 *
 * The per-turn review runs on every armed turn, cannot afford to be wrong, and defaults to keeping,
 * which is what the 0.14% closure rate costs. A reconcile is rare, explicit and expensive, so its
 * instruction asks the model to justify KEEPING a row rather than to justify dropping one. That
 * asymmetry is the whole product argument; without it this is the review with a bigger window.
 *
 * Two safety properties, both load-bearing.
 *
 * **A value reaches the record only through a diff the player ticks.** The first cut of this pass
 * enforced something stricter, the answer was an enum and an id and never a value at all, on the
 * Xianxia retrospective's measurement of what happens when a model supplies numbers: 25 absolute
 * `set` against 12 relative `dq`, and narrator-stated balances agreeing with the ledger 33% of the
 * time, worst gap 2604. But that measurement is of values adopted SILENTLY, per turn, unconfirmed.
 * What it condemns is the silence, not the number. A value that is proposed, evidenced, listed with
 * its own checkbox and applied only on confirmation is a different mechanism, and it is the only one
 * that reaches the faults this pass exists for, the ones removal cannot fix.
 *
 * **Every non-`keep` verdict needs positive evidence.** A repair requires a non-empty `evidence`
 * field. There is no "never true" in the vocabulary: a model failing to find something in a window
 * is not evidence it never happened, and that distinction has a body count, `cap:stale-hidden`
 * fired 540 times in this campaign hiding items that were in the character's pockets, and was
 * retired on exactly this reasoning, citing `BayesFilter.zero_residual_is_fixed`. Silence is a zero
 * residual.
 *
 * Fold never READS the evidence. A non-empty string is STRUCTURE; judging its content would be RULE
 * 1's defect. It exists to be shown to the player in the diff, which is where judgement happens.
 */

import { splitItemKey } from './state-table.js';

/**
 * The verdict vocabulary.
 *
 * `keep` and `gone` were the whole of it, and that was too narrow to be a cleanup: the Raccoon City
 * record's real faults were `ammunition x29` (three magazines summed with twenty-five shells), rows
 * sentence-cased into near-unrecognisable names, money that had stopped matching the story, and the
 * same person on two rows, Kang existed twice for the whole of the live Solo Leveling chat
 * (`FOLD-RPG-GAP.md` §2). None of those is fixed by removal.
 *
 * So `rename`, `amount`, `move`, `merge` and `split` carry a VALUE, which the original design
 * forbade. The safety property is unchanged and is not weakened: what the Xianxia measurement
 * condemned was a value adopted SILENTLY, per turn, unconfirmed, narrator-stated balances agreeing
 * with the fold 33% of the time, worst gap 2604. Here a value is proposed, carries the evidence that
 * justifies it, and reaches the record only through a diff the player ticks. The player is the gate;
 * that is a different mechanism from trusting the number.
 *
 * Still absent, deliberately: anything meaning "this was never true". A pass may repair the record;
 * only the player may `forget` it.
 */
export const KEEP = 'keep';
export const GONE = 'gone';
export const RENAME = 'rename';
export const AMOUNT = 'amount';
export const MOVE = 'move';
export const MERGE = 'merge';
export const SPLIT = 'split';
export const VERDICTS = Object.freeze([KEEP, GONE, RENAME, AMOUNT, MOVE, MERGE, SPLIT]);

/**
 * Which repairs each row kind can actually take, so a category error is caught rather than guessed.
 *
 * Widened per row, from the writer each row actually has, never mechanically.
 *
 * · ITEM takes everything. It is the only kind with a real re-key path (`edits.editItem`, whose
 *   docblock is a treatise on the ordering), a quantity, a place and a `splitItem` writer that
 *   already exists for exactly the `ammunition x29` fault this pass keeps failing to reach.
 *
 * · MARK takes `gone` and `merge`, and NOT `rename`. There is no mark writer for a new phrase
 *   anywhere in `edits.js`, and one cannot be added safely: `statusKeyFor` (`state-table.js`:729)
 *   folds an incoming phrase back onto an EXISTING key whenever the two share a content token,
 *   "fatigued" and "mild fatigue" on Solomon are deliberately one mark, so a rename to a near
 *   spelling would be an off-and-then-on pair against the same key inside one event, and which half
 *   won would be fold order rather than intent. A merge is expressible with the writer that exists.
 *
 * · CAST takes `move`. `face()` below has always printed `: last placed: X` on every cast line, so
 *   the block advertised a field the vocabulary could not correct; `entities.setPlace` is the
 *   writer, reached through `edits.editCast(key, {place})`. It takes `merge` because
 *   `entities.merge` exists and is the one operator built for the two-rows-one-person case. It does
 *   NOT take `split`: splitting a person means dividing a trail, an alias set and a dossier between
 *   two rows, and there is no operator in this codebase that can do it, `mergeEntities` accumulates
 *   aliases and has no inverse.
 *
 * · THREAD takes `merge` (`clocks.merge`, which keeps the more advanced dial, `thread-table.js`:1459
 *   and the Karr clock that a name-length tie-break once wound BACKWARDS from 7/8 to 1/6). It does
 *   NOT take `rename`: the thread table is keyed BY NAME through `clocks.set`, so there is no rename
 *   operator to route to and the one this pass used to call was destroying data, see `planReconcile`.
 *   It does not take `move` either, though threads carry a `where`: `face()` never prints it, so a
 *   `move` verdict would be proposed against a value the model was never shown and the `no-change`
 *   guard could not fire.
 */
export const OPS_FOR = Object.freeze({
    item: [GONE, RENAME, AMOUNT, MOVE, MERGE, SPLIT],
    mark: [GONE, MERGE],
    cast: [GONE, RENAME, MOVE, MERGE],
    thread: [GONE, MERGE],
});

/**
 * Why an answer was refused.
 *
 * Named constants rather than inline literals because `reconcile.js` turns each into the counter
 * `reconcile:<reason>` through a template, which is invisible to the literal reader in
 * `tests/sanguine-observe.test.js`: the same blind spot the invariant witnesses have. `REJECTIONS`
 * is what lets a test enumerate them and hold `observe.js` `KNOWN_RULES` to declaring every one.
 */
export const UNKNOWN_ID = 'unknown-id';
export const DUPLICATE_ID = 'duplicate-id';
export const WRONG_OP = 'wrong-op';
export const NO_EVIDENCE = 'no-evidence';
export const NO_CHANGE = 'no-change';
export const UNUSABLE_AMOUNT = 'unusable-amount';
export const UNKNOWN_TARGET = 'unknown-target';
export const MERGE_CONFLICT = 'merge-conflict';
export const UNUSABLE_SPLIT = 'unusable-split';
export const REJECTIONS = Object.freeze([
    UNKNOWN_ID, DUPLICATE_ID, WRONG_OP, NO_EVIDENCE, NO_CHANGE, UNUSABLE_AMOUNT,
    UNKNOWN_TARGET, MERGE_CONFLICT, UNUSABLE_SPLIT,
]);

/**
 * How many things one row may turn out to be.
 *
 * Bounds the BLAST RADIUS of a single line, which is what separates a split from a way to write the
 * record. The measured case needs three, `ammunition x28` was three magazines, twenty-five buckshot
 * shells and a box of birdshot (`edit-table.js` `splitDelta`), so six is double the worst real
 * fault and still small enough that forty posed lines cannot become two hundred and forty rows.
 * Parts past the bound are COUNTED and reported in the diff rather than dropped in silence, on the
 * same argument `reconcileBlock` makes about the rows it cannot pose.
 */
export const MAX_SPLIT_PARTS = 6;

/**
 * Id prefixes per row kind.
 *
 * Kind-prefixed for `reviewBlock`'s reason: the id names the kind, so one answer list can carry
 * every sort of line and the router never has to guess which table a verdict belongs to.
 */
export const PREFIX = Object.freeze({ item: 'RI', mark: 'RM', cast: 'RC', thread: 'RT' });

/** Row kinds this pass can pose, in the order they are posed. */
export const RECONCILE_KINDS = Object.freeze(['item', 'mark', 'cast', 'thread']);

/**
 * How many lines one reconcile may pose.
 *
 * Bounds the BLOCK, not the record: an unposed row is unchanged, which is the safe direction. Forty
 * covers the whole live panel of every chat in the corpus, Raccoon City's is 33 inventory rows, 3
 * marks, 19 cast and 16 threads at its largest, and the pass poses what is currently rendered rather
 * than everything ever stored.
 */
export const MAX_RECONCILE_LINES = 40;

/**
 * Turn the live panel into askable rows, in a stable order.
 *
 * Sorted within kind by key so two runs over the same record pose the same ids, an id that moved
 * between the prompt and the answer would route a verdict onto a neighbour.
 *
 * @param {Array<{kind: string, key: string, name: string}>} rows Live rows from the panel.
 * @returns {Array<object>} Askable rows.
 */
export function reconcileAsks(rows) {
    const asks = [];
    for (const kind of RECONCILE_KINDS) {
        const of = (Array.isArray(rows) ? rows : [])
            .filter(row => row?.kind === kind && row?.key && String(row?.name ?? '').trim())
            .sort((a, b) => String(a.key).localeCompare(String(b.key)));
        asks.push(...of);
    }
    return asks;
}

/** How a row reads on its line. Fold's own fields, never prose it has to understand. */
function face(ask) {
    if (ask.kind === 'item') {
        return `${ask.name}${Number(ask.qty) > 1 ? ` x${ask.qty}` : ''}`;
    }
    if (ask.kind === 'mark') {
        return `${ask.name}${ask.who ? ` (${ask.who})` : ''}`;
    }
    if (ask.kind === 'cast') {
        return `${ask.name}${ask.place ? `: last placed: ${ask.place}` : ''}`;
    }
    return ask.name;
}

/**
 * Build the reconcile block and the index that reads its answers back.
 *
 * The offset is what makes "run it again" true.
 *
 * `reconcileAsks` sorts deterministically so an id cannot move between the prompt and the answer.
 * That stability plus a fixed budget means a record larger than the budget would pose the SAME first
 * rows every run, and everything past the bound would be permanently unreachable, measured on the
 * live Raccoon City campaign at 68 live rows against a budget of 40. The offset walks the record
 * instead, wrapping, so successive runs cover it.
 *
 * @param {object} params Parameters.
 * @param {Array<object>} params.asks Rows to pose, from `reconcileAsks`.
 * @param {number} [params.budget] How many lines may be posed.
 * @param {number} [params.offset] Where in the record to start. Wraps.
 * @returns {{text: string, index: Map<string, object>, covered: number}} The block, the id index,
 *   and how far through the record this pass reached, the caller's next `offset`.
 */
export function reconcileBlock({ asks = [], budget = MAX_RECONCILE_LINES, offset = 0 } = {}) {
    const index = new Map();
    const list = Array.isArray(asks) ? asks : [];
    const size = Math.max(0, budget);
    if (!list.length || !size) {
        return { text: '', index, covered: 0 };
    }
    const start = ((Math.trunc(Number(offset) || 0) % list.length) + list.length) % list.length;
    // Wrapping rather than clamping: a record whose tail is shorter than the budget still gets a
    // full block, and the pass after it starts where this one stopped.
    const posed = Array.from({ length: Math.min(size, list.length) },
        (_, at) => list[(start + at) % list.length]);

    const counters = {};
    const lines = posed.map((ask) => {
        counters[ask.kind] = (counters[ask.kind] ?? 0) + 1;
        const id = `${PREFIX[ask.kind]}${counters[ask.kind]}`;
        index.set(id, { ...ask, id });
        return `  ${id} [${ask.kind}] ${face(ask)}`;
    });

    // The dropped count is printed rather than swallowed. A block that silently truncates reads as
    // "everything was considered" when it was not, and the unposed rows are exactly the ones a
    // player would assume had been checked. With the offset above, running it again reaches them.
    const dropped = list.length - posed.length;
    const tail = dropped > 0
        ? `\n  (${dropped} more rows not posed this pass, run it again to reach them)`
        : '';

    return { text: `STILL TRUE?\n${lines.join('\n')}${tail}`, index, covered: start + posed.length };
}

/**
 * What the model must answer with.
 *
 * Every property sits in `required`: OpenAI strict mode demands it, and a field the model may omit
 * is a field it will omit. No enum member is the empty string, Google's converter rejects those
 * (`src/prompt-converters.js` `toGeminiSchema`).
 *
 * What this schema does and does not let a model say.
 *
 * It carries values, a name, a count, a place, a sibling id, a list of parts, and that is not the
 * property the original design was protecting. The load-bearing one is the one `VERDICTS` states:
 * every value here is a PROPOSAL that reaches the record only through a diff the player ticks, and
 * every one of them arrives with the evidence that justifies it. What is still unsayable is
 * "this was never true": there is no verdict that forgets, because a model that could not find
 * something in a window has found nothing at all.
 *
 * @returns {object} A JSON schema.
 */
export function schema() {
    return {
        type: 'object',
        description: 'Your reading of the lines under "STILL TRUE?".',
        properties: {
            lines: {
                type: 'array',
                description: 'One entry per id in the block. Answer every id.',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'The id exactly as listed, e.g. "RI3", "RM1", "RC2", "RT1".' },
                        verdict: {
                            type: 'string',
                            enum: [...VERDICTS],
                            description: '"keep" when the record is right. "gone" when the story shows it ended, was spent, left, healed, died or was resolved. "rename" when the record calls it something the story does not. "amount" when the record holds the wrong number of it. "move" when it is somewhere other than where the record puts it. "merge" when another line in the block is the same thing under a different name. "split" when one line is really several different things lumped together.',
                        },
                        to: {
                            type: 'string',
                            description: 'For "rename", the name the story uses. For "move", the place it is actually in. Empty otherwise.',
                        },
                        count: {
                            type: 'integer',
                            description: 'For "amount", how many the story says there are. A whole number, zero or more. Use 0 for anything else.',
                        },
                        with: {
                            type: 'string',
                            description: 'For "merge", the id of the OTHER line in this block that is the same thing, exactly as listed, e.g. "RC2". It must be a line in the block and the same kind. Empty otherwise.',
                        },
                        parts: {
                            type: 'array',
                            description: 'For "split", the separate things this one line is actually holding. Empty for every other verdict.',
                            items: {
                                type: 'object',
                                properties: {
                                    name: { type: 'string', description: 'What this part is, as the story names it.' },
                                    count: { type: 'integer', description: 'How many of this part. A whole number; use 0 when the story does not say.' },
                                },
                                required: ['name', 'count'],
                                additionalProperties: false,
                            },
                        },
                        evidence: {
                            type: 'string',
                            description: 'Required for every verdict except "keep": what in the text shows it. Quote or paraphrase the moment. Never guess, if the story does not show it, the answer is "keep".',
                        },
                    },
                    required: ['id', 'verdict', 'to', 'count', 'with', 'parts', 'evidence'],
                    additionalProperties: false,
                },
            },
        },
        required: ['lines'],
        additionalProperties: false,
    };
}

/**
 * The instruction that inverts the prior.
 *
 * Says outright that not finding something is not evidence, because that is the failure this pass is
 * most likely to produce and the one that costs the player real inventory.
 *
 * @returns {string} The instruction block.
 */
export function instruction() {
    return [
        'The "STILL TRUE?" block lists what the record currently holds, with the name and amount it holds them under. You have been given a long stretch of the story to check it against.',
        'Answer every id once. This is a cleanup: fix what the record has wrong, and leave alone what it has right.',
        '"keep" when the row matches the story. "gone" when the story shows the thing ended, spent, dropped, traded, healed, resolved, killed, departed. "rename" when the record calls it something the story does not, or has mangled its name. "amount" when the story establishes a different number. "move" when it is somewhere other than where the record puts it.',
        '"merge" when two lines in the block are the same thing under different names, the same person named once by name and once by description, the same stake counted twice, the same pile of a thing on two rows. Put the OTHER line\'s id in "with". Answer "merge" on one of the pair, not on both.',
        '"split" when one line is several different things lumped under one name, and list them in "parts". "ammunition x29" is the case: if the story says three magazines and twenty-five shells and a box of birdshot, that is three parts, not one row. The parts do not have to add up to the number the record holds, if the story corrects the total, use the story\'s numbers.',
        'Every verdict except "keep" needs "evidence": what in the text shows it. If you cannot say what shows it, the answer is "keep".',
        'Not finding a mention is NOT evidence of anything. A knife nobody has spoken about for thirty turns is still in the pack; a person nobody has named is still wherever they were.',
        'Give an amount only where the story states or clearly implies one. Do not compute totals across scenes, do not estimate, and do not convert between units, if the story says three magazines and twenty-five shells, those are two different rows, not a sum. If the record has already summed them, that is what "split" is for.',
    ].join(' ');
}

/**
 * Read the parts of a `split`, or say why the row cannot be split.
 *
 * The counts are NOT checked against the row's own total, deliberately.
 *
 * `ammunition x29` was three magazines, twenty-five buckshot shells and a box of birdshot: 29 parts
 * against a row of 29 only by coincidence of the arithmetic that produced the fault. A sum check
 * would refuse the correct answer whenever the story ALSO corrects the total, which is the common
 * case: the record's number came from the same summing mistake the split is repairing.
 * `edit-table.js` `splitDelta` already settles this the other way round and says why: every part is
 * credited in full and the debit is clamped to what the row can pay, so an over-count is the player
 * correcting two numbers at once and an under-count leaves an honest remainder on the panel.
 *
 * A part is refused whole rather than repaired. A blank name or a negative count is a model that has
 * not understood the row, and there is no reading of "half of this list is usable" that is safer than
 * asking again next pass.
 *
 * @param {object} raw The answered line.
 * @param {object} row The posed row.
 * @returns {{parts: Array<{name: string, count: number}>, dropped: number}|null} The parts, or null.
 */
function splitParts(raw, row) {
    const parts = [];
    let dropped = 0;
    for (const part of Array.isArray(raw?.parts) ? raw.parts : []) {
        const name = String(part?.name ?? '').trim();
        const count = Number(part?.count);
        if (!name || !Number.isInteger(count) || count < 0) {
            return null;
        }
        if (parts.length >= MAX_SPLIT_PARTS) {
            dropped++;
            continue;
        }
        // A zero reads as "the story does not say how many", which is what the schema's own
        // `count` field already means everywhere else in this block. `splitDelta` would turn it
        // into one anyway (`parsed.qty ?? 1`); doing it here is what puts the 1 in front of the
        // player in the diff rather than letting the writer invent it after they have ticked.
        parts.push({ name: name.slice(0, 120), count: count || 1 });
    }
    if (!parts.length) {
        return null;
    }
    // A "split" into one part with the row's own name is a rename that changes nothing, and
    // `splitDelta` skips a part named after its source, so it would record an event that moved
    // no quantity at all.
    const only = parts.length === 1 && parts[0].name.toLowerCase() === String(row?.name ?? '').trim().toLowerCase();
    return only ? null : { parts, dropped };
}

/**
 * Refuse the merges that cannot be applied in one pass, once the whole plan is known.
 *
 * Chains and cycles: refuse the middle, keep the pass deterministic.
 *
 * A merge both destroys a row and depends on another row surviving, so two of them can contradict
 * each other in a way no per-line gate can see. Three shapes:
 *
 *   A→B and B→A   a cycle. Both rows are merge targets, so both verdicts go, and nothing collapses.
 *   A→B→C         a chain. B is a target AND a source; B's verdict goes and A→B still applies, so
 *                 one collapse happens and the record is left in a state where the next pass can
 *                 propose the other. Refusing the middle rather than the whole chain is what makes
 *                 the result independent of the order the model happened to answer in.
 *   B is `gone`   or `split`, and something merges into it. The survivor would be retracted or
 *                 broken up by the time the merge landed, so the merge would write to a dead key.
 *
 * In every case the refused row is the one that is a merge TARGET. Collapsing three rows in one
 * confirmation is the case most likely to be wrong and the cheapest to defer: the pass is explicit,
 * bounded and re-runnable, and its offset walk already assumes it takes several passes to cover a
 * record.
 *
 * `rename`, `move` and `amount` on a merge target are LEFT ALONE. They edit a row rather than
 * removing it, and `apply` orders the merge ahead of them, so the field edit lands on the survivor
 * after it has absorbed the other half, which is the order that makes the story's number win.
 *
 * @param {object} plan The plan so far, mutated.
 * @returns {object} The same plan.
 */
function settleMerges(plan) {
    const targets = new Set(plan.repairs.filter(repair => repair.op === MERGE).map(repair => repair.withId));
    if (!targets.size) {
        return plan;
    }
    const kept = [];
    for (const repair of plan.repairs) {
        if (targets.has(repair.id) && (repair.op === MERGE || repair.op === GONE || repair.op === SPLIT)) {
            plan.rejected.push({
                item: repair.name,
                reason: MERGE_CONFLICT,
                raw: { id: repair.id, verdict: repair.op, with: repair.with ?? '' },
            });
            continue;
        }
        kept.push(repair);
    }
    plan.repairs = kept;
    return plan;
}

/**
 * Route the answers back through the index.
 *
 * @param {object} fragment The model's answer.
 * @param {object} params Parameters.
 * @param {Map<string, object>} params.index The index `reconcileBlock` returned.
 * @returns {{repairs: object[], held: number, rejected: object[]}} What fold should do.
 */
export function planReconcile(fragment, { index = new Map() } = {}) {
    const plan = { repairs: [], held: 0, rejected: [] };
    const answered = new Set();

    for (const raw of Array.isArray(fragment?.lines) ? fragment.lines : []) {
        const id = String(raw?.id ?? '').trim().toUpperCase();
        const row = index.get(id);
        if (!row) {
            plan.rejected.push({ item: String(raw?.id ?? ''), reason: UNKNOWN_ID, raw });
            continue;
        }
        if (answered.has(id)) {
            plan.rejected.push({ item: id, reason: DUPLICATE_ID, raw });
            continue;
        }
        answered.add(id);

        const verdict = String(raw?.verdict ?? '').trim().toLowerCase();
        if (verdict === KEEP || !VERDICTS.includes(verdict)) {
            // Anything that is not a known repair keeps the row. A verdict outside the vocabulary is
            // a model that did not understand the question, and the safe reading of a
            // misunderstanding is "change nothing".
            plan.held++;
            continue;
        }

        // A quantity on a thread, a place on a mark: the row cannot take the operation at all. Caught
        // rather than coerced onto the nearest thing that would accept it.
        if (!(OPS_FOR[row.kind] ?? []).includes(verdict)) {
            plan.rejected.push({ item: row.name, reason: WRONG_OP, raw });
            continue;
        }

        const evidence = String(raw?.evidence ?? '').trim();
        if (!evidence) {
            // The safety property, in one branch. Structure only: fold checks that something was
            // written, never what it says. The player reads it and decides.
            plan.rejected.push({ item: row.name, reason: NO_EVIDENCE, raw });
            continue;
        }

        const repair = { id, op: verdict, kind: row.kind, key: row.key, name: row.name, who: row.who ?? '', evidence: evidence.slice(0, 200) };

        if (verdict === RENAME || verdict === MOVE) {
            const to = String(raw?.to ?? '').trim();
            // A rename to the same name and a move to the same place are both no-ops dressed as
            // repairs; they would spend an event to change nothing.
            const same = verdict === RENAME
                ? to.toLowerCase() === String(row.name ?? '').trim().toLowerCase()
                : to.toLowerCase() === String(row.place ?? '').trim().toLowerCase();
            if (!to || same) {
                plan.rejected.push({ item: row.name, reason: NO_CHANGE, raw });
                continue;
            }
            repair.to = to.slice(0, 120);
        }

        if (verdict === AMOUNT) {
            const count = Number(raw?.count);
            // Refused rather than clamped: a non-integer or negative count is a model that has not
            // understood the row, and rounding it into something writable would hide that.
            if (!Number.isInteger(count) || count < 0) {
                plan.rejected.push({ item: row.name, reason: UNUSABLE_AMOUNT, raw });
                continue;
            }
            if (count === Number(row.qty)) {
                plan.rejected.push({ item: row.name, reason: NO_CHANGE, raw });
                continue;
            }
            repair.count = count;
            repair.from = Number(row.qty) || 0;
        }

        if (verdict === MERGE) {
            // Resolved through the index exactly as `id` is, and for the same reason the ids are
            // deterministic in the first place: a target read as a raw table key, or as a name, could
            // route a collapse onto a row the block never posed and the player never saw.
            const other = index.get(String(raw?.with ?? '').trim().toUpperCase());
            if (!other) {
                plan.rejected.push({ item: row.name, reason: UNKNOWN_TARGET, raw });
                continue;
            }
            if (other.id === id) {
                plan.rejected.push({ item: row.name, reason: NO_CHANGE, raw });
                continue;
            }
            if (other.kind !== row.kind) {
                // A person is not a stake and a stake is not a pile of a thing. Each kind's merge
                // lives in a different table with a different keeper rule; there is no operator that
                // spans two of them and inventing one would be guessing at what survived.
                plan.rejected.push({ item: row.name, reason: WRONG_OP, raw });
                continue;
            }
            if (row.kind === 'item') {
                // Two piles in two places are not a duplicate.
                //
                // The item merge is `edits.renameItem`, which is one transfer event: the source's
                // whole quantity is debited and credited under the target's name AT THE SOURCE'S OWN
                // place and owner (`edit-table.js` `renameDelta`). That lands on the target key only
                // when the place and the owner already match. When they do not, the honest reading is
                // not a merge at all, a knife in the pack and a knife in the van are two knives, and
                // if one of them moved, `move` is the verdict for it.
                const here = splitItemKey(row.key);
                const there = splitItemKey(other.key);
                if (here.place !== there.place || here.who !== there.who) {
                    plan.rejected.push({ item: row.name, reason: MERGE_CONFLICT, raw });
                    continue;
                }
            }
            repair.with = other.key;
            repair.withId = other.id;
            repair.withName = other.name;
        }

        if (verdict === SPLIT) {
            const split = splitParts(raw, row);
            if (!split) {
                plan.rejected.push({ item: row.name, reason: UNUSABLE_SPLIT, raw });
                continue;
            }
            repair.parts = split.parts;
            repair.dropped = split.dropped;
            repair.from = Number(row.qty) || 0;
        }

        plan.repairs.push(repair);
    }

    return settleMerges(plan);
}
