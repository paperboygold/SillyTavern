/**
 * fold/block-parse.js: reading the state block a card asks its narrator to emit.
 *
 * Pure, dependency-free, unit-testable.
 *
 * Many survival/simulation cards end every reply with a self-reported status line, e.g.
 *
 *     ---
 *     [Time: 7:22 AM | Location: Ennerdale Street | Health: uninjured | Inventory: keys, wallet]
 *
 * That is a perfectly good transport: the narrator is already being asked for it, so reading it
 * costs no extra request. It has two problems as *presentation*, which is what this module fixes:
 *
 *   · The user sees it. It is bookkeeping, not prose, and it grows as the run goes on.
 *   · It is re-sent every turn. Twenty replies means twenty copies of an ever-longer block in
 *     context, all but the last of them stale.
 *
 * So fold lifts the block out of the message, keeps the data, and injects one compact canonical
 * block of its own instead. The narrator keeps its continuity; the reader gets clean prose; the
 * context stops accumulating.
 *
 * What it is NOT is an authority. The block states totals, and a narrator that forgets to relist
 * an item has not thereby destroyed it; see `diffInventory` for how that is handled.
 */

/** Field labels understood as inventory, lowercased. */
const INVENTORY_LABELS = new Set(['inventory', 'carrying', 'items', 'equipment', 'gear']);

/** Field labels understood as health or condition. */
const HEALTH_LABELS = new Set(['health', 'condition', 'status', 'injuries', 'state']);

/**
 * Find the trailing state block in a reply.
 *
 * Anchored to the END of the message: a bracketed line mid-prose is dialogue or an aside, not a
 * status report. Tolerates an optional `---` or `***` rule above it, which cards commonly add.
 *
 * @param {string} text The message text.
 * @returns {{raw: string, inner: string, index: number}|null} The block, or null.
 */
export function findStateBlock(text) {
    const source = String(text ?? '');

    // Three wrappers, because cards do not agree on one.
    //
    // This recognised `[...]` and nothing else, and that cost a whole campaign its ground truth. A
    // live Isekai card closes its replies with a FENCED block inside an XML-ish tag:
    //
    //     <stats>
    //     ```
    //     HP: 100/100 | MP: 50/50
    //     Skills: Sense E (0/5), Quarterstaff Proficiency E (1/5)
    //     Abilities: Null Insight (Active), Void Comprehension (Passive)
    //     Equipment: Worn Quarterstaff (Common), School Uniform, Backpack
    //     Inventory: Smartphone, Wallet
    //     ```
    //     </stats>
    //
    // `findStateBlock` returned null for every one of them, so `absorb.js` never ran, `clock.block`
    // was never written, and fold fell back to inferring state from prose. What that inference
    // produced, on the panel the owner was reading: `Quarterstaff proficiency (e)` and
    // `Quarterstaff proficiency` as two abilities (they are one skill that went F→E→D), `Work` as an
    // ability (from "settling into the rhythm of the work"), and no Smartphone, Wallet, School
    // Uniform or Backpack at all, every one of them listed, correctly, in a block fold could not
    // see. The structured truth was in the message the whole time.
    //
    // Matching a delimiter shape is FORMAT, which RULE 1 permits explicitly, and the field LABELS
    // this feeds (`INVENTORY_LABELS` and friends) are block-field labels, which it permits as
    // PROTOCOL. Nothing here reads narrative.
    const patterns = [
        // A bracketed block: `[HP: 10 | Location: the inn]`
        /\n?\s*(?:^|\n)\s*(?:[-*_]{3,}\s*\n)?\s*\[([^[\]]*)\]\s*$/,
        // A tag wrapper, with or without a fence inside: `<stats> ``` ... ``` </stats>`
        /\n?\s*(?:^|\n)\s*(?:[-*_]{3,}\s*\n)?\s*<([a-z][\w-]*)>\s*(?:```[^\n]*\n)?([\s\S]*?)(?:\n\s*```)?\s*<\/\1>\s*$/i,
        // A bare fenced block at the end: ``` ... ```
        /\n?\s*(?:^|\n)\s*(?:[-*_]{3,}\s*\n)?\s*```[^\n]*\n([\s\S]*?)\n\s*```\s*$/,
    ];

    for (const pattern of patterns) {
        const match = source.match(pattern);
        if (!match) {
            continue;
        }
        // The tag form captures the tag name first, so the payload is always the LAST group.
        const inner = String(match[match.length - 1] ?? '').trim();
        // A status block is labelled fields; a bare bracketed aside or a code sample is not.
        if (!inner.includes(':')) {
            continue;
        }
        return { raw: match[0], inner, index: source.length - match[0].length };
    }
    return null;
}

/**
 * Remove the trailing state block from a reply.
 * @param {string} text The message text.
 * @returns {string} The text without its state block.
 */
export function stripStateBlock(text) {
    const found = findStateBlock(text);
    return found ? String(text).slice(0, found.index).trimEnd() : String(text ?? '');
}

/**
 * Parse a state block into labelled fields.
 *
 * Splits on `|` and then on the FIRST colon only, so values containing colons (a time like
 * "7:22 AM" is the common case) survive intact.
 *
 * @param {string} text A message, or the block itself.
 * @returns {Map<string, string>|null} label -> value, lowercased labels, or null if absent.
 */
export function parseStateBlock(text) {
    const found = findStateBlock(text);
    const inner = found ? found.inner : null;
    if (!inner) {
        return null;
    }

    const fields = new Map();
    // Newlines separate fields as surely as `|` does: a one-line block uses pipes, a fenced one
    // uses lines, and the live Isekai card uses BOTH (`HP: 100/100 | MP: 50/50` on its own line).
    // Splitting on only `|` folded ten labelled lines into one field whose value was the rest of
    // the block.
    for (const part of inner.split(/[\n|]/)) {
        const colon = part.indexOf(':');
        if (colon === -1) {
            continue;
        }
        const label = part.slice(0, colon).trim().toLowerCase();
        const value = part.slice(colon + 1).trim();
        if (label) {
            fields.set(label, value);
        }
    }
    return fields.size ? fields : null;
}

/**
 * Is this field value a way of saying "nothing"?
 * @param {string} value A field value.
 * @returns {boolean} True if it carries no content.
 */
/**
 * Is a value structurally empty?
 *
 * This used to be an English word list (`EMPTY_VALUES`, `EMPTY_HEAD`: "none", "nothing", "nil",
 * "unknown", "unchanged", ...) that decided whether a block field meant "nothing here". Those words
 * are prose in the card's language; the model reads the block text and reports emptiness as
 * structure. The only refusal left is a genuinely empty string.
 *
 * @param {string} value A field value.
 * @returns {boolean} True if the value is empty or whitespace.
 */
export function isEmptyValue(value) {
    return !String(value ?? '').trim().replace(/[.]+$/, '').length;
}

/**
 * Strip one bracket pair that encloses the WHOLE value.
 *
 * A wrapper is not a qualifier, and the depth guard could not tell them apart.
 *
 * `splitItems` ignores separators inside brackets so that a qualifier, "Beretta M92F (12 rounds,
 * one spare magazine)", stays one item. That guard is right about qualifiers and was catastrophic
 * about lists, because plenty of cards bracket the entire field:
 *
 *     Equipment: [School Uniform, Backpack]
 *     Inventory: [Smartphone, Wallet]
 *
 * Every comma there sits at depth 1, so nothing split, and the line became a single item literally
 * named `school uniform, backpack`. MEASURED in the live Isekai RPG chat: those two lines produced
 * four inventory rows across two absorbs, `school uniform, backpack`, `rough cloth wraps,
 * smartphone, wallet`, `school uniform, rough cloth wraps`, `backpack, smartphone, wallet`, five
 * real possessions rendered as four fictional ones, each listed twice, and the narrator was handed
 * all of it as `Carrying:`.
 *
 * The distinction is structural, not linguistic: a bracket whose match is the last character
 * encloses everything, so it is punctuation around a list. A bracket that closes early is attached
 * to one entry, so it qualifies that entry. No word is consulted, which keeps this on RULE 1's
 * STRUCTURE side.
 *
 * Only one layer comes off, and only when it is genuinely the outermost: `[a, b]` unwraps, and
 * `[a], [b]` does not, because the first `[` closes before the end.
 *
 * @param {string} value A field value.
 * @returns {string} The value with one enclosing bracket pair removed, if it had one.
 */
export function unwrapList(value) {
    const text = String(value ?? '').trim();
    // Fullwidth and ideographic brackets too: a card written in Chinese wraps its lists in ［］ or 【】,
    // and a wrapper fold cannot see is a list it turns into one long item.
    const pairs = { '[': ']', '(': ')', '［': '］', '【': '】', '（': '）', '「': '」' };
    const close = pairs[text[0]];
    if (!close || text[text.length - 1] !== close) {
        return text;
    }
    let depth = 0;
    for (let at = 0; at < text.length; at++) {
        if (text[at] === text[0]) depth++;
        else if (text[at] === close) depth--;
        // Closed before the end, so this bracket belongs to the first entry rather than the list.
        if (depth === 0 && at < text.length - 1) {
            return text;
        }
    }
    return text.slice(1, -1).trim();
}

/**
 * Split an inventory field into item strings.
 *
 * Splits on commas and semicolons at bracket depth zero, so a qualifier like
 * "Beretta M92F (12 rounds, one spare magazine)" stays one item rather than three; after
 * `unwrapList` removes a bracket that wraps the whole field, which is a list and not a qualifier.
 *
 * @param {string} value The inventory field value.
 * @returns {string[]} Item strings, uncleaned.
 */
export function splitItems(value) {
    if (isEmptyValue(value)) {
        return [];
    }

    const items = [];
    let current = '';
    let depth = 0;

    for (const ch of unwrapList(value)) {
        if (ch === '(' || ch === '[') {
            depth++;
            current += ch;
        } else if (ch === ')' || ch === ']') {
            depth = Math.max(0, depth - 1);
            current += ch;
        } else if ((ch === ',' || ch === ';' || ch === '，' || ch === '、' || ch === '；') && depth === 0) {
            if (current.trim()) items.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    if (current.trim()) {
        items.push(current.trim());
    }

    return items.filter(item => !isEmptyValue(item));
}

/**
 * Turn a restated inventory list into ABSOLUTE quantities for the items it names.
 *
 * Why totals and not deltas.
 *
 * Everything else in fold is a delta, on purpose: a delta has a magnitude and a magnitude can be
 * bounds-checked. A card's status block is the one source that does not work that way. It reports
 * *totals*, "Inventory: M-65 jacket, grey flat cap" means you have one of each right now, not
 * that you just acquired them.
 *
 * The first version bridged the gap by diffing the list against what was held and proposing the
 * difference. That bridge broke the moment inventory keys gained a place prefix: bare names never
 * matched place-keyed entries, every lookup returned nothing, and each restatement of the same
 * coat read as another coat. One flat cap became seven, one turn at a time.
 *
 * Diffing is the wrong shape regardless of that bug. A restatement is idempotent by nature and
 * should be idempotent by construction, not by a lookup that has to succeed. Writing the total
 * makes folding "you have one cap" twenty times give one cap, and, because the fold is ordered,
 * the next restatement in an already-corrupted chat repairs it. History heals on the next turn
 * rather than needing a migration.
 *
 * **The block is still evidence, not authority.** A total is written only for items the block
 * NAMES. A narrator that forgets to relist the crowbar has not destroyed it; unlisted items are
 * untouched. That asymmetry is what keeps restate-the-whole-list implementations from silently
 * losing everything, and it survives intact here.
 *
 * @param {object} params Parameters.
 * @param {Map<string, {qty: number}>} params.held Inventory as currently derived, by bare name.
 * @param {string[]} params.listed Item names from the block, already normalized.
 * @returns {Array<{item: string, set: number}>} Absolute quantities to propose.
 */
export function restateInventory({ held, listed }) {
    const counts = new Map();
    for (const name of listed) {
        // Exact-key identity. Whether a listed spelling is the same thing as a held row is the
        // model's reading; it reuses the exact State-block name when restating, and the review
        // probe answers `[same?]` for a pair fold cannot resolve. The old `resolveAlias` folded
        // near-identical namings with an English stopword list; that list is gone.
        counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    // The place is carried FORWARD, not assumed. A card's block says "you have canned tuna"; it
    // does not say the tuna is in your hands. Emitting `carried` for everything meant that the
    // moment anything was stored, the next restatement dragged it back out of the cupboard, which
    // is why a shelf of groceries kept reading as luggage.
    return [...counts].map(([item, qty]) => ({ item, set: qty, at: held.get(item)?.at ?? CARRIED_PLACE }));
}

/**
 * The default place, duplicated from state-table rather than imported.
 *
 * block-parse is the pure half and state-table imports IT (for `isNegation`, `sameItem`); importing
 * back would be a cycle. One string, and the two are held equal by `restateInventory` tests.
 */
const CARRIED_PLACE = 'carried';

/**
 * Do two names refer to the same thing?
 *
 * Exact equality, and deliberately nothing more. Identity used to be decided by English morphology
 * via a `POST_HEAD` preposition list and a `WEAK_TOKENS` stopword list that truncated an item name
 * to its "head noun" so "m-65 jacket" and "m-65 military jacket" silently merged. Those lists
 * could only read English. Whether two spellings name one thing is a reading the model answers:
 * the delta schema instructs it to reuse the exact name from the State block when restating, and
 * the review probe answers `[same?]` for a pair fold cannot resolve. fold never guesses identity
 * from words.
 *
 * @param {string} a One name.
 * @param {string} b Another.
 * @returns {boolean} True only if they are the same string.
 */
export function sameItem(a, b) {
    return String(a ?? '') === String(b ?? '');
}

/**
 * The head noun of an item name.
 *
 * Identity is exact now (see `sameItem`), so there is no head to derive. Kept as the identity
 * function so the mention-coverage fallback and callers can treat "what the item is called" as
 * exactly what the model reported.
 *
 * @param {string} name An item name.
 * @returns {string} The name, unchanged.
 */
export function itemHead(name) {
    return String(name ?? '');
}

/**
 * Do two names refer to the same thing, judged strictly enough to merge quantities?
 *
 * Exact equality, and deliberately nothing more. This function used to narrow item merges by
 * English head-token identity so "phone" never merged into "solomon's phone number" while "m-65
 * jacket" still merged into "m-65 military jacket". Both of those are record-linkage decisions;
 * fold does not make them from English morphology. The delta schema instructs the model to reuse
 * the exact name from the State block when restating a held item, and the review probe answers
 * `[same?]` for a pair fold cannot resolve. fold never guesses identity from words.
 *
 * @param {string} a One name.
 * @param {string} b Another.
 * @returns {boolean} True only if they are the same string.
 */
export function sameItemHead(a, b) {
    return String(a ?? '') === String(b ?? '');
}

/**
 * Characters beyond which a statement is long enough to need an expander.
 *
 * Lives here rather than in the panel so the calibration instrument can import it. A bound that
 * only exists inside a module importing `script.js` is a bound nothing can measure.
 *
 * Measured (`tests/util/fold-calibrate.mjs`, Raccoon City, n=323 statements): p50 19, p95 92,
 * max 137, a short body with a long tail, which is the shape a clamp should serve. The threshold
 * is the p95, so the control appears only for the tail that genuinely runs past two lines. At 84 it
 * was appearing on statements most cards write normally.
 */
export const LONG_STATEMENT = 92;

/**
 * Extract condition phrases from a health field written as prose.
 *
 * DEMOTED in Phase D: legacy prose only, and no longer a judgement about English.
 *
 * This used to be the primary way an affliction entered fold, and `FOLD-REDESIGN.md` §3 retires it
 * from that job. Marks now come from probes that were ASKED for one affliction per entry, the
 * delta's `st` array (`state.js` `deltaSchema`) and the scene probe's `conditions` array
 * (`scene.js`), so the judgement "which half of this sentence is the wound" is made by something
 * that can read the sentence. What is left for this function is prose fold never asked for in mark
 * shape, and there are exactly two such callers: a card's own `Health:`/`Condition:` block
 * (`classifyBlock` below, via `absorb.js`) and the v1 → v2 migration of `state.context.conditions`
 * and `.health` (`migrate.js`, §9's read-time healing row).
 *
 * The split on "but" is gone, and that is the actual fix.
 *
 * It read:
 *
 *     .split(/[,;]|\band\b|\bbut\b|\bthough\b|\botherwise\b|\bwhile\b/)
 *
 * with the comment "'but', 'though' and 'otherwise' are separators here, not conjunctions to keep:
 * they almost always introduce the reassuring half". The design was: cut the sentence in half, then
 * let `isNegation` drop the reassuring half. Both halves of that plan failed on the same live line.
 * From the card block *"left arm heavily bruised but functional"* the split produced `left arm
 * heavily bruised` and `functional`, and `functional` is not in `isNegation`'s enumerated
 * vocabulary, so the panel carried the GOOD NEWS as a live flag for the rest of the session
 * (`FOLD-REDESIGN.md` §0.1-4, measured at message 72 of the live Solo Leveling chat, where it sat
 * beside `mild fatigue` and `bandaged`).
 *
 * That is not a missing word. It is the shape §11 bans with a standing measurement: an enumerated
 * judgement about English, which will be missing a word for as long as English has words. Adding
 * "functional" would fix the instance and leave the class; the next narrator writes "usable",
 * "not slowing him down", "he can still grip a sword".
 *
 * So a concessive clause is no longer a separator: *"bruised but functional"* is ONE phrase, kept
 * whole, and it is the phrase §3 names as the correct single mark. The affliction survives with its
 * qualifier attached, which is more information than the old split preserved and none of the risk.
 *
 * "and" went with it, and that one IS measured.
 *
 * Every `Health:` and `Conditions:` line the four live chats contain was pulled out of the raw
 * messages and read. Every single occurrence of "and" in them joins a COMPOUND PREDICATE about one
 * affliction, and not one separates two:
 *
 *     lacerations cleaned and bandaged, left arm heavily bruised but functional, mild fatigue
 *     bandaged left calf, left arm bruised and sore
 *     calf scabbed and rebandaged, left arm bruised shoulder to elbow
 *
 * Splitting those produced exactly the duplicate pairs the live header carried: `lacerations
 * cleaned` beside `bandaged`, and `calf scabbed` beside `rebandaged`, one wound filed twice, which
 * then consumed two of three consequence slots. The commas in the same lines separate correctly
 * every time. So the separator set is punctuation only: `,` and `;` are a list, and everything else
 * is one condition described in as many words as the narrator wanted. The counter-example the old
 * unit test asserted, "bleeding from the forearm and badly winded", was invented for the test and
 * appears nowhere in any log; the measured cases all run the other way.
 *
 * @param {string} value The health field value.
 * @returns {string[]} Condition phrases.
 */
export function splitConditions(value) {
    if (isEmptyValue(value)) {
        return [];
    }
    return String(value)
        .split(/[,;，、；]/)
        .map(part => part.trim().toLowerCase().replace(/[.]+$/, ''))
        .filter(part => part && !isEmptyValue(part));
}

/**
 * Classify a parsed block into the shapes fold tracks.
 * @param {Map<string, string>} fields Parsed fields.
 * @returns {{items: string[], conditions: string[], context: Map<string, string>}} Classified.
 */
export function classifyBlock(fields) {
    const items = [];
    const conditions = [];
    const context = new Map();

    for (const [label, value] of fields ?? new Map()) {
        if (INVENTORY_LABELS.has(label)) {
            items.push(...splitItems(value));
        } else if (HEALTH_LABELS.has(label)) {
            conditions.push(...splitConditions(value));
            // Kept verbatim as well as split: a narrator writing "mild hangover, otherwise
            // uninjured" is saying something a set of flags cannot, and the panel should show
            // what the card actually reported rather than only what fold could model.
            if (!isEmptyValue(value)) {
                context.set(label, value);
            }
        } else if (!isEmptyValue(value)) {
            // Time, Location, Conditions, Leads and anything else a card invents: kept as the card
            // wrote it so the injected block can carry them without fold needing to model them,
            // less the bracket some cards wrap a whole field in, for the same reason `splitItems`
            // drops it. `Quests: [Journey to the Capital, The Sage's Mandate]` is a two-item list,
            // and a reader that splits it on the comma without unwrapping first produces
            // `[Journey to the Capital` and `The Sage's Mandate]`, which is what the panel showed.
            context.set(label, unwrapList(value));
        }
    }

    return { items, conditions, context };
}
