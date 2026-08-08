/**
 * fold/block-parse.js — reading the state block a card asks its narrator to emit.
 *
 * Pure, dependency-free, unit-testable.
 *
 * Many survival/simulation cards end every reply with a self-reported status line, e.g.
 *
 *     ---
 *     [Time: 7:22 AM | Location: Ennerdale Street | Health: uninjured | Inventory: keys, wallet]
 *
 * That is a perfectly good transport — the narrator is already being asked for it, so reading it
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
 * an item has not thereby destroyed it — see `diffInventory` for how that is handled.
 */

/** Field labels understood as inventory, lowercased. */
const INVENTORY_LABELS = new Set(['inventory', 'carrying', 'items', 'equipment', 'gear']);

/** Field labels understood as health or condition. */
const HEALTH_LABELS = new Set(['health', 'condition', 'status', 'injuries', 'state']);

/** Values that mean "nothing here", not an item called "none". */
const EMPTY_VALUES = new Set([
    'none', 'nothing', 'empty', 'n/a', 'na', 'unknown', 'uninjured', 'unharmed', 'healthy',
    'as established', 'as established by user', 'unchanged', '-', '—',
]);

/**
 * Emptiness stated with a qualifier attached.
 *
 * Exact-match against EMPTY_VALUES is not enough, and the gap is visible in play: a narrator
 * writing "Inventory: none carried" produced an item literally named "none carried", which then
 * accumulated a quantity as the phrase recurred. Models write "nothing of note", "no items at
 * present" and "none currently" just as readily, so the test has to be on the HEAD of the phrase.
 *
 * `\b` after "no" is what keeps this from eating real names — "north gate" has no boundary there.
 */
const EMPTY_HEAD = /^(none|nothing|nil|empty|no|n\/a|na|unknown|unspecified|undetermined)\b/;

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
    // Optional horizontal rule, then a bracketed block, then only whitespace to the end.
    const match = source.match(/\n?\s*(?:^|\n)\s*(?:[-*_]{3,}\s*\n)?\s*(\[[^[\]]*\])\s*$/);
    if (!match) {
        return null;
    }
    const raw = match[0];
    const inner = match[1].slice(1, -1).trim();
    // A status block is labelled fields; a bare bracketed aside is not.
    if (!inner.includes(':')) {
        return null;
    }
    return { raw, inner, index: source.length - raw.length };
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
 * Splits on `|` and then on the FIRST colon only, so values containing colons — a time like
 * "7:22 AM" is the common case — survive intact.
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
    for (const part of inner.split('|')) {
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
export function isEmptyValue(value) {
    const text = String(value ?? '').trim().toLowerCase().replace(/[.]+$/, '');
    if (!text) {
        return true;
    }
    if (EMPTY_VALUES.has(text) || EMPTY_HEAD.test(text)) {
        return true;
    }
    // "as established by {{user}}", "unchanged from before", and similar deferrals.
    return /^(as established|unchanged|same as)\b/.test(text);
}

/**
 * Split an inventory field into item strings.
 *
 * Splits on commas and semicolons at bracket depth zero, so a qualifier like
 * "Beretta M92F (12 rounds, one spare magazine)" stays one item rather than three.
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

    for (const ch of String(value)) {
        if (ch === '(' || ch === '[') {
            depth++;
            current += ch;
        } else if (ch === ')' || ch === ']') {
            depth = Math.max(0, depth - 1);
            current += ch;
        } else if ((ch === ',' || ch === ';') && depth === 0) {
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
 * ── Why totals and not deltas ──
 *
 * Everything else in fold is a delta, on purpose: a delta has a magnitude and a magnitude can be
 * bounds-checked. A card's status block is the one source that does not work that way. It reports
 * *totals* — "Inventory: M-65 jacket, grey flat cap" means you have one of each right now, not
 * that you just acquired them.
 *
 * The first version bridged the gap by diffing the list against what was held and proposing the
 * difference. That bridge broke the moment inventory keys gained a place prefix: bare names never
 * matched place-keyed entries, every lookup returned nothing, and each restatement of the same
 * coat read as another coat. One flat cap became seven, one turn at a time.
 *
 * Diffing is the wrong shape regardless of that bug. A restatement is idempotent by nature and
 * should be idempotent by construction, not by a lookup that has to succeed. Writing the total
 * makes folding "you have one cap" twenty times give one cap, and — because the fold is ordered —
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
        // Fold near-identical namings onto whatever is already held. A narrator restating its own
        // list writes "M-65 jacket" one turn and "M-65 military jacket" the next.
        const canonical = resolveAlias(held, name);
        counts.set(canonical, (counts.get(canonical) ?? 0) + 1);
    }
    // The place is carried FORWARD, not assumed. A card's block says "you have canned tuna"; it
    // does not say the tuna is in your hands. Emitting `carried` for everything meant that the
    // moment anything was stored, the next restatement dragged it back out of the cupboard — which
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

/** Words too generic to carry identity on their own. */
const WEAK_TOKENS = new Set(['the', 'a', 'an', 'of', 'and', 'with', 'his', 'her', 'their', 'my', 'one', 'pair', 'all']);

/**
 * Significant tokens of an item name.
 * @param {string} name An item name.
 * @returns {Set<string>} The tokens that identify it.
 */
function identityTokens(name) {
    const tokens = new Set();
    for (const raw of String(name ?? '').toLowerCase().split(/[^a-z0-9-]+/)) {
        // A hyphenated compound counts as BOTH the compound and its parts. Keeping only the
        // compound made "all-black dress clothes" and "black dress clothes" two separate garments,
        // because `all-black` is one token and `black` is not in it. Keeping only the parts would
        // shred "m-65" into "m" and "65" and lose the model number that identifies the jacket.
        // Emitting both means containment sees whichever form the other name happened to use.
        for (const token of [raw, ...raw.split('-')]) {
            if (token.length > 2 && !WEAK_TOKENS.has(token)) {
                tokens.add(token);
            }
        }
    }
    return tokens;
}

/**
 * Resolve a listed name onto an item already held, when the two clearly name the same thing.
 *
 * Containment, not similarity: one name's significant tokens must be a subset of the other's.
 * "M-65 jacket" ⊆ "M-65 military jacket" is the same coat described twice; "silver coin" and
 * "gold coin" share only "coin" and neither contains the other, so they stay separate.
 *
 * @param {Map<string, {qty: number}>} held Inventory keyed by bare name.
 * @param {string} name A listed name.
 * @returns {string} The name to count under.
 */
export function resolveAlias(held, name) {
    if (held.has(name)) {
        return name;
    }
    for (const existing of held.keys()) {
        if (sameItem(existing, name)) {
            return existing;
        }
    }
    return name;
}

/**
 * Do two names refer to the same thing?
 *
 * Containment, not similarity: one name's significant tokens must be a subset of the other's.
 * "M-65 jacket" ⊆ "M-65 military jacket" is the same coat described twice; "silver coin" and
 * "gold coin" share only "coin" and neither contains the other, so they stay separate.
 *
 * @param {string} a One name.
 * @param {string} b Another.
 * @returns {boolean} True if they name one item.
 */
export function sameItem(a, b) {
    if (a === b) {
        return true;
    }
    const left = identityTokens(a);
    const right = identityTokens(b);
    if (!left.size || !right.size) {
        return false;
    }
    return [...left].every(token => right.has(token))
        || [...right].every(token => left.has(token));
}

/**
 * Connectives that begin a post-head modifier.
 *
 * English puts the head noun BEFORE its prepositional phrase, so "knife with sheath" heads on
 * `knife` and not on `sheath`. Without this the two names the live ledger actually holds for one
 * object — `rusty hunter's knife with sheath` (events at mids 22 and 38) and any later
 * `rusty hunter's knife` — would head differently and never merge, which is the failure the
 * containment rule was built to avoid in the first place.
 *
 * `of` is already in `WEAK_TOKENS` (`block-parse.js:227`) and appears here too: the two lists do
 * different jobs — that one drops a token from the identity set, this one truncates the phrase.
 */
const POST_HEAD = /\b(?:with|of|in|on|and|for|from|at|to)\b/;

/**
 * The head noun of an item name.
 *
 * The last significant token of the phrase up to its first post-head connective. The "last
 * significant token" convention is `isMentioned`'s (`state-table.js:723-736`), reused verbatim so a
 * name that heads on `potion` is the same name the mention gate heads on `potion`; two tokenizers
 * for one notion of "what is this thing called" is how a gate and a merge come to disagree.
 *
 * Parentheticals are qualifiers, not the thing — `goblin knife (worn)` heads on `knife` — which is
 * again `isMentioned`'s rule. Names too short to have a significant token ("hp", "axe") fall back
 * to their last bare token, because the alternative is an empty head that matches everything.
 *
 * @param {string} name An item name.
 * @returns {string} The head token, or '' if the name is empty.
 */
export function itemHead(name) {
    const text = String(name ?? '').toLowerCase().replace(/\(.*?\)/g, ' ');
    const significant = text.split(POST_HEAD)[0].split(/[^a-z0-9']+/).filter(token => token.length > 2);
    if (significant.length) {
        return significant[significant.length - 1];
    }
    const bare = text.split(/[^a-z0-9']+/).filter(Boolean);
    return bare.length ? bare[bare.length - 1] : '';
}

/**
 * Do two names refer to the same thing, judged strictly enough to merge quantities?
 *
 * ── Why `sameItem` is too loose for inventory canonicalization ──
 *
 * `sameItem` above accepts containment in EITHER direction over the whole token set, and that is
 * right for a restated block, where the narrator is relisting things it already listed and the
 * question is "which row did you mean". It is wrong for the inventory key, and the live ledger says
 * how wrong: a block that listed `phone` was absorbed onto `solomon's phone number`
 * (`FOLD-RPG-GAP.md` §4) because `{phone} ⊆ {solomon, phone, number}`. A handset and a string of
 * digits became one row, and the row's quantity then meant nothing.
 *
 * The narrowing is head-token identity plus non-contradicting qualifiers:
 *
 *   · the heads must be equal — `phone` ≠ `number`, so those two names stay apart;
 *   · the remaining tokens of one must contain the remaining tokens of the other — `m-65 jacket`
 *     and `m-65 military jacket` still merge (the measured case the containment rule exists for,
 *     `tests/fold-block-parse.test.js:339`), while `silver coin` and `gold coin` still do not.
 *
 * Rejected alternative: keeping `sameItem` and adding a stop-list of "contact-ish" head words
 * (number, address, handle). That fixes the one measured pair and nothing else, needs a new list
 * per language, and would still merge `phone` into `phone charger`. Head identity is the same fix
 * without the vocabulary.
 *
 * Known cost, accepted: the containment is still asymmetric for an empty qualifier set, so a bare
 * `coin` merges onto a held `silver coin`. That is the pre-existing behaviour of `sameItem` and the
 * measured defect was never in that direction — every duplication in the three live chats came from
 * a *longer* name absorbing a shorter one, not the reverse.
 *
 * @param {string} a One name.
 * @param {string} b Another.
 * @returns {boolean} True if they name one item.
 */
export function sameItemHead(a, b) {
    if (a === b) {
        return true;
    }
    const head = itemHead(a);
    if (!head || head !== itemHead(b)) {
        return false;
    }
    const left = identityTokens(a);
    const right = identityTokens(b);
    left.delete(head);
    right.delete(head);
    return [...left].every(token => right.has(token))
        || [...right].every(token => left.has(token));
}

/**
 * Verbs that make a fragment a statement rather than a continuation.
 *
 * Not a grammar — a list of the finite forms narrators actually reach for when writing a lead.
 * Being wrong about one costs a joined or split line, never data.
 */
const FINITE_VERB = new RegExp('\\b(is|are|was|were|has|have|had|remains?|stays?|keeps?|'
    + 'confirms?|confirmed|cited?|issued?|reports?|reported|says?|said|shows?|showed|'
    + 'appears?|appeared|seems?|seemed|stopped|stops?|closed?|opens?|opened|went|goes|gone|'
    + 'left|leaves?|came|comes?|will|would|may|might|can|could|should|must|refuses?|refused|'
    + 'suspended|missing|scheduled|expected|pending|due)\\b', 'i');

/**
 * Split a field value into the separate statements it actually contains.
 *
 * ── Why a plain comma split is wrong, and why not splitting is also wrong ──
 *
 * A card writes its leads as one comma-joined run:
 *
 *     Adele Ricci of the closed corner clinic is missing, Umbrella contractor access remains
 *     suspended pending review, Spencer Memorial is difficult to reach, with limited lines
 *
 * Three of those commas separate leads and one is a continuation. Splitting on all of them
 * produces fragments that are not leads; splitting on none produces a grey wall, which is what the
 * panel showed. The distinction the punctuation lost is recoverable from the fragments themselves:
 * a lead is a clause, and a clause has a finite verb. "with limited lines and restricted visitors"
 * has none, so it belongs to the sentence before it.
 *
 * Fields that are genuinely lists — "Ramen shop owner, older man in raincoat" — contain no finite
 * verb anywhere, so the rule would join everything into one. Hence the mode check: clause-joining
 * only applies to values that are made of clauses in the first place.
 *
 * @param {string} value A field value.
 * @returns {string[]} The statements, in order.
 */
/**
 * Characters beyond which a statement is long enough to need an expander.
 *
 * Lives here rather than in the panel so the calibration instrument can import it. A bound that
 * only exists inside a module importing `script.js` is a bound nothing can measure.
 *
 * Measured (`tests/util/fold-calibrate.mjs`, Raccoon City, n=323 statements): p50 19, p95 92,
 * max 137 — a short body with a long tail, which is the shape a clamp should serve. The threshold
 * is the p95, so the control appears only for the tail that genuinely runs past two lines. At 84 it
 * was appearing on statements most cards write normally.
 */
export const LONG_STATEMENT = 92;

/**
 * Split a field value into the separate statements it contains.
 * @param {string} value A field value.
 * @returns {string[]} The statements, in order.
 */
export function splitClauses(value) {
    const fragments = String(value ?? '')
        .split(/\s*[;,]\s+/)
        .map(part => part.trim())
        .filter(Boolean);

    if (fragments.length < 2) {
        return fragments;
    }

    // A value with no finite verb anywhere is a list of things, not a run of statements.
    if (!fragments.some(fragment => FINITE_VERB.test(fragment))) {
        return fragments;
    }

    const statements = [];
    for (const fragment of fragments) {
        if (statements.length && !FINITE_VERB.test(fragment)) {
            statements[statements.length - 1] += `, ${fragment}`;
        } else {
            statements.push(fragment);
        }
    }
    return statements;
}

/**
 * Extract condition phrases from a health field written as prose.
 *
 * ── DEMOTED in Phase D: legacy prose only, and no longer a judgement about English ──
 *
 * This used to be the primary way an affliction entered fold, and `FOLD-REDESIGN.md` §3 retires it
 * from that job. Marks now come from probes that were ASKED for one affliction per entry — the
 * delta's `st` array (`state.js` `deltaSchema`) and the scene probe's `conditions` array
 * (`scene.js`) — so the judgement "which half of this sentence is the wound" is made by something
 * that can read the sentence. What is left for this function is prose fold never asked for in mark
 * shape, and there are exactly two such callers: a card's own `Health:`/`Condition:` block
 * (`classifyBlock` below, via `absorb.js`) and the v1 → v2 migration of `state.context.conditions`
 * and `.health` (`migrate.js`, §9's read-time healing row).
 *
 * ── The split on "but" is gone, and that is the actual fix ──
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
 * vocabulary — so the panel carried the GOOD NEWS as a live flag for the rest of the session
 * (`FOLD-REDESIGN.md` §0.1-4, measured at message 72 of the live Solo Leveling chat, where it sat
 * beside `mild fatigue` and `bandaged`).
 *
 * That is not a missing word. It is the shape §11 bans with a standing measurement: an enumerated
 * judgement about English, which will be missing a word for as long as English has words. Adding
 * "functional" would fix the instance and leave the class — the next narrator writes "usable",
 * "not slowing him down", "he can still grip a sword".
 *
 * So a concessive clause is no longer a separator: *"bruised but functional"* is ONE phrase, kept
 * whole, and it is the phrase §3 names as the correct single mark. The affliction survives with its
 * qualifier attached, which is more information than the old split preserved and none of the risk.
 *
 * ── "and" went with it, and that one IS measured ──
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
 * cleaned` beside `bandaged`, and `calf scabbed` beside `rebandaged` — one wound filed twice, which
 * then consumed two of three consequence slots. The commas in the same lines separate correctly
 * every time. So the separator set is punctuation only: `,` and `;` are a list, and everything else
 * is one condition described in as many words as the narrator wanted. The counter-example the old
 * unit test asserted — "bleeding from the forearm and badly winded" — was invented for the test and
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
        .split(/[,;]/)
        .map(part => part.trim().toLowerCase().replace(/[.]+$/, ''))
        .filter(part => part && !isEmptyValue(part) && !isNegation(part));
}

/**
 * Is this clause saying a character is fine, rather than naming an affliction?
 *
 * Narrators habitually qualify: "mild hangover, otherwise uninjured". Splitting on the comma and
 * keeping both halves puts "otherwise uninjured" in the panel as though it were a wound.
 *
 * ── DEMOTED in Phase D, and the demotion is what makes the remaining list defensible ──
 *
 * `FOLD-REDESIGN.md` §11 bans enumerated judgements about English, naming this function as the
 * still-live sibling of the deleted movement-verb gate: it kept `functional` as a status flag
 * because the word was not on the list (§0.1-4). The list survives, and only because its job has
 * shrunk to something a list can do honestly:
 *
 *   · It no longer decides which HALF of a sentence to keep — `splitConditions` above no longer cuts
 *     sentences in half, so a missing word costs nothing. Every word it does not know now leaves the
 *     phrase intact rather than discarding the wound.
 *   · It no longer runs on what a probe answered. The probes are instructed to record the affliction
 *     and never the reassurance (`state.js` `deltaSchema`, `scene.js`); this runs on card prose and
 *     on v1 rows being migrated.
 *   · A false negative is one extra mark, visible on the panel, clearable by the review
 *     (`review-table.js`, the M-lines). A false positive drops a whole clause, which is why the
 *     vocabulary stays deliberately small and stays anchored: it matches whole words and only ones
 *     that assert the absence of harm outright.
 *
 * `validateStatus` (`state-table.js`) still consults it on the write path and `deriveState` on the
 * read path, and both are the same one-way service `stripDecoration` performs for old item names —
 * healing rows that were written before anything better existed.
 *
 * @param {string} part A condition clause.
 * @returns {boolean} True if it asserts the absence of harm.
 */
export function isNegation(part) {
    const text = String(part ?? '').trim().toLowerCase();
    // ── Reassurance is ANCHORED; clearance is not; and the asymmetry is the Phase D fix ──
    //
    // While `splitConditions` cut sentences in half, an unanchored reassurance test was harmless:
    // the affliction was already in its own fragment. It no longer cuts, so "winded but unhurt"
    // arrives whole — and an unanchored test would read the reassurance and throw away the wound
    // with it, which is the same bug as `functional` with the polarity reversed. A clause is
    // reassurance only when it is NOTHING BUT reassurance, so the test runs at the head, after the
    // function words a narrator puts in front of it.
    const head = text
        .replace(/^(?:but|though|otherwise|and|so|yet)\s+/, '')
        .replace(/^(?:he|she|they|it|i|you|is|are|was|were|am|feels?|looks?|seems?|remains?|stays?)\s+/, '')
        .replace(/^(?:still|now|all|quite|very|completely|fully|perfectly|mostly|generally|otherwise|entirely)\s+/, '');
    return /^(uninjured|unhurt|unharmed|fine|healthy|well|ok|okay|normal|intact|no injuries|nothing serious|no visible)\b/.test(head)
        // Full clearance, which is the *end* of a condition rather than a condition, and which is a
        // predicate ABOUT a named subject — "the hangover is gone" — so it is matched anywhere in
        // the clause rather than at its head. Deliberately excludes "eased", "better" and
        // "improving": those describe a condition that is still present, and treating them as
        // clearance would silently drop a real affliction. Known cost, named rather than hidden: a
        // clause that reports one wound and the end of another ("arm still bruised but the numbness
        // is gone") reads as clearance for the whole clause. Measured across four live chats: zero
        // occurrences; the review's M-lines are the recovery if one ever appears.
        || /\b(gone|cleared|resolved|healed|recovered|subsided|worn off|no longer)\b/.test(text)
        || /^(no|none|not|nothing)\b/.test(head);
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
            // Time, Location, Conditions, Leads and anything else a card invents: kept verbatim
            // so the injected block can carry them without fold needing to model them.
            context.set(label, value);
        }
    }

    return { items, conditions, context };
}
