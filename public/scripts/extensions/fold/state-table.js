/**
 * fold/state-table.js — the pure logic for tracked character state.
 *
 * Imports only pure siblings, so it runs in plain Node and is unit-testable.
 *
 * ── State is a FOLD OVER THE CHRONICLE, not a table beside it ──
 *
 * Both implementations this was ported from keep inventory as a parallel structure the model has
 * to remember to keep in sync. RPG Companion has the model restate the whole list each turn, so an
 * item it forgets to mention silently disappears. Scribe has the model propose a whole new state
 * and then trusts it — its `rejected` vector is never populated, and reconciliation ends with
 * `inventory = new.inventory.clone()` under a comment reading "Trust LLM output".
 *
 * Here there is no parallel structure. A chronicle event may carry a delta describing what it did
 * to the world, and the current state is a fold over the live events:
 *
 *     state = fold(liveEvents, empty, applyDelta)
 *
 * Four things fall out of that, none of which needed building:
 *
 *   · One source of truth. "What happened" and "what you have" cannot disagree.
 *   · Branch-awareness for free. Fold only events that are live on this swipe — the mechanism
 *     already built for retrieval — and swiping away a turn un-does its inventory changes.
 *   · An audit trail. Every quantity traces to the event that caused it.
 *   · Corrections propagate. Edit or delete an event and the state re-derives.
 *
 * Three merges do the folding:
 *
 *   inventory  norm(item)          merge_qty     Count      quantities add, floored at 0
 *   vitals     norm(name)          merge_vital   Count×Map  clamp(cur + dcur, 0, max)
 *   marks      who␀subject(flag)   merge_b       Map        last write wins, three slots per owner
 *
 * `marks` is the Map face and NOT the Set face, deliberately. `merge_nb` is `nu || old` — once
 * true, always true — and a wound has to be able to heal. Calling it a Set because it looks like a
 * set of flags would be exactly the decorative labelling this basis exists to avoid.
 *
 * The key gained its owner in Phase D (`FOLD-REDESIGN.md` §3). Before that the flag namespace was
 * flat and subjectless, so *"Lee gets raked across the ribs"* and *"Park's bandaged thigh re-opens"*
 * — two events, mid 30, both `{"flag":"bleeding","on":true}` — wrote one another's slot and the
 * panel showed the PLAYER bleeding for the rest of the session (`FOLD-RPG-GAP.md` §3). An event with
 * no `who` still folds, into the unowned bucket every consumer reads as the pov's; see `ownerKey`.
 *
 * ── Why DELTAS and not totals ──
 *
 * If the model hands back a complete inventory, your only options are to accept it wholesale or to
 * diff it and guess which differences were intentional. A delta is a proposition with a magnitude,
 * and a magnitude can be bounds-checked. The Count face is chosen because it is the representation
 * in which hallucination is *detectable*, not because counting is tidy. Validation happens once,
 * at write time (`validateInventory` and friends), so the fold itself stays a pure sum.
 */

import { isNegation, itemHead, sameItemHead } from './block-parse.js';
import { CLOCK_STALE_AFTER } from './clock.js';
// Marks are OWNED, and an owner is a cast row, so the two tables have to agree about what a name
// is. Importing the one normaliser rather than re-deriving a key here is the same discipline
// `itemHead` enforces for items: two definitions of "what is this called" is how a gate comes to
// refuse the very thing its window was about (Phase A's LANDED note). `entity-table.js` imports
// nothing but `lib/hash.js`, so this adds no cycle.
import { PERSON, normalizeEntityName, resolveEntity } from './entity-table.js';
import { fold, insert_with, lookup, merge_b, merge_graph, table_entries } from './lib/hash.js';

/**
 * Where an item is. Both reference implementations model this — RPG Companion has
 * onPerson/clothing/stored{location}/assets, Scribe has inventory/inventory_stored/assets — because
 * "everything you own is in your pockets" is wrong the moment a character has a home or a car.
 *
 * Here it is part of the key rather than a parallel structure, so the same merges do the work and
 * two crowbars in two places stay two entries.
 */
export const CARRIED = 'carried';

/**
 * ── Categories are places, and cost nothing ──
 *
 * A house, a starship and a knack for reading people are not "inventory", but they do not need a
 * separate system either: `itemKey(name, place)` is already a product type, and every stage of the
 * pipeline — `canonicalItemName`, `validateInventory`, `deriveState`, `renderState`, the panel —
 * already dispatches on the place half. So a category is just a reserved place, and the whole
 * inventory/assets/abilities divide arrives with no new table and no new merge.
 *
 * They differ from ordinary places in exactly one way, and it is the one that matters: `isFresh`
 * already exempts non-CARRIED keys from staleness, which is precisely the semantics that standing
 * property and permanent capabilities want. Nothing had to be built for that either.
 *
 * Deliberately NOT a category: equipment. Foundry VTT's dnd5e data model keeps ONE inventory list
 * with `equipped` as a flag on the item — a decade of iteration arriving at that specifically to
 * kill the desync two parallel lists guarantee. Worn things stay CARRIED.
 */
export const ASSETS = 'assets';
export const ABILITIES = 'abilities';

/**
 * Money, which is not an item and must not be bounded like one.
 *
 * A stack of crowbars caps at MAX_QTY because a four-digit crowbar count is a serialisation
 * accident. Money has no such property: a Korean campaign counts in won, a civilisation-scale one
 * counts a treasury, and 9,999 is an insulting ceiling for either. Measured on a live chat, a
 * character's funds rendered as `Won ×9999` under "Carrying" — wrong in the bound, wrong in the
 * pluralisation, and wrong in the section.
 */
export const MONEY = 'money';

/**
 * The place the model invents for contact details, kept only so it can be refused.
 *
 * Not a category and not a location: "Kang's phone number" is not a thing in a pocket, it is how
 * you reach a person, and the entity schema already carries that notion as prose
 * (`entity-table.js:411`). It reached inventory because `normalizePlace` accepts any word as a
 * place, so the event at mid 52 of the live Solo Leveling chat stored
 * `{"item":"kang's phone number","dq":1,"at":"contacts"}` against a schema that never offered it.
 * `validateInventory` refuses this place; the delta instruction says why in words the model reads.
 *
 * Named here rather than inlined at the check so the migration that moves the two existing rows
 * onto their people (`FOLD-REDESIGN.md` §9) has one string to look for.
 */
export const CONTACTS = 'contacts';

/**
 * How a model might spell that place. Same shape and same reason as `CATEGORY_WORDS` below: a
 * refusal that only matches one spelling is a refusal the next reply routes around.
 */
export const CONTACT_PLACE = /^(?:contacts?|contact list|phone ?book|address book)\b/;

/**
 * The model's many ways of saying "on the character". Worn and held things stay CARRIED — see the
 * note on Foundry above; two parallel lists for inventory and equipment guarantee a desync.
 */
const CARRIED_SYNONYMS = /^(carried|on person|inventory|self|worn|held|equipped|wearing)$/;

/** Places that are categories rather than locations. */
export const CATEGORIES = new Set([ASSETS, ABILITIES, MONEY]);

/**
 * How a model might name each category. Spelled out rather than stemmed, because the naive stem of
 * "abilities" is "abilitie" — and a category that silently fails to match becomes an ordinary place,
 * which is worse than not having categories at all.
 */
const CATEGORY_WORDS = new Map([
    [ASSETS, /^(assets?|property|holdings?|possessions?|estates?)\b/],
    [ABILITIES, /^(abilit(?:y|ies)|skills?|powers?|talents?|traits?|spells?)\b/],
    [MONEY, /^(money|currency|currencies|funds?|coins?|cash|wealth)\b/],
]);

/** Separator between place and item in an inventory key. Not typeable, so it cannot collide. */
const PLACE_SEP = ' ';

/**
 * Build an inventory key from a place and an item name.
 * @param {string} name Normalized item name.
 * @param {string} [place] Where it is; defaults to carried.
 * @returns {string} The table key.
 */
export function itemKey(name, place = CARRIED) {
    return `${normalizePlace(place)}${PLACE_SEP}${name}`;
}

/**
 * Split an inventory key back into place and name.
 * @param {string} key A table key.
 * @returns {{place: string, name: string}} The parts.
 */
export function splitItemKey(key) {
    const index = String(key ?? '').indexOf(PLACE_SEP);
    // Keys written before places existed are carried by definition.
    return index === -1
        ? { place: CARRIED, name: String(key ?? '') }
        : { place: key.slice(0, index), name: key.slice(index + 1) };
}

/**
 * Normalize a place label.
 * @param {string} raw Raw place.
 * @returns {string} Normalized place, or CARRIED.
 */
export function normalizePlace(raw) {
    const said = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, MAX_ITEM_NAME);
    // Synonyms are tested BEFORE the article strip, because "on person" begins with a preposition
    // and stripping it first leaves "person" — a place, and the wrong one.
    if (!said || CARRIED_SYNONYMS.test(said)) {
        return CARRIED;
    }
    const text = said.replace(/^(?:the|my|in|at|on)\s+/, '');
    if (!text) {
        return CARRIED;
    }
    // A category is never folded into CARRIED, however it was phrased — swallowing "assets" would
    // put a starship in your pockets.
    for (const [category, words] of CATEGORY_WORDS) {
        if (words.test(text)) {
            return category;
        }
    }
    return CARRIED_SYNONYMS.test(text) ? CARRIED : text;
}

/**
 * ── Bounds, measured ──
 *
 * These used to read "generous enough for real play, tight enough to bound the metadata blob",
 * which is prose standing where a number should be. Every one below is now stated against an
 * observation, in the style `whispering-tides/src/globe.slang` uses for its roughness exponent:
 * the configured value, the observed distribution, and what the data cannot answer.
 *
 * Instrument: `tests/util/fold-calibrate.mjs`, re-runnable against any chat file.
 * Corpus: "Raccoon City First Day", 2026-08-06 — 28 assistant turns, 18 state blocks, 20 events,
 * 11 distinct items. One card, one genre; a second corpus would sharpen every row here.
 */
export const MAX_ITEM_NAME = 64;        // observed max 23, p95 20 (n=36) — 2.8x headroom
export const MAX_ITEMS = 64;            // observed 11 distinct — 5.8x headroom
export const MAX_VITALS = 12;           // observed 0: this card reports health as prose, not levels
export const MAX_FLAGS = 32;            // observed 0 in the ledger; conditions arrived via the block
export const MAX_QTY = 9999;            // observed max 1 — a serialization guard, not a play limit

/**
 * Severity, as a word, because a mark is a phrase and not a point total.
 *
 * Fate's consequence ladder is mild / moderate / severe and Cortex's is a die size; the plan's keep
 * table took the words and refused the arithmetic, and `FOLD-REDESIGN.md` §1 extends the
 * phrase-over-number rule (`entity-table.js:71-88`, the disposition ladder) to marks explicitly:
 * "severity is a word (minor / moderate / severe), never a point total". `minor` rather than Fate's
 * `mild` only because `mild` is already a STATUS_MODIFIER below — a severity word that the subject
 * heuristic strips out of phrases would be two things at once.
 *
 * Ordered mildest first; `severityRank` is the only place the order becomes a number, and it exists
 * for two questions a word cannot answer on its own: which of three marks is the mildest, and what
 * the next step up is.
 */
export const MINOR = 'minor';
export const MODERATE = 'moderate';
export const SEVERE = 'severe';
export const SEVERITIES = [MINOR, MODERATE, SEVERE];

/**
 * Consequence slots per cast row.
 *
 * Three, from Fate's consequence slots (mild / moderate / severe, one of each), which is the
 * precedent `FOLD-REDESIGN.md` §3 names — "up to three consequence slots per cast row, each a phrase
 * plus a severity word (Fate/Cortex, per the plan's keep table)". What fold takes is the SLOT COUNT
 * and the escalation move; what it refuses is Fate's tiering (one slot per severity) and its
 * stress-track arithmetic, because fold has no dice to absorb and no shifts to spend.
 *
 * Why a bound at all, when `MAX_FLAGS = 32` already bounds the table: the bound is not about storage.
 * A body carrying nine simultaneous named afflictions is a panel nobody reads and an injection that
 * spends its budget describing bruises; three is the number that keeps "what is wrong with this
 * person" answerable at a glance. Measured on the live Solo Leveling ledger, the worst moment
 * (message 72, after the Nowon raid) carried five subjectless flags at once — `bandaged`,
 * `left arm heavily bruised`, `functional`, `mild fatigue`, `possible infection monitored` — of
 * which one was a reassurance, one a morphological duplicate and one an observation about a mark
 * rather than a mark. Three real ones, and the cap would have forced exactly that reading.
 */
export const MAX_MARKS = 3;

/**
 * The only real boundary on money.
 *
 * Not a play limit — there is no such thing. A trillionaire is a legitimate character, a national
 * treasury is a legitimate quantity, and any ceiling chosen for feeling roomy is a number that
 * eventually becomes a bug in somebody's campaign. The first attempt here was 1e12 for exactly that
 * bad reason.
 *
 * `Number.MAX_SAFE_INTEGER` is different in kind: past it, JavaScript integer arithmetic silently
 * stops being exact, so `a + b` quietly returns the wrong total. Clamping there is not a judgement
 * about how rich anyone may be — it is the point beyond which the fold could no longer add up
 * correctly, and a wrong total is worse than a refused one.
 */
export const MAX_MONEY = Number.MAX_SAFE_INTEGER;

/**
 * The ceiling for a given place.
 * @param {string} place A normalized place or category.
 * @returns {number} The largest quantity that place may hold.
 */
export function maxQty(place) {
    return place === MONEY ? MAX_MONEY : MAX_QTY;
}

/**
 * ── Why the magnitude bound is RELATIVE, and why an absolute one was a genre bug ──
 *
 * This was 20, then measured down to 6 against a corpus where every quantity change was ±1. That
 * retune was correct for the corpus and wrong for the user: the same tracker runs civilisation-scale
 * play — armies, fleets, treasuries — where "gained 10,000 troops" is an ordinary Tuesday and a cap
 * of 6 rejects the entire economy. An absolute bound on a quantity encodes a genre.
 *
 * What travels between genres is the RATIO. Ten thousand credits against two million is
 * unremarkable; ten thousand crowbars against one is a hallucination. So the bound is growth
 * against what is already held.
 *
 * And the first sighting cannot be bounded at all. With nothing held there is no prior, and a
 * legitimate first acquisition may be any size — one crowbar or a warehouse of them. Refusing to
 * bound it is the same discipline as "absence is not a retraction": no evidence, no verdict.
 *
 * What replaces the bound there is corroboration. A delta larger than the growth allowance is
 * accepted only if a number of that order actually appears in the narrative — the mention gate,
 * applied to the magnitude instead of the name. A model that invents "10,000" in a scene that never
 * says a number that big is doing the thing this rule exists to catch, at any scale.
 */
export const DELTA_GROWTH = 4;

/**
 * Growth allowance for a small holding, so ordinary play never trips the ratio.
 *
 * Measured max was 1 (n=20); at 8 the rule cannot fire on domestic play, and against a stack of a
 * thousand the ratio takes over long before this floor matters.
 */
export const MIN_DELTA_HEADROOM = 8;

/**
 * The largest change accepted for a given holding, before corroboration is required.
 * @param {number} held Current quantity.
 * @returns {number} The allowance.
 */
export function deltaAllowance(held, place) {
    const have = Number.isFinite(held) ? Math.max(0, held) : 0;
    // Nothing held is no prior, so nothing to bound against — the corroboration rule takes over.
    if (have === 0) {
        return maxQty(place);
    }
    // Money moves in amounts an item never does, and across scales an item never spans: a purse, a
    // payroll, a war chest. The ratio still governs — a thousandfold jump is still a hallucination
    // at any scale — but the floor is proportional too, so nothing is bounded by a number invented
    // for pockets.
    const floor = place === MONEY ? Math.max(MAX_QTY, have) : MIN_DELTA_HEADROOM;
    return Math.max(floor, have * DELTA_GROWTH);
}

/**
 * Does the narrative actually state a number of this order?
 *
 * The magnitude's own mention gate. Order-of-magnitude rather than exact, because a narrative
 * saying "about twelve thousand" and a delta of 10000 are the same claim, and demanding an exact
 * match would reject every rounded summary.
 *
 * @param {number} magnitude The proposed change.
 * @param {string} windowText The narrative window.
 * @returns {boolean} True if a number of comparable size appears.
 */
export function magnitudeCorroborated(magnitude, windowText) {
    const size = Math.abs(Number(magnitude) || 0);
    if (size <= MIN_DELTA_HEADROOM) {
        return true;
    }
    const digits = String(Math.floor(size)).length;
    // Strip the separators narrators write: "10,000" and "10 000" are one number.
    const text = String(windowText ?? '').replace(/(\d)[,\s](?=\d{3}\b)/g, '$1');
    for (const match of text.matchAll(/\b\d+\b/g)) {
        if (String(Number(match[0])).length >= digits - 1) {
            return true;
        }
    }
    // Scale words carry the order when the digits are spelled out.
    return /\b(hundreds?|thousands?|millions?|billions?|dozens?|scores?|legions?|fleets?)\b/i.test(text);
}

/**
 * Applied changes allowed per turn, before the rest are dropped.
 *
 * Measured: a block lists up to 6 items in one turn (n=18, max 6, p95 6). At 8 this had 1.3x
 * headroom over the observed maximum — the tightest margin of any bound here, and it drops changes
 * silently. Raised to 12, twice the observed maximum. `cap:rate-limited` in `/fold-calibrate` says
 * whether that was enough.
 *
 * It was not. Phase A's window replay reported the bound BINDING at an observed maximum of 13 in a
 * single turn of the live chat (`FOLD-REDESIGN.md` §10, "Findings carried out of Phase A"). Held to
 * the same house convention as the last retune — twice the observed maximum, so the bound has to be
 * wrong by a factor of two before it silently drops anything: 2 × 13 = 26.
 *
 * ── Re-measured here, because the two measurements disagree and the disagreement is informative ──
 *
 * Counted over all four live ledger copies (Solo Leveling, Evil Hero Party, Raccoon City, Nora),
 * the largest number of non-restated changes carried by any one stored delta is **6** (the Goblin
 * Market purchase, Solo Leveling mids 66 and 68), and the largest per-turn total across every event
 * sharing a message is **11**. Neither reaches 13 — because the stored ledger cannot contain what
 * the bound refused. A cap's own victims are exactly the rows missing from the file you measure it
 * against, so the live count is the tighter observation and the ledger count is the floor. 26 clears
 * both by more than a factor of two.
 *
 * ── And the counting itself was wrong, which is the larger half of this fix ──
 *
 * The check below reads `if (!restated && accepted.length >= budget)`: a restated total is exempt
 * from being refused, but it still INFLATES `accepted.length` and so consumes the budget of the
 * changes after it. The measured shape is not hypothetical — the message-72 reconciliation in Solo
 * Leveling is one `validateInventory` call carrying **30** inventory lines, all restatements, and
 * any genuine gain arriving after the twelfth would have been dropped as `rate-limited` for having
 * queued behind a list of totals that changed nothing. That is precisely the starvation the
 * paragraph beside the check already argues against ("would let a card with nine items starve its
 * own last item of refreshes forever"); the intent was right and only half-implemented. The budget
 * now counts changes, which is what it is named for.
 */
export const MAX_CHANGES_PER_TURN = 26;

/**
 * Block labels that name the health domain.
 *
 * ── A second copy of a list, named rather than papered over ──
 *
 * `block-parse.js` holds the authoritative set (its `HEALTH_LABELS`, private) and `classifyBlock`
 * already routes these into `conditions` for `validateStatus`. What it ALSO does is keep the raw
 * value as a context field, which is the "block fields that shadow structured tables are parked
 * rather than routed" defect `FOLD-REDESIGN.md` §5 names: the same affliction ends up as a status
 * flag AND as free-text context, and the context copy outranks narrative on trust for
 * CONTEXT_OVERRIDE_AFTER turns. `absorb.js` needs to know which labels those are in order to stop
 * parking them, and cannot import a private constant.
 *
 * Exporting it from `block-parse.js` would be the right fix and is not this phase's to make: that
 * file is Phase D's (its `isNegation` and `splitConditions` are being demoted to read-time healing)
 * and a shared export landing in both phases at once is a merge nobody can review. So the list is
 * duplicated here, deliberately, with a unit test that drives `classifyBlock` with every member and
 * fails the moment the two disagree — which is the only kind of duplication this codebase permits.
 */
export const HEALTH_LABELS = new Set(['health', 'condition', 'status', 'injuries', 'state']);

/**
 * Turns an unmentioned item survives before it stops being rendered.
 *
 * Measured: the gap between mentions of the same item is at most 8 turns (n=25, p50 1, p95 2), so
 * 12 clears the observed maximum by 1.5x.
 *
 * ⚠ The measurement only covers CARRIED items, and it cannot cover anything else: a card's block
 * lists what is on the character, so nothing ever re-mentions what is in your apartment. Applying
 * this threshold to a stored item is therefore unanchored *and wrong* — a crowbar in a locked flat
 * does not become uncertain because you spent twelve turns elsewhere. Named rather than papered
 * over; the fix is to scope staleness to presence, not to raise the number.
 */
export const STALE_THRESHOLD = 12;

/**
 * ── What the PROMPT is allowed to assert, as distinct from what the panel may show ──
 *
 * These are two products with one data source, and until now one stale string did both jobs. The
 * panel can afford to show a field with "(as of 9 exchanges ago)" beside it, because a reader
 * discounts it. The prompt cannot: `InsertEmission.the_insert_law` (`:322`) makes an insert a
 * *projection* rather than a boost once its influence exceeds half the margin, and a projection can
 * absorb the emission — so a stale assertion does not merely fail to inform the model, it overrides
 * what the model would otherwise have written. Stale state is corrosive, not inert.
 *
 * Hence three bands rather than two, which is `the_dispatch_law`'s shape again — decide at the
 * endpoints, take a third action in between:
 *
 *   fresh      assert it plainly; it is the present scene
 *   ageing     assert it WITH its age, which converts a claim into a question the narrator can
 *              answer — the repair that stopped fold freezing the clock at 1:03 PM
 *   stale      drop it; there is no warrant left, and an annotated falsehood is still an insert
 *
 * ⚠ Unmeasured. `CONTEXT_ANNOTATE_AFTER` is the threshold already in use for the age suffix.
 * `CONTEXT_DROP_AFTER` reuses STALE_THRESHOLD deliberately rather than inventing a second number:
 * it is the same question — "has this stopped being part of the present scene?" — and a duplicated
 * threshold is a second thing to retune. `cap:context-stale` counts every drop so the number can be
 * judged from play rather than defended from argument.
 */
export const CONTEXT_ANNOTATE_AFTER = 2;
export const CONTEXT_DROP_AFTER = STALE_THRESHOLD;

/**
 * How much warrant a context field still has.
 * @param {number} age Turns since the field was asserted.
 * @returns {'assert'|'annotate'|'drop'} What the prompt may do with it.
 */
export function contextBand(age) {
    const turns = Number.isFinite(age) ? Math.max(0, age) : 0;
    if (turns < CONTEXT_ANNOTATE_AFTER) {
        return 'assert';
    }
    return turns <= CONTEXT_DROP_AFTER ? 'annotate' : 'drop';
}
/** Longest duration a condition may claim, so one bad extraction cannot pin a flag on forever. */
export const MAX_CONDITION_TURNS = 60;

/**
 * Keys that would collide with object internals once a table is serialized to JSON.
 * Lifted from the reference extension, which hit this in the wild.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Names that assert there is nothing to name.
 *
 * Rejecting the bare word "none" was not enough. "None carried" reached the table as an item and
 * then gained a quantity as the narrator repeated the phrase, so the panel reported carrying two
 * of nothing. Same regex as block-parse's, applied at the other end of the pipe, because a name
 * can also arrive from the extraction model rather than from a card's block.
 */
const EMPTY_NAME = /^(none|nothing|nil|empty|no|n\/a|na|unknown|unspecified|undetermined)\b/;

/**
 * Modifiers and connectives that are not what a status phrase is *about*.
 *
 * Used only by `statusSubject`; getting an entry wrong costs a duplicated flag, never data.
 */
const STATUS_MODIFIERS = new Set([
    'mild', 'milder', 'slight', 'slightly', 'minor', 'moderate', 'severe', 'severely', 'bad',
    'badly', 'light', 'lightly', 'heavy', 'heavily', 'faint', 'faintly', 'deep', 'deeply',
    'mostly', 'partly', 'partially', 'fully', 'completely', 'somewhat', 'quite', 'very',
    'still', 'now', 'again', 'almost', 'nearly', 'barely', 'otherwise', 'generally',
    'being', 'feeling', 'feels', 'looks', 'seems', 'has', 'have', 'had', 'the', 'and', 'but',
    'from', 'with', 'left', 'right', 'both', 'own',
]);

/**
 * What a status phrase is ABOUT, as opposed to what it says.
 *
 * The whole phrase is the wrong key. Keyed that way, "mild hangover" and "hangover mostly eased"
 * are two independent facts, both true, both rendered — which is how a panel ends up reporting a
 * hangover, a mostly-eased hangover, and no injuries as three separate conditions. They are one
 * subject, described twice, and the second description supersedes the first.
 *
 * That is precisely what the Map face is for: `merge_b` is last-write-wins, and it does the right
 * thing the moment the key names the subject rather than the sentence. Keying on the sentence
 * turned a Map into an accumulating Set by accident.
 *
 * The heuristic is the first content word after modifiers are dropped. English condition phrases
 * either lead with a modifier ("mild hangover") or lead with the subject ("hangover mostly eased"),
 * so one rule covers both. Where it fails, the fallback is the full phrase and the old behaviour.
 *
 * @param {string} flag A status phrase, normalized.
 * @returns {string|null} The subject token, or null if the phrase has no content word.
 */
export function statusSubject(flag) {
    return [...contentTokens(flag)][0] ?? null;
}

/**
 * The content words of a status phrase, with modifiers removed.
 * @param {string} flag A status phrase.
 * @returns {Set<string>} The tokens that carry meaning.
 */
function contentTokens(flag) {
    return new Set(String(flag ?? '')
        .toLowerCase()
        .split(/[^a-z0-9']+/)
        .filter(token => token.length > 2 && !STATUS_MODIFIERS.has(token)));
}

/**
 * Shortest token length at which one word being a prefix of another means they are one word.
 *
 * See `sameSubject`. Five, and the number is the whole of the rule's safety: at four, "arms" and
 * "arm" is the same test as "wound" and "wounded" and the first is a plural, not an inflection worth
 * merging on.
 */
export const STEM_MIN = 5;

/**
 * Do two content words name the same thing?
 *
 * ── The morphology hole, measured, and the smallest structural rule that closes it ──
 *
 * `fatigued` and `mild fatigue` sat in the live Solo Leveling header as two live flags for one
 * condition (`FOLD-REDESIGN.md` §0.1-4). `contentTokens` has no morphology, so `statusKeyFor`'s
 * overlap test compared {fatigued} against {fatigue} and correctly found no shared member — two
 * facts, both true, both rendered, about one tired man.
 *
 * The tempting fix is a stemmer or a suffix list (`-ed`, `-ing`, `-s`), and it is the shape §11 bans
 * with a standing measurement: an enumerated judgement about English applied without the care the
 * enumeration implies. What is used instead is structural rather than lexical, the same licence
 * `isExposition` claims for its grammatical test: **English inflects at the END of a word**, so a
 * shorter content word that is a PREFIX of a longer one is the same word wearing an inflection.
 * No list of suffixes, no list of stems, no vocabulary to keep current.
 *
 * ── What it does on the real corpus ──
 *
 * Run over every `st` flag in all four live chats (n = 27 distinct across Solo Leveling 17, Raccoon
 * City 8, Evil Hero Party 2, Nora 0), the prefix branch fires on exactly ONE pair that the token
 * overlap does not already catch — `fatigued` / `mild fatigue` — and on nothing else. Zero false
 * positives, including the pairs it was most at risk of merging: `bandaged` / `rebandaged` (a prefix
 * in the wrong direction: an inflection lands on the end, so `re-` is correctly not seen),
 * `mild hangover` / `hangover mostly eased` (already merged by plain overlap), and
 * `mild arm fatigue` / `mild fatigue` (ditto).
 *
 * What it does not cover, stated rather than hidden: irregular morphology and synonymy. `bled` will
 * not merge with `bleeding`, and `winded` will never merge with `out of breath`. Those are the
 * review's identity question, which is where §3 puts near-duplicate marks on one owner in the first
 * place — this rule exists to stop the cheapest and commonest case from needing a question at all.
 *
 * @param {string} a One content token.
 * @param {string} b Another.
 * @returns {boolean} True if they are one word.
 */
function sameSubject(a, b) {
    if (a === b) {
        return true;
    }
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    return short.length >= STEM_MIN && long.startsWith(short);
}

/**
 * Which existing condition an incoming phrase is talking about.
 *
 * Word position alone cannot answer this. "Mild hangover" and "hangover mostly eased" share a
 * leading modifier and a trailing one respectively; "broken arm" and "arm healing" invert again.
 * Any rule of the form "take the Nth word" gets half of them right and silently duplicates the
 * rest, which is the bug this whole mechanism exists to kill.
 *
 * Overlap is the rule that survives all four: two phrases sharing a content word are about the
 * same thing. The first phrase's subject stays the key, so the identity of a condition is fixed by
 * how it was first described rather than drifting with each restatement.
 *
 * ── Scoped to one owner, which is the whole of Phase D in one line ──
 *
 * The table used to be a flat namespace with no subject, so Lee's ribs and Park's thigh both wrote
 * `bleeding` into the same slot and the panel showed the PLAYER bleeding for the rest of the session
 * (`FOLD-RPG-GAP.md` §3, the two mid-30 events). Overlap now only ever consults marks belonging to
 * the same person: `bruised` on Kang and `bruised` on Solomon are two marks, and `fatigued` and
 * `mild fatigue` on Solomon are one.
 *
 * @param {Map<string, object>} marks The marks table, keyed by `markKey`.
 * @param {string} flag An incoming phrase.
 * @param {string} [who] The owner key the phrase belongs to; '' is the unowned/pov bucket.
 * @returns {string} The key to write under.
 */
export function statusKeyFor(marks, flag, who = '') {
    const owner = ownerKey(who);
    const incoming = contentTokens(flag);
    for (const [key, value] of table_entries(marks)) {
        const parts = splitMarkKey(key);
        if (parts.who !== owner) {
            continue;
        }
        const existing = contentTokens(value?.phrase ?? parts.subject);
        for (const token of incoming) {
            for (const held of existing) {
                if (sameSubject(token, held)) {
                    return key;
                }
            }
        }
    }
    return markKey(owner, statusSubject(flag) ?? String(flag ?? ''));
}

/**
 * The owner half of a mark key: a name, normalised the way the cast table normalises names.
 *
 * '' is a real value and means "nobody said" — every `st` delta written before Phase D
 * (`FOLD-REDESIGN.md` §3) and every block-sourced condition whose chat has no point-of-view
 * character yet. Consumers read the empty bucket as the pov's, which is the read-time healing §9
 * specifies for subjectless deltas ("fold-time default `who = pov`, read-time healing, no rewrite").
 *
 * @param {string} who A name, as written.
 * @returns {string} The normalised owner key, or ''.
 */
export function ownerKey(who) {
    return normalizeEntityName(who)?.key ?? '';
}

/**
 * The key a mark is stored under: its owner and what it is about.
 *
 * Same NUL separator and same reason as `itemKey` and `entityKey` — a separator that cannot occur in
 * a name, so a key round-trips through JSON and back without a parser.
 *
 * @param {string} who Owner key, or '' for the unowned bucket.
 * @param {string} subject What the mark is about (`statusSubject`).
 * @returns {string} The table key.
 */
export function markKey(who, subject) {
    return `${ownerKey(who)}${PLACE_SEP}${String(subject ?? '')}`;
}

/**
 * Split a mark key back into its owner and subject.
 * @param {string} key A mark key.
 * @returns {{who: string, subject: string}} The parts.
 */
export function splitMarkKey(key) {
    const raw = String(key ?? '');
    const at = raw.indexOf(PLACE_SEP);
    // A key with no separator is a pre-Phase-D status key, which had no owner. Reading it as
    // subject-only puts it in the unowned bucket, which is where the healing rule wants it.
    return at < 0 ? { who: '', subject: raw } : { who: raw.slice(0, at), subject: raw.slice(at + 1) };
}

/**
 * Where a severity word sits on the ladder.
 * @param {string} word A severity word.
 * @returns {number} 0 for minor, 2 for severe; unknown words read as moderate.
 */
export function severityRank(word) {
    const at = SEVERITIES.indexOf(String(word ?? '').trim().toLowerCase());
    return at < 0 ? SEVERITIES.indexOf(MODERATE) : at;
}

/**
 * Normalise a proposed severity to the ladder.
 * @param {string} word Anything.
 * @returns {string} A severity word.
 */
export function normalizeSeverity(word) {
    return SEVERITIES[severityRank(word)];
}

/**
 * The marks one owner is currently carrying, mildest first.
 * @param {Map<string, object>} marks The marks table.
 * @param {string} who Owner key.
 * @returns {Array<[string, object]>} Live marks for that owner, mildest and oldest first.
 */
export function marksOf(marks, who) {
    const owner = ownerKey(who);
    return table_entries(marks)
        .filter(([key, value]) => value?.on && splitMarkKey(key).who === owner)
        .sort((a, b) => severityRank(a[1]?.severity) - severityRank(b[1]?.severity)
            || (a[1]?.t ?? 0) - (b[1]?.t ?? 0));
}

/**
 * The point-of-view character's live marks, worst first.
 *
 * The unowned bucket is his: every `st` delta written before Phase D had no subject at all, and §9's
 * migration row for those is read-time healing rather than a rewrite (see `ownerKey`). So this is
 * two buckets read as one, and it is the only place in the codebase that decides what "the player's
 * own wounds" means.
 *
 * @param {Map<string, object>} marks The marks table.
 * @param {string} who The pov's name.
 * @returns {Array<[string, object]>} Live pov marks, most severe first.
 */
export function povMarks(marks, who) {
    const mine = ownerKey(who);
    return [...marksOf(marks, ''), ...(mine ? marksOf(marks, mine) : [])]
        .sort((a, b) => severityRank(b[1]?.severity) - severityRank(a[1]?.severity));
}

/**
 * How hurt the point-of-view character is, weighted by severity.
 *
 * ── The subjectless count this replaces, and the weighting ──
 *
 * `verdict.js` read `state.snapshot().status.length` — a count of a flat, subjectless table — so the
 * ambush that wounded Lee and Park made SOLOMON two steps worse at everything for the rest of the
 * session (`FOLD-RPG-GAP.md` §3, `FOLD-REDESIGN.md` §3). It is now the pov's marks and nobody
 * else's, which is the whole point of putting a `who` on a state change.
 *
 * Severe counts 2 and everything else 1, and the coarseness is deliberate. `adjudicate` subtracts
 * this from a base of small integers (`verdict-table.js`), where momentum is ±1 and a disposition is
 * ±1, so a scale with more steps would make injury dominate every other term in the verdict — and
 * fold has no dice to argue back with. Two steps says the one thing a judge needs: whether what you
 * are carrying is an inconvenience or a reason you might not manage this. `minor` and `moderate` are
 * not distinguished HERE and are still distinguished everywhere else, because the difference is real
 * for a reader and below the resolution of this sum.
 *
 * The rejected alternative was severity-as-points (1/2/3, Fate-style shifts). It reads well and it
 * re-imports the arithmetic §1 spent the phrase-over-number rule getting rid of: three minor
 * scratches would then outweigh a severed hand.
 *
 * @param {Map<string, object>} marks The marks table.
 * @param {string} who The pov's name.
 * @returns {number} The weighted count.
 */
export function hurtOf(marks, who) {
    return povMarks(marks, who)
        .reduce((sum, [, mark]) => sum + (mark?.severity === SEVERE ? 2 : 1), 0);
}

/**
 * Is this owner out of consequence slots?
 * @param {Map<string, object>} marks The marks table.
 * @param {string} who Owner key.
 * @returns {boolean} True when a new mark would have to displace or escalate.
 */
export function marksFull(marks, who) {
    return marksOf(marks, who).length >= MAX_MARKS;
}

/**
 * Write one mark into the table, applying the consequence-slot rule when the owner is full.
 *
 * ── The fourth wound, and why nothing is ever simply dropped ──
 *
 * Fate's rule when the slot you need is taken is to **escalate** — take a bigger consequence — and
 * only when nothing is left are you taken out. Fold has no "taken out" band and no dice to absorb, so
 * it keeps the half of that rule that is about bookkeeping and refuses the half that is about
 * resolution. Concretely, when a fourth affliction arrives on a full row:
 *
 *   incoming ≥ mildest held   the mildest is displaced and the incoming takes its slot. The three
 *                             worst things wrong with a person are what "what is wrong with this
 *                             person" means; a graze superseded by a broken arm is not information
 *                             lost, it is information ranked.
 *   incoming < mildest held   the incoming does NOT get a slot — and the mildest held ESCALATES one
 *                             step. This is the branch that makes the cap honest rather than a
 *                             silent ceiling: a fourth hurt on a body already carrying three worse
 *                             ones is not nothing, and the only true thing to say about it is that
 *                             the person is now worse off than they were. It is exactly Fate's move
 *                             ("the slot is taken, so it costs you more"), with fold's arithmetic.
 *
 * The two rejected alternatives, recorded with what killed them:
 *
 *   · **Refuse the fourth mark** (the `flags-full` treatment inventory gets). Refusal is right for a
 *     bounded LIST — a 65th item is a proposal fold declines — and wrong for a body, because the
 *     narrative did not propose an item, it wounded someone. A refused wound is the retraction-by-
 *     silence this whole redesign exists to delete, wearing a counter.
 *   · **Raise the cap to whatever arrives.** That is the pre-Phase-D behaviour: `MAX_FLAGS = 32` per
 *     CHAT, no per-person bound, and the live header carrying five simultaneous conditions of which
 *     three were duplicates or reassurances. A ceiling nobody reaches is a ceiling that measures
 *     nothing.
 *
 * Both branches count `cap:marks-full` at the caller (`state.js` `validateDelta`), because a bound
 * that binds silently is a bound nobody can retune.
 *
 * @param {Map<string, object>} marks The marks table, MUTATED.
 * @param {string} key The key the incoming mark would take (`statusKeyFor`).
 * @param {object} value The incoming mark record.
 * @returns {{applied: string, displaced?: string}} What the rule did.
 */
export function placeMark(marks, key, value) {
    const { who } = splitMarkKey(key);
    // A restatement of a mark that already exists is not a fourth wound; last-write, no cap.
    if (marks.has(key) || !value?.on) {
        insert_with(marks, merge_b, key, value);
        return { applied: 'set' };
    }
    const held = marksOf(marks, who);
    if (held.length < MAX_MARKS) {
        insert_with(marks, merge_b, key, value);
        return { applied: 'add' };
    }
    const [mildestKey, mildest] = held[0];
    if (severityRank(value?.severity) >= severityRank(mildest?.severity)) {
        insert_with(marks, merge_b, mildestKey, { ...mildest, on: false, cleared: 'displaced' });
        insert_with(marks, merge_b, key, value);
        return { applied: 'replaced', displaced: mildestKey };
    }
    insert_with(marks, merge_b, mildestKey, {
        ...mildest,
        severity: SEVERITIES[Math.min(SEVERITIES.length - 1, severityRank(mildest?.severity) + 1)],
        // The phrase the narrative actually wrote is kept beside the one that escalated, because a
        // reader asking "why is this severe now?" is asking about the thing that arrived.
        worsened: String(value?.phrase ?? '').slice(0, MAX_ITEM_NAME),
    });
    return { applied: 'escalated', displaced: key };
}

/**
 * Strip the formatting models actually emit.
 * @param {string} raw Raw text.
 * @returns {string} Cleaned text.
 */
function stripDecoration(raw) {
    const text = String(raw ?? '')
        // Paired markdown first: stripping leading list markers earlier would eat the opening
        // `**` of `**Sword**` and leave the closing pair stranded.
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/~~(.+?)~~/g, '$1')
        .replace(/`(.+?)`/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/^[\s>*\-•]+/, '')
        .replace(/^\d+[.)]\s*/, '')
        .replace(/\s+/g, ' ')
        .trim();
    return trimWrapping(text);
}

/**
 * Remove decoration that WRAPS a name, without touching brackets that belong to it.
 *
 * Stripping every trailing bracket unconditionally turns "Thinkpad (closed)" into
 * "Thinkpad (closed" — a qualifier is not decoration, and the truncation is visible to the user.
 * So a pair only comes off when it encloses the whole string, and a stray closer only comes off
 * when nothing opened it.
 *
 * @param {string} input Cleaned text.
 * @returns {string} Text without wrapping decoration.
 */
function trimWrapping(input) {
    const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', '\'': '\'' };
    let text = input;

    // Peel wrapping pairs while the opener at the front is closed by the very last character and
    // nothing in between closes it early.
    let peeled = true;
    while (peeled && text.length > 1) {
        peeled = false;
        const closer = PAIRS[text[0]];
        if (closer && text.endsWith(closer) && enclosesWhole(text, text[0], closer)) {
            text = text.slice(1, -1).trim();
            peeled = true;
        }
    }

    // Now drop only unbalanced strays, e.g. a trailing ")" with no "(" anywhere.
    for (const [open, close] of Object.entries(PAIRS)) {
        if (open === close) continue;
        const opens = text.split(open).length - 1;
        let closes = text.split(close).length - 1;
        while (closes > opens && text.endsWith(close)) {
            text = text.slice(0, -1).trim();
            closes--;
        }
        // An opener with no closer is the truncation this function exists to prevent, arriving
        // from the other direction: names like "thinkpad (closed" are already in ledgers written
        // before the fix above, and state is a fold, so they fold forward forever. Dropping the
        // orphaned bracket heals them on read without discarding the qualifier it introduced.
        if (opens > closes) {
            text = text.split(open).join(' ').replace(/\s+/g, ' ').trim();
        }
    }

    return text.trim();
}

/**
 * Does the opening bracket at index 0 close only at the final character?
 * @param {string} text Text beginning with `open` and ending with `close`.
 * @param {string} open Opening character.
 * @param {string} close Closing character.
 * @returns {boolean} True if the pair wraps the whole string.
 */
function enclosesWhole(text, open, close) {
    if (open === close) {
        // Quotes: treat as wrapping if they appear only at the ends.
        return text.slice(1, -1).indexOf(open) === -1;
    }
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === open) depth++;
        else if (text[i] === close) {
            depth--;
            if (depth === 0) return i === text.length - 1;
        }
    }
    return false;
}

/**
 * Normalize an item name, pulling out any quantity the model baked into it.
 *
 * Models write "3x Healing Potion", "Healing Potion x3", and "2 gold coins" at least as often as
 * they fill in a separate quantity field. Parsing it out of the name means those turns produce a
 * correct delta instead of silently adding one of something.
 *
 * @param {string} raw Raw item name.
 * @returns {{name: string, qty: number|null}|null} Normalized name and embedded quantity, or null.
 */
export function normalizeItemName(raw) {
    let text = stripDecoration(raw).toLowerCase();
    if (!text) {
        return null;
    }

    let qty = null;

    // Leading "3x " / "3 × " / "3 "
    const leading = text.match(/^(\d{1,5})\s*(?:x|×)?\s+(.*)$/);
    if (leading) {
        qty = Number(leading[1]);
        text = leading[2].trim();
    } else {
        // Trailing " x3" / " ×3"
        const trailing = text.match(/^(.*?)\s*(?:x|×)\s*(\d{1,5})$/);
        if (trailing) {
            qty = Number(trailing[2]);
            text = trailing[1].trim();
        }
    }

    text = text.replace(/[.,;:]+$/, '').trim().slice(0, MAX_ITEM_NAME);

    if (!text || EMPTY_NAME.test(text) || UNSAFE_KEYS.has(text)) {
        return null;
    }

    return { name: text, qty: Number.isFinite(qty) && qty > 0 ? Math.min(qty, MAX_QTY) : null };
}

/**
 * Normalize a vital or flag name.
 * @param {string} raw Raw name.
 * @returns {string|null} Normalized name, or null if unusable.
 */
export function normalizeKey(raw) {
    const text = stripDecoration(raw).toLowerCase().replace(/[.,;:]+$/, '').trim().slice(0, MAX_ITEM_NAME);
    if (!text || EMPTY_NAME.test(text) || UNSAFE_KEYS.has(text)) {
        return null;
    }
    return text;
}

/** Count face: quantities add, floored at zero and capped. */
export const merge_qty = (nu, old) => ({
    qty: Math.max(0, Math.min(maxQty(nu?.at ?? old?.at), (old?.qty ?? 0) + (nu?.dq ?? 0))),
});

/**
 * Add a quantity delta to an inventory table.
 *
 * `insert_with` stores the incoming value verbatim when the key is absent and only calls the merge
 * on collision — so handing it `{dq}` would store `{dq}` for the first sighting of an item, with
 * no quantity at all. Seeding the key first means the merge runs every time and the stored shape
 * is always `{qty}`.
 *
 * ── The place is read off the KEY, and until Phase C it was not read at all ──
 *
 * `merge_qty` picks its ceiling with `maxQty(nu?.at ?? old?.at)`, and this function used to hand it
 * a bare `{dq}`: no `at` on the incoming value, and none on the stored one either, because the
 * stored shape is `{qty}`. So `maxQty(undefined)` returned MAX_QTY for EVERY dq-sourced change,
 * including money — a `{item: "won", dq: 360000, at: "money"}` delta clamped to 9,999 despite being
 * correctly tagged, and the pinned `Money:` line then lied about the balance for the rest of the
 * chat. Only `setQty` (the restated-total path) ever read the place, which is why the hand repair's
 * `{set: 210000, at: "money"}` landed and the raid payout at mid 46 of the live Solo Leveling chat
 * did not (`FOLD-RPG-GAP.md` §0, "money | won ×9,999 | ₩330,000"; the analysis is Phase A's LANDED
 * note in `FOLD-REDESIGN.md` §10).
 *
 * The key already carries the place — `itemKey` puts it there and `splitItemKey` takes it back —
 * so the ceiling is derivable rather than something the caller has to remember to pass. That is
 * the same argument `setQty` makes two functions below, applied to the path that was missing it.
 *
 * ⚠ It fixes the clamp, not the tagging. The event actually recorded at mid 46 reads
 * `{"item":"won","dq":360000}` with no `at` at all, so it keys as `carried␀won` and is still capped
 * at MAX_QTY — correctly, since a carried object is not a balance. Getting THAT delta into the
 * money place is the delta instruction's job (`state.js` `deltaInstruction`, "Money is at: money")
 * and the directed money question's, not a currency word list here — `FOLD-REDESIGN.md` §11 rules
 * those out with a standing measurement.
 *
 * @param {Map<string, {qty: number}>} table Inventory table, mutated.
 * @param {string} name Full inventory key — place and name, as `itemKey` builds it.
 * @param {number} dq Quantity change.
 * @returns {number} The resulting quantity.
 */
/**
 * The name an item is already known by in a given place, if it is known by a near variant.
 *
 * Applied at fold time so a chat that recorded "m-65 jacket" and later "m-65 military jacket"
 * renders one row rather than two, without needing the ledger rewritten.
 *
 * ── The match is head-token identity, not `sameItem`'s containment ──
 *
 * This used `sameItem` (`block-parse.js:285-296`), whose either-direction token subset merged a
 * block's `phone` into the ledger's `solomon's phone number` — one handset and one string of digits
 * counted as one row (`FOLD-RPG-GAP.md` §4). The merge for an inventory KEY has to be stricter than
 * the merge for a restated list, because this one decides what a quantity is a quantity *of*.
 * `sameItemHead` (`block-parse.js`) is the narrowed rule and carries the full argument; `sameItem`
 * is left alone for `resolveAlias` (`block-parse.js:262-272`), the restatement path, where the
 * looser reading is the correct one.
 *
 * @param {Map<string, {qty: number}>} inv Inventory table, place-keyed.
 * @param {string} name Normalized item name.
 * @param {string} [place] Raw place.
 * @returns {string} The canonical name to key under.
 */
export function canonicalItemName(inv, name, place) {
    const where = normalizePlace(place);
    if (inv.has(itemKey(name, where))) {
        return name;
    }
    for (const key of inv.keys()) {
        const parts = splitItemKey(key);
        if (parts.place === where && sameItemHead(parts.name, name)) {
            return parts.name;
        }
    }
    return name;
}

/**
 * Write an absolute quantity, the way a restated total means it.
 *
 * The Map face rather than the Count face, deliberately. A total is a last-write-wins assertion
 * about the present, so folding the same one twice has to be a no-op — which is exactly the
 * property the delta path cannot offer and exactly the property a repeated status block needs.
 *
 * @param {Map<string, {qty: number}>} table Inventory table, mutated.
 * @param {string} key Full inventory key.
 * @param {number} qty The stated quantity.
 * @returns {number} The change this represented, for the audit trail.
 */
export function setQty(table, key, qty) {
    const before = lookup(table, key, { qty: 0 }).qty;
    // The key carries the place, so the right ceiling is derivable rather than assumed.
    const after = Math.max(0, Math.min(maxQty(splitItemKey(key).place), Math.trunc(qty)));
    insert_with(table, merge_b, key, { qty: after });
    return after - before;
}

export function bumpQty(table, name, dq) {
    if (!table.has(name)) {
        table.set(name, { qty: 0 });
    }
    insert_with(table, merge_qty, name, { dq, at: splitItemKey(name).place });
    return lookup(table, name, { qty: 0 }).qty;
}

/**
 * Count × Map: `cur` accumulates and clamps, `max` is last-write.
 * The clamp rule is the reference implementation's, verbatim: clamp(cur + delta, 0, max).
 */
export const merge_vital = (nu, old) => {
    const max = Number.isFinite(nu?.max) ? nu.max : (old?.max ?? 100);
    const base = Number.isFinite(old?.cur) ? old.cur : max;
    return { max, cur: Math.max(0, Math.min(max, base + (nu?.dcur ?? 0))) };
};

/**
 * How a vital name should read on the panel and in the injected block.
 *
 * Vital names are stored lowercased for key stability (`normalizeKey`), so display casing is
 * applied here — the same division of labour the item names have (`stripDecoration` +
 * `sentenceCase`). Two shapes:
 *
 *   · A classic RPG initialism reads better all-caps. "hp" becomes "HP", not "Hp" — a vital bar
 *     labelled "Hp 0/70" reads as a typo.
 *   · Everything else is sentence-cased ("stamina" → "Stamina").
 *
 * This is a display table, not a judgement list: it never decides what the narrative means, it
 * only formats a key fold already chose, and any name outside the set falls back to sentence-case.
 * That is the boundary §11 draws (enumerated *judgements* are forbidden; formatting is not).
 */
const VITAL_INITIALISMS = new Set(['hp', 'mp', 'sp', 'pp', 'ap', 'tp']);
export function vitalLabel(name) {
    const key = String(name ?? '').toLowerCase();
    if (!key) {
        return '';
    }
    return VITAL_INITIALISMS.has(key) ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1);
}

/**
 * Does the narrative window actually talk about this thing?
 *
 * The strongest and cheapest rejection rule: a model cannot invent a state change for something
 * nobody mentioned.
 *
 * Matching is on the HEAD of the noun phrase, not on any token. Any-token matching is too permissive
 * in exactly the way that matters: a model can smuggle an invented item past the gate by reusing one
 * word from the scene, so "dragon egg" sails through a narrative that only ever mentioned a "Dragon
 * Keep". Head matching still keeps the leniency that motivated it, because "healing potion (minor)"
 * heads on "potion" and matches a narrative that just says potion.
 *
 * The head is `itemHead`'s (`block-parse.js`), which is where that notion now lives because the
 * inventory merge needs the same one. This module used to compute it inline as "the last significant
 * token", and the two definitions disagreeing is not hypothetical: the live ledger holds
 * `rusty hunter's knife with sheath`, which heads on `sheath` under the inline rule and therefore
 * fails a window that says "reaching weakly for the knife in its belt" — a gate refusing the item
 * the narrative is visibly about. `itemHead` truncates at the preposition, so both agree on `knife`.
 *
 * @param {string} name Normalized name.
 * @param {string} windowText The narrative window, lowercased by this function.
 * @returns {boolean} True if mentioned.
 */
export function isMentioned(name, windowText) {
    const haystack = String(windowText ?? '').toLowerCase();
    const needle = String(name ?? '').toLowerCase().trim();
    if (!haystack || !needle) {
        return false;
    }
    if (haystack.includes(needle)) {
        return true;
    }
    const head = itemHead(needle);
    // Short names ("axe", "hp") have no token long enough to be discriminating, so the whole-string
    // check above is all they get.
    return head.length > 2 ? haystack.includes(head) : false;
}

/**
 * Validate proposed inventory deltas against the narrative and the current state.
 *
 * Runs once, when an event is recorded — not on every fold. Rejected deltas never reach the
 * ledger, so the fold is a pure sum over changes that were already justified.
 *
 * ── `already-recorded`: the gate that closes the double-billing loop ──
 *
 * The window split (`extract-table.js`) stops the model being *shown* an old beat as if it were
 * new; this stops it *billing* one that leaked through anyway, because the narration in the new
 * half re-tells it. Both were needed, and the live ledger says why: the phone-number exchange is in
 * it three times (events at mids 50, 52 and 54), the candies twice (54 and 58), the goblin knife
 * twice (22 and 38), and the staff-and-shortsword purchase three times (60, 66, 68). Every one of
 * those is one thing that happened once.
 *
 * The rule, and every condition in it is load-bearing:
 *
 *   1. `shown` is a Set of the inventory keys the pinned ledger actually put in front of the model
 *      this pass. Not "everything held" — the ledger drops stale carried items (`isFresh`,
 *      `state-table.js:1157-1173`), and refusing a delta for a line the model was never told about
 *      would punish it for our own omission. A null `shown` turns the gate off entirely, which is
 *      what happens on any path that does not pin the ledger (block absorption, `absorb.js:114`).
 *   2. Positive `dq` only. A loss is never a restatement — nobody re-narrates dropping something.
 *   3. Not a restated total (`set`). Those are the Map face and idempotent by construction; that is
 *      the whole argument in `setQty` below.
 *   4. The key is already held at `qty >= dq`. Gaining three of something you have one of is not a
 *      re-report of the one; it is refused only when the ledger already covers the whole proposal.
 *   5. Money was exempt, and that exemption is GONE for the trail check below. The exemption rested
 *      on "never a duplicated credit — observed" (`FOLD-REDESIGN.md` §5). The live Solo Leveling chat
 *      falsified it: the Eunpyeong ₩680,000 raid payout was credited twice, at mids 128 and 142, by
 *      two extraction passes re-telling one deposit. `shown` still gates nothing for money (a
 *      balance is not evidence about a payment), but the contributor trail is — see below.
 *
 * ── The contributor trail closes what `shown` cannot ──
 *
 * The shown-based gate above only fires when THIS pass's pinned ledger showed the line. A re-record
 * leaks through when the model re-tells an old beat in a later window whose ledger happened not to
 * carry the line — the goblin knife (22 and 38), the phone numbers (50 and 54), the ₩680,000
 * payout (128 and 142) are all that shape. The trail (`deriveState` builds it, keyed by item key)
 * is the full history, and an EXACT `dq` match against it is arithmetic on fold's own recorded
 * numbers — not the similarity metric §11 refuses, which is about reading the narrative. One thing
 * that happened once and is billed twice is refused here whether or not it was shown this pass.
 *
 * ── What this refuses that it should not ──
 *
 * Buying a second identical knife while carrying the first. Nothing in a `{item, dq, at}` delta
 * distinguishes that from re-reporting the first knife: same name, same place, same magnitude. The
 * choice is which error to make, and the ledger settles it — duplication happened at least eight
 * times in one 63-message chat, a genuine same-name re-acquisition never once. The cost is bounded
 * and visible: the refusal is counted as `reject:already-recorded` and the user can add the second
 * knife by hand (`state.adjustItem`), which records it as the user event it is. The same trade
 * now applies to money: two genuinely identical credits in one story are refused unless the user
 * adds the second by hand.
 *
 * @param {object} params Parameters.
 * @param {Map<string, {qty: number}>} params.inv Inventory as currently derived.
 * @param {Array<{item: string, dq: number}>} params.deltas Proposed changes.
 * @param {string} params.windowText Narrative window, for the mention gate.
 * @param {number} [params.budget] Accepted changes allowed.
 * @param {Set<string>|null} [params.shown] Inventory keys the pinned ledger showed the model this
 *   pass; null when no ledger was pinned, which disables the already-recorded gate.
 * @param {Map<string, Array<{dq: number}>>} [params.contributors] The contributor trail per item
 *   key, for cross-window re-record refusal. Null disables the trail check.
 * @returns {{accepted: Array<{item: string, dq: number}>, rejected: object[]}} Outcome.
 */
export function validateInventory({ inv, deltas, windowText, budget = MAX_CHANGES_PER_TURN, shown = null, contributors = null }) {
    const accepted = [];
    const rejected = [];
    const projected = new Map(inv);
    // Counted apart from `accepted` because a restated total is not a change: see the
    // MAX_CHANGES_PER_TURN docblock for the measured starvation that shared counting caused.
    let changes = 0;

    for (const raw of Array.isArray(deltas) ? deltas : []) {
        const parsed = normalizeItemName(raw?.item);
        if (!parsed) {
            rejected.push({ item: String(raw?.item ?? ''), reason: 'unusable-name' });
            continue;
        }

        const { name } = parsed;
        let place = normalizePlace(raw?.at);
        // ── Precedent: an item already tracked as money stays money when the tag is missing ──
        //
        // The mid-46 event of the live Solo Leveling chat — `{"item":"won","dq":360000}` with no
        // `at` — keyed as carried and `merge_qty` clamped it to 9,999, so the panel read a false
        // balance while the real one went unrecorded. Reading the item NAME to guess "won is
        // currency" would be the enumerated word list §11 forbids ("reading the narrative is never
        // fold's job"). This does not read the name. It reads fold's OWN state: once a `money␀won`
        // row exists, an untagged delta for "won" joins it — precedent is the oracle, the same
        // authority the adjudicator and the review use. The first payout is the only one a repair or
        // the directed-money question touches; every payout after lands right. The `troops x10000`
        // case is untouched, because troops is not an existing money row — civilisation scale still
        // passes its gate on the strength of the narrative, not of a place guess.
        if (!String(raw?.at ?? '').trim() && place === CARRIED
            && lookup(projected, itemKey(name, MONEY), null)) {
            place = MONEY;
        }
        // ── Contact details are not things in a pocket ──
        //
        // Checked before every other rule because it is a stronger statement than any of them: the
        // others say this change is unsupported, this one says the thing is not inventory at all,
        // and the counter should say so rather than reporting whichever gate happened to fire
        // first. The model invented this place — the event at mid 52 of the live Solo Leveling chat
        // proposed `{"item":"kang's phone number","dq":1,"at":"contacts"}`, and nothing in the
        // schema ever offered it (`state.js` `deltaSchema`, the `at` description). Contact details
        // become `reach` on the person's row in a later phase; until then not-an-item is the honest
        // answer, and a silently accepted `contacts` row is not.
        if (CONTACT_PLACE.test(place)) {
            rejected.push({ item: name, reason: 'not-an-item' });
            continue;
        }
        // An absolute quantity from a restated block. Bounds-checked like everything else, but it
        // is not a magnitude of change, so the delta cap below does not apply to it.
        const restated = Number.isFinite(raw?.set);
        // A quantity baked into the name ("3x potion") wins only when no explicit delta was given.
        const dq = Number.isFinite(raw?.dq) && raw.dq !== 0 ? Math.trunc(raw.dq) : (parsed.qty ?? 0);

        if (!restated && !dq) {
            rejected.push({ item: name, reason: 'no-change' });
            continue;
        }
        // The rate limit bounds how much a single turn may CHANGE. A restated total is not a
        // change proposal — it is the same list you already have, re-read — so counting it here
        // would let a card with nine items starve its own last item of refreshes forever.
        if (!restated && changes >= budget) {
            rejected.push({ item: name, reason: 'rate-limited' });
            continue;
        }
        // The strongest and cheapest rule: a model cannot invent a change to something the
        // excerpt never mentions.
        if (!isMentioned(name, windowText)) {
            rejected.push({ item: name, reason: 'not-mentioned' });
            continue;
        }
        const canonical = canonicalItemName(projected, name, place);
        const key = itemKey(canonical, place);
        const held = lookup(projected, key, null);
        // See the docblock: only a positive delta, only against a line the model was actually
        // shown, only when the ledger already covers the whole proposal, and never for money.
        if (shown && dq > 0 && !restated && place !== MONEY && shown.has(key) && (held?.qty ?? 0) >= dq) {
            rejected.push({ item: canonical, reason: 'already-recorded' });
            continue;
        }
        // ── The contributor trail closes what `shown` cannot ──
        //
        // The gate above only fires when THIS pass's ledger showed the line. A re-record slips
        // through when the model re-tells an old beat in a later window — the goblin knife (22 and
        // 38), the phone numbers (50 and 54), and the Eunpyeong ₩680,000 payout (128 and 142) all
        // did. The trail is the full history fold already stores, keyed by item key; an EXACT `dq`
        // match against it is arithmetic on fold's own numbers, not the narrative-similarity metric
        // §11 refuses. Money is deliberately NOT exempt here — the "never a duplicated credit"
        // observation the old exemption rested on was falsified by that ₩680,000 pair.
        if (dq > 0 && !restated && (held?.qty ?? 0) >= dq
            && contributors?.has(key)
            && contributors.get(key).some(c => Number(c.dq) === dq)) {
            rejected.push({ item: canonical, reason: 'already-recorded' });
            continue;
        }
        if (!held && !restated && dq < 0) {
            rejected.push({ item: canonical, reason: 'remove-unknown' });
            continue;
        }
        if (!held && projected.size >= MAX_ITEMS) {
            rejected.push({ item: canonical, reason: 'inventory-full' });
            continue;
        }

        // Growth against what is held, then corroboration for anything past it. See DELTA_GROWTH.
        if (!restated && Math.abs(dq) > deltaAllowance(held?.qty ?? 0, place)
            && !magnitudeCorroborated(dq, windowText)) {
            rejected.push({ item: canonical, reason: 'implausible-delta' });
            continue;
        }

        if (restated) {
            const total = Math.max(0, Math.min(maxQty(place), Math.trunc(raw.set)));
            setQty(projected, key, total);
            accepted.push(place === CARRIED
                ? { item: canonical, set: total }
                : { item: canonical, set: total, at: place });
            continue;
        }

        // Underflow clamps rather than rejects: our count may simply be behind, and the narrative
        // is the more trustworthy source about what just happened.
        if ((held?.qty ?? 0) + dq < 0) {
            rejected.push({ item: canonical, reason: 'clamped-underflow' });
        }

        bumpQty(projected, key, dq);
        changes++;
        accepted.push(place === CARRIED ? { item: canonical, dq } : { item: canonical, dq, at: place });
    }

    return { accepted, rejected };
}

/**
 * Validate proposed vital changes.
 * @param {object} params Parameters.
 * @param {Map<string, {cur: number, max: number}>} params.vitals Vitals as currently derived.
 * @param {Array<{name: string, dcur?: number, max?: number}>} params.deltas Proposed changes.
 * @param {string} params.windowText Narrative window.
 * @returns {{accepted: object[], rejected: object[]}} Outcome.
 */
export function validateVitals({ vitals, deltas, windowText }) {
    const accepted = [];
    const rejected = [];

    for (const raw of Array.isArray(deltas) ? deltas : []) {
        const name = normalizeKey(raw?.name);
        if (!name) {
            rejected.push({ item: String(raw?.name ?? ''), reason: 'unusable-name' });
            continue;
        }
        if (!isMentioned(name, windowText)) {
            rejected.push({ item: name, reason: 'not-mentioned' });
            continue;
        }

        const held = lookup(vitals, name, null);
        if (!held && vitals.size + accepted.length >= MAX_VITALS) {
            rejected.push({ item: name, reason: 'vitals-full' });
            continue;
        }
        // A max that moves by more than half in one turn is a hallucination, not a level-up.
        if (held && Number.isFinite(raw?.max) && Math.abs(raw.max - held.max) > held.max * 0.5) {
            rejected.push({ item: name, reason: 'implausible-max' });
            continue;
        }

        const entry = { name, dcur: Number.isFinite(raw?.dcur) ? raw.dcur : 0 };
        if (Number.isFinite(raw?.max)) {
            entry.max = raw.max;
        }
        if (!entry.dcur && entry.max === undefined) {
            rejected.push({ item: name, reason: 'no-change' });
            continue;
        }
        accepted.push(entry);
    }

    return { accepted, rejected };
}

/**
 * Validate proposed mark changes.
 *
 * ── `who` is resolved HERE, at write time, and stored on the event ──
 *
 * The alternative — store whatever the model wrote and resolve on read — was rejected: a cast row
 * can be merged, renamed or pruned between the turn that wounded someone and the turn that reads the
 * ledger back, and a name that resolved to nobody at read time would silently move a wound onto the
 * player (which is the pre-Phase-D bug, `FOLD-RPG-GAP.md` §3). Resolving at write time means the
 * event says whose it was, permanently, and the fold cannot change its mind. The stored form is the
 * cast row's DISPLAY name rather than its table key, so a later merge — which accumulates the loser's
 * name into the keeper's `aka` (`entity-table.js` `mergeEntities`) — leaves the mark findable by the
 * one-hop alias resolution every other consumer uses.
 *
 * An empty `who` is the pov, and is never rejected: a chat whose point of view has not been
 * established yet still has a body to wound, and refusing the mark would trade a misattributed
 * consequence for no consequence at all. A NAMED owner that matches no cast row is rejected
 * (`reject:unknown-owner`) — an invented owner is worse than none, because it opens a row-shaped
 * hole nothing will ever close.
 *
 * @param {object} params Parameters.
 * @param {Map<string, object>} params.status Marks as currently derived.
 * @param {Array<{who?: string, flag: string, on: boolean}>} params.deltas Proposed changes.
 * @param {string} params.windowText Narrative window.
 * @param {Map<string, object>|null} [params.cast] The cast table, for resolving `who`.
 * @param {string} [params.pov] The point-of-view character's name, for the empty-`who` default.
 * @returns {{accepted: object[], rejected: object[], capped: number}} Outcome.
 */
export function validateStatus({ status, deltas, windowText, cast = null, pov = '' }) {
    const accepted = [];
    const rejected = [];
    let capped = 0;

    for (const raw of Array.isArray(deltas) ? deltas : []) {
        const flag = normalizeKey(raw?.flag);
        if (!flag) {
            rejected.push({ item: String(raw?.flag ?? ''), reason: 'unusable-name' });
            continue;
        }
        if (!isMentioned(flag, windowText)) {
            rejected.push({ item: flag, reason: 'not-mentioned' });
            continue;
        }

        const owner = resolveOwner(raw?.who, { cast, pov });
        if (!owner.ok) {
            // Named somebody fold has never heard of. Counted with the name it invented, so the
            // report says which name rather than only how often.
            rejected.push({ item: String(raw?.who ?? '').slice(0, MAX_ITEM_NAME), reason: 'unknown-owner' });
            continue;
        }

        const subject = statusKeyFor(status, flag, owner.key);

        // "Otherwise uninjured" is not a condition, it is the absence of one. The block path
        // already drops these; the extraction path did not, which is how a reassurance ended up
        // listed beside a real affliction. When it names something already tracked it clears that
        // flag — "the hangover is gone" is information — and otherwise there is nothing to record.
        if (isNegation(flag)) {
            if (!status.has(subject)) {
                rejected.push({ item: flag, reason: 'negation' });
                continue;
            }
            accepted.push({ who: owner.name, flag, on: false });
            continue;
        }

        if (!status.has(subject) && status.size + accepted.length >= MAX_FLAGS) {
            rejected.push({ item: flag, reason: 'flags-full' });
            continue;
        }
        // The per-owner slot bound is not a refusal — `placeMark` owns what actually happens to the
        // fourth wound, and it never drops it. This is only the count, taken where a pass can be
        // measured rather than in the fold, which re-runs on every render and would report the same
        // displacement forever.
        if (!status.has(subject) && !!raw?.on && marksFull(status, owner.key)) {
            capped++;
        }

        // A duration is a claim like any other and gets bounded like one. Zero means indefinite,
        // which is also what an absent or nonsensical value degrades to — a condition that stays
        // until the narrative clears it is the safe failure, not one that silently expires.
        const turns = Number(raw?.turns);
        accepted.push({
            who: owner.name,
            flag,
            on: !!raw?.on,
            severity: normalizeSeverity(raw?.severity),
            turns: Number.isFinite(turns) && turns > 0 ? Math.min(Math.trunc(turns), MAX_CONDITION_TURNS) : 0,
        });
    }

    return { accepted, rejected, capped };
}

/**
 * Who a proposed mark belongs to.
 *
 * @param {string} raw The `who` the model wrote, possibly empty.
 * @param {object} context Context.
 * @param {Map<string, object>|null} context.cast The cast table, or null when the caller has none.
 * @param {string} context.pov The point-of-view character's name.
 * @returns {{ok: boolean, key: string, name: string}} The resolved owner.
 */
function resolveOwner(raw, { cast, pov }) {
    const said = String(raw ?? '').trim();
    if (!said) {
        // The default the panel already applied silently (`FOLD-REDESIGN.md` §3); it is now written
        // down on the event instead of assumed by whoever reads it.
        return { ok: true, key: ownerKey(pov), name: String(pov ?? '').trim() };
    }
    // The pov is frequently not a cast row of his own — `renderEntities` and the panel both exclude
    // him from the list he is the centre of, and a chat can name him from the scene probe before the
    // cast probe has ever placed him. So he is matched before the table is consulted.
    if (ownerKey(said) === ownerKey(pov) && pov) {
        return { ok: true, key: ownerKey(pov), name: String(pov).trim() };
    }
    if (!cast) {
        // No table to check against — the absorb path and the unit fixtures. Taking the name as
        // written is the honest degradation: the alternative is refusing every mark in a caller that
        // has no way to be right.
        return { ok: true, key: ownerKey(said), name: said.slice(0, MAX_ITEM_NAME) };
    }
    const found = resolveEntity(cast, PERSON, said);
    return found
        ? { ok: true, key: ownerKey(found.entity?.name ?? said), name: String(found.entity?.name ?? said) }
        : { ok: false, key: '', name: '' };
}

/**
 * Derive current state by folding the deltas carried by a sequence of events.
 *
 * This is the whole state model. Pass only the events that are live on the current branch and
 * swipe-awareness is automatic; pass them in chronological order and the arithmetic is the same
 * arithmetic the narrative described, in the order it described it.
 *
 * `since` counts how many events have passed since each item was last touched — staleness,
 * derived rather than stored, because it is a function of the ledger and nothing else.
 *
 * ── Marks are derived here and stored nowhere, which is the swipe argument in one sentence ──
 *
 * `FOLD-REDESIGN.md` §3 gives cast rows `marks`, and a cast row is a STORED table — so the obvious
 * reading is a `marks` field on the row, written by the probe. Phase C faced the same choice for
 * thread closures and recorded three options with the swipe scenario that decided it
 * (`thread-table.js` `overlayClosures`); marks land on the other side of that same argument, and
 * more cheaply:
 *
 *   1. **Store marks on the cast row.** A swipe that removes the turn in which someone was wounded
 *      leaves the wound on the row, with nothing anywhere saying why — the failure mode
 *      `overlayClosures` rejects, and worse here, because a mark changes what the adjudicator does
 *      (`verdict.js` `standing.hurt`) on every subsequent roll.
 *   2. **Store the row, overlay from the ledger** — Phase C's shape for threads.
 *   3. **Owned `st` events, folded; no stored field at all.** Chosen. A wound is not a standing fact
 *      a turn revealed (which is what a thread's `about` is, and why threads are stored); it is the
 *      RESULT OF AN EVENT, which is the exact thing this ledger exists to hold. `st` deltas already
 *      fold here, already carry `turns`, already tick, and already vanish when their event does. All
 *      Phase D adds is `who`.
 *
 * The swipe scenario, spelled out for this shape: mid 30 wounds Lee; the pass records
 * `{who: 'Lee', flag: 'bleeding', on: true}` on an event whose liveness key is that message's
 * content key. Lee's row shows the mark. The user swipes message 30; SillyTavern replaces the text;
 * `liveEvents()` no longer contains the event; this fold never sees it; Lee is unhurt. No overlay, no
 * stored field to reconcile, no third state. The one thing the ledger cannot hold is a mark that
 * predates the ledger — `state.context.conditions` from a v1 chat — and that is precisely what
 * migration seeds onto the stored row (`migrate.js`), which is the only writer of `cast[key].marks`
 * and is read exactly once, by `seedMarks` below.
 *
 * @param {Array<{t?: number, d?: object}>} events Events, live ones only.
 * @param {object} [options] Options.
 * @param {Array<object>} [options.seeds] Pre-ledger marks from migration, folded before the events.
 * @returns {{inv: Map, vitals: Map, marks: Map, since: Map, contributors: Map}} Derived state.
 */
export function deriveState(events, { seeds = [] } = {}) {
    const ordered = [...(events ?? [])].sort((a, b) => (a?.t ?? 0) - (b?.t ?? 0));
    const inv = new Map();
    const vitals = new Map();
    const status = seedMarks(seeds);
    const lastTouch = new Map();
    const statusTouch = new Map();
    /** @type {Map<string, Array<{at: number, dq: number, summary: string}>>} */
    const contributors = new Map();

    ordered.forEach((event, index) => {
        const delta = event?.d;
        if (!delta) {
            return;
        }

        for (const change of delta.inv ?? []) {
            // Normalized again on READ, not only on write. Names are cleaned before an event is
            // recorded, but state is a fold: an event written under an older, buggier normalizer
            // keeps folding forward under that name forever. Re-normalizing here means a fix to
            // `stripDecoration` heals existing chats instead of only helping new ones, and it is
            // a no-op for anything already clean.
            const parsed = normalizeItemName(change?.item)?.name ?? '';
            if (!parsed) continue;

            // ── Contact rows are `reach` now, and this is the read rule that finishes the move ──
            //
            // `validateInventory` refuses the `contacts` place at WRITE time (`reject:not-an-item`,
            // above), and Phase B's migration copied the two existing rows onto the Kang and Jin-Woo
            // cast rows as `reach`. Neither of those touches the ledger — state is a fold, and an
            // event is the record of what happened — so the events at mids 50–54 of the live Solo
            // Leveling chat keep folding two phone numbers back into the derived inventory forever.
            // That is the residual Phase B's replay printed and declined to fix in its own file
            // (`FOLD-REDESIGN.md` §10, LANDED deviation 7).
            //
            // Read-time, deliberately, and the same discipline as re-normalising names two lines
            // down: rewriting the ledger to delete the rows would destroy the evidence that the
            // numbers were ever exchanged, and a chat rolled back to a build without this rule
            // would silently lose them. A read rule heals every existing chat and is reversible.
            if (CONTACT_PLACE.test(normalizePlace(change?.at))) continue;

            // Place is part of the key, so a crowbar in the boot and a crowbar in your hand are
            // two entries and moving one does not silently merge them.
            const name = canonicalItemName(inv, parsed, change?.at);
            const key = itemKey(name, change?.at);

            // A restated TOTAL overwrites; a delta accumulates. Both land in the same table and
            // the same audit trail, recorded as the change they actually represented — so a
            // restatement that corrects a runaway count shows up as the correction it is.
            const restated = Number.isFinite(change?.set);
            const dq = restated ? setQty(inv, key, change.set) : Number(change?.dq ?? 0);
            if (!restated && !dq) continue;
            if (!restated) {
                bumpQty(inv, key, dq);
            }

            insert_with(lastTouch, merge_b, key, index);
            // The audit trail: every quantity traces to the events that produced it. A restatement
            // that changed nothing is not worth a row — that is most of them. `mid` is the anchor
            // that lets the UI jump a contributor to its causing message (FOLD-REDESIGN.md §8,
            // altitude 3, Ledger tab: "click a contributor → the chat scrolls to the causing
            // message"), so it rides the trail from the start.
            if (dq) {
                insert_with(contributors, merge_graph, key, [{ at: event.t ?? 0, dq, summary: event.s ?? '', mid: Number.isFinite(event.mid) ? event.mid : null }]);
            }

            if (lookup(inv, key, { qty: 0 }).qty <= 0) {
                inv.delete(key);
                lastTouch.delete(key);
                contributors.delete(key);
            }
        }

        for (const change of delta.vit ?? []) {
            const name = String(change?.name ?? '');
            if (!name) continue;
            // ── The same seeding rule as `bumpQty`, for the same reason ──
            //
            // `insert_with` stores the incoming value verbatim when the key is absent and only
            // calls the merge on collision, so handing it a raw `{dcur, max}` delta would store
            // that shape for the vital's FIRST sighting — no `cur` field at all. Every read then
            // shows the fallback (`0` in the panel, `NaN` in the injection) and the accumulation
            // base is wrong for the next delta. The live failure mode: a first HP report that
            // carries the damage with it (`{name:"hp", dcur:-26, max:70}`) folded to a row with no
            // `cur`, the panel showed "Hp 0/70" and the model read "hp NaN/70". Seeding the key
            // first makes the merge run on the first write too, so the stored shape is always
            // `{max, cur}` and that report folds to `cur: 44`.
            const proposed = {
                dcur: Number(change?.dcur ?? 0),
                max: Number.isFinite(change?.max) ? change.max : undefined,
            };
            insert_with(vitals, merge_vital, name,
                vitals.has(name) ? proposed : merge_vital(proposed, undefined));
        }

        for (const change of delta.st ?? []) {
            const flag = String(change?.flag ?? '');
            if (!flag) continue;
            // Filtered on READ, not only on write. `validateStatus` refuses negations now, but a
            // flag recorded before it did is permanent: nothing turns it off and `turns = 0` means
            // it never expires. "Otherwise uninjured" sat in a panel for seventy-four turns for
            // exactly that reason. Same read-time healing the item names get.
            if (change?.on && isNegation(flag)) continue;
            // ── Whose it is, healed on read for every event written before Phase D ──
            //
            // An `st` delta with no `who` is not a delta about nobody; it is a delta from before the
            // schema had anywhere to put a subject (`FOLD-RPG-GAP.md` §3 — the mid-30 events that
            // wounded Lee and Park and rendered on the player). It folds into the unowned bucket,
            // which every consumer reads as the pov's. That is §9's "fold-time default `who = pov`,
            // read-time healing, no rewrite", and it is what lets a chat downgrade to a build
            // without marks and lose nothing.
            const who = ownerKey(change?.who);
            // Keyed by OWNER and SUBJECT, valued by phrase: two descriptions of one condition on one
            // person are one fact, and the later one wins. See `statusSubject` for why the phrase is
            // the wrong key, and `statusKeyFor` for why the owner is part of it.
            const key = statusKeyFor(status, flag, who);
            const turns = Number(change?.turns ?? 0);
            placeMark(status, key, {
                who,
                on: !!change?.on,
                t: event.t ?? 0,
                phrase: flag,
                severity: normalizeSeverity(change?.severity),
                turns: Number.isFinite(turns) && turns > 0 ? Math.min(turns, MAX_CONDITION_TURNS) : 0,
            });
            insert_with(statusTouch, merge_b, key, index);
        }
    });

    const total = ordered.length;
    const since = fold(table_entries(lastTouch), new Map(), (acc, [name, index]) =>
        insert_with(acc, merge_b, name, Math.max(0, total - 1 - index)));

    tickConditions(status, statusTouch, total);

    return { inv, vitals, marks: status, since, contributors };
}

/**
 * The marks a migration seeded onto cast rows, folded in before the ledger.
 *
 * ── The one thing the ledger cannot hold ──
 *
 * `state.context.conditions` — "calf scabbed and rebandaged, left arm bruised shoulder to elbow" in
 * the live Solo Leveling chat — is a standing claim about the pov's body that no event ever carried:
 * it arrived from the scene probe into a context field and was rendered inside the scene header,
 * which is how "Bandaged calf" came to read as a property of the Goblin Market (`FOLD-REDESIGN.md`
 * §0). Migration routes it to marks (§9), and there is no event to hang it on — the turns that
 * caused those wounds are long past and their `st` deltas, where they exist at all, were subjectless.
 *
 * So migration writes `cast[key].marks`, and this is the only reader. Seeds fold FIRST, so any
 * ledger event about the same subject supersedes them by ordinary last-write — a seeded
 * "bruised left arm" that the story later clears is cleared, and a seeded mark nothing contradicts
 * stands. They are not swipe-sensitive, correctly: they describe a body as it was before the branch
 * existed, and no swipe on this branch can undo a wound from before it.
 *
 * @param {Array<{who?: string, phrase: string, severity?: string}>} seeds Seeded marks.
 * @returns {Map<string, object>} The starting marks table.
 */
export function seedMarks(seeds) {
    const marks = new Map();
    for (const seed of Array.isArray(seeds) ? seeds : []) {
        const phrase = normalizeKey(seed?.phrase);
        if (!phrase) continue;
        const who = ownerKey(seed?.who);
        placeMark(marks, statusKeyFor(marks, phrase, who), {
            who,
            on: true,
            t: Number(seed?.t) || 0,
            phrase,
            severity: normalizeSeverity(seed?.severity),
            turns: 0,
            seeded: true,
        });
    }
    return marks;
}

/**
 * Age every condition that was given a duration, and clear the ones that have run out.
 *
 * ── Consequence without dice ──
 *
 * A hangover should fade. A bite should not. Both were recorded identically and both stayed true
 * forever, which is the failure mode that makes a tracker feel like a noticeboard rather than a
 * simulation: nothing on it has a future.
 *
 * The fix needs no scheduler and no new mechanism. A condition may carry `turns` — roughly how many
 * exchanges it lasts — and the fold already knows how many events have passed since it was written.
 * Expiry is therefore a READ of the ledger, not a write to it, which is what keeps it correct under
 * swiping: undo the turn that caused the hangover and the hangover was never there to fade.
 *
 * Conditions with no duration are permanent until something says otherwise, which is the right
 * default. A missing amputation does not heal because twelve turns went by.
 *
 * @param {Map<string, object>} status Status table, mutated in place.
 * @param {Map<string, number>} touch Event index at which each status was last written.
 * @param {number} total Total events folded.
 */
function tickConditions(status, touch, total) {
    for (const [key, value] of table_entries(status)) {
        const turns = value?.turns ?? 0;
        if (!turns) {
            // No stated duration: indefinite, and `fade` of 1 means the panel draws no timer.
            insert_with(status, merge_b, key, { ...value, elapsed: 0, fade: 1 });
            continue;
        }
        const elapsed = Math.max(0, total - 1 - lookup(touch, key, 0));
        const remaining = Math.max(0, turns - elapsed);
        insert_with(status, merge_b, key, {
            ...value,
            elapsed,
            fade: remaining / turns,
            on: value.on && remaining > 0,
        });
    }
}

/**
 * ── DELETED: `isFresh`, and staleness-as-hiding with it ──
 *
 * House style keeps a removed approach recorded with the measurement that killed it, so the
 * function is gone and its argument stays. It read:
 *
 *     // carried items only; a place is never stale
 *     if (splitItemKey(name).place !== CARRIED) return true;
 *     return lookup(since, name, 0) < STALE_THRESHOLD;
 *
 * and every renderer skipped whatever it refused. What it was: a retraction by silence — an item
 * stopped being shown because nobody had said its name for twelve events. What killed it, in three
 * measurements and one theorem:
 *
 *   · `cap:stale-hidden` **198** in the live Solo Leveling chat and **540** in Raccoon City (both
 *     read straight off the stored `state.observed` tables in the chat copies). It was fold's
 *     single largest silent intervention, by an order of magnitude over every other cap.
 *   · The things it hid were right: the goblin knife, the E-rank licence and the hunter pamphlet
 *     all vanished from the prompt while sitting in the character's pockets (`FOLD-RPG-GAP.md` §4,
 *     "carried | knife, licence, pamphlet all silently hidden").
 *   · `BayesFilter.zero_residual_is_fixed` (`BayesFilter.lean:80-81`): a measurement equal to the
 *     prediction moves the belief not at all. Silence is a zero residual. A knife does not become
 *     uncertain because the conversation moved on to noodles.
 *
 * Retraction is evidence-driven from here on — an event that spends the item, or a review closure
 * that says it is gone (`FOLD-REDESIGN.md` §2, §5). `cap:stale-hidden` stays registered in
 * `observe.js` KNOWN_RULES precisely so its zero is visible: a bound retired by construction is a
 * finding, and a rule that quietly disappears from the list proves nothing.
 *
 * `STALE_THRESHOLD` survives, and only for the one job §11 leaves it: the width of the scene-field
 * context bands (`CONTEXT_DROP_AFTER` above), where "has the present moved on" is an honest
 * question about a claim that was always about the present moment.
 */

/**
 * Render tracked state as a compact prompt block.
 *
 * Sections with nothing in them are omitted, and an entirely empty state renders '' so nothing is
 * injected at all — an empty header spends tokens telling the model nothing.
 *
 * @param {object} params Parameters.
 * @param {Map<string, {qty: number}>} params.inv Inventory.
 * @param {Map<string, {cur: number, max: number}>} params.vitals Vitals.
 * @param {Map<string, object>} params.marks Marks, keyed by `markKey`.
 * @param {string} [params.pov] The point-of-view character, whose marks are the `Status:` line.
 * @returns {string} The block, or ''.
 */
export function renderState({ inv, vitals, marks, pov = '' }) {
    const lines = [];

    const vitalParts = table_entries(vitals)
        .map(([name, v]) => `${vitalLabel(name)} ${Math.round(v.cur)}/${Math.round(v.max)}`);
    if (vitalParts.length) {
        lines.push(`Vitals: ${vitalParts.join(' · ')}`);
    }

    // The pov's marks only. Everyone else's are rendered beside the person they belong to
    // (`entity-table.js` `renderEntities`), which is the entire point of Phase D: this line used to
    // carry Lee's ribs and Park's thigh as though they were the player's (`FOLD-RPG-GAP.md` §3).
    // The phrase, not the key: the key is the subject ("hangover"), the phrase is what was
    // actually observed ("hangover mostly eased"), and the model wants the observation.
    const flags = povPhrases(marks, pov);
    if (flags.length) {
        lines.push(`Status: ${flags.join(', ')}`);
    }

    // Grouped by place, so the model is told what is to hand versus what is at home or in the car.
    const byPlace = new Map();
    for (const [key, item] of table_entries(inv)) {
        const { place, name } = splitItemKey(key);
        const label = item.qty > 1 ? `${name} x${item.qty}` : name;
        insert_with(byPlace, merge_graph, place, [label]);
    }

    for (const [place, names] of table_entries(byPlace)) {
        const heading = place === CARRIED ? 'Carrying' : `Stored (${place})`;
        lines.push(`${heading}: ${names.join(', ')}`);
    }

    return lines.length ? `[State]\n${lines.join('\n')}` : '';
}

/**
 * Render the tracked-state half of the pinned ledger, and say exactly what it showed.
 *
 * ── Why this exists beside `renderState` rather than replacing it ──
 *
 * `renderState` is the narrator's injection and it has a shape the narrator has been reading for
 * the whole life of every live chat; changing it is a change to how the fiction gets written, and
 * this phase is not entitled to that. The unification the design asks for (`FOLD-REDESIGN.md` §5,
 * one renderer for panel, narrator, extractor and judge) lands with the phases that also rebuild
 * what is being rendered. Until then the extraction prompt gets its own view, and the two are held
 * in step by sharing every rule that decides *content* — `isFresh`, the place grouping, the
 * status-phrase rule — and differing only in wording.
 *
 * Two differences from `renderState`, both deliberate:
 *
 *   · Money is a line of its own. It is already keyed under the MONEY place, but `renderState`
 *     prints it as `Stored (money): won x330000` — a balance dressed as luggage. The extraction
 *     prompt is where the model is being asked to record purchases (`FOLD-REDESIGN.md` §5: money
 *     moved up three times and down never in 35 turns), so the balance says what it is.
 *   · It returns `shown`, the exact set of inventory keys it put in front of the model. That is
 *     what makes `reject:already-recorded` honest: the gate may only refuse a re-report of a line
 *     the model was actually told about. Phase A needed it because `isFresh` hid stale carried
 *     items, so "held" and "shown" were different sets; Phase C retired that hiding and the two
 *     sets now coincide. `shown` stays anyway, and is not vestigial: the ledger still omits things
 *     it holds — the Elsewhere cast, hidden dials' numbers — and a gate that reconstructs the
 *     prompt's contents from the state is a second definition of what the model was told, which is
 *     the exact class of bug `itemHead` was introduced to close.
 *
 * @param {object} params Parameters.
 * @param {Map<string, {qty: number}>} params.inv Inventory.
 * @param {Map<string, {cur: number, max: number}>} params.vitals Vitals.
 * @param {Map<string, object>} params.marks Marks, keyed by `markKey`.
 * @param {string} [params.pov] The point-of-view character, whose marks this block carries.
 * @returns {{lines: string[], shown: Set<string>}} The lines, and the keys they contained.
 */
export function renderLedger({ inv, vitals, marks, pov = '' }) {
    const lines = [];
    const shown = new Set();

    const money = [];
    const byPlace = new Map();
    for (const [key, item] of table_entries(inv)) {
        const { place, name } = splitItemKey(key);
        shown.add(key);
        if (place === MONEY) {
            money.push(`${item.qty} ${name}`);
            continue;
        }
        insert_with(byPlace, merge_graph, place, [item.qty > 1 ? `${name} x${item.qty}` : name]);
    }

    if (money.length) {
        lines.push(`Money: ${money.join(' · ')}`);
    }
    for (const [place, names] of table_entries(byPlace)) {
        lines.push(`${place === CARRIED ? 'Carrying' : `Stored (${place})`}: ${names.join(', ')}`);
    }

    const vitalParts = table_entries(vitals)
        .map(([name, v]) => `${vitalLabel(name)} ${Math.round(v.cur)}/${Math.round(v.max)}`);
    if (vitalParts.length) {
        lines.push(`Vitals: ${vitalParts.join(' · ')}`);
    }

    // The pov's marks; everyone else's ride on their own cast line. The phrase, not the key —
    // `statusSubject` explains why the key is the wrong thing to show.
    const flags = povPhrases(marks, pov);
    if (flags.length) {
        lines.push(`Condition: ${flags.join(', ')}`);
    }

    return { lines, shown };
}

/**
 * One owner's live marks, as the phrases a reader would recognise, worst first.
 *
 * The severity word rides along in parentheses only for `severe`, and the cut is the same one
 * `hurtOf` makes: a phrase cannot carry the difference between a nuisance and the reason you cannot
 * lift a sword, and that difference is the only part of the ladder fold ACTS on. Printing the word
 * on every mark was tried first and measured against the block's budget — `moderate` is the default
 * for every legacy row, every card block and every migrated condition, so it appeared on nearly
 * every line and said "nothing much" in eleven characters. §12's second open question is this
 * block's size discipline.
 *
 * @param {Map<string, object>} marks The marks table.
 * @param {string} who Owner key or name; '' is the unowned/pov bucket.
 * @returns {string[]} Phrases, most severe first.
 */
export function markPhrases(marks, who) {
    // STRICTLY this owner's bucket. Reading the unowned bucket here as well was tried and is wrong
    // in the one place it matters: `renderEntities` calls this once per person, so every legacy
    // subjectless mark — which belongs to the point-of-view character — would have rendered on
    // EVERY cast row, which is the mid-30 bug inverted and multiplied. The pov's own reading is
    // `povPhrases` below, and it is the only caller entitled to the unowned bucket.
    return sayMarks(marksOf(marks, ownerKey(who)));
}

/**
 * The point-of-view character's live marks, as phrases, worst first.
 * @param {Map<string, object>} marks The marks table.
 * @param {string} who The pov's name.
 * @returns {string[]} Phrases, most severe first.
 */
export function povPhrases(marks, who) {
    return sayMarks(povMarks(marks, who));
}

/**
 * Format marks for a prompt line.
 * @param {Array<[string, object]>} entries Mark entries.
 * @returns {string[]} Phrases, most severe first.
 */
function sayMarks(entries) {
    return [...entries]
        .sort((a, b) => severityRank(b[1]?.severity) - severityRank(a[1]?.severity))
        .map(([key, mark]) => {
            const phrase = mark?.phrase ?? splitMarkKey(key).subject;
            return mark?.severity === SEVERE ? `${phrase} (${SEVERE})` : phrase;
        });
}

/**
 * Where a context field came from, most trusted last.
 *
 * A status block is the narrator asserting the state of the scene in its own words; a reading
 * lifted from prose is fold inferring it. Both are worth having and they are not equally good, so
 * the table records which is which rather than flattening them into "the value" — the ontology's
 * `source-trust` conflation strategy, in the smallest form that pays for itself.
 */
// Imported rather than restated. A second copy of a threshold is a second thing to retune, and
// retuning only one of them is how a bound comes to mean two different numbers.
export const NARRATIVE = 'narrative';
export const BLOCK = 'block';
const TRUST = { [NARRATIVE]: 1, [BLOCK]: 2 };

/**
 * How many turns a block's assertion outranks a fresher narrative reading.
 *
 * Beyond this the block is describing a scene the story has left, and deferring to it is how the
 * injected `[Scene]` came to assert a location that was no longer true. Deliberately the same
 * threshold the clock uses to decide it has gone stale, and for the same reason: it is the point at
 * which a restated fact stops being about the present.
 */
export const CONTEXT_OVERRIDE_AFTER = CLOCK_STALE_AFTER;

/**
 * Merge one context field, ranking by trust and then by recency.
 *
 * Plain last-write is wrong the moment there are two sources. Extraction is async and
 * fire-and-forget, so a narrative reading of turn 9 can land after a block from turn 10 and erase
 * it; `merge_b` cannot see that, because it only knows which call arrived second. Ordering on the
 * pair each value carries makes the result independent of arrival order — `resolution_max_converges`
 * again, over a two-level key.
 *
 * @param {object} nu Incoming field.
 * @param {object} old Existing field.
 * @returns {object} The winner.
 */
export const merge_context = (nu, old) => {
    if (!old) {
        return nu;
    }
    const [tNu, tOld] = [TRUST[nu?.src] ?? 1, TRUST[old?.src] ?? 1];
    if (tNu !== tOld) {
        // The lower-trust reading wins only once the better one is old enough to be describing a
        // different moment. A card that restates its block every turn is never overridden.
        const better = tNu > tOld ? nu : old;
        const worse = tNu > tOld ? old : nu;
        return (worse.t ?? 0) - (better.t ?? 0) > CONTEXT_OVERRIDE_AFTER ? worse : better;
    }
    return (nu?.t ?? 0) >= (old?.t ?? 0) ? nu : old;
};

/**
 * Consecutive disagreements a locked field tolerates before the contest is raised.
 *
 * ── Why a count and not an expiry ──
 *
 * A lock is a field you corrected by hand, and `setContext` discards every write that disagrees
 * with it (`state.js`, `cap:field-locked`). Measured on the live Solo Leveling chat: the location
 * lock taken at turn 10 blocked **7** writes and the panel went on showing an empty room in a scene
 * that contained the player — the mechanism did exactly its job and the result was a lie nobody
 * could see (`FOLD-REDESIGN.md` §0.1-2, §5).
 *
 * The obvious repair is an expiry, and it is refused: a lock that times out is decay wearing a UI,
 * and `FOLD-REDESIGN.md` §11 rules out decay with `BayesFilter.zero_residual_is_fixed`. The honest
 * mechanism is the one the rest of this design uses everywhere — surface the disagreement and ask.
 * The lock still wins until the user acts; that is what a lock is. It simply can no longer lie
 * silently.
 *
 * Three, because one disagreement is the narrator wandering and two is a coincidence; three
 * consecutive reads that all say the same other thing is the story having moved. The live sequence
 * would have raised it once, on the third of its seven blocked writes, which is the shape a signal
 * should have — not seven alerts about one argument.
 */
export const CONTEST_AT = 3;

/**
 * Fold one blocked write into a field's contest record.
 *
 * ── Consecutive, and agreement is what breaks the run ──
 *
 * The count is of consecutive reads saying THE SAME other thing. A narrator that says "the chamber",
 * then "the gate site", then "the chamber" has not built a case for anything; it has wandered.
 * Whereas three reads that all say "the Nowon gate site" is the story having moved on without the
 * lock, which is the fact worth surfacing. So a different value restarts the run at one, and a write
 * that AGREES with the locked value clears the record entirely — the argument is over.
 *
 * Pure and total: it takes what is stored and returns what should be stored, so the impure caller
 * has nothing to decide.
 *
 * @param {object|null} held The stored contest record for this field, or null.
 * @param {object} params Parameters.
 * @param {string} params.locked The value the lock is holding.
 * @param {string} params.value The value the write proposed.
 * @param {number} [params.turn] The turn this write arrived on.
 * @returns {{record: object|null, raised: boolean}} What to store — null to clear — and whether
 *   this write is the one that crosses CONTEST_AT.
 */
export function foldContest(held, { locked, value, turn = 0 }) {
    const said = String(value ?? '').trim();
    const stands = String(locked ?? '').trim();
    // Agreement is not a contest, and it ends the one in progress. Compared case-insensitively:
    // "The Chamber" and "the chamber" are the same claim, and a case difference raising a lock
    // contest is the kind of noise that teaches a user to ignore the signal.
    if (!said || said.toLowerCase() === stands.toLowerCase()) {
        return { record: null, raised: false };
    }
    const same = String(held?.value ?? '').trim().toLowerCase() === said.toLowerCase();
    const count = same ? (Number(held?.count) || 0) + 1 : 1;
    return {
        record: { value: said, locked: stands, count, turn },
        // Raised on the crossing only. Counting every subsequent disagreement would make
        // `lock:contested` a measure of how long the user took to answer rather than of how often
        // a lock and the narrative fell out, which is the question the counter exists to settle.
        raised: count === CONTEST_AT,
    };
}

/**
 * The acquisitions a pass recorded with nothing paid for them.
 *
 * ── The strongest of the three money fixes, because it is a trigger in code ──
 *
 * Measured twice on the live Solo Leveling chat: across 40 turns money moved up and never down,
 * and the second hand repair found the one purchase priced *five separate times* in plain text —
 * including the player's own "I hand over the 120k" — with all six items credited and the balance
 * unmoved (`FOLD-REDESIGN.md` §0.1, §5). The first draft's remedy was a line in the delta
 * instruction; the correction that was accepted is that a prompt line is the weakest of the three
 * available fixes, by the same argument that moved adjudication into code — instructions decay,
 * triggers in code do not. So: code decides WHEN to ask, and the model only reads the scene and
 * answers, which is the division of labour `verdict.js:5-18` established.
 *
 * A credit with no debit is mechanically detectable, and this is the detection. Categories are
 * excluded because they are not bought: an ability learned and a property inherited are gains that
 * legitimately cost nothing, and asking after each of them would spend the question budget on noise.
 *
 * ── It is also the designed recovery for Phase A's known cost ──
 *
 * `reject:already-recorded` refuses a genuine same-name re-acquisition — the bracers destroyed at
 * mid 38 and re-bought at 66 stay at ledger 1 (Phase A's LANDED note, `FOLD-REDESIGN.md` §10).
 * Nothing in `{item, dq, at}` distinguishes a re-buy from a re-report, so the refusal is the right
 * error to make at write time. But a refused credit *plus a payment in the window* is exactly this
 * function's trigger shape, which is why refusals are passed in beside the accepted deltas: the
 * question that comes back — "these were recorded with nothing paid" — is the one that surfaces the
 * purchase the gate declined to bill, and the answer arrives as an ordinary validated money delta.
 *
 * @param {object} params Parameters.
 * @param {object[]} params.accepted Accepted inventory deltas from this pass, flattened.
 * @param {object[]} [params.refused] Rejections from this pass, so a refused credit still counts.
 * @returns {string[]} Item names credited with no money debit; empty when nothing is owed.
 */
export function creditsWithoutDebit({ accepted = [], refused = [] } = {}) {
    let debited = false;
    const credits = [];
    for (const change of accepted) {
        const place = normalizePlace(change?.at);
        const dq = Number(change?.dq ?? 0);
        if (place === MONEY) {
            // A restated money total is not a payment either way, so only a real negative delta
            // counts as the debit side. `set` carries no sign.
            if (dq < 0) debited = true;
            continue;
        }
        // A restatement is not an acquisition — it is the list you already had, re-read.
        if (Number.isFinite(change?.set) || dq <= 0 || CATEGORIES.has(place)) continue;
        credits.push(String(change.item ?? ''));
    }
    for (const rejection of refused) {
        if (rejection?.reason === 'already-recorded' && rejection.item) {
            credits.push(String(rejection.item));
        }
    }
    return debited ? [] : [...new Set(credits.filter(Boolean))];
}

/** Scale words a narrator writes instead of zeros, and what each is worth. */
const SCALE_WORDS = new Map([['k', 1e3], ['thousand', 1e3], ['m', 1e6], ['million', 1e6], ['bn', 1e9], ['billion', 1e9]]);

/**
 * Read an amount out of an answer.
 *
 * The review answers "what was paid?" in whatever words the fiction used — "₩120,000", "120k won",
 * "eighty-five thousand". This reads the first number and any scale word attached to it, and
 * nothing else: it is not a parser for prose about money, it is the narrow step between a model's
 * sentence and a delta that then goes through the ordinary validators (mention gate, growth ratio,
 * corroboration). Anything it cannot read returns null and the question simply goes unanswered,
 * which is the safe failure — a wrong debit is worse than a missing one, because the missing one is
 * asked about again next pass.
 *
 * Deliberately NOT a currency-name list. The currency is whatever the ledger already calls money,
 * read off the balance rather than guessed from a symbol; `FOLD-REDESIGN.md` §11 rules out the
 * word-list version and a symbol table is one.
 *
 * @param {string} text The answer.
 * @returns {number|null} The magnitude, or null when there is no number in it.
 */
export function parseAmount(text) {
    const said = String(text ?? '').toLowerCase().replace(/(\d)[,\s](?=\d{3}\b)/g, '$1');
    const match = said.match(/(\d+(?:\.\d+)?)\s*(k|m|bn|thousand|million|billion)?/);
    if (!match) {
        return null;
    }
    const size = Number(match[1]);
    if (!Number.isFinite(size) || size <= 0) {
        return null;
    }
    return Math.round(size * (SCALE_WORDS.get(match[2]) ?? 1));
}

/**
 * The contested locks, in the shape a consumer can act on.
 *
 * Only fields that have crossed CONTEST_AT reach a consumer: a single blocked write is the narrator
 * wandering, and surfacing it would make the panel noisier than the problem it reports. The record
 * is kept from the FIRST disagreement, because that is what makes the third countable.
 *
 * @param {Map<string, object>} table The stored contest table.
 * @returns {Array<{field: string, lockedValue: string, narrativeValue: string, count: number}>}
 *   Contested fields, most argued-over first.
 */
export function contestsOf(table) {
    return table_entries(table ?? new Map())
        .filter(([, record]) => (Number(record?.count) || 0) >= CONTEST_AT)
        .map(([field, record]) => ({
            field,
            lockedValue: String(record?.locked ?? ''),
            narrativeValue: String(record?.value ?? ''),
            count: Number(record?.count) || 0,
        }))
        .sort((a, b) => b.count - a.count);
}
