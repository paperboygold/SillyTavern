/**
 * fold/state-table.js: the pure logic for tracked character state.
 *
 * Imports only pure siblings, so it runs in plain Node and is unit-testable.
 *
 * State is a FOLD OVER THE CHRONICLE, not a table beside it.
 *
 * Both implementations this was ported from keep inventory as a parallel structure the model has
 * to remember to keep in sync. RPG Companion has the model restate the whole list each turn, so an
 * item it forgets to mention silently disappears. Scribe has the model propose a whole new state
 * and then trusts it, its `rejected` vector is never populated, and reconciliation ends with
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
 *   · Branch-awareness for free. Fold only events that are live on this swipe, the mechanism
 *     already built for retrieval, and swiping away a turn un-does its inventory changes.
 *   · An audit trail. Every quantity traces to the event that caused it.
 *   · Corrections propagate. Edit or delete an event and the state re-derives.
 *
 * Three merges do the folding:
 *
 *   inventory  norm(item)          merge_qty     Count      quantities add, floored at 0
 *   vitals     norm(name)          merge_vital   Count×Map  clamp(cur + dcur, 0, max)
 *   marks      who␀subject(flag)   merge_b       Map        last write wins, three slots per owner
 *
 * `marks` is the Map face and NOT the Set face, deliberately. `merge_nb` is `nu || old`: once
 * true, always true, and a wound has to be able to heal. Calling it a Set because it looks like a
 * set of flags would be exactly the decorative labelling this basis exists to avoid.
 *
 * The key gained its owner in Phase D (`FOLD-REDESIGN.md` §3). Before that the flag namespace was
 * flat and subjectless, so *"Lee gets raked across the ribs"* and *"Park's bandaged thigh re-opens"*
 *, two events, mid 30, both `{"flag":"bleeding","on":true}`, wrote one another's slot and the
 * panel showed the PLAYER bleeding for the rest of the session (`FOLD-RPG-GAP.md` §3). An event with
 * no `who` still folds, into the unowned bucket every consumer reads as the pov's; see `ownerKey`.
 *
 * Why DELTAS and not totals.
 *
 * If the model hands back a complete inventory, your only options are to accept it wholesale or to
 * diff it and guess which differences were intentional. A delta is a proposition with a magnitude,
 * and a magnitude can be bounds-checked. The Count face is chosen because it is the representation
 * in which hallucination is *detectable*, not because counting is tidy. Validation happens once,
 * at write time (`validateInventory` and friends), so the fold itself stays a pure sum.
 */

import { CLOCK_STALE_AFTER } from './clock.js';
import { windowSnippet } from './diag.js';
// Marks are OWNED, and an owner is a cast row, so the two tables have to agree about what a name
// is. Importing the one normaliser rather than re-deriving a key here is the same discipline
// `itemHead` enforces for items: two definitions of "what is this called" is how a gate comes to
// refuse the very thing its window was about (Phase A's LANDED note). `entity-table.js` imports
// nothing but `lib/hash.js` (and the shared `diag.js`), so this adds no cycle.
import { MAX_DETAIL, PERSON, normalizeEntityName, resolveEntity } from './entity-table.js';
// The place RECORD, for the two things a free-text place cannot say: whether the room you left the
// crowbar in still exists, and what the narrator should be told about where it is standing.
// `place-table.js` imports `entity-table.js` and `lib/hash.js` and nothing else, so this closes no
// cycle, and the dependency runs one way only, because nothing about a place reads an item.
import { renderPlaces, unreachableBy } from './place-table.js';
import { fold, insert_with, lookup, merge_b, merge_graph, table_entries } from './lib/hash.js';

/**
 * Where an item is. Both reference implementations model this, RPG Companion has
 * onPerson/clothing/stored{location}/assets, Scribe has inventory/inventory_stored/assets, because
 * "everything you own is in your pockets" is wrong the moment a character has a home or a car.
 *
 * Here it is part of the key rather than a parallel structure, so the same merges do the work and
 * two crowbars in two places stay two entries.
 */
export const CARRIED = 'carried';

/**
 * Categories are places, and cost nothing.
 *
 * A house, a starship and a knack for reading people are not "inventory", but they do not need a
 * separate system either: `itemKey(name, place)` is already a product type, and every stage of the
 * pipeline, `canonicalItemName`, `validateInventory`, `deriveState`, `renderState`, the panel,
 * already dispatches on the place half. So a category is just a reserved place, and the whole
 * inventory/assets/abilities divide arrives with no new table and no new merge.
 *
 * They differ from ordinary places in exactly one way, and it is the one that matters: `isFresh`
 * already exempts non-CARRIED keys from staleness, which is precisely the semantics that standing
 * property and permanent capabilities want. Nothing had to be built for that either.
 *
 * Deliberately NOT a category: equipment. Foundry VTT's dnd5e data model keeps ONE inventory list
 * with `equipped` as a flag on the item, a decade of iteration arriving at that specifically to
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
 * character's funds rendered as `Won ×9999` under "Carrying", wrong in the bound, wrong in the
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
 * Contact details are not items.
 *
 * This used to be an English word list (`contacts?|contact list|phone ?book|address book`) that
 * refused fold's `at` field, but the delta schema instruction already says "Contact details are
 * never items" and the model is told to express them as `reach` on the person. A hardcoded English
 * refusal was fold second-guessing the model's structured report with words, the enumerated list
 * §11 bans. The schema instruction is the contract; fold stores what the model reports.
 */

/** Places that are categories rather than locations. */
export const CATEGORIES = new Set([ASSETS, ABILITIES, MONEY]);

/**
 * How a thing came to be held, the field that replaced a guess fold could not make.
 *
 * The guess, and what it cost.
 *
 * `creditsWithoutDebit` modelled "an item arrived and no money moved" as "an unpaid purchase". In
 * play that premise is almost always false. Replayed over the 2316 traced extraction passes in the
 * corpus (`data/default-user/extensions/{fold,sanguine}-traces`), the rule fired on **286 passes
 * and 531 items**, and the model itself was asked to price all of them. Its own answers are the
 * verdict: 369 `[paid?]` asks reaching a prompt, matched back to the review line answering that id:
 *
 *     no answer row at all   244   (66%)  the excerpt had scrolled; nothing to answer from
 *     "nothing was paid"     102   (28%)  a gift, a find, loot, the premise refused outright
 *     an amount               19    (5%)
 *
 * Six of those nineteen are defects this file already documents: the four Wuxia restatement
 * double-bills at mids 253/260/267/287 (see the `set` branch below, the last one deleted the
 * campaign's whole balance), the Isekai one-coin-two-debits at mid 45 (`review.js applyMoney`), and
 * the twenty taels of wound medicine that were a REWARD (the money-credit branch below). So the
 * question's lifetime yield across nine campaigns is at most thirteen correct debits against six
 * proven harms, and 84% of the times the model answered at all it answered "you are wrong to ask".
 *
 * On the live Wuxia chat of 2026-08-20 the shape is plain: of 17 firing passes exactly ONE is a
 * purchase (mid 96, "buys a bedroll, ground sheet, rope and fishing line from the market vendor").
 * The other sixteen are a basket found in a cabin, two butchered wolves, a looted corpse (four
 * passes of it), a coin pouch handed over by 王大夫, a token issued at a registration desk, a spear
 * taken off a weapon rack, and the character drawing his own sword.
 *
 * So stop guessing and ask, which is the move that fixed the world turn and the drive nomination.
 *
 * Loot, finds, gifts, issued tokens, borrowed gear and taught techniques are the dominant
 * acquisition modes and buying is roughly one in twenty. Nothing in `{item, dq, at}` separates
 * them, and nothing ever will, it is a reading of the scene, which is RULE 1's definition of the
 * model's job. `how` is that reading, answered once at record time with the excerpt still in front
 * of the model, instead of a pass later when 66% of asks got no answer because the evidence was
 * gone.
 *
 * No member is a free skip, and the failure mode is benign either way.
 *
 * `moves: []` came back 107/107 and `drive_size: 0` came back 288/288, both because an empty answer
 * was legal and cost nothing. The counter-evidence in this same corpus is `st.severity`: a required
 * enum with no empty member, 305 rows, answered 137 minor / 120 moderate / 48 severe, every row,
 * no evasions. `entities.feels`, which DOES carry `''` as a member, came back empty 562 times in
 * 3150. So the enum below has no `''` and no `other`: every member names a real way a thing arrives,
 * and `lost` is the honest answer for the 48% of rows that gain nothing (449 losses and 116 no-ops
 * out of 1638), not a hatch, a `dq > 0` row calling itself `lost` is a self-contradiction, and
 * `acquisitionOf` discards it rather than believing it.
 *
 * And if the field were skipped anyway, the degradation is that the question stops firing, which
 * costs at most those thirteen debits and removes 356 wrong asks. That is the opposite of `moves`,
 * where the empty answer destroyed the whole feature. `bought` is the only member that cannot be
 * reached by shrugging: it asserts money changed hands.
 */
export const BOUGHT = 'bought';

/** The ways a thing arrives, plus `lost` for an entry that gains nothing. Order is the prompt's. */
export const ACQUISITIONS = Object.freeze([BOUGHT, 'given', 'found', 'taken', 'made', 'lost']);

/** The subset that means something ARRIVED. `lost` is deliberately absent. */
const ARRIVALS = new Set(ACQUISITIONS.filter(word => word !== 'lost'));

/**
 * Read a delta's acquisition mode, and only believe it when it agrees with the arithmetic.
 *
 * Three ways to get nothing back, all of which mean "fold was not told how this arrived":
 *
 *   · the row is not a gain, `dq <= 0` or a restated total, where the mode has nothing to describe;
 *   · the word is not one fold offered, a block-parsed delta, a player-authored one, or a ledger
 *     written before this field existed, none of which ever carry it;
 *   · the row gains something and calls itself `lost`, which is the model contradicting its own
 *     `dq` and is exactly the shape a free-skip answer would take.
 *
 * Nothing here defaults to `bought`, and that is the load-bearing property: an unanswered entry
 * must never become an unpaid purchase, or a fix aimed at 95% false positives makes them 100%.
 *
 * @param {object} raw The proposed inventory delta.
 * @param {number} dq The quantity change already parsed from it.
 * @returns {string} An arrival word, or '' when fold was not told.
 */
export function acquisitionOf(raw, dq) {
    if (!(Number(dq) > 0)) {
        return '';
    }
    const said = String(raw?.how ?? '').trim().toLowerCase();
    return ARRIVALS.has(said) ? said : '';
}

/** Separator between place and item in an inventory key. Not typeable, so it cannot collide. */
const PLACE_SEP = '\u0000';

/** Nothing fold writes may contain its own separator; a name that does would break the split. */
const unseparated = part => String(part ?? '').split(PLACE_SEP).join('');

/**
 * Build an inventory key from an owner, a place and an item name.
 *
 * Whose, not only where.
 *
 * `place` says where a thing is; `owner` says whose it is, and they are different questions. New
 * Eldoria proved it three ways in one session: Kaelira's ironwood branch (chronicled at mid 82,
 * never recorded, because there was nowhere to put it), Vexia's stone sphere and cloth scrap (filed
 * in Solomon's pocket), and mid 108's "Vexia accepts the coins and tucks them into her belt pouch"
 * recorded as `gold +17` on the PLAYER's balance. The model tried to say it and had only one
 * channel: `{"item":"pale stone sphere","dq":-1,"at":"Sylanna's satchel"}`, which is a place, and
 * was refused as `remove-unknown`.
 *
 * The empty owner is spelled by ABSENCE, which is why nothing migrates.
 *
 * `markKey` writes the owner segment always, because marks were built with one. Items were not, so
 * every stored baseline, crosswalk answer and `reachKeys` entry in every live chat is a two-part
 * key. Omitting the segment when the owner is empty makes the player's key byte-identical to what
 * it has always been: no rewrite, no read-heal, no version gate. Only somebody else's belongings
 * carry a third part, and they are all new rows by construction.
 *
 * @param {string} name Normalized item name.
 * @param {string} [place] Where it is; defaults to carried.
 * @param {string} [who] Whose it is; '' (the default) is the point-of-view character's.
 * @returns {string} The table key.
 */
export function itemKey(name, place = CARRIED, who = '') {
    const owner = unseparated(ownerKey(who));
    const at = unseparated(normalizePlace(place));
    const what = unseparated(name);
    return owner ? `${owner}${PLACE_SEP}${at}${PLACE_SEP}${what}` : `${at}${PLACE_SEP}${what}`;
}

/**
 * Split an inventory key back into owner, place and name.
 *
 * Three shapes, and the arity decides which, the same trick `splitMarkKey` uses, and sound because
 * `itemKey` strips the separator out of every part it is given:
 *
 *   · `name`: written before places existed. Carried, and the player's.
 *   · `place<SEP>name`: every key in every live chat today. The player's.
 *   · `who<SEP>place<SEP>name`: somebody else's.
 *
 * @param {string} key A table key.
 * @returns {{who: string, place: string, name: string}} The parts.
 */
export function splitItemKey(key) {
    const parts = String(key ?? '').split(PLACE_SEP);
    if (parts.length >= 3) {
        return { who: parts[0], place: parts[1], name: parts.slice(2).join(PLACE_SEP) };
    }
    if (parts.length === 2) {
        return { who: '', place: parts[0], name: parts[1] };
    }
    return { who: '', place: CARRIED, name: parts[0] ?? '' };
}

/**
 * Whether the review may ask "are you still carrying this?" about a row.
 *
 * A question the key already answers is not a question.
 *
 * The disposition question is about the PACK, `review-table.js` says so outright ("do you still
 * have this" and "how many" are the same question about a pack). The selector that fed it asked
 * only that the row not be money, so every row NOT on the pack was posed too, and the honest answer
 * deleted it. `review.js` turns a `settled`/`moot` into `dq: -1` at the row's own place, and that is
 * the only thing that removes an item, so there was no second chance.
 *
 * Three shapes, all measured in the live Wuxia ledger:
 *
 *   · `abilities`  a technique is never carried, so "no" is the only honest answer and the deletion
 *                  was CERTAIN. Five of the six techniques the campaign ever learned were destroyed
 *                  this way, two at mid 34, three more at mid 212 in a single pass. The summaries
 *                  fold wrote say it in as many words: "No longer carrying nine realms heavenly
 *                  ascension technique (stored as ability)".
 *   · `assets`     the same certainty for a house or a mount. 赤焰居 was one pass from the same end.
 *   · a place      the record ALREADY says where it is. "No longer carrying sandstone slab (left at
 *                  rocky ridge overhang)" is the model agreeing with the row it was shown, and the
 *                  agreement was transcribed as a removal from the overhang. The slab and the boar
 *                  hide both went that way at mid 34.
 *
 * 11 of the 38 review disposals across every campaign on disk fired at an off-pack row. The one that
 * happened to be right (`heavy iron-tusk pair` out of the storage ring at mid 26, forged into a
 * spear) was right by luck, not by the question being answerable, a genuine removal still arrives
 * as an ordinary `inv` delta from the narrative pass, which this does not touch.
 *
 * So the predicate is the docblock: the pack, and the pack only. Money is excluded by the same
 * clause it always was, and now for a stated reason rather than as the sole exclusion, a balance
 * falls by being spent, which the `paid?` question already covers.
 *
 * @param {string} key An inventory key.
 * @param {string} [who] The pov's name; rows owned by somebody else are never posed.
 * @returns {boolean} True when the row is on the pov's person.
 */
export function isDisposable(key, who = '') {
    const parts = splitItemKey(key);
    return parts.place === CARRIED && (!parts.who || parts.who === ownerKey(who));
}

/**
 * Normalize a place label.
 *
 * Protocol tokens, not synonyms.
 *
 * The delta schema's `at` field is fold's own vocabulary: the model is told to write `carried`,
 * `assets`, `abilities` or `money` exactly for a category, and any other string is a literal place
 * ("the apartment", "the car boot"). So fold only recognises those four protocol tokens, it no
 * longer guesses "on person"/"worn" means carried or "coin" means money from an English synonym
 * list, which could only work in one language. `CONTACT_PLACE` refusal is gone too: the schema
 * says contact details are never items.
 *
 * @param {string} raw Raw place.
 * @returns {string} Normalized place, or CARRIED.
 */
export function normalizePlace(raw) {
    const said = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, MAX_ITEM_NAME);
    if (!said) {
        return CARRIED;
    }
    if (CATEGORIES.has(said)) {
        return said;
    }
    // A bare article/preposition prefix is noise; strip it, then re-check the protocol tokens so
    // "the carried" and "my money" still land where they mean.
    const text = said.replace(/^(?:the|my|in|at|on)\s+/, '');
    if (!text) {
        return CARRIED;
    }
    return CATEGORIES.has(text) ? text : text === CARRIED ? CARRIED : text;
}

/**
 * Bounds, measured.
 *
 * These used to read "generous enough for real play, tight enough to bound the metadata blob",
 * which is prose standing where a number should be. Every one below is now stated against an
 * observation, in the style `whispering-tides/src/globe.slang` uses for its roughness exponent:
 * the configured value, the observed distribution, and what the data cannot answer.
 *
 * Instrument: `tests/util/fold-calibrate.mjs`, re-runnable against any chat file.
 * Corpus: "Raccoon City First Day", 2026-08-06, 28 assistant turns, 18 state blocks, 20 events,
 * 11 distinct items. One card, one genre; a second corpus would sharpen every row here.
 */
export const MAX_ITEM_NAME = 64;        // observed max 23, p95 20 (n=36), 2.8x headroom
export const MAX_ITEMS = 64;            // observed 11 distinct, 5.8x headroom
/**
 * How many capabilities one character may hold at once.
 *
 * Its own bound rather than a share of `MAX_ITEMS`, because they are no longer the same table, see
 * `foldAbility`. Measured over every trace file on disk, counting the DISTINCT abilities each
 * campaign's extraction ever proposed (accepted or not): Wuxia World RPG 11, Isekai RPG 7, and
 * fourteen more campaigns at 4 or fewer. 48 is 4.4x the worst observed.
 *
 * What the data cannot answer: no campaign on disk runs a class system with a full spell list, which
 * is the shape that would test this. If one ever hits the bound it rejects as `abilities-full` and
 * says so, rather than silently dropping the newest technique.
 */
export const MAX_ABILITIES = 48;        // observed 11 distinct proposed (Wuxia), 4.4x headroom
export const MAX_VITALS = 12;           // observed 0: this card reports health as prose, not levels
export const MAX_FLAGS = 32;            // observed 0 in the ledger; conditions arrived via the block
export const MAX_QTY = 9999;            // observed max 1, a serialization guard, not a play limit

/**
 * Severity, as a word, because a mark is a phrase and not a point total.
 *
 * Fate's consequence ladder is mild / moderate / severe and Cortex's is a die size; the plan's keep
 * table took the words and refused the arithmetic, and `FOLD-REDESIGN.md` §1 extends the
 * phrase-over-number rule (`entity-table.js:71-88`, the disposition ladder) to marks explicitly:
 * "severity is a word (minor / moderate / severe), never a point total". `minor` rather than Fate's
 * `mild` only because `mild` is already a STATUS_MODIFIER below, a severity word that the subject
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
 * precedent `FOLD-REDESIGN.md` §3 names, "up to three consequence slots per cast row, each a phrase
 * plus a severity word (Fate/Cortex, per the plan's keep table)". What fold takes is the SLOT COUNT
 * and the escalation move; what it refuses is Fate's tiering (one slot per severity) and its
 * stress-track arithmetic, because fold has no dice to absorb and no shifts to spend.
 *
 * Why a bound at all, when `MAX_FLAGS = 32` already bounds the table: the bound is not about storage.
 * A body carrying nine simultaneous named afflictions is a panel nobody reads and an injection that
 * spends its budget describing bruises; three is the number that keeps "what is wrong with this
 * person" answerable at a glance. Measured on the live Solo Leveling ledger, the worst moment
 * (message 72, after the Nowon raid) carried five subjectless flags at once, `bandaged`,
 * `left arm heavily bruised`, `functional`, `mild fatigue`, `possible infection monitored`: of
 * which one was a reassurance, one a morphological duplicate and one an observation about a mark
 * rather than a mark. Three real ones, and the cap would have forced exactly that reading.
 */
export const MAX_MARKS = 3;

/**
 * The only real boundary on money.
 *
 * Not a play limit, there is no such thing. A trillionaire is a legitimate character, a national
 * treasury is a legitimate quantity, and any ceiling chosen for feeling roomy is a number that
 * eventually becomes a bug in somebody's campaign. The first attempt here was 1e12 for exactly that
 * bad reason.
 *
 * `Number.MAX_SAFE_INTEGER` is different in kind: past it, JavaScript integer arithmetic silently
 * stops being exact, so `a + b` quietly returns the wrong total. Clamping there is not a judgement
 * about how rich anyone may be, it is the point beyond which the fold could no longer add up
 * correctly, and a wrong total is worse than a refused one.
 */
export const MAX_MONEY = Number.MAX_SAFE_INTEGER;

/**
 * The ceiling for a given place.
 * @param {string} place A normalized place or category.
 * @returns {number} The largest quantity that place may hold.
 */
export function maxQty(place) {
    if (place === MONEY) {
        return MAX_MONEY;
    }
    // A capability is held or it is not. `foldAbility` is where presence is enforced; this bounds
    // the projection the validator gates against, so a re-grant inside one pass cannot pretend to be
    // a growing stack the magnitude rule then has to argue about.
    return place === ABILITIES ? 1 : MAX_QTY;
}

/**
 * How many rows a projection holds at (or away from) one place.
 *
 * The two inventory ceilings stopped sharing a table when capabilities did, and `projected.size`
 * counts both, so it can no longer answer either question. Owner-blind on purpose: `MAX_ITEMS` and
 * `MAX_ABILITIES` bound the metadata blob, and the blob does not care whose row it is.
 *
 * @param {Map<string, object>} table An inventory projection.
 * @param {string} place The place to count.
 * @param {boolean} [invert] True to count everything EXCEPT that place.
 * @returns {number} The row count.
 */
function countPlace(table, place, invert = false) {
    let n = 0;
    for (const [key] of table_entries(table)) {
        if ((splitItemKey(key).place === place) !== invert) {
            n++;
        }
    }
    return n;
}

/**
 * Why the magnitude bound is RELATIVE, and why an absolute one was a genre bug.
 *
 * This was 20, then measured down to 6 against a corpus where every quantity change was ±1. That
 * retune was correct for the corpus and wrong for the user: the same tracker runs civilisation-scale
 * play, armies, fleets, treasuries, where "gained 10,000 troops" is an ordinary Tuesday and a cap
 * of 6 rejects the entire economy. An absolute bound on a quantity encodes a genre.
 *
 * What travels between genres is the RATIO. Ten thousand credits against two million is
 * unremarkable; ten thousand crowbars against one is a hallucination. So the bound is growth
 * against what is already held.
 *
 * And the first sighting cannot be bounded at all. With nothing held there is no prior, and a
 * legitimate first acquisition may be any size, one crowbar or a warehouse of them. Refusing to
 * bound it is the same discipline as "absence is not a retraction": no evidence, no verdict.
 *
 * What replaces the bound there is corroboration. A delta larger than the growth allowance is
 * accepted only if a number of that order actually appears in the narrative, the mention gate,
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
    // Nothing held is no prior, so nothing to bound against, the corroboration rule takes over.
    if (have === 0) {
        return maxQty(place);
    }
    // Money moves in amounts an item never does, and across scales an item never spans: a purse, a
    // payroll, a war chest. The ratio still governs, a thousandfold jump is still a hallucination
    // at any scale, but the floor is proportional too, so nothing is bounded by a number invented
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
    // Spelled-out numbers ("a hundred") are the model's `magnitude` answer now, not a word list's.
    return false;
}

/**
 * Applied changes allowed per turn, before the rest are dropped.
 *
 * Measured: a block lists up to 6 items in one turn (n=18, max 6, p95 6). At 8 this had 1.3x
 * headroom over the observed maximum, the tightest margin of any bound here, and it drops changes
 * silently. Raised to 12, twice the observed maximum. `cap:rate-limited` in `/fold-calibrate` says
 * whether that was enough.
 *
 * It was not. Phase A's window replay reported the bound BINDING at an observed maximum of 13 in a
 * single turn of the live chat (`FOLD-REDESIGN.md` §10, "Findings carried out of Phase A"). Held to
 * the same house convention as the last retune, twice the observed maximum, so the bound has to be
 * wrong by a factor of two before it silently drops anything: 2 × 13 = 26.
 *
 * Re-measured here, because the two measurements disagree and the disagreement is informative.
 *
 * Counted over all four live ledger copies (Solo Leveling, Evil Hero Party, Raccoon City, Nora),
 * the largest number of non-restated changes carried by any one stored delta is **6** (the Goblin
 * Market purchase, Solo Leveling mids 66 and 68), and the largest per-turn total across every event
 * sharing a message is **11**. Neither reaches 13, because the stored ledger cannot contain what
 * the bound refused. A cap's own victims are exactly the rows missing from the file you measure it
 * against, so the live count is the tighter observation and the ledger count is the floor. 26 clears
 * both by more than a factor of two.
 *
 * And the counting itself was wrong, which is the larger half of this fix.
 *
 * The check below reads `if (!restated && accepted.length >= budget)`: a restated total is exempt
 * from being refused, but it still INFLATES `accepted.length` and so consumes the budget of the
 * changes after it. The measured shape is not hypothetical, the message-72 reconciliation in Solo
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
 * A second copy of a list, named rather than papered over.
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
 * fails the moment the two disagree, which is the only kind of duplication this codebase permits.
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
 * this threshold to a stored item is therefore unanchored *and wrong*, a crowbar in a locked flat
 * does not become uncertain because you spent twelve turns elsewhere. Named rather than papered
 * over; the fix is to scope staleness to presence, not to raise the number.
 */
export const STALE_THRESHOLD = 12;

/**
 * What the PROMPT is allowed to assert, as distinct from what the panel may show.
 *
 * These are two products with one data source, and until now one stale string did both jobs. The
 * panel can afford to show a field with "(as of 9 exchanges ago)" beside it, because a reader
 * discounts it. The prompt cannot: `InsertEmission.the_insert_law` (`:322`) makes an insert a
 * *projection* rather than a boost once its influence exceeds half the margin, and a projection can
 * absorb the emission, so a stale assertion does not merely fail to inform the model, it overrides
 * what the model would otherwise have written. Stale state is corrosive, not inert.
 *
 * Hence three bands rather than two, which is `the_dispatch_law`'s shape again, decide at the
 * endpoints, take a third action in between:
 *
 *   fresh      assert it plainly; it is the present scene
 *   ageing     assert it WITH its age, which converts a claim into a question the narrator can
 *              answer: the repair that stopped fold freezing the clock at 1:03 PM
 *   stale      drop it; there is no warrant left, and an annotated falsehood is still an insert
 *
 * ⚠ Unmeasured. `CONTEXT_ANNOTATE_AFTER` is the threshold already in use for the age suffix.
 * `CONTEXT_DROP_AFTER` reuses STALE_THRESHOLD deliberately rather than inventing a second number:
 * it is the same question, "has this stopped being part of the present scene?", and a duplicated
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
 * This used to be an English word list (`none|nothing|nil|empty|no|n/a|unknown|...`) that refused
 * a model-reported item name. That was fold second-guessing the model's structured report with a
 * vocabulary that could only work in one language, the enumerated list §11 bans. The delta schema
 * instruction is the contract now: "Use empty arrays when an event changes nothing" and "Record
 * only what the excerpt NAMES." If a model reports an item named "none" anyway, that is the model's
 * error: visible on the panel, correctable, and the review probe re-reads the ledger. fold stores
 * what the model reports; the only refusal left here is structural (an empty string).
 */

/**
 * The content words of a status phrase, with short noise removed.
 *
 * The old `STATUS_MODIFIERS` stoplist (an English modifier list that guessed what a condition was
 * about) is gone: the mark's `subject` comes from the delta schema. The remaining token filter is
 * structural, length, and means the same in every language.
 */

/**
 * What a status phrase is ABOUT, as opposed to what it says.
 *
 * The whole phrase is the wrong key. Keyed that way, "mild hangover" and "hangover mostly eased"
 * are two independent facts, both true, both rendered, which is how a panel ends up reporting a
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
 * The content words of a status phrase, with short noise removed.
 *
 * No English modifier stoplist: the mark's `subject` comes from the delta schema, and the only
 * filter here is structural token length, which means the same thing in every language.
 * @param {string} flag A status phrase.
 * @returns {Set<string>} The tokens that carry meaning.
 */
function contentTokens(flag) {
    return new Set(String(flag ?? '')
        .toLowerCase()
        .split(/[^a-z0-9']+/)
        .filter(token => token.length > 2));
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
 * The morphology hole, measured, and the smallest structural rule that closes it.
 *
 * `fatigued` and `mild fatigue` sat in the live Solo Leveling header as two live flags for one
 * condition (`FOLD-REDESIGN.md` §0.1-4). `contentTokens` has no morphology, so `statusKeyFor`'s
 * overlap test compared {fatigued} against {fatigue} and correctly found no shared member, two
 * facts, both true, both rendered, about one tired man.
 *
 * The tempting fix is a stemmer or a suffix list (`-ed`, `-ing`, `-s`), and it is the shape §11 bans
 * with a standing measurement: an enumerated judgement about English applied without the care the
 * enumeration implies. What is used instead is structural rather than lexical, the same licence
 * `isExposition` claims for its grammatical test: **English inflects at the END of a word**, so a
 * shorter content word that is a PREFIX of a longer one is the same word wearing an inflection.
 * No list of suffixes, no list of stems, no vocabulary to keep current.
 *
 * What it does on the real corpus.
 *
 * Run over every `st` flag in all four live chats (n = 27 distinct across Solo Leveling 17, Raccoon
 * City 8, Evil Hero Party 2, Nora 0), the prefix branch fires on exactly ONE pair that the token
 * overlap does not already catch, `fatigued` / `mild fatigue`, and on nothing else. Zero false
 * positives, including the pairs it was most at risk of merging: `bandaged` / `rebandaged` (a prefix
 * in the wrong direction: an inflection lands on the end, so `re-` is correctly not seen),
 * `mild hangover` / `hangover mostly eased` (already merged by plain overlap), and
 * `mild arm fatigue` / `mild fatigue` (ditto).
 *
 * What it does not cover, stated rather than hidden: irregular morphology and synonymy. `bled` will
 * not merge with `bleeding`, and `winded` will never merge with `out of breath`. Those are the
 * review's identity question, which is where §3 puts near-duplicate marks on one owner in the first
 * place: this rule exists to stop the cheapest and commonest case from needing a question at all.
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
 * Scoped to one owner, which is the whole of Phase D in one line.
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
 * '' is a real value and means "nobody said", every `st` delta written before Phase D
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
 * Same NUL separator and same reason as `itemKey` and `entityKey`: a separator that cannot occur in
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
 * The subjectless count this replaces, and the weighting.
 *
 * `verdict.js` read `state.snapshot().status.length`, a count of a flat, subjectless table, so the
 * ambush that wounded Lee and Park made SOLOMON two steps worse at everything for the rest of the
 * session (`FOLD-RPG-GAP.md` §3, `FOLD-REDESIGN.md` §3). It is now the pov's marks and nobody
 * else's, which is the whole point of putting a `who` on a state change.
 *
 * Severe counts 2 and everything else 1, and the coarseness is deliberate. `adjudicate` subtracts
 * this from a base of small integers (`verdict-table.js`), where momentum is ±1 and a disposition is
 * ±1, so a scale with more steps would make injury dominate every other term in the verdict, and
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
 * The fourth wound, and why nothing is ever simply dropped.
 *
 * Fate's rule when the slot you need is taken is to **escalate**, take a bigger consequence, and
 * only when nothing is left are you taken out. Fold has no "taken out" band and no dice to absorb, so
 * it keeps the half of that rule that is about bookkeeping and refuses the half that is about
 * resolution. Concretely, when a fourth affliction arrives on a full row:
 *
 *   incoming ≥ mildest held   the mildest is displaced and the incoming takes its slot. The three
 *                             worst things wrong with a person are what "what is wrong with this
 *                             person" means; a graze superseded by a broken arm is not information
 *                             lost, it is information ranked.
 *   incoming < mildest held   the incoming does NOT get a slot, and the mildest held ESCALATES one
 *                             step. This is the branch that makes the cap honest rather than a
 *                             silent ceiling: a fourth hurt on a body already carrying three worse
 *                             ones is not nothing, and the only true thing to say about it is that
 *                             the person is now worse off than they were. It is exactly Fate's move
 *                             ("the slot is taken, so it costs you more"), with fold's arithmetic.
 *
 * The two rejected alternatives, recorded with what killed them:
 *
 *   · **Refuse the fourth mark** (the `flags-full` treatment inventory gets). Refusal is right for a
 *     bounded LIST, a 65th item is a proposal fold declines, and wrong for a body, because the
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
 * "Thinkpad (closed", a qualifier is not decoration, and the truncation is visible to the user.
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
    // The key is lowercased; the NAME the story wrote is not.
    //
    // This lowercased once and kept only that, so `SIG P226` and `KV Cache` were destroyed at write
    // time and the panel's `sentenceCase` could only ever produce `Sig p226` and `Kv cache`. Casing
    // carries meaning a display heuristic cannot reconstruct: initialisms, model numbers, proper
    // nouns, trade names. `entity-table.js` `normalizeEntityName` already solved this by returning
    // `{key, display}`: same split here, same reason.
    //
    // The key stays lowercase so `SIG P226` and `sig p226` remain one row. Only the face changes.
    let text = stripDecoration(raw).toLowerCase();
    let shown = stripDecoration(raw);
    if (!text) {
        return null;
    }

    let qty = null;

    // Leading "3x " / "3 × " / "3 "
    const leading = text.match(/^(\d{1,5})\s*(?:x|×)?\s+(.*)$/);
    if (leading) {
        qty = Number(leading[1]);
        text = leading[2].trim();
        shown = shown.replace(/^\s*\d{1,5}\s*(?:x|×)?\s+/i, '').trim();
    } else {
        // Trailing " x3" / " ×3"
        const trailing = text.match(/^(.*?)\s*(?:x|×)\s*(\d{1,5})$/);
        if (trailing) {
            qty = Number(trailing[2]);
            text = trailing[1].trim();
            shown = shown.replace(/\s*(?:x|×)\s*\d{1,5}\s*$/i, '').trim();
        }
    }

    text = text.replace(/[.,;:]+$/, '').trim().slice(0, MAX_ITEM_NAME);
    shown = shown.replace(/[.,;:]+$/, '').trim().slice(0, MAX_ITEM_NAME);

    if (!text || UNSAFE_KEYS.has(text)) {
        return null;
    }

    return {
        name: text,
        // The story's own casing, for the panel and the injected block. Falls back to the key when
        // stripping left nothing recognisable.
        display: shown || text,
        qty: Number.isFinite(qty) && qty > 0 ? Math.min(qty, MAX_QTY) : null,
    };
}

/**
 * Normalize a vital or flag name.
 * @param {string} raw Raw name.
 * @returns {string|null} Normalized name, or null if unusable.
 */
export function normalizeKey(raw) {
    const text = stripDecoration(raw).toLowerCase().replace(/[.,;:]+$/, '').trim().slice(0, MAX_ITEM_NAME);
    if (!text || UNSAFE_KEYS.has(text)) {
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
 * on collision, so handing it `{dq}` would store `{dq}` for the first sighting of an item, with
 * no quantity at all. Seeding the key first means the merge runs every time and the stored shape
 * is always `{qty}`.
 *
 * The place is read off the KEY, and until Phase C it was not read at all.
 *
 * `merge_qty` picks its ceiling with `maxQty(nu?.at ?? old?.at)`, and this function used to hand it
 * a bare `{dq}`: no `at` on the incoming value, and none on the stored one either, because the
 * stored shape is `{qty}`. So `maxQty(undefined)` returned MAX_QTY for EVERY dq-sourced change,
 * including money, a `{item: "won", dq: 360000, at: "money"}` delta clamped to 9,999 despite being
 * correctly tagged, and the pinned `Money:` line then lied about the balance for the rest of the
 * chat. Only `setQty` (the restated-total path) ever read the place, which is why the hand repair's
 * `{set: 210000, at: "money"}` landed and the raid payout at mid 46 of the live Solo Leveling chat
 * did not (`FOLD-RPG-GAP.md` §0, "money | won ×9,999 | ₩330,000"; the analysis is Phase A's LANDED
 * note in `FOLD-REDESIGN.md` §10).
 *
 * The key already carries the place, `itemKey` puts it there and `splitItemKey` takes it back,
 * so the ceiling is derivable rather than something the caller has to remember to pass. That is
 * the same argument `setQty` makes two functions below, applied to the path that was missing it.
 *
 * ⚠ It fixes the clamp, not the tagging. The event actually recorded at mid 46 reads
 * `{"item":"won","dq":360000}` with no `at` at all, so it keys as `carried␀won` and is still capped
 * at MAX_QTY, correctly, since a carried object is not a balance. Getting THAT delta into the
 * money place is the delta instruction's job (`state.js` `deltaInstruction`, "Money is at: money")
 * and the directed money question's, not a currency word list here, `FOLD-REDESIGN.md` §11 rules
 * those out with a standing measurement.
 *
 * @param {Map<string, {qty: number}>} table Inventory table, mutated.
 * @param {string} name Full inventory key, place and name, as `itemKey` builds it.
 * @param {number} dq Quantity change.
 * @returns {number} The resulting quantity.
 */
/**
 * The name an item is already known by in a given place.
 *
 * Identity is the model's answer, not fold's: when the model says `same_as` names a held item,
 * that name IS the row it meant, the model resolved the spelling itself. Otherwise fold keys
 * under exactly what the model reported; it never merges two spellings on its own. The old
 * head-token rule (`POST_HEAD`/`WEAK_TOKENS`) and the exact-key stopgap it became are both gone:
 * whether "m-65 military jacket" is "m-65 jacket" is a question fold asks the model, not a guess
 * fold makes from words.
 *
 * `same_as` is answered against what the ledger PRINTED, not against the key alone.
 *
 * The rule above is right and the comparison was too narrow. The model does not read fold's key
 * space; it reads the line `renderLedger` put in front of it, and that line is not the key. It is
 * `‹face› ‹rank› x‹qty›`: the story's own casing, the grade appended, and the count. So the model
 * copies back exactly that, and an exact test against `itemKey(said)` cannot match it.
 *
 * MEASURED over every trace file on disk, 1,543 inventory deltas, 215 of them carrying a
 * `same_as`. **25 of those 215 (11.6%) cannot match by construction**, and every one is the model
 * quoting the rendered line:
 *
 *   item `9mm rounds`               same_as `ammunition x29`          ← the count
 *   item `low-grade spirit stone`   same_as `low-grade spirit stone x3`
 *   item `wolf pelt`                same_as `wolf pelts x3`
 *   item `misty moon lotus`         same_as `misty moon lotus Tier-1` ← the grade
 *   item `cracked copper beast core` same_as `cracked copper beast core Nascent Rank 1`
 *   item `basic iron sword`         same_as `Basic Iron Sword`        ← the story's casing
 *   item `ka-bar knife`             same_as `Ka-Bar`
 *
 * Each is a merge the model explicitly asked for and fold silently declined, and a declined merge is
 * a second row, the exact duplicate the field exists to prevent. So the candidate set is every
 * string the ledger could have shown for a held row, and the test stays EXACT against all of them:
 *
 *   1. the key itself, lowercased, unchanged, and still the first thing tried.
 *   2. the key after `normalizeItemName`, which strips decoration, folds case and pulls a trailing
 *      `x3` / `×3` out of the name. That is the same normaliser the `item` field already goes
 *      through, so `same_as` is finally read the way `item` is.
 *   3. the rendered label of each row in the same place and owner: its face, its `face rank`, and
 *      its `name rank`. Built from fold's OWN table and its OWN renderer, never from the narrative.
 *
 * No stemming, no stopwords, no token overlap, no similarity score. Every branch is string equality
 * against something fold itself wrote down, which is what keeps this on RULE 1's structure side.
 *
 * @param {Map<string, {qty: number, rank?: string}>} inv Inventory table, place-keyed.
 * @param {string} name Normalized item name.
 * @param {string} [place] Raw place.
 * @param {string} [sameAs] The model's own answer: the exact held name this is a spelling of.
 * @param {string} [who] Whose belongings to resolve against.
 * @param {Map<string, string>|null} [faces] Key -> the name the story wrote, so the rendered label
 *   is in the candidate set. Null when the caller has no face map, which loses only branch 3.
 * @returns {string} The canonical name to key under.
 */
export function canonicalItemName(inv, name, place, sameAs = '', who = '', faces = null) {
    const where = normalizePlace(place);
    const said = String(sameAs ?? '').trim().toLowerCase();
    // The model's answer is the authority. Only an exact match against a held key counts, fold
    // does not fuzzy-match its own guess against the model's word. Scoped to the owner, because
    // "the same one you already have" is a claim about one person's belongings: Kaelira's branch
    // may not be renamed onto Solomon's row by a `same_as` that happens to match it.
    if (said && inv.has(itemKey(said, where, who))) {
        return said;
    }
    if (said) {
        // Branch 2: the same normaliser `item` goes through. `ammunition x29` becomes `ammunition`.
        const cleaned = normalizeItemName(said)?.name ?? '';
        if (cleaned && cleaned !== said && inv.has(itemKey(cleaned, where, who))) {
            return cleaned;
        }
        // Branch 3: what the ledger printed for each row here. Exact equality against fold's own
        // rendering, the inverse of the string `renderLedger` built, and nothing more.
        const printed = renderedNames(inv, where, who, faces);
        const hit = printed.get(said) ?? (cleaned ? printed.get(cleaned) : undefined);
        if (hit) {
            return hit;
        }
    }
    if (inv.has(itemKey(name, where, who))) {
        return name;
    }
    return name;
}

/**
 * Every string the ledger could have shown for a row in one place, mapped back to its key name.
 *
 * The candidate set for `same_as` branch 3. Lowercased on both sides because the key half already
 * is; a collision between two rows' labels resolves to the first, which is the ledger's own order.
 *
 * @param {Map<string, {rank?: string}>} inv Inventory table.
 * @param {string} where Normalized place.
 * @param {string} who Owner name or key.
 * @param {Map<string, string>|null} faces Key -> the name the story wrote.
 * @returns {Map<string, string>} Printed label -> the name to key under.
 */
function renderedNames(inv, where, who, faces) {
    const out = new Map();
    const owner = ownerKey(who);
    for (const [key] of table_entries(inv)) {
        const parts = splitItemKey(key);
        if (parts.place !== where || parts.who !== owner) {
            continue;
        }
        const rank = String(lookup(inv, key, {}).rank ?? '').trim().toLowerCase();
        const face = String(faces?.get(key) ?? '').trim().toLowerCase();
        for (const label of [face, rank && `${parts.name} ${rank}`, rank && face && `${face} ${rank}`]) {
            if (label && !out.has(label)) {
                out.set(label, parts.name);
            }
        }
    }
    return out;
}

/**
 * Fold one delta into the capability table.
 *
 * Abilities were never inventory, and the count was the tell.
 *
 * `ABILITIES` was a reserved PLACE, a value of the same field that holds `carried`, `assets`,
 * `money` and "the car boot", so a technique was stored as a thing with a quantity that lives
 * somewhere. Every consequence of that followed mechanically and every one of them is wrong:
 *
 *   · **A count.** `tier 3 access ×1` is on the live Raccoon City panel. There is no ×2 of a
 *     clearance level, and the model reporting the same grant twice, which it did, at mids 83 and
 *     86 of that chat, proposed exactly that. The count face makes a re-report an accumulation;
 *     presence makes it a no-op, which is what a re-report of a permanent fact should be.
 *   · **A location.** "Where is your quarterstaff proficiency" has no answer, and `renderState`
 *     printed one anyway: `Stored (abilities): …`, beside `Stored (the SUV)`.
 *   · **A disposal question.** `isDisposable` had to be taught to exclude the ability place by hand
 *     after the review destroyed five of the six techniques a Wuxia campaign ever learned, asking
 *     "are you still carrying this?" about a technique has one honest answer and it deletes the row.
 *     That fix stands; this removes the need for it.
 *   · **A shared ceiling.** Sixty-four rows between a pack and a skill tree.
 *
 * The shape, and why it is `standing`'s and not `flows`'.
 *
 * `standing` (`deriveState`, below) is the closest precedent: an open-ended attribute pair, keyed by
 * owner and subject, valued by something fold stores and never interprets, folded last-write. An
 * ability is that plus one bit, you either have it or you do not, and its grade is the same opaque
 * free-text `rank` an item already carried, for the same stated reason: F/E/D/C/B/A/S, "Amateur",
 * 47/100 and "Lv. 12" are all real, and any ordering fold imposed would be fold deciding that D
 * beats E. So `rank` stays exactly where it is and keeps its meaning; what changes is that it is now
 * a property of a capability rather than a property of a thing in a bag.
 *
 * `flows`' shape, a side table keyed independently of the fold, was the alternative and is
 * rejected: an ability is granted and revoked BY EVENTS, so it belongs in the ledger for the reason
 * marks do (`deriveState`, the three-option note). A stored table would survive a swipe that undoes
 * the turn the technique was learned in.
 *
 * The key is unchanged (`itemKey(name, ABILITIES, who)`), which is what makes this cost no
 * migration: `contributors`, `since`, `faces`, the crosswalk and every hand edit address rows by it.
 *
 * The rules.
 *
 *   gained  `dq > 0`, or a restated `set > 0`: the row exists. Idempotent: asserting a capability
 *                                                you already have changes nothing but its grade.
 *   lost    `dq < 0`, or a restated `set <= 0`: the row is gone. Revocation is a real event (the
 *                                                live `tier 4 access` at mid 120 is one).
 *   graded  `dq === 0` with a `rank`: last-write onto a row that ALREADY EXISTS. Never
 *                                                creates one, for the reason the inventory branch
 *                                                gives: a grade for something never acquired would
 *                                                let a passing mention become a skill.
 *
 * @param {Map<string, object>} abilities The capability table, mutated.
 * @param {string} key The row key, as `itemKey(name, ABILITIES, who)` builds it.
 * @param {object} change What the delta said.
 * @param {boolean} change.restated Whether the delta stated a total rather than a change.
 * @param {number} [change.set] The stated total.
 * @param {number} change.dq The stated change.
 * @param {string} change.rank The grade, verbatim.
 * @returns {{dq: number, touched: boolean}} +1 gained, -1 lost, 0 neither; and whether the row moved.
 */
export function foldAbility(abilities, key, { restated = false, set, dq = 0, rank = '' } = {}) {
    const parts = splitItemKey(key);
    const has = abilities.has(key);
    const grade = String(rank ?? '').trim().slice(0, MAX_ITEM_NAME);
    const stated = restated ? Math.trunc(Number(set) || 0) : 0;

    if (restated ? stated <= 0 : dq < 0) {
        // Nothing to retract is not a retraction. Reporting it as one would put a −1 in the trail of
        // a row that never existed.
        if (!has) {
            return { dq: 0, touched: false };
        }
        abilities.delete(key);
        return { dq: -1, touched: true };
    }

    if (restated ? stated > 0 : dq > 0) {
        // Last-write on the grade, presence-only on the fact. An empty grade never erases one: the
        // model reporting a technique without its rank is the exact live case that made
        // `quarterstaff proficiency (e)` and `quarterstaff proficiency` two rows, and silence about
        // a grade is not a statement that it has none.
        insert_with(abilities, merge_b, key, {
            who: parts.who,
            name: parts.name,
            ...(grade || lookup(abilities, key, {}).rank ? { rank: grade || lookup(abilities, key, {}).rank } : {}),
        });
        return { dq: has ? 0 : 1, touched: true };
    }

    if (grade && has) {
        insert_with(abilities, merge_b, key, { ...lookup(abilities, key, {}), rank: grade });
        return { dq: 0, touched: true };
    }
    return { dq: 0, touched: false };
}

/**
 * Write an absolute quantity, the way a restated total means it.
 *
 * The Map face rather than the Count face, deliberately. A total is a last-write-wins assertion
 * about the present, so folding the same one twice has to be a no-op, which is exactly the
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
 *
 * A zero ceiling is silence, not a ceiling of zero.
 *
 * `Number.isFinite(0)` is true, so an explicit `max: 0` used to be taken as the ceiling, and since
 * `cur` clamps to it, the reported change was destroyed on arrival. Measured in the live My Hero
 * Academia RP: `{name:"mana", dcur:80, max:0}` at mid 94 folded to `{max: 0, cur: 0}`, and the panel
 * read `Mana 0/0` for the rest of a campaign whose entire subject is output percentages and hold
 * durations.
 *
 * The model had no way to avoid it. `state.js`'s schema calls `max` a "Ceiling; send only when newly
 * established, then omit afterwards" and lists it in `required`, which strict mode makes mandatory
 * on every row, so the omission the description asks for is unexpressible and 0 is what a model
 * sends instead. The identical trap was already reasoned through for the sibling field, in
 * `validateInventory`: "`set: 0` is not a total, nothing is held at zero, and strict mode forces
 * the field into every row, so a 0/null `set` on an ordinary delta must read as 'not a
 * restatement'." Same rule, same reason, applied here at last.
 *
 * Nothing is lost by refusing zero: a vital whose ceiling is genuinely zero is a vital that cannot
 * hold anything, which is not a thing a story tracks.
 *
 * …and an ABSENT ceiling is silence too, which is a second thing this invented.
 *
 * The paragraph above establishes that a stated `max: 0` means "not stated". The fallback then
 * turned round and invented one anyway: `?? 100` gave an unbounded quantity a hundred-wide pool, and
 * `base = max` declared it full before a single event had said what was in it.
 *
 * MEASURED, live Raccoon City campaign. Its one and only vital event is
 * `{name: "ammunition", dcur: -1}` at mid 138, a single shot fired from an SUV window. It folded to
 * `Ammunition 99/100`: a ceiling nobody stated, a starting value nobody stated, and one real datum.
 * Meanwhile the same campaign held `ammunition ×29`, `9mm rounds ×1` and `shotgun shells ×1` in the
 * INVENTORY, so the same quantity existed in two substrates with two different numbers.
 *
 * `reconcile_ok` (`sanguine/proof/Closures/Applied/DerivedState.lean:105`) is a theorem about
 * clamping to a real ceiling and `trust_can_break` (`:115`) is the branch that does not; a defaulted
 * ceiling is neither, it makes the clamp a fabrication engine. The corpus's shape for an unbounded
 * quantity is the group fold (`balance l = foldKey id l`, `:59`, with `refund_is_exact` at `:77`),
 * and this file already implements it as `merge_qty`. sanguine's own vocabulary draws the same line:
 * "gauge" for a pool with a current and a maximum, "counter" for an unbounded quantity, coin, ammo,
 * charges (`review-table.js`, the sheet classifier).
 *
 * So the ceiling is used when it was attested and nothing stands in for it when it was not:
 *
 *   · attested, unchanged in every respect, the "arrives full, then takes its damage" case
 *     included. `{dcur: -26, max: 70}` still folds to 44, which is what the seeding note below is
 *     about.
 *   · unattested, `max: 0`, the sentinel every reader in this codebase already understands as
 *     "no ceiling stated", and the count accumulates from zero with only the floor applied.
 *
 * Routing such a row to the inventory fold, where removal is exact, is the sheet classifier's job
 * and not this merge's. What this merge owes is to stop inventing the two numbers it was never told.
 */
export const merge_vital = (nu, old) => {
    const stated = Number.isFinite(nu?.max) && nu.max > 0 ? nu.max : 0;
    const max = stated || (old?.max ?? 0);
    // A gauge with a ceiling arrives full; a count with no ceiling arrives at nothing. The only
    // honest base for "you were never told how much of this there is" is zero.
    const base = Number.isFinite(old?.cur) ? old.cur : (max > 0 ? max : 0);
    const next = base + (nu?.dcur ?? 0);
    return { max, cur: max > 0 ? Math.max(0, Math.min(max, next)) : Math.max(0, next) };
};

/**
 * How a vital name should read on the panel and in the injected block.
 *
 * Vital names are stored lowercased for key stability (`normalizeKey`), so display casing is
 * applied here, the same division of labour the item names have (`stripDecoration` +
 * `sentenceCase`). Two shapes:
 *
 *   · A classic RPG initialism reads better all-caps. "hp" becomes "HP", not "Hp", a vital bar
 *     labelled "Hp 0/70" reads as a typo.
 *   · Everything else is sentence-cased ("stamina" → "Stamina").
 *
 * This is a display table, not a judgement list: it never decides what the narrative means, it
 * only formats a key fold already chose, and any name outside the set falls back to sentence-case.
 * That is the boundary §11 draws (enumerated *judgements* are forbidden; formatting is not).
 */
/**
 * How a vital reads in a block the model will read back.
 *
 * `max: 0` is "no ceiling was ever stated" (see `merge_vital`), so a count prints as a count.
 * `Charges 6/0` reports a bound nobody set, and a denominator in the injected block is a fact the
 * narrator then has to reason against, which is how an invented hundred becomes an ammunition
 * economy nobody wrote.
 *
 * @param {string} name The vital's key.
 * @param {{cur: number, max: number}} v The folded row.
 * @returns {string} One reading.
 */
export function vitalReading(name, v) {
    const cur = Math.round(Number(v?.cur) || 0);
    const max = Math.round(Number(v?.max) || 0);
    return max > 0 ? `${vitalLabel(name)} ${cur}/${max}` : `${vitalLabel(name)} ${cur}`;
}

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
 * This docblock described head-of-noun-phrase matching for a long time after it stopped doing it.
 *
 * It said matching was on the HEAD, "healing potion (minor)" heading on "potion", `itemHead`
 * truncating at the preposition so `rusty hunter's knife with sheath` matched a window saying "the
 * knife". None of that is here. The body is `haystack.includes(needle)`, whole-string containment,
 * and `itemHead` (`block-parse.js`) is now `String(name ?? '')`: an identity function. The RULE 1
 * sweep gutted it correctly, because head-token extraction is English morphology, but nothing
 * replaced it for the COVERAGE question, so this test silently degraded to a form a descriptive name
 * cannot pass. `scroll bound with a faded red cord` never appears verbatim in prose.
 *
 * What replaced it is `coveredByReport` below, the model's own `mentions` report, matched by token
 * containment on fold's keys. This function survives ONLY as the fallback for the block path, which
 * carries no report, and as the residue of the model under-reporting its own coverage. It is a
 * substring test on message text, which RULE 1 forbids and names by this function's own name; the
 * instruction fix in `state.js deltaInstruction` is the work that makes deleting it possible.
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
    return haystack.includes(needle);
}

/**
 * Does the model's own coverage report name this thing?
 *
 * `mentioned` is the set of phrases the model said the excerpt uses, verbatim, "the scroll",
 * "twenty silver wen", "coins". A delta carries fold's KEY for the same thing, "scroll bound with
 * a faded red cord", "silver wen", "copper coins". Those are two different vocabularies for one
 * object, and exact set membership requires them to coincide, which they mostly do not.
 *
 * MEASURED across every trace, 472 inventory deltas: exact membership admits 53%. Adding the token
 * relation below takes the report's own admission much higher, and against the FULL current gate
 * (exact membership OR the window substring test) it recovers 20 deltas, 4.2%, including the pair
 * that started this audit, `scroll bound with a faded red cord` and `clay vessel sealed with wax
 * bearing the spiral stamp`, both of which the model reported as "the scroll" and "clay vessel".
 *
 * The relation is strict token containment in either direction, which is `nearIdentity`'s algebra
 * (`thread-table.js`) and RULE 1's STRUCTURE clause: a set operation on fold's own keys, no
 * morphology, no stoplist, no head extraction, the last of which is why this is needed at all.
 * `itemHead` was gutted to an identity function by the RULE 1 sweep (English head-token extraction
 * is exactly what that rule forbids) and `isMentioned`'s docblock above still describes the
 * behaviour it used to have; nothing replaced it, so the coverage test silently became
 * whole-string containment. A descriptive name cannot pass whole-string containment.
 *
 * What it deliberately does NOT do is bridge a rename: the model reporting "pendant" while the
 * delta says "jade trinket" shares no token, and no set operation reaches it. That is record
 * linkage: the review probe's `[same?]`, not this gate's business.
 *
 * @param {string} name The delta's name, normalized.
 * @param {Set<string>|null} mentioned Phrases the model reports the excerpt uses, lowercased.
 * @returns {boolean} True when the report covers this name.
 */
export function coveredByReport(name, mentioned) {
    if (!mentioned || !mentioned.size) {
        return false;
    }
    const needle = String(name ?? '').toLowerCase().trim();
    if (!needle) {
        return false;
    }
    if (mentioned.has(needle)) {
        return true;
    }
    const tokens = new Set(needle.split(/[^0-9a-zÀ-￿]+/i).filter(Boolean));
    if (!tokens.size) {
        return false;
    }
    for (const phrase of mentioned) {
        const other = new Set(String(phrase).split(/[^0-9a-zÀ-￿]+/i).filter(Boolean));
        if (!other.size) {
            continue;
        }
        const [small, large] = tokens.size <= other.size ? [tokens, other] : [other, tokens];
        let contained = true;
        for (const token of small) {
            if (!large.has(token)) {
                contained = false;
                break;
            }
        }
        if (contained) {
            return true;
        }
    }
    return false;
}

/**
 * Validate proposed inventory deltas against the narrative and the current state.
 *
 * Runs once, when an event is recorded, not on every fold. Rejected deltas never reach the
 * ledger, so the fold is a pure sum over changes that were already justified.
 *
 * `already-recorded`: the gate that closes the double-billing loop.
 *
 * The window split (`extract-table.js`) stops the model being *shown* an old beat as if it were
 * new; this stops it *billing* one that leaked through anyway, because the narration in the new
 * half re-tells it. Both were needed, and the live ledger says why: the phone-number exchange is in
 * it three times (events at mids 50, 52 and 54), the candies twice (54 and 58), the goblin knife
 * twice (22 and 38), and the staff-and-shortsword purchase three times (60, 66, 68). Every one of
 * those is one thing that happened once.
 *
 * A refusal may not rest on a beat the model cannot see.
 *
 * `visible` is the set of mids this pass displayed, `splitWindow`'s `seen`, both halves, the
 * older one already headed "already recorded, extract nothing from this". BOTH gates below are
 * conjoined with it, and that conjunction is the whole correction. Without it the trail is
 * unbounded history: once you have picked one bundle of nightshade you may never pick one again,
 * and once you have bought a two-gold mug of mead every later two-gold purchase is a re-tell.
 *
 * Measured over the six live chats that carry a rejection log, 53 `already-recorded` refusals:
 *
 *   · 41 at distance 1-4 from the trail entry they matched. Every one is a real re-tell.
 *   · 12 at distance 13, 15, 17, 18, 19, 21, 22, 22, 37, 47, 50 and 110. Every one is a purchase
 *     or a harvest that really happened, New Eldoria's pack (mid 128, matched at 115) and its
 *     whole trail kit, Time Stop's waterskin and rope re-supply (mid 60, matched at 38), Royal
 *     Succession's second `marks -500` (mid 295, matched at 258).
 *
 * And from the other direction, every same-key same-`dq` pair that BOTH reached a live ledger,
 * the duplicates this gate exists to stop, sits at distance 0, 1, 1 or 2. The window is six and
 * passes run every two, so a re-tell is an artifact of overlap and has nowhere else to come from.
 * Nothing in the corpus occupies the gap between 2 and 13.
 *
 * The rule, and every condition in it is load-bearing:
 *
 *   1. `shown` is a Set of the inventory keys the pinned ledger actually put in front of the model
 *      this pass. Not "everything held", the ledger drops stale carried items (`isFresh`,
 *      `state-table.js:1157-1173`), and refusing a delta for a line the model was never told about
 *      would punish it for our own omission. A null `shown` turns the gate off entirely, which is
 *      what happens on any path that does not pin the ledger (block absorption, `absorb.js:114`).
 *   2. Either sign, under a magnitude bound. The gate used to fire on positive `dq` only, on the
 *      claim that "a loss is never a restatement, nobody re-narrates dropping something". The Time
 *      Stop RPG ledger falsified that: one spear purchase billed twice (mids 36 and 38), one room
 *      rental twice (73 and 74), one locket give-back twice (66 and 67). `Math.abs(dq) <= held`
 *      means the change is already fully present in the current quantity. It is load-bearing in
 *      both directions: New Eldoria took two 9-silver payments of change five messages apart
 *      (mids 164 and 169) and only the held quantity, 8, short of 9, kept the second one.
 *   3. Not a restated total (`set`). Those are the Map face and idempotent by construction; that is
 *      the whole argument in `setQty` below.
 *   4. The key is already held at `qty >= dq`. Gaining three of something you have one of is not a
 *      re-report of the one; it is refused only when the ledger already covers the whole proposal.
 *   5. Money is exempt from the `shown` gate and not from the trail: a balance is not evidence
 *      about a payment, but a recorded payment of the same amount, still on screen, is.
 *   6. A visible contribution to the key must exist. No trail entry means no recorded beat to have
 *      been re-told, which is the rule the debit side already kept ("a loss with no trail is not a
 *      restatement") applied to the credit side as well.
 *
 * The contributor trail closes what `shown` cannot.
 *
 * The shown-based gate only fires when THIS pass's pinned ledger showed the line, and never for
 * money. The trail (`deriveState` builds it, keyed by item key, carrying the anchor mid of the pass
 * that recorded each contribution) catches a re-record the ledger did not carry. An EXACT `dq`
 * match against a visible entry is arithmetic on fold's own recorded numbers, not the similarity
 * metric §11 refuses, which is about reading the narrative.
 *
 * The recall channel is deliberately NOT built.
 *
 * A beat can also reach the model through recall, which re-shows past event summaries to the
 * narrator (`index.js` `applyRecallBlock`, which already records exactly which). That would be the
 * second half of `visible`. It is not built, because no measurement asks for it: the only evidence
 * ever offered for a long-distance re-tell was "the Eunpyeong ₩680,000 payout, mids 128 and 142",
 * and that pair is not reproducible, `Solo Leveling The Eve of the Double Dungeon` carries
 * `won +680000` exactly once, at mid 131, and has never recorded an `already-recorded` refusal at
 * all. When a duplicate past distance 2 is measured, union the recalled mids into `visible`; the
 * signature does not change.
 *
 * What this still refuses that it should not.
 *
 * Buying a second identical knife while carrying the first, IN THE SAME WINDOW as the first. Within
 * six messages nothing in a `{item, dq, at}` delta separates that from re-reporting the first, and
 * the corpus says re-telling is what actually happens there. The cost is bounded and visible: the
 * refusal is counted as `reject:already-recorded` and the user can add the second knife by hand
 * (`state.adjustItem`), which records it as the user event it is.
 *
 * What it does NOT catch, and this is measured too: a re-tell that revises the number. New Eldoria
 * mid 106 recorded `gold -16`; mid 108 re-told the same handover as `gold -17` and it was accepted,
 * because the discriminator is exact `dq`. Nothing in fold's own data separates a corrected
 * magnitude from a second payment, that one needs an owner on the key, or the model asked.
 *
 * @param {object} params Parameters.
 * @param {Map<string, {qty: number}>} params.inv Inventory as currently derived.
 * @param {Array<{item: string, dq: number}>} params.deltas Proposed changes.
 * @param {string} params.windowText Narrative window, for the mention gate.
 * @param {number} [params.budget] Accepted changes allowed.
 * @param {Set<string>|null} [params.shown] Inventory keys the pinned ledger showed the model this
 *   pass; null when no ledger was pinned, which disables the already-recorded gate.
 * @param {Set<string>|null} [params.mentioned] Names the model reports the excerpt uses,
 *   coverage by report, not a substring proxy ([ROUTER]). When present it replaces the token
 *   mention gate.
 * @param {Map<string, Array<{dq: number, mid: number|null}>>} [params.contributors] The contributor
 *   trail per item key, for cross-window re-record refusal. Null disables the trail check.
 * @param {Set<number>|null} [params.visible] The mids this pass displayed (`splitWindow`'s `seen`).
 *   A contribution outside it cannot be what the model is re-telling, so it refuses nothing. Null
 *   turns both already-recorded gates off, the same fail-open `shown` already takes, and for the
 *   same reason: a caller that cannot say what the model saw must not be allowed to refuse on it.
 * @param {Map<string, object>|null} [params.cast] The cast table, for resolving a delta's `who`.
 *   Threaded exactly as `validateStatus` takes it, and refused the same way: a NAMED owner that
 *   matches no cast row is `reject:unknown-owner`, because an invented owner opens a row-shaped
 *   hole nothing will ever close. Null is the honest degradation for callers with no table.
 * @param {string} [params.pov] The point-of-view character, for the empty-`who` default.
 * @returns {{accepted: Array<{item: string, dq: number}>, rejected: object[]}} Outcome.
 */
export function validateInventory({ inv, deltas, windowText, budget = MAX_CHANGES_PER_TURN, shown = null, mentioned = null, contributors = null, visible = null, cast = null, pov = '', abilities = null, faces = null }) {
    const accepted = [];
    const rejected = [];
    // The window excerpt every rejection records, for the caret-level diagnostics log.
    const snippet = windowSnippet(windowText);
    // Abilities are a different table and the SAME gates.
    //
    // `foldAbility` took capabilities out of `inv`, and every gate below asks a question that is
    // still exactly right about one: you cannot lose a technique you never learned
    // (`remove-unknown`), a grade change needs a row to land on (`graded`), and a re-granted
    // technique is a re-report (`already-recorded`). Re-keying them into the projection under their
    // own place, the key they were folded under and still carry, means all of that keeps working
    // with no branch. `qty: 1` because presence is the whole of what an ability's count ever meant.
    //
    // Null is the honest degradation for a caller with no ability table (the block path, the unit
    // fixtures): the gates simply see no capabilities, exactly as they see no cast without `cast`.
    const projected = new Map(inv);
    for (const [key, row] of table_entries(abilities ?? new Map())) {
        insert_with(projected, merge_b, key, { qty: 1, ...(row?.rank ? { rank: row.rank } : {}) });
    }
    // Counted apart from `accepted` because a restated total is not a change: see the
    // MAX_CHANGES_PER_TURN docblock for the measured starvation that shared counting caused.
    let changes = 0;

    for (const raw of Array.isArray(deltas) ? deltas : []) {
        const parsed = normalizeItemName(raw?.item);
        if (!parsed) {
            rejected.push({ item: String(raw?.item ?? ''), reason: 'unusable-name', raw, snippet });
            continue;
        }

        const { name } = parsed;
        // Whose, resolved at WRITE time, for `validateStatus`'s reason.
        //
        // A cast row can be merged, renamed or pruned between the turn somebody picked a thing up
        // and the turn the ledger is read back, and a name that resolved to nobody on read would
        // silently move their belongings onto the player. Resolving here means the event says whose
        // it was, permanently, and the fold cannot change its mind.
        const owner = resolveOwner(raw?.who, { cast, pov });
        if (!owner.ok) {
            rejected.push({ item: String(raw?.who ?? '').slice(0, MAX_ITEM_NAME), reason: 'unknown-owner', raw, snippet });
            continue;
        }
        // The pov's own things key with no owner segment, that is what makes every existing key in
        // every live chat still resolve. `resolveOwner` returns the pov for an empty `who` AND for
        // the pov named explicitly, so both spellings land on the same rows.
        const mine = !owner.key || owner.key === ownerKey(pov);
        const owns = mine ? '' : owner.name;
        let place = normalizePlace(raw?.at);
        // Precedent: an item already tracked as money stays money when the tag is missing.
        //
        // The mid-46 event of the live Solo Leveling chat, `{"item":"won","dq":360000}` with no
        // `at`: keyed as carried and `merge_qty` clamped it to 9,999, so the panel read a false
        // balance while the real one went unrecorded. Reading the item NAME to guess "won is
        // currency" would be the enumerated word list §11 forbids ("reading the narrative is never
        // fold's job"). This does not read the name. It reads fold's OWN state: once a `money␀won`
        // row exists, an untagged delta for "won" joins it, precedent is the oracle, the same
        // authority the adjudicator and the review use. The first payout is the only one a repair or
        // the directed-money question touches; every payout after lands right. The `troops x10000`
        // case is untouched, because troops is not an existing money row, civilisation scale still
        // passes its gate on the strength of the narrative, not of a place guess.
        // Precedent is per owner: Vexia's purse being money says nothing about Solomon's pocket.
        if (!String(raw?.at ?? '').trim() && place === CARRIED
            && lookup(projected, itemKey(name, MONEY, owns), null)) {
            place = MONEY;
        }
        // Contact details are never items.
        //
        // The delta schema instruction says so outright, and the entity probe reports contact
        // details as `reach` on the person rather than as inventory. A model that writes a contact
        // as an item anyway is violating the schema it was handed; the rejection was an English
        // word list ("contacts", "phone book", "address book") that could only work in one
        // language. The schema instruction is the contract, fold stores what the model reports.
        // The review probe re-reads the ledger and can flag a contact row it sees as wrong.
        // An absolute quantity from a restated block. Bounds-checked like everything else, but it
        // is not a magnitude of change, so the delta cap below does not apply to it.
        // `set: 0` is not a total, nothing is held at zero, and strict mode forces the field into
        // every row, so a 0/null `set` on an ordinary delta must read as "not a restatement".
        const restated = Number.isFinite(raw?.set) && (raw?.set ?? 0) > 0;
        // A quantity baked into the name ("3x potion") wins only when no explicit delta was given.
        const dq = Number.isFinite(raw?.dq) && raw.dq !== 0 ? Math.trunc(raw.dq) : (parsed.qty ?? 0);

        // A rank-up moves no quantity, and that is not the same as saying nothing.
        //
        // The whole reason `rank` is a field: "a skill that goes F→E→D is one row whose rank
        // changes, not three rows", after a live campaign showed "Quarterstaff proficiency (e)" and
        // "Quarterstaff proficiency" as two abilities. `deriveState` has a branch for exactly this
        //, a zero-delta change that lands a new grade onto an existing row.
        //
        // It could never reach it. Strict mode forces `set` into every delta, so a model reporting
        // a grade change sends `{dq: 0, set: 0, rank: "D"}` and this refusal read it as silence.
        // Measured: the validator returned `no-change`, and on the one path where such an event
        // could have been folded anyway, `set: 0` read as a restated total of zero and DELETED the
        // ability. The feature has never once fired.
        //
        // A grade with no row is still nothing, `deriveState` keeps that rule and so does this:
        // inventing a row from a passing mention of a skill would let the mention become the skill.
        //
        // What this refuses, counted, and why the fix went upstream.
        //
        // MEASURED over 2256 traced passes: 102 of 1607 proposed rows (6.3%) reach here with no
        // `dq`, no `set > 0` and no `rank`: 12 of them in the live Wuxia chat, which is that
        // chat's entire `no-change` count. Three shapes: 69 bare mentions of something already
        // held (24 of those a currency at `at: "money"`), 24 that set `same_as` to the entry's own
        // `item` string, and 9 that assert a rename carrying no quantity.
        //
        // None of them is recoverable. A row that moves nothing has nothing to fold, and accepting
        // it would put a mention into the ledger as an acquisition, the failure `already-recorded`
        // and the mention gate both exist to stop. So the gate does not move; `state.js` now says
        // in the `inv` array description, on `dq`, on `same_as` and in `deltaInstruction` that an
        // entry needs a reason to exist, which is the half that was never stated anywhere.
        const graded = String(raw?.rank ?? '').trim() && lookup(projected, itemKey(canonicalItemName(projected, name, place, raw?.same_as, owns, faces), place, owns), null);
        if (!restated && !dq && !graded) {
            rejected.push({ item: name, reason: 'no-change', raw, snippet });
            continue;
        }
        // The rate limit bounds how much a single turn may CHANGE. A restated total is not a
        // change proposal, it is the same list you already have, re-read, so counting it here
        // would let a card with nine items starve its own last item of refreshes forever.
        if (!restated && changes >= budget) {
            rejected.push({ item: name, reason: 'rate-limited', raw, snippet });
            continue;
        }
        // The strongest and cheapest rule: a model cannot invent a change to something the
        // excerpt never mentions. Admission is by the model's OWN coverage report when one exists
        // (`mentioned`: what it says the excerpt named, in any language), falling back to the
        // token test only on the block path that carries no report. ([ROUTER]: coverage, not a
        // substring proxy.)
        //
        // Coverage is the model's ATTESTATION, not fold's guess at whether two names match.
        //
        // This asked whether the delta's item name could be token-matched against the model's
        // `mentions` report or against the window text. Both halves are a similarity proxy, and
        // AGENTS.md rules that out by name: "admission is by whether the model reports the window
        // mentions a tracked line, never a similarity or substring proxy", and "identity is the
        // model's answer, never fold's".
        //
        // MEASURED across ten campaigns: `not-mentioned` is 442 of 763 rejections, 57.9% of every
        // refusal fold has ever made, and its cascade `remove-unknown` (58 more) is fold declining
        // to remove things whose acquisition it refused first. Run against the shipped
        // `coveredByReport`, the failures are inflection and function words:
        //
        //   REJECT  "low-grade spirit stone"        vs ["spirit stones"]
        //   REJECT  "copper penny"                  vs ["copper coins"]
        //   REJECT  "strip of coarse beast meat"    vs ["strips of coarse meat"]
        //   REJECT  "scroll bound with a red cord"  vs ["the scroll"]
        //   PASS    "scroll bound with a red cord"  vs ["a scroll"]
        //
        // Those last two decide it. Identical semantics, opposite verdicts, and the difference is
        // that the item name happens to contain the token `a` elsewhere in the phrase. A gate whose
        // answer turns on a coincidental article is the English-morphology defect RULE 1 forbids,
        // and a stopword list or a stemmer would be the same defect in a new coat.
        //
        // So the question fold asks changes from "do these two names match?", record linkage, the
        // model's job, to "did the model attest to anything here at all?", which is fold's own
        // structure. Three states, and the middle one is the whole point:
        //
        //   report absent (null)   the caller does not run the probe, the block path, the review's
        //                          money answer, the unit fixtures. Nothing to judge against, so
        //                          nothing is refused; the other gates still apply.
        //   report empty (size 0)  the model WAS asked and named nothing, yet proposes a change.
        //                          That is the hallucination this gate exists for, and it is the
        //                          only case it now refuses.
        //   report non-empty       the model read the excerpt and said what it names. Its delta is
        //                          its own reading of the same excerpt; re-deriving the
        //                          correspondence between two things it wrote is the proxy.
        //
        // What still catches a bad delta is untouched and is all arithmetic on fold's own keys:
        // `already-recorded`, `remove-unknown`, `invariant:overdraw`, the magnitude and growth
        // bounds, and `MAX_CHANGES_PER_TURN`. The instruction now also asks the model to word a
        // delta's item exactly as it listed it in `mentions` (`chronicle.js`), which makes the
        // attestation worth more without fold ever comparing the two.
        if (mentioned instanceof Set && mentioned.size === 0) {
            rejected.push({ item: name, reason: 'not-mentioned', raw, snippet });
            continue;
        }
        const canonical = canonicalItemName(projected, name, place, raw?.same_as, owns, faces);
        const key = itemKey(canonical, place, owns);
        // The name the story wrote, which fold has been throwing away since faces existed.
        //
        // `normalizeItemName` returns `{name, display}` precisely so `SIG P226` survives a lowercase
        // key, `deriveState` keeps a `faces` map for it, and `snapshot` reads
        // `faces.get(key) || parts.name`. None of it has ever run: the accepted delta carried
        // `item: canonical`, which is the LOWERCASE key, so by the time the fold read the event the
        // casing was already gone and there was nothing for the face map to hold. Read straight off
        // the live Raccoon City ledger, `{"item":"sig p226"}`, `{"item":"ka-bar knife"}`,
        // `{"item":"mossberg 590"}`: every capital letter the narrator wrote, discarded at the
        // write. (`deriveState` then compounded it by reading `.display` off a string; see there.)
        //
        // And ONLY when the key did not move, which is the line that keeps this honest.
        //
        // The obvious extension is to take the model's word whenever `same_as` resolved, so
        // `{item: "9mm rounds", same_as: "ammunition"}` re-labels the `ammunition` row it merged
        // into. That is wrong, and the Time Stop ledger says why in one line: the model also writes
        // `{item: "locket", same_as: "silver moon locket"}`, which is the identical shape carrying
        // the opposite intent, a shorthand for a row fold names better than the model just did.
        // Nothing in `{item, same_as}` separates a refinement from an abbreviation, and deciding
        // which is which means reading the two names, which is the record-linkage judgement fold
        // does not make (RULE 1; the `sameItemHead` deletion note in `block-parse.js` is the same
        // argument).
        //
        // So `same_as` stays what it says it is, an identity claim, never a naming one, and a row
        // is re-named only by something that says so outright: `renameDelta`, `splitDelta`, or the
        // model proposing the debit and the credit itself. What THIS field carries is the case and
        // decoration of a name fold already agreed on, where there is no judgement to make at all.
        const face = canonical === name && parsed.display && parsed.display !== name ? parsed.display : '';
        const named = face ? { face: face.slice(0, MAX_ITEM_NAME) } : {};
        const held = lookup(projected, key, null);
        // What the model can still see, and nothing older.
        //
        // The trail entry's `mid` is the anchor of the pass that recorded it (`applyExtraction`
        // attributes every event to the newest source it read), so a contribution is in sight
        // exactly when that anchor is among the mids this pass displayed. Both refusals below hang
        // off this: a beat outside the window is not something the model is re-telling, it is
        // something the model no longer has. See the docblock for the corpus measurement, every
        // real re-tell lands within four messages, every refusal past four was a real purchase.
        const trail = contributors?.get(key) ?? null;
        const inSight = c => visible instanceof Set && Number.isFinite(c?.mid) && visible.has(c.mid);
        const reTold = Boolean(trail?.some(inSight));

        // See the docblock: only a positive delta, only against a line the model was actually
        // shown, only when the ledger already covers the whole proposal, never for money, and only
        // when the beat that put the line there is still on screen. Without that last condition the
        // ledger line itself becomes the evidence, and a line stays on the ledger for as long as
        // it is held, which is how one bundle of nightshade at mid 76 refused a second bundle
        // picked eighteen messages later.
        if (shown && dq > 0 && !restated && place !== MONEY && shown.has(key) && (held?.qty ?? 0) >= dq && reTold) {
            rejected.push({ item: canonical, reason: 'already-recorded', raw, snippet });
            continue;
        }
        // The contributor trail closes what `shown` cannot.
        //
        // The gate above only fires when THIS pass's ledger showed the line, and never for money.
        // A re-record slips past it when the model re-tells a beat the ledger did not carry, the
        // goblin knife (mids 22 and 38) and the phone numbers (50 and 54) are that shape. An EXACT
        // `dq` match against a visible entry is arithmetic on fold's own numbers, not the
        // narrative-similarity metric §11 refuses.
        //
        // The sign condition, and why it covers losses.
        //
        // The gate used to fire on `dq > 0` only, on the docblock's old assumption that "a loss is
        // never a restatement". The Time Stop RPG ledger falsified it: the spear purchase is billed
        // TWICE (mids 36 and 38, both `silver -10`), the room rental twice (73 and 74, both `-2`),
        // the locket give-back twice (66 and 67, both `-1`). Each second bill is one thing that
        // happened once, and the double-bill drains the balance to zero so the THIRD bill reads as
        // `remove-unknown`: a symptom of the corruption, not a separate defect.
        if (!restated && Math.abs(dq) <= (held?.qty ?? 0)
            && trail?.some(c => Number(c.dq) === dq && inSight(c))) {
            rejected.push({ item: canonical, reason: 'already-recorded', raw, snippet });
            continue;
        }
        if (!held && !restated && dq < 0) {
            rejected.push({ item: canonical, reason: 'remove-unknown', raw, snippet });
            continue;
        }
        // Two tables, two ceilings. Counting a spell list against `MAX_ITEMS` was the arithmetic
        // consequence of filing capabilities as luggage: sixty-four rows shared between a pack and a
        // skill tree means a character who learns things cannot also carry things. Counted by place
        // rather than by `projected.size`, which now holds both.
        if (!held) {
            const room = place === ABILITIES
                ? countPlace(projected, ABILITIES) < MAX_ABILITIES
                : countPlace(projected, ABILITIES, true) < MAX_ITEMS;
            if (!room) {
                rejected.push({ item: canonical, reason: place === ABILITIES ? 'abilities-full' : 'inventory-full', raw, snippet });
                continue;
            }
        }

        // Growth against what is held, then corroboration for anything past it. See DELTA_GROWTH.
        // Corroboration is the model's own `magnitude` answer, the count it says the narrative
        // stated, never fold reading scale words out of prose. An explicit magnitude equal to the
        // change corroborates it; otherwise the digit test on the window (structural) is the fallback.
        if (!restated && Math.abs(dq) > deltaAllowance(held?.qty ?? 0, place)
            && !(Number.isInteger(Number(raw?.magnitude)) && Number(raw?.magnitude) >= Math.abs(dq) * 0.5)
            && !magnitudeCorroborated(dq, windowText)) {
            rejected.push({ item: canonical, reason: 'implausible-delta', raw, snippet });
            continue;
        }

        // `who` rides on the accepted delta only when there IS one, so a player's delta serialises
        // exactly as it always did, the fold re-keys from these fields, so an absent `who` has to
        // mean the same thing on read as it does here.
        const whose = owns ? { who: owns } : {};

        if (restated) {
            const total = Math.max(0, Math.min(maxQty(place), Math.trunc(raw.set)));
            setQty(projected, key, total);
            accepted.push(place === CARRIED
                ? { item: canonical, set: total, ...named, ...whose }
                : { item: canonical, set: total, at: place, ...named, ...whose });
            continue;
        }

        // Underflow clamps rather than rejects: our count may simply be behind, and the narrative
        // is the more trustworthy source about what just happened.
        if ((held?.qty ?? 0) + dq < 0) {
            rejected.push({ item: canonical, reason: 'clamped-underflow', raw, snippet });
        }

        bumpQty(projected, key, dq);
        changes++;
        // The grade rides along, or the fold has nothing to write it from, `deriveState` reads
        // `change.rank` off the stored delta and this is the only thing that puts it there.
        const grade = String(raw?.rank ?? '').trim();
        const ranked = grade ? { rank: grade.slice(0, MAX_ITEM_NAME) } : {};
        // Provenance rides on the accepted row, and only on a gain.
        //
        // `creditsWithoutDebit` reads it off this array in the same pass, so nothing here is needed
        // for the trigger to work, but the ledger is the audit trail and "where did this come
        // from" is precisely the class of question it exists to answer. The owner replays LEDGERS,
        // not traces, so a mode that lived only in memory could never be checked after the fact.
        // Absent on a loss and on a restatement, where `acquisitionOf` returns '' and the key would
        // be a lie about the row it sits on.
        const how = acquisitionOf(raw, dq);
        const from = how ? { how } : {};
        accepted.push(place === CARRIED
            ? { item: canonical, dq, ...ranked, ...named, ...whose, ...from }
            : { item: canonical, dq, at: place, ...ranked, ...named, ...whose, ...from });
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
export function validateVitals({ vitals, deltas, windowText, mentioned = null }) {
    const accepted = [];
    const rejected = [];
    // The window excerpt every rejection records, for the caret-level diagnostics log.
    const snippet = windowSnippet(windowText);

    for (const raw of Array.isArray(deltas) ? deltas : []) {
        const name = normalizeKey(raw?.name);
        if (!name) {
            rejected.push({ item: String(raw?.name ?? ''), reason: 'unusable-name', raw, snippet });
            continue;
        }
        // A gauge name is fold's KEY, and a key is never in the prose.
        //
        // This asked whether the token `hp` appeared in the window. It never does. A narrator
        // writes "the tusk opens his flank" and "he sags against the rock"; it does not write "hp",
        // because `hp` is fold's name for the gauge, not the story's. The delta is the model's
        // READING of the scene, so demanding the reading appear literally in the text it was read
        // from is RULE 1's own defect, the same one `validateStatus` above documents at length and
        // fixed by testing the PERSON (a name genuinely quoted from the window) instead of the flag.
        //
        // Vitals have no person to test: they are the pov's body, and the mark gate already states
        // the rule for that case, the pov "is in every scene by definition and is never rejected".
        // A gauge is the same body measured differently, so the same answer applies.
        //
        // MEASURED, live Wuxia World RPG at 85 messages: eight consecutive `hp` deltas refused
        // `not-mentioned`, `{dcur:-10}`, `{dcur:+30}`, `{dcur:-20}`, `{dcur:+20}`, so the health
        // bar never moved once across a campaign of boar fights and recoveries. Every one of those
        // was the model reading the fiction correctly and fold discarding it for failing to quote
        // a word fold invented.
        //
        // What still protects the row is structural and unchanged: `MAX_VITALS` bounds how many
        // gauges can exist, `implausible-max` bounds how fast a ceiling may move, and `merge_vital`
        // clamps the value into its own range. Those are arithmetic on fold's keys. The prose test
        // was the only part that was a judgement about English, and it is gone.

        const held = lookup(vitals, name, null);
        if (!held && vitals.size + accepted.length >= MAX_VITALS) {
            rejected.push({ item: name, reason: 'vitals-full', raw, snippet });
            continue;
        }
        // A max that moves by more than half in one turn is a hallucination, not a level-up.
        //
        // `held.max > 0` is load-bearing, and its absence was a trap rather than a wrong number: a
        // row zeroed by the `max: 0` bug had a bound of `0 * 0.5`, so EVERY correction exceeded it
        // and the row could never be repaired. Nothing is plausible or implausible against a
        // ceiling nobody has established; the guard only has an opinion once there is one.
        if (held && held.max > 0 && Number.isFinite(raw?.max) && raw.max > 0
            && Math.abs(raw.max - held.max) > held.max * 0.5) {
            rejected.push({ item: name, reason: 'implausible-max', raw, snippet });
            continue;
        }

        const entry = { name, dcur: Number.isFinite(raw?.dcur) ? raw.dcur : 0 };
        // Zero is silence, see `merge_vital`. Carrying it onto the accepted delta would store the
        // same destroyed ceiling one layer down, where the fold reads it back on every derive.
        if (Number.isFinite(raw?.max) && raw.max > 0) {
            entry.max = raw.max;
        }
        // This one has never fired, and it is kept for what it bounds, not what it catches.
        //
        // The inventory `no-change` above accounts for every `no-change` in the record. MEASURED
        // over the same 2256 traced passes: 70 proposed vital rows in total, 4 with `dcur: 0`, and
        // all 4 of those carrying a real `max`: so zero rows have ever reached this line. A gauge
        // is a much narrower thing to talk about than an inventory, and the model does not name one
        // to say it is unchanged the way it names a coin purse.
        //
        // It stays because a `{dcur: 0, max: 0}` row would otherwise fold as a write of nothing
        // onto a live gauge, and because `max: 0` is the sentinel for "unstated" (`merge_vital`),
        // the pair reads as silence and silence is not an accepted delta.
        if (!entry.dcur && entry.max === undefined) {
            rejected.push({ item: name, reason: 'no-change', raw, snippet });
            continue;
        }
        accepted.push(entry);
    }

    return { accepted, rejected };
}

/**
 * Validate proposed mark changes.
 *
 * `who` is resolved HERE, at write time, and stored on the event.
 *
 * The alternative, store whatever the model wrote and resolve on read, was rejected: a cast row
 * can be merged, renamed or pruned between the turn that wounded someone and the turn that reads the
 * ledger back, and a name that resolved to nobody at read time would silently move a wound onto the
 * player (which is the pre-Phase-D bug, `FOLD-RPG-GAP.md` §3). Resolving at write time means the
 * event says whose it was, permanently, and the fold cannot change its mind. The stored form is the
 * cast row's DISPLAY name rather than its table key, so a later merge, which accumulates the loser's
 * name into the keeper's `aka` (`entity-table.js` `mergeEntities`), leaves the mark findable by the
 * one-hop alias resolution every other consumer uses.
 *
 * An empty `who` is the pov, and is never rejected: a chat whose point of view has not been
 * established yet still has a body to wound, and refusing the mark would trade a misattributed
 * consequence for no consequence at all. A NAMED owner that matches no cast row is rejected
 * (`reject:unknown-owner`), an invented owner is worse than none, because it opens a row-shaped
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
export function validateStatus({ status, deltas, windowText, cast = null, pov = '', mentioned = null }) {
    const accepted = [];
    const rejected = [];
    let capped = 0;
    // The window excerpt every rejection records, for the caret-level diagnostics log.
    const snippet = windowSnippet(windowText);

    for (const raw of Array.isArray(deltas) ? deltas : []) {
        const flag = normalizeKey(raw?.flag);
        if (!flag) {
            rejected.push({ item: String(raw?.flag ?? ''), reason: 'unusable-name', raw, snippet });
            continue;
        }
        const owner = resolveOwner(raw?.who, { cast, pov });
        if (!owner.ok) {
            // Named somebody fold has never heard of. Counted with the name it invented, so the
            // report says which name rather than only how often.
            rejected.push({ item: String(raw?.who ?? '').slice(0, MAX_ITEM_NAME), reason: 'unknown-owner', raw, snippet });
            continue;
        }

        // Coverage is about the PERSON, never about the flag word.
        //
        // This gate used to read `(mentioned && mentioned.has(flag)) || isMentioned(flag, windowText)`
        //, it asked whether the word "dead" appeared in the prose. A flag is the model's READING of
        // the window, not a quote from it, so requiring it to appear literally requires the
        // conclusion to be present in the text it was concluded from. That is RULE 1's defect
        // exactly: a substring test applied to message text to decide what the story means.
        //
        // MEASURED, Isekai RPG turn 1. The narration reads "The teacher and bus driver vanished
        // along with it, blood spattering across the first few rows." The model read two deaths and
        // reported `{who: "Ms. Tanaka", flag: "dead"}` and `{who: "bus driver", flag: "dead"}`. The
        // word "dead" is nowhere in the window, and `mentioned` is a set of NAMES so it can never
        // contain a condition word, both were rejected `not-mentioned` and BOTH DEATHS WERE LOST.
        // Neither person appears in the cast at all. Narrators write "vanished", "didn't get up",
        // "her legs burned"; they do not write "dead", "unconscious", "exhausted". Every condition
        // whose flag word the prose does not literally spell was being destroyed.
        //
        // The person is a different kind of thing: a NAME is quoted from the window, so testing for
        // it is token algebra on fold's own key (RULE 1's STRUCTURE clause), and it is what the
        // coverage report can actually answer. It also keeps the protection the gate was written
        // for, a condition inflicted on somebody the window never touched is still refused, which
        // is the hallucination this guards against. An empty `who` is the pov, whose body is in
        // every scene by definition and who the docblock above already says is never rejected.
        //
        // …and the NAME comparison is a proxy too.
        //
        // Testing the person rather than the flag was the right half of the fix and it kept the
        // wrong half: `coveredByReport` and `isMentioned` still decide whether two spellings of a
        // name are one name. `Ms. Tanaka` against a report of `Tanaka`, `the tall guard` against
        // `Marek`: the inflection and function-word failures measured on the item gate are the same
        // failures here, and a name is exactly the thing RULE 1 says fold may not resolve.
        //
        // Same three states as the item gate above: no report means nothing to judge; an empty
        // report with a proposal is the hallucination; a non-empty report is the model's own
        // attestation about the excerpt it also wrote this mark from. The pov is unconditionally
        // covered, unchanged, his body is in every scene by definition.
        const said = String(raw?.who ?? '').trim().toLowerCase();
        const covered = !said || !(mentioned instanceof Set) || mentioned.size > 0;
        if (!covered) {
            rejected.push({ item: String(raw?.who ?? '').slice(0, MAX_ITEM_NAME), reason: 'not-mentioned', raw, snippet });
            continue;
        }

        // The address is the key the FOLD will write, not a subject.
        //
        // This computed a bare `subject` string when the delta carried one and a full `markKey`
        // otherwise, then asked `status.has(subject)`: a table whose keys are all `who␀subject`.
        // In the structured-subject path that lookup could never match, so every restatement read as
        // a brand-new mark to the two bounds below.
        //
        // `accepted` does not carry `subject` onward (see the push at the end of this loop), so the
        // key `deriveState` will land on is `statusKeyFor`'s, unconditionally. Computing the same
        // address here is what makes a bound in this function a bound on the row that will exist.
        const address = statusKeyFor(status, flag, owner.key);
        const severity = normalizeSeverity(raw?.severity);
        const turns = Number(raw?.turns);
        const lasts = Number.isFinite(turns) && turns > 0 ? Math.min(Math.trunc(turns), MAX_CONDITION_TURNS) : 0;

        // A mark already held is not news.
        //
        // MEASURED, Raccoon City: one clause at message 90, "your hands are tired and your eyes are
        // burning", became 34 `burning eyes` events and 32 `tired hands` events over 88 turns,
        // against a single retraction in the whole campaign. The scene probe re-answers the
        // conditions it can still see every pass (`scene.js`), and `recordMarks` appended each answer
        // unconditionally. 13.4 KB of a blob at 99.8% of its cap, spent restating two facts.
        //
        // The second cost is the one that hid the first: every re-assertion rewrote the row's `t`,
        // so no mark could ever look old and `cap:condition-expired` has never fired in any chat.
        // A staleness clock the assertion loop rewinds is not a clock.
        //
        // `validateInventory` has refused exactly this since the double-billing repair
        // (`already-recorded`). Same law, stated in the corpus as `zero_residual_is_fixed`
        // (`kalmanUpdate x K x = x`: no surprise, no move): an observation that changes no derived
        // proposition must be the identity on everything persisted, the recency included.
        //
        // Every field the fold stores is compared, so this can only refuse a genuine no-op. A
        // changed phrase, a worsened severity, a healing, a re-tell of something that healed, all
        // change the derived row, and all still land.
        const previous = status.get(address);
        if (previous
            && !!previous.on === !!raw?.on
            && String(previous.phrase ?? '') === flag
            && previous.severity === severity
            && (previous.turns ?? 0) === lasts) {
            rejected.push({ item: flag, reason: 'already-held', raw, snippet });
            continue;
        }

        // Healing is the model's own report, not an English word list. The delta schema tells the
        // model to record the affliction, never the reassurance ("otherwise unhurt" is not a
        // condition), and to set `on: false` when one heals or is treated away. A `false` flag
        // carries that directly; the old `isNegation` word-list (which kept `functional` as a live
        // flag because the word was not on it) is gone from the write path.

        if (!status.has(address) && status.size + accepted.length >= MAX_FLAGS) {
            rejected.push({ item: flag, reason: 'flags-full', raw, snippet });
            continue;
        }
        // The per-owner slot bound is not a refusal, `placeMark` owns what actually happens to the
        // fourth wound, and it never drops it. This is only the count, taken where a pass can be
        // measured rather than in the fold, which re-runs on every render and would report the same
        // displacement forever.
        if (!status.has(address) && !!raw?.on && marksFull(status, owner.key)) {
            capped++;
        }

        // A duration is a claim like any other and gets bounded like one. Zero means indefinite,
        // which is also what an absent or nonsensical value degrades to, a condition that stays
        // until the narrative clears it is the safe failure, not one that silently expires.
        accepted.push({
            who: owner.name,
            flag,
            on: !!raw?.on,
            severity,
            turns: lasts,
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
    // The pov is frequently not a cast row of his own, `renderEntities` and the panel both exclude
    // him from the list he is the centre of, and a chat can name him from the scene probe before the
    // cast probe has ever placed him. So he is matched before the table is consulted.
    if (ownerKey(said) === ownerKey(pov) && pov) {
        return { ok: true, key: ownerKey(pov), name: String(pov).trim() };
    }
    if (!cast) {
        // No table to check against, the absorb path and the unit fixtures. Taking the name as
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
 * `since` counts how many events have passed since each item was last touched, staleness,
 * derived rather than stored, because it is a function of the ledger and nothing else.
 *
 * Marks are derived here and stored nowhere, which is the swipe argument in one sentence.
 *
 * `FOLD-REDESIGN.md` §3 gives cast rows `marks`, and a cast row is a STORED table, so the obvious
 * reading is a `marks` field on the row, written by the probe. Phase C faced the same choice for
 * thread closures and recorded three options with the swipe scenario that decided it
 * (`thread-table.js` `overlayClosures`); marks land on the other side of that same argument, and
 * more cheaply:
 *
 *   1. **Store marks on the cast row.** A swipe that removes the turn in which someone was wounded
 *      leaves the wound on the row, with nothing anywhere saying why, the failure mode
 *      `overlayClosures` rejects, and worse here, because a mark changes what the adjudicator does
 *      (`verdict.js` `standing.hurt`) on every subsequent roll.
 *   2. **Store the row, overlay from the ledger**, Phase C's shape for threads.
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
 * predates the ledger, `state.context.conditions` from a v1 chat, and that is precisely what
 * migration seeds onto the stored row (`migrate.js`), which is the only writer of `cast[key].marks`
 * and is read exactly once, by `seedMarks` below.
 *
 * @param {Array<{t?: number, d?: object}>} events Events, live ones only.
 * Capabilities come out of `inv`, and nothing migrates.
 *
 * `foldAbility` is the whole argument. What matters HERE is that the split is a read rule and not a
 * rewrite: the events are unchanged, the keys are unchanged, and every chat on disk that has ever
 * recorded an `at: "abilities"` delta re-derives into the new table on its next fold. Rolling back
 * to a build without this loses nothing either, because the ledger it reads is byte-identical. That
 * is the same discipline the `reachKeys` rule below states in as many words, and it is why there is
 * no migration step to run twice.
 *
 * @param {object} [options] Options.
 * @param {Array<object>} [options.seeds] Pre-ledger marks from migration, folded before the events.
 * @param {object} [options.crosswalk] Key relabel from `crosswalk.js`; identity when absent.
 * @returns {{inv: Map, abilities: Map, vitals: Map, marks: Map, since: Map, contributors: Map, suppressed: number, overdrawn: object[], drifted: object[], faces: Map}} Derived state.
 */
export function deriveState(events, { seeds = [], reachKeys = null, crosswalk = null, baseline = null, pov = '' } = {}) {
    const ordered = [...(events ?? [])].sort((a, b) => (a?.t ?? 0) - (b?.t ?? 0));
    // Absent a crosswalk this is the identity relabel and a filter that never fires, so every
    // existing caller, the tests, the replay harness, migration, folds exactly as before.
    const relabel = crosswalk?.relabel ?? (key => key);
    const isDuplicate = crosswalk?.deduper?.() ?? (() => false);
    let suppressed = 0;
    /** Rows a debit took below zero, captured before the row is deleted. See the deletion site. */
    const overdrawn = [];
    /**
     * Money rows where a stated total disagreed with what the fold had computed. Adopted anyway,
     * see the capture site for why, and for the measurement that motivated recording it at all.
     */
    const drifted = [];

    // The baseline: what the ledger held before the events it no longer keeps.
    //
    // State is a fold over LIVE events, so an evicted event does not merely stop being recallable,
    // its contribution is retroactively unwound and the balance changes to match a history that no
    // longer exists. `demoteEvents` archives the summary and drops `d`, so once an event has been
    // demoted the evidence needed to re-fold it is gone for good. Royal Succession sat at 100% of
    // MAX_FOLD_BYTES with 174 events already demoted.
    //
    // The baseline is the accumulated contribution of everything shed, seeded here so the fold
    // resumes from it instead of from nothing. Sound because `selectEvictions` weights `hasDelta` at
    // +100000 and breaks ties on insertion order, so delta-bearing events leave OLDEST FIRST, the
    // shed set is a time-ordered prefix, and folding a prefix into an accumulator and the suffix on
    // top is the same fold (`accum_append`). Where that stops holding is where a row crosses zero,
    // which is not commutative and is already recorded as an overdraw.
    //
    // Relabelled on the way in, because a verdict can land after the eviction and the baseline must
    // move with the crosswalk like any other key. Two aliases can collapse onto one canonical row,
    // so the seed SUMS rather than overwrites, last-write here would silently drop a merged pocket.
    const inv = new Map();
    const vitals = new Map();
    /**
     * Capabilities: what the character can DO, keyed exactly as an item is and folded nothing like
     * one. See `foldAbility` for the whole argument; the short version is that a technique has no
     * count, no location and no way to be dropped, so counting it, placing it and asking the review
     * whether it is still in the pack were three wrong answers to one category error.
     *
     * The KEY stays `itemKey(name, ABILITIES, who)`, deliberately. `contributors`, `since`, `faces`,
     * the crosswalk relabel, the eviction baseline and every hand edit address a row by that key, so
     * keeping it means the split costs no rewrite anywhere, the rows simply arrive in a different
     * table with a different face. Every existing `abilities` row in every live chat heals on the
     * next read, and there is nothing to migrate because nothing stored changes.
     */
    const abilities = new Map();
    // The name the story wrote, per row, last-write. Kept beside the fold rather than inside it:
    // `setQty` and `bumpQty` replace their row wholesale, so threading a face through the merges
    // would put a display concern inside the arithmetic. A separate map costs nothing and cannot
    // perturb a quantity.
    const faces = new Map();
    const status = seedMarks(seeds);
    const lastTouch = new Map();
    const statusTouch = new Map();
    /** @type {Map<string, Array<{at: number, dq: number, summary: string}>>} */
    const contributors = new Map();
    /** Named tracks the setting keeps score with: owner+track -> opaque reading. See the fold below. */
    const standings = new Map();

    for (const [rawKey, row] of baseline ?? []) {
        const qty = Math.trunc(Number(row?.qty ?? row) || 0);
        if (qty <= 0) continue;
        const key = relabel(rawKey);
        // A capability whose granting event has been evicted is still held, and a carried-forward
        // COUNT is the one thing it must not become. Presence, and the grade if the baseline kept
        // one, the same shape `foldAbility` writes, so a later event about it folds normally.
        if (splitItemKey(key).place === ABILITIES) {
            const parts = splitItemKey(key);
            insert_with(abilities, merge_b, key, { who: parts.who, name: parts.name, ...(row?.rank ? { rank: row.rank } : {}) });
            continue;
        }
        insert_with(inv, merge_b, key, { qty: lookup(inv, key, { qty: 0 }).qty + qty });
    }

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
            const read = normalizeItemName(change?.item);
            const parsed = read?.name ?? '';
            if (!parsed) continue;

            // Contact rows are `reach` now, and this is the read rule that finishes the move.
            //
            // The delta schema says contact details are never items and the entity probe reports
            // them as `reach`. A legacy chat that filed a contact under the `contacts` place is
            // skipped by the migration's OWN record, the exact item keys it found, stored under
            // `state.migrated.reachKeys`: never by an English place word. Anything not in that
            // record folds as the model reported it.
            //
            // Read-time, deliberately, and the same discipline as re-normalising names two lines
            // down: rewriting the ledger to delete the rows would destroy the evidence that the
            // numbers were ever exchanged, and a chat rolled back to a build without this rule
            // would silently lose them. A read rule heals every existing chat and is reversible.
            if (reachKeys && reachKeys.has(itemKey(parsed, change?.at))) continue;

            // Place is part of the key, so a crowbar in the boot and a crowbar in your hand are
            // two entries and moving one does not silently merge them.
            // Whose, as the validator resolved it at write time. An absent `who` is the
            // point-of-view character's, which is every delta written before owners existed.
            const whose = String(change?.who ?? '');
            // Identity is resolved against the table the row actually lives in. `same_as` between
            // two spellings of one technique, the live `quarterstaff proficiency (e)` ~
            // `quarterstaff proficiency` pair, has to reach the capability rows, and they are no
            // longer in `inv` to be found.
            const table = normalizePlace(change?.at) === ABILITIES ? abilities : inv;
            const name = canonicalItemName(table, parsed, change?.at, change?.same_as, whose, faces);
            // The crosswalk, applied here and nowhere else.
            //
            // `KeyResolution.relabel`: two names the model has confirmed are one thing fold into one
            // row. Late is sound because `dq` sums (`accum_append`), and this relabel reads only the
            // answer table, never the inventory being built, which is the prefix-independence
            // `IncrementalResolution.relabelInc_const` requires. `canonicalItemName` above DOES read
            // the accumulating `inv`, which is why the crosswalk is a separate step rather than an
            // extension of it.
            const key = relabel(itemKey(name, change?.at, whose));

            // A restated TOTAL overwrites; a delta accumulates. Both land in the same table and
            // the same audit trail, recorded as the change they actually represented, so a
            // restatement that corrects a runaway count shows up as the correction it is.
            // `set: 0` remains a REMOVAL here: the fold runs over stored events and block
            // restatements, where a literal "set 0" means "nothing left", and `validateInventory`
            // already refused a model-authored `set: 0` at write time.
            const restated = Number.isFinite(change?.set);

            // One event read twice is one event.
            //
            // Extraction runs on overlapping windows, so the same message is often read twice, the
            // case the `replaced` branch of `applyEvents` is built around. When the second reading
            // lands under a DIFFERENT event key, that guard does not fire and the quantity is
            // counted twice. Measured: 25 units across the corpus, and it is what put Time Stop's
            // silver at −11.
            //
            // Downstream of `relabel` on purpose. Wuxia's double-count was invisible until the
            // crosswalk merged the keys, because the two readings landed on `carried␀silver wen` and
            // `money␀silver` and nothing could see they were one transfer. Merging without this
            // check turns 76-and-21-split into a confident, wrong 97.
            //
            // Restatements are exempt: `set` is idempotent, so a repeated one is already harmless,
            // and suppressing it would discard a correction.
            if (!restated && isDuplicate(key, Number(change?.dq ?? 0), Number.isFinite(event.mid) ? event.mid : null)) {
                suppressed++;
                continue;
            }

            // The grade, stored and never interpreted.
            //
            // An opaque string in whatever system the setting uses, "E", "Amateur", "47/100",
            // "Lv. 12". fold keeps it as a value ON the row rather than in the key, which is what
            // makes a skill that goes F→E→D one row instead of three, and never compares two of
            // them: ordering ranks is language understanding and belongs to the model.
            const rank = String(change?.rank ?? '').trim().slice(0, MAX_ITEM_NAME);

            // The drift detector: a stated total that disagrees is a transaction fold missed.
            //
            // Read before `setQty` overwrites it, for the same reason `had` is read before the merge
            // below, the evidence dies at the write.
            //
            // A restatement is the narrator's own printed balance, and fold adopts it. That is
            // usually right: the narrator is the authority on its own fiction, and fold demonstrably
            // misses extractions, so refusing the total would entrench fold's error rather than
            // correct it. What was missing is that the disagreement left no trace at all.
            //
            // Measured across a completed Xianxia campaign, comparing every narrator-stated balance
            // against what fold had computed at that point: **21 of 63 agreed (33%)**, 8 more were
            // one beat behind, and 34 were neither, adrift, worst gap 2604. Two thirds of the money
            // on that ledger arrived as `set` rather than as a transaction, so fold was transcribing
            // a total, not computing one, and nothing in the product could say so. Finding those
            // numbers took a bespoke script; this is that script, moved inside.
            //
            // Pure integer comparison of fold's own keys, no text is read, and it holds in any
            // language because a number does.
            if (restated && inv.has(key) && splitItemKey(key).place === MONEY) {
                const held = lookup(inv, key, { qty: 0 }).qty;
                const said = Math.trunc(Number(change.set));
                if (Number.isFinite(said) && said !== held) {
                    drifted.push({
                        key,
                        held,
                        said,
                        gap: said - held,
                        mid: Number.isFinite(event.mid) ? event.mid : null,
                    });
                }
            }

            // Last-write: the newest telling of a name is the one the story is using now.
            //
            // Two defects in three lines, both dead for the whole life of every chat.
            //
            // The first was here: `parsed` is a STRING (`normalizeItemName(...)?.name`), so
            // `parsed.display` was `undefined` on every single change and this map was never written
            // at all. `snapshot` reads `faces.get(key) || parts.name`, so the fallback ran always and
            // the feature was invisible rather than broken.
            //
            // The second was upstream, in `validateInventory`: the accepted delta carried
            // `item: canonical`, the lowercase KEY, so even a working reader here would have
            // re-derived the display from a string whose casing was already gone. `change.face` is
            // the repair, and it is the model's own word: `SIG P226` rather than `sig p226`, and
            // `9mm rounds` for a row the model told us is the `ammunition` it already holds.
            //
            // Preferred over the local reading, never instead of it: a delta written before `face`
            // existed still gets the best casing this event can offer, which is what makes the fix
            // heal old chats instead of only helping new ones.
            const display = String(change?.face ?? '').trim() || read?.display || '';
            // Only when it says something the key does not. A face equal to its own key is 53 map
            // entries that answer no question (measured: the live Raccoon City ledger, every row),
            // and it would also put a duplicate candidate into the `same_as` set for nothing.
            if (display && display !== splitItemKey(key).name) {
                faces.set(key, display.slice(0, MAX_ITEM_NAME));
            }

            // Capabilities fold here and leave the inventory alone.
            //
            // Everything above this line, the crosswalk, the duplicate guard, the grade, the face,
            // is about IDENTITY and applies identically to a technique. Everything below it is
            // ARITHMETIC, and none of it does: a spell has no quantity to add, no balance to
            // overdraw, no total to restate and nothing to carry forward into a baseline.
            if (splitItemKey(key).place === ABILITIES) {
                const moved = foldAbility(abilities, key, { restated, set: change?.set, dq: Number(change?.dq ?? 0), rank });
                if (moved.touched) {
                    insert_with(lastTouch, merge_b, key, index);
                }
                if (moved.dq) {
                    insert_with(contributors, merge_graph, key, [{ at: event.t ?? 0, dq: moved.dq, summary: event.s ?? '', mid: Number.isFinite(event.mid) ? event.mid : null }]);
                }
                // A retraction takes the trail with it, exactly as an emptied inventory row does:
                // the audit trail explains a row that is there, and there is no row.
                if (moved.dq < 0) {
                    lastTouch.delete(key);
                    contributors.delete(key);
                }
                continue;
            }

            const dq = restated ? setQty(inv, key, change.set) : Number(change?.dq ?? 0);
            if (!restated && !dq) {
                // A rank-up moves no quantity, "Quarterstaff Proficiency (E) → (D)" is a real
                // change with `dq: 0`. Without this it fell through the zero-delta skip, and the
                // only way the new grade could reach the ledger was as a second row under a
                // different name, which is exactly the duplicate a live campaign showed.
                //
                // Only onto a row that already exists: a rank for something never acquired is a
                // grade for nothing, and inventing the row would let a passing mention of a skill
                // the character does not have become a skill they do.
                if (rank && inv.has(key)) {
                    insert_with(inv, merge_b, key, { ...lookup(inv, key, { qty: 0 }), rank });
                    insert_with(lastTouch, merge_b, key, index);
                }
                continue;
            }
            // Read BEFORE the merge, because the merge is where the evidence dies: `merge_qty`
            // floors at zero, so a row debited past its balance lands on exactly 0 and the shortfall
            // is gone before any later line can see it. Capturing it here is the only place the four
            // numbers coexist. See the deletion site below for why it is worth capturing at all.
            const had = lookup(inv, key, { qty: 0 }).qty;
            if (!restated) {
                bumpQty(inv, key, dq);
            }
            // Last-write, after the quantity has settled so the row exists to carry it. The newest
            // grade the story stated is the grade, no comparison, no ordering, no opinion about
            // whether it went up or down.
            if (rank && inv.has(key)) {
                insert_with(inv, merge_b, key, { ...lookup(inv, key, { qty: 0 }), rank });
            }
            if (!restated && dq < 0 && had + dq < 0) {
                overdrawn.push({
                    kind: 'overdraw',
                    key,
                    had,
                    dq,
                    short: -(had + dq),
                    mid: Number.isFinite(event.mid) ? event.mid : null,
                });
            }

            insert_with(lastTouch, merge_b, key, index);
            // The audit trail: every quantity traces to the events that produced it. A restatement
            // that changed nothing is not worth a row, that is most of them. `mid` is the anchor
            // that lets the UI jump a contributor to its causing message (FOLD-REDESIGN.md §8,
            // altitude 3, Ledger tab: "click a contributor → the chat scrolls to the causing
            // message"), so it rides the trail from the start.
            if (dq) {
                insert_with(contributors, merge_graph, key, [{ at: event.t ?? 0, dq, summary: event.s ?? '', mid: Number.isFinite(event.mid) ? event.mid : null }]);
            }

            // An emptied row is dropped, and THAT is why the overdraw is captured above.
            //
            // Dropping is right for the panel: nobody holds nothing. But between this line and
            // `merge_qty`'s floor, a debit past the balance leaves no trace at all, the row reads 0,
            // then vanishes. So the derived table can never hold a negative, and every check that
            // scanned for one was dead on the live path. `invariant-table.js` had two of them, and
            // one was documented as the language-invariant detector: measured across nine campaigns
            // it returned `[]` every time, while the event streams held real overdraws (Isekai
            // `money copper` 12 debited 14; Solo Leveling `carried painkillers` 1 debited 2).
            //
            // Going below zero is the strongest evidence fold has that a credit landed under another
            // key, and it reads no text whatsoever, so it is the only split detector that holds in
            // Han, Hangul, Kana and inflected scripts, where the token supplement cannot.
            if (lookup(inv, key, { qty: 0 }).qty <= 0) {
                inv.delete(key);
                lastTouch.delete(key);
                contributors.delete(key);
            }
        }

        // Standings: whatever this setting keeps score with.
        //
        // Keyed by owner and track, valued by an opaque reading. The Map face, because a track has
        // one current value and the newest statement of it wins, "Reputation: 0" then
        // "Reputation: 12 (Known)" is one track twice, not two tracks.
        //
        // fold never parses `value`. It cannot tell whether 12 beats 0, whether Exalted beats
        // Friendly, or what "0/100 EXP" is a fraction of, and it does not need to: nothing here
        // compares two readings. That is the same discipline `rank` follows on an inventory row, and
        // it is what lets one field carry level, class, threat, reputation and a relationship score
        // in any language without fold learning a single one of their names.
        for (const change of delta.standing ?? []) {
            const name = normalizeKey(change?.name);
            const value = String(change?.value ?? '').trim().slice(0, MAX_DETAIL);
            if (!name || !value) continue;
            // Reusing `markKey` deliberately: a standing and a mark are the same shape, something
            // true OF someone, keyed by owner and subject, so they share the owner-resolution rule
            // and an unowned entry reads as the pov's, exactly as an unowned `st` delta does.
            insert_with(standings, merge_b, markKey(change?.who, name), {
                who: ownerKey(change?.who),
                name,
                value,
                // The fold index, the same stamp `lastTouch` uses, `total` is not in scope yet.
                turn: index,
            });
        }

        for (const change of delta.vit ?? []) {
            const name = String(change?.name ?? '');
            if (!name) continue;
            // The same seeding rule as `bumpQty`, for the same reason.
            //
            // `insert_with` stores the incoming value verbatim when the key is absent and only
            // calls the merge on collision, so handing it a raw `{dcur, max}` delta would store
            // that shape for the vital's FIRST sighting, no `cur` field at all. Every read then
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
            // Whose it is, healed on read for every event written before Phase D.
            //
            // An `st` delta with no `who` is not a delta about nobody; it is a delta from before the
            // schema had anywhere to put a subject (`FOLD-RPG-GAP.md` §3, the mid-30 events that
            // wounded Lee and Park and rendered on the player). It folds into the unowned bucket,
            // which every consumer reads as the pov's. That is §9's "fold-time default `who = pov`,
            // read-time healing, no rewrite", and it is what lets a chat downgrade to a build
            // without marks and lose nothing.
            // The unowned bucket IS the pov's, so it has to be the pov's KEY.
            //
            // The paragraph above says the design out loud, "fold-time default `who = pov`", and
            // the code did not do it: an empty `who` kept the empty key, so the same condition on
            // the same person lived in two rows the moment one pass named him and another did not.
            //
            // MEASURED in the live Isekai RPG chat. The mid-0 pass ran before the scene probe had
            // established a point of view, so `resolveOwner('')` had no pov to return and the crash
            // trauma was written unowned; every later pass had `pov: 'Ike Kōtoku'` and wrote the
            // same trauma owned. Both rendered `mine: true`, under keys `␀traumatized` and
            // `ike kōtoku␀traumatized`, and the narrator was handed
            // `Status: ... traumatized by the bus crash, traumatized by the bus crash`.
            //
            // Resolved at FOLD time rather than by rewriting the events: the events are right,
            // "nobody said" is what happened, and a chat whose pov later changes re-folds to the
            // new answer for free. Rows written before there was ever a pov still land in the
            // unowned bucket when there is still no pov, which is the legacy behaviour unchanged.
            const who = ownerKey(change?.who) || ownerKey(pov);
            // Keyed by OWNER and SUBJECT, valued by phrase: two descriptions of one condition on one
            // person are one fact, and the later one wins. The subject is the model's STRUCTURED
            // `subject` answer when the event carries one; `statusKeyFor` (a token heuristic) is
            // only the legacy fallback for rows written before the schema had the field.
            const subject = String(change?.subject ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
            const key = subject
                ? markKey(who, subject.slice(0, MAX_ITEM_NAME))
                : statusKeyFor(status, flag, who);
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

    return { inv, abilities, vitals, marks: status, since, contributors, suppressed, overdrawn, drifted, standings, faces };
}

/**
 * The marks a migration seeded onto cast rows, folded in before the ledger.
 *
 * The one thing the ledger cannot hold.
 *
 * `state.context.conditions`: "calf scabbed and rebandaged, left arm bruised shoulder to elbow" in
 * the live Solo Leveling chat, is a standing claim about the pov's body that no event ever carried:
 * it arrived from the scene probe into a context field and was rendered inside the scene header,
 * which is how "Bandaged calf" came to read as a property of the Goblin Market (`FOLD-REDESIGN.md`
 * §0). Migration routes it to marks (§9), and there is no event to hang it on, the turns that
 * caused those wounds are long past and their `st` deltas, where they exist at all, were subjectless.
 *
 * So migration writes `cast[key].marks`, and this is the only reader. Seeds fold FIRST, so any
 * ledger event about the same subject supersedes them by ordinary last-write, a seeded
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
 * Consequence without dice.
 *
 * A hangover should fade. A bite should not. Both were recorded identically and both stayed true
 * forever, which is the failure mode that makes a tracker feel like a noticeboard rather than a
 * simulation: nothing on it has a future.
 *
 * The fix needs no scheduler and no new mechanism. A condition may carry `turns`: roughly how many
 * exchanges it lasts, and the fold already knows how many events have passed since it was written.
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
 * DELETED: `isFresh`, and staleness-as-hiding with it.
 *
 * House style keeps a removed approach recorded with the measurement that killed it, so the
 * function is gone and its argument stays. It read:
 *
 *     // carried items only; a place is never stale
 *     if (splitItemKey(name).place !== CARRIED) return true;
 *     return lookup(since, name, 0) < STALE_THRESHOLD;
 *
 * and every renderer skipped whatever it refused. What it was: a retraction by silence, an item
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
 * Retraction is evidence-driven from here on, an event that spends the item, or a review closure
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
 * injected at all, an empty header spends tokens telling the model nothing.
 *
 * @param {object} params Parameters.
 * @param {Map<string, {qty: number}>} params.inv Inventory.
 * @param {Map<string, {cur: number, max: number}>} params.vitals Vitals.
 * @param {Map<string, object>} params.marks Marks, keyed by `markKey`.
 * @param {Map<string, object>} [params.abilities] Capabilities, from `deriveState`.
 * @param {Map<string, string>} [params.faces] Key -> the name the story wrote.
 * @param {string} [params.pov] The point-of-view character, whose marks are the `Status:` line.
 * @param {Map<string, string>} [params.parts] Key -> its components, as one line (`parts.faces()`).
 * @param {Map<string, object>|null} [params.places] The place table, or null when there is none.
 * @param {string} [params.here] The scene's own location, for the proximity tier.
 * @param {Iterable<string>} [params.mentioned] Other places this pass touched.
 * @returns {string} The block, or ''.
 */
export function renderState({ inv, vitals, marks, standings = new Map(), abilities = new Map(),
    faces = new Map(), pov = '', parts = new Map(), places = null, here = '', mentioned = [] }) {
    const lines = [];

    // Where you are, at the resolution proximity earns (§7.3).
    //
    // Nothing at all until a chat has a place record and the caller passes the table, which is every
    // chat that exists, so this block is empty by construction today and the shape `renderState`
    // has been injecting for the whole life of every live chat is unchanged until somebody builds a
    // house. `renderPlaces` decides the tiers; see its docblock for why full-and-then-a-line rather
    // than a list.
    const where = places ? renderPlaces(places, { here, mentioned }) : '';
    if (where) {
        lines.push(where);
    }

    const vitalParts = table_entries(vitals).map(([name, v]) => vitalReading(name, v));
    if (vitalParts.length) {
        lines.push(`Vitals: ${vitalParts.join(' · ')}`);
    }

    // Standings the setting keeps, rendered without fold understanding any of them.
    //
    // The pov's own tracks go on one line; a standing owned by someone else is a fact ABOUT them and
    // belongs on their cast line, not the player's, the same split the marks below use. Printed in
    // the story's own words because that is all fold ever stored.
    const povStandings = table_entries(standings)
        .filter(([, row]) => !row.who || row.who === ownerKey(pov))
        .map(([, row]) => `${row.name} ${row.value}`);
    if (povStandings.length) {
        lines.push(`Standing: ${povStandings.join(' · ')}`);
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

    // What the character can DO, on its own line and with no place.
    //
    // Capabilities used to arrive here as `Stored (abilities): tier 3 access`: a technique filed as
    // luggage in a location. `foldAbility` took them out of the item table; this is the half the
    // narrator reads. No count, because there is no ×2 of a clearance level.
    const known = abilityLabels(abilities, faces, pov);
    if (known.length) {
        lines.push(`Abilities: ${known.join(', ')}`);
    }

    // Grouped by place, so the model is told what is to hand versus what is at home or in the car.
    const byPlace = new Map();
    for (const [key, item] of table_entries(inv)) {
        const { place, name } = splitItemKey(key);
        // The grade rides the label, never the key: "quarterstaff proficiency D", one row.
        const face = itemFace(faces, key, name);
        const graded = item.rank ? `${face} ${item.rank}` : face;
        const counted = item.qty > 1 ? `${graded} x${item.qty}` : graded;
        // What the thing is MADE OF, at its own tier. Empty for every row that has no components,
        // which is every row in every chat until something says otherwise.
        const made = String(parts?.get(key) ?? '').trim();
        insert_with(byPlace, merge_graph, place, [made ? `${counted} (${made})` : counted]);
    }

    for (const [place, names] of table_entries(byPlace)) {
        // Unreachable, and still listed.
        //
        // The place burned down and the crowbar is still in it. It is NOT removed from the block and
        // its count does not change: the row renders with the reason attached, which is the lesson
        // of `cap:stale-hidden`: 540 silent hidings in Raccoon City alone, every one of them a real
        // thing in a real pocket. What fold may do is say why it cannot be got at.
        const shut = places && place !== CARRIED && !CATEGORIES.has(place)
            ? unreachableBy(places, place)
            : null;
        const heading = place === CARRIED
            ? 'Carrying'
            : `Stored (${place}${shut ? `: unreachable, ${shut.row?.status || 'destroyed'}` : ''})`;
        lines.push(`${heading}: ${names.join(', ')}`);
    }

    return lines.length ? `[State]\n${lines.join('\n')}` : '';
}

/**
 * The name to PRINT for a row: the story's own, when fold caught it.
 *
 * The key is lowercase by construction and always will be, it is what every table, trail and hand
 * edit addresses a row by. `faces` is the side map that keeps what the story actually wrote, and
 * until `validateInventory` started carrying `face` on the accepted delta it was never populated at
 * all, so every block fold has ever injected said `sig p226` and `ka-bar knife`. Printing the face
 * is what makes the block, the panel and the overlay finally say the same words.
 *
 * @param {Map<string, string>} faces Key -> the name the story wrote.
 * @param {string} key A row key.
 * @param {string} name The key's own name half, as the fallback.
 * @returns {string} What to print.
 */
function itemFace(faces, key, name) {
    return String(faces?.get(key) ?? '').trim() || name;
}

/**
 * One character's capabilities, as labels, grade attached.
 *
 * The pov's own only, somebody else's ride on their cast line, which is the rule `renderLedger`
 * already keeps for standings, marks and belongings and for the same reason: attributing a
 * companion's technique to the player is the misattribution `who` was added to stop.
 *
 * @param {Map<string, object>} abilities The capability table.
 * @param {Map<string, string>} faces Key -> the name the story wrote.
 * @param {string} pov The point-of-view character.
 * @returns {Array<[string, string]>} `[key, label]`, in table order.
 */
function abilityRows(abilities, faces, pov) {
    const out = [];
    for (const [key, row] of table_entries(abilities)) {
        if (row?.who && row.who !== ownerKey(pov)) {
            continue;
        }
        const face = itemFace(faces, key, row?.name ?? splitItemKey(key).name);
        out.push([key, row?.rank ? `${face} ${row.rank}` : face]);
    }
    return out;
}

/** @returns {string[]} The pov's capability labels; see `abilityRows`. */
function abilityLabels(abilities, faces, pov) {
    return abilityRows(abilities, faces, pov).map(([, label]) => label);
}

/**
 * How far back a contributor mid may sit and still count as "written from what you are reading".
 *
 * The default trailing window is six messages (`extract.js runExtraction`, `windowSize = 6`), so a
 * row recorded at or after `mark - 6` was recorded from a message inside a default-sized window. It
 * is a horizon on the LEDGER's own record of when it wrote a row, not a claim about the excerpt: see
 * `recentlyRecorded` for what the mark means and `renderLedger` for the wording that rides on it.
 *
 * MEASURED on the live Wuxia campaign (`sanguine-traces/Wuxia World RPG - 2026-08-20@…`, 149 passes,
 * 22 `reject:already-recorded`). Replaying every proposal through `validateInventory` recovers 21 of
 * them; for each, the distance from that pass's mark back to the newest contributor of the refused
 * row, `mark - mid`, is:
 *
 *   0   10 refusals      the previous pass's own write, re-proposed one turn later
 *   2    3
 *   3    1
 *   6    1
 *   10   6               all six from ONE pass, turn 64, and not this distribution at all
 *
 * Turn 64 is a swipe: mid went BACKWARD (122 -> 120), `resolveMark` could not find the mark's
 * content key, and `splitWindow` fell back to `FIRST_WINDOW` and re-read twenty-four messages. Six
 * beats already recorded at mids 112-116 were handed back to the model as if new. That is a
 * mark-resolution defect in `extract-table.js`, not a horizon question, and no value here would
 * make it right, a horizon of 10 would only be lying on the 143 passes that read six messages.
 *
 * So the horizon is the window, and the swipe pass is named rather than absorbed.
 */
export const RECORDED_HORIZON = 6;

/**
 * The ledger rows written from the newest messages fold has read.
 *
 * The gate knows this and the model does not, which is the whole defect.
 *
 * `validateInventory` refuses `already-recorded` on exactly one predicate: the row is on the pinned
 * block AND the contributor that put it there is a mid the pass displayed (`reTold`, and the exact
 * `dq` match below it). Replaying the live Wuxia campaign, every one of the 21 recoverable refusals
 * had `shown.has(key) === true`: the item was printed on the block, in full, every time. So the
 * premise `extract.js` states for the pinned ledger ("a model shown 'Carrying: kang's phone number'
 * has no reason to propose gaining it a third time") holds for the NAME and fails for the BEAT: the
 * block says the line exists, and says nothing about which message paid for it.
 *
 * That gap is what the refusals are made of. Six of them are the same shape read straight out of the
 * trace: fold recorded a transaction from the message where it was OFFERED, and refused the message
 * where it completed.
 *
 *   turn 46, mids 83-88   the haggle at 85 ("I take out the three silver as if it were already
 *                         sorted") records `spear +1`, `silver -3`. The new half at 86-88 is the
 *                         stall owner actually handing the spear over and taking the coins. The
 *                         model reports the sale; both halves refuse.
 *   turn 91-93, mids 167-174  赵老爷 counts out forty taels at 170 and holds out his palm; fold
 *                         records `silver +40` there. The exchange happens at 172. The model
 *                         reports it at 172, again at 173, again at 174, and each time the credit
 *                         refuses `already-recorded` while the matching `fragment -1` refuses
 *                         `remove-unknown`, so the artifact fragment is sold three times and never
 *                         leaves the ledger.
 *
 * The model is not being careless in those passes; it is reading the message where the thing
 * actually happened. What it cannot see is that fold already billed the intention. Printing that
 * fact is the fix, and it is fold's own arithmetic, a mid on a contributor trail against the mark,
 * never a judgement about the narrative.
 *
 * The mark is `state.extractMark().mid`: the last message a successful pass read. It is the right
 * anchor rather than "the newest message in the chat" because it is what `buildWindow` splits on, so
 * a row recorded at or after it is a row the previous pass wrote out of text this pass re-displays
 * as context, the "Earlier, for context only (already recorded, extract nothing from this)" half
 * the refusals are overwhelmingly re-extracted from.
 *
 * @param {Map<string, Array<{mid: number|null}>>|null} contributors The trail, from `deriveState`.
 * @param {number} mark The high-water mark: the last mid a pass read. NaN before the first pass.
 * @param {number} [horizon] How far back of the mark still counts. See `RECORDED_HORIZON`.
 * @returns {Set<string>} Inventory/ability keys written within the horizon.
 */
export function recentlyRecorded(contributors, mark, horizon = RECORDED_HORIZON) {
    const out = new Set();
    if (!(contributors instanceof Map) || !Number.isFinite(mark)) {
        return out;
    }
    const floor = mark - Math.max(0, horizon);
    for (const [key, trail] of table_entries(contributors)) {
        if (trail?.some(entry => Number.isFinite(entry?.mid) && entry.mid >= floor)) {
            out.add(key);
        }
    }
    return out;
}

/**
 * How many refused debits the pinned block carries, and for how many turns.
 *
 * The cap is a prompt-budget bound, not a storage one: this text rides the block on every pass, and
 * the worst observed pass in the corpus proposed two refused debits at once (Wuxia turn 40, `herb
 * basket` and `vine herb`). Four is double that. The turn bound is what makes the note self-clearing
 * without a destructive read, a renderer that deletes what it printed cannot be called twice, and
 * `state.ledgerBlock` has two callers.
 */
export const MAX_REFUSED = 4;
export const REFUSED_TURNS = 2;

/**
 * The refusals worth reporting back to the model: a debit against a row fold does not hold.
 *
 * What qualifies, and what deliberately does not.
 *
 * Only `remove-unknown`, and only from a delta that actually carried a negative `dq`. The same
 * reason travels on two other things and neither belongs here:
 *
 *   · a `parts` entry naming an unheld row (`state.js validateDelta`, the component loop), its
 *     `raw` is the component's NAME, not a delta, so it carries no `dq` and this filters it by that
 *     alone. Asking the model to re-identify what a property belongs to is a different question.
 *   · the block path's refusals (`absorb.js`), which come from a card status block the model did not
 *     write and cannot correct.
 *
 * @param {object[]} rejections Rejections as the validators produced them.
 * @param {number} turn The turn to stamp, so the note can expire without a destructive read.
 * @returns {Array<{key: string, name: string, at: string, turn: number}>} Rows to keep.
 */
export function refusedDebits(rejections, turn) {
    const rows = [];
    for (const rejection of Array.isArray(rejections) ? rejections : []) {
        if (rejection?.reason !== 'remove-unknown') {
            continue;
        }
        const dq = Number(rejection?.raw?.dq);
        const name = String(rejection?.raw?.item ?? rejection?.item ?? '').trim();
        if (!Number.isFinite(dq) || dq >= 0 || !name) {
            continue;
        }
        const at = normalizePlace(rejection?.raw?.at);
        rows.push({ key: itemKey(name, at), name: name.slice(0, MAX_ITEM_NAME), at, turn });
    }
    return rows;
}

/**
 * Fold new refusals into the kept set, newest first, bounded.
 *
 * Newest wins the cap for a reason: an old refusal the model never acted on is the least useful line
 * in the block, it has already had its pass and the excerpt that raised it has scrolled away.
 *
 * @param {Map<string, object>} kept What is already stored.
 * @param {Array<{key: string}>} rows New refusals, from `refusedDebits`.
 * @param {number} [max] The cap. See `MAX_REFUSED`.
 * @returns {Map<string, object>} The table to store.
 */
export function keepRefused(kept, rows, max = MAX_REFUSED) {
    const next = new Map(kept instanceof Map ? kept : []);
    for (const row of rows ?? []) {
        // Re-keyed rather than appended: `copper -500` refused at turns 95, 96 and 97 is one thing
        // fold cannot spend, not three, and the newest stamp is the one the expiry should read.
        next.delete(row.key);
        next.set(row.key, row);
    }
    return new Map([...table_entries(next)]
        .sort((a, b) => (b[1]?.turn ?? 0) - (a[1]?.turn ?? 0))
        .slice(0, Math.max(0, max)));
}

/**
 * The refused-debit note, as the pinned block carries it.
 *
 * Fold states what it can prove and then ASKS.
 *
 * Two facts: the wording it was sent, and that nothing on the record answers to it. It does NOT name
 * a candidate. `fragment` against the held `artifact fragment` and `copper` against the held
 * `silver` are the same shape to any test fold could write, a shorter name, a shared token, and
 * the first is a merge while the second would spend a tael as if it were a copper coin. Which one it
 * is, is record linkage, and record linkage is the model's answer (`canonicalItemName`, RULE 1).
 *
 * The AMOUNT is deliberately absent from the ask. A model told "your 500 was refused" re-sends 500
 * against whatever row it settles on; a model told "this name matched nothing" re-sends the delta it
 * would have written anyway with `same_as` filled in, and every magnitude gate downstream
 * (`deltaAllowance`, `clamped-underflow`, `invariant:overdraw`) still runs on it unchanged. Nothing
 * here relaxes `remove-unknown`: a debit whose `same_as` still resolves to nothing is refused
 * exactly as before, and the note says so in its last clause rather than inviting another try.
 *
 * @param {Map<string, {name: string, at: string, turn: number}>} kept The stored refusals.
 * @param {number} turn The current turn.
 * @param {number} [within] How many turns a refusal stays worth saying. See `REFUSED_TURNS`.
 * @returns {string} The note, or '' when nothing was refused recently.
 */
export function renderRefused(kept, turn, within = REFUSED_TURNS) {
    const rows = [...table_entries(kept instanceof Map ? kept : new Map())]
        .map(([, row]) => row)
        .filter(row => Number.isFinite(row?.turn) && Number.isFinite(turn) && turn - row.turn < within);
    if (!rows.length) {
        return '';
    }
    const named = rows.map(row => `"${row.name}" (${row.at})`).join(', ');
    return [
        `Not counted, you reported these LEAVING and the record holds no line by that name: ${named}.`,
        'If one of them is a line listed above worded differently, report the change again with "same_as" set to that line\'s exact wording, and it will be counted.',
        'If it is genuinely something that was never recorded as held, leave it out; reporting it again unchanged will be refused again.',
    ].join(' ');
}

/** The suffix a recently-recorded row carries, and the sentence that says what it means. */
const COUNTED_MARK = ' (counted)';
const COUNTED_LEGEND = 'A line marked (counted) was written from the newest messages fold has read, that beat is already in the number beside it. Never report it as gained or lost again; report only a FURTHER change on top of it.';

/**
 * Render the tracked-state half of the pinned ledger, and say exactly what it showed.
 *
 * Why this exists beside `renderState` rather than replacing it.
 *
 * `renderState` is the narrator's injection and it has a shape the narrator has been reading for
 * the whole life of every live chat; changing it is a change to how the fiction gets written, and
 * this phase is not entitled to that. The unification the design asks for (`FOLD-REDESIGN.md` §5,
 * one renderer for panel, narrator, extractor and judge) lands with the phases that also rebuild
 * what is being rendered. Until then the extraction prompt gets its own view, and the two are held
 * in step by sharing every rule that decides *content*, `isFresh`, the place grouping, the
 * status-phrase rule, and differing only in wording.
 *
 * Two differences from `renderState`, both deliberate:
 *
 *   · Money is a line of its own. It is already keyed under the MONEY place, but `renderState`
 *     prints it as `Stored (money): won x330000`: a balance dressed as luggage. The extraction
 *     prompt is where the model is being asked to record purchases (`FOLD-REDESIGN.md` §5: money
 *     moved up three times and down never in 35 turns), so the balance says what it is.
 *   · It returns `shown`, the exact set of inventory keys it put in front of the model. That is
 *     what makes `reject:already-recorded` honest: the gate may only refuse a re-report of a line
 *     the model was actually told about. Phase A needed it because `isFresh` hid stale carried
 *     items, so "held" and "shown" were different sets; Phase C retired that hiding and the two
 *     sets now coincide. `shown` stays anyway, and is not vestigial: the ledger still omits things
 *     it holds, the Elsewhere cast, hidden dials' numbers, and a gate that reconstructs the
 *     prompt's contents from the state is a second definition of what the model was told, which is
 *     the exact class of bug `itemHead` was introduced to close.
 *
 * @param {object} params Parameters.
 * @param {Map<string, {qty: number}>} params.inv Inventory.
 * @param {Map<string, {cur: number, max: number}>} params.vitals Vitals.
 * @param {Map<string, object>} params.marks Marks, keyed by `markKey`.
 * @param {string} [params.pov] The point-of-view character, whose marks this block carries.
 * @param {Set<string>|null} [params.counted] Keys written from the newest messages fold has read
 *   (`recentlyRecorded`). Those rows carry `(counted)` and the block gains one legend line saying
 *   what that means. Null renders exactly as before, the judge's block passes null, because
 *   "already billed" is not a fact about the attempt it is being asked to rule on.
 * @returns {{lines: string[], shown: Set<string>, counted: number}} The lines, the keys they
 *   contained, and how many of those rows were marked.
 */
export function renderLedger({ inv, vitals, marks, standings = new Map(), abilities = new Map(), faces = new Map(), pov = '', counted = null }) {
    const lines = [];
    const shown = new Set();
    // The mark is per ROW, not per line.
    //
    // A `Carrying:` line holds a dozen items and the refusals name one of them: at turn 46 of the
    // live Wuxia campaign the block carried nine carried rows and exactly one, the spear, was the
    // beat being re-extracted. Marking the line would say "all of this is counted", which is true of
    // every row on it and useless; marking the row says which beat the model is looking at.
    let marked = 0;
    const tag = (key, label) => {
        if (!(counted instanceof Set) || !counted.has(key)) {
            return label;
        }
        marked++;
        return `${label}${COUNTED_MARK}`;
    };

    // Capabilities first among the belongings, because they are the one part of the record the
    // model cannot re-derive from the scene, a sword is in the prose, a proficiency is not. In
    // `shown` like any other row: `already-recorded` may only refuse a re-report of a line the
    // model was actually told about, and a re-granted technique is exactly that.
    const known = abilityRows(abilities, faces, pov);
    if (known.length) {
        for (const [key] of known) {
            shown.add(key);
        }
        lines.push(`Abilities: ${known.map(([key, label]) => tag(key, label)).join(', ')}`);
    }

    const money = [];
    const byPlace = new Map();
    for (const [key, item] of table_entries(inv)) {
        const { who, place, name } = splitItemKey(key);
        // Somebody else's belongings stay on their cast line, the rule this function already keeps
        // for standings and marks a few lines down, and the reason it exists: attributing another
        // character's gear to the player is the misattribution the owner was added to stop. They are
        // also left OUT of `shown`, because `shown` means "lines the model was told about here".
        if (who && who !== ownerKey(pov)) {
            continue;
        }
        shown.add(key);
        const face = itemFace(faces, key, name);
        if (place === MONEY) {
            money.push(tag(key, `${item.qty} ${face}`));
            continue;
        }
        const graded = item.rank ? `${face} ${item.rank}` : face;
        insert_with(byPlace, merge_graph, place, [tag(key, item.qty > 1 ? `${graded} x${item.qty}` : graded)]);
    }

    if (money.length) {
        lines.push(`Money: ${money.join(' · ')}`);
    }
    for (const [place, names] of table_entries(byPlace)) {
        lines.push(`${place === CARRIED ? 'Carrying' : `Stored (${place})`}: ${names.join(', ')}`);
    }

    const vitalParts = table_entries(vitals).map(([name, v]) => vitalReading(name, v));
    if (vitalParts.length) {
        lines.push(`Vitals: ${vitalParts.join(' · ')}`);
    }

    // Same rule as `renderState`: the pov's own tracks on one line, and a standing owned by someone
    // else stays on their cast line rather than being attributed to the player.
    const povStandings = table_entries(standings)
        .filter(([, row]) => !row.who || row.who === ownerKey(pov))
        .map(([, row]) => `${row.name} ${row.value}`);
    if (povStandings.length) {
        lines.push(`Standing: ${povStandings.join(' · ')}`);
    }

    // The pov's marks; everyone else's ride on their own cast line. The phrase, not the key,
    // `statusSubject` explains why the key is the wrong thing to show.
    const flags = povPhrases(marks, pov);
    if (flags.length) {
        lines.push(`Condition: ${flags.join(', ')}`);
    }

    // Last, and only when something carries it. A legend for a marker nothing wears is prompt budget
    // spent teaching a notation the block does not use, and on a quiet pass with no recent writes
    // that is every pass. It sits under the rows rather than over them for the same reason the
    // review's instructions sit under its ids: the reader meets the notation first.
    if (marked) {
        lines.push(COUNTED_LEGEND);
    }

    return { lines, shown, counted: marked };
}

/**
 * One owner's live marks, as the phrases a reader would recognise, worst first.
 *
 * The severity word rides along in parentheses only for `severe`, and the cut is the same one
 * `hurtOf` makes: a phrase cannot carry the difference between a nuisance and the reason you cannot
 * lift a sword, and that difference is the only part of the ladder fold ACTS on. Printing the word
 * on every mark was tried first and measured against the block's budget, `moderate` is the default
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
    // subjectless mark, which belongs to the point-of-view character, would have rendered on
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
 * One person's belongings, as the phrases a reader would recognise.
 *
 * `markPhrases` for items, and STRICTLY that owner's bucket for the same reason: the unowned bucket
 * is the point-of-view character's, and reading it here would print the player's whole inventory on
 * every cast row. Money is rendered as a quantity and a name because that is how a purse reads; a
 * thing is rendered as itself, with a count only when there is more than one.
 *
 * @param {Map<string, {qty: number, rank?: string}>} inv The inventory table.
 * @param {string} who Owner name or key. '' returns nothing, use `renderLedger` for the pov.
 * @returns {string[]} Phrases, money first, then belongings in table order.
 */
export function itemPhrases(inv, who) {
    const owner = ownerKey(who);
    if (!owner) {
        return [];
    }
    const money = [];
    const things = [];
    for (const [key, item] of table_entries(inv)) {
        const parts = splitItemKey(key);
        if (parts.who !== owner) continue;
        if (parts.place === MONEY) {
            money.push(`${item.qty} ${parts.name}`);
            continue;
        }
        const graded = item.rank ? `${parts.name} ${item.rank}` : parts.name;
        things.push(item.qty > 1 ? `${graded} x${item.qty}` : graded);
    }
    return [...money, ...things];
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
 * the table records which is which rather than flattening them into "the value", the ontology's
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
 * pair each value carries makes the result independent of arrival order, `resolution_max_converges`
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
 * Why a count and not an expiry.
 *
 * A lock is a field you corrected by hand, and `setContext` discards every write that disagrees
 * with it (`state.js`, `cap:field-locked`). Measured on the live Solo Leveling chat: the location
 * lock taken at turn 10 blocked **7** writes and the panel went on showing an empty room in a scene
 * that contained the player, the mechanism did exactly its job and the result was a lie nobody
 * could see (`FOLD-REDESIGN.md` §0.1-2, §5).
 *
 * The obvious repair is an expiry, and it is refused: a lock that times out is decay wearing a UI,
 * and `FOLD-REDESIGN.md` §11 rules out decay with `BayesFilter.zero_residual_is_fixed`. The honest
 * mechanism is the one the rest of this design uses everywhere, surface the disagreement and ask.
 * The lock still wins until the user acts; that is what a lock is. It simply can no longer lie
 * silently.
 *
 * Three, because one disagreement is the narrator wandering and two is a coincidence; three
 * consecutive reads that all say the same other thing is the story having moved. The live sequence
 * would have raised it once, on the third of its seven blocked writes, which is the shape a signal
 * should have, not seven alerts about one argument.
 */
export const CONTEST_AT = 3;

/**
 * Fold one blocked write into a field's contest record.
 *
 * Consecutive, and agreement is what breaks the run.
 *
 * The count is of consecutive reads saying THE SAME other thing. A narrator that says "the chamber",
 * then "the gate site", then "the chamber" has not built a case for anything; it has wandered.
 * Whereas three reads that all say "the Nowon gate site" is the story having moved on without the
 * lock, which is the fact worth surfacing. So a different value restarts the run at one, and a write
 * that AGREES with the locked value clears the record entirely, the argument is over.
 *
 * Pure and total: it takes what is stored and returns what should be stored, so the impure caller
 * has nothing to decide.
 *
 * @param {object|null} held The stored contest record for this field, or null.
 * @param {object} params Parameters.
 * @param {string} params.locked The value the lock is holding.
 * @param {string} params.value The value the write proposed.
 * @param {number} [params.turn] The turn this write arrived on.
 * @returns {{record: object|null, raised: boolean}} What to store, null to clear, and whether
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
 * The purchases a pass recorded with nothing paid for them.
 *
 * What this used to be, and the measurement that changed it.
 *
 * It used to be *acquisitions* with nothing paid for them, on the premise that a credit with no
 * debit is an unpaid purchase. The premise is false in play and the full corpus measurement is on
 * `BOUGHT` above: 286 firing passes, 531 items, 369 asks, and of the 121 asks the model answered
 * at all it answered "nothing was paid" 102 times. The trigger was right about one acquisition in
 * twenty and settled once in forty-two on the owner's live chat.
 *
 * So the detection no longer guesses the acquisition mode, it reads the one the model stated
 * (`acquisitionOf`) and fires only on `bought`. Everything below this line is unchanged and still
 * right: what has changed is that "an item arrived" is no longer evidence of a purchase, and the
 * model saying it PAID for the thing is.
 *
 * The Solo Leveling case the whole mechanism was built for survives the narrowing intact, because
 * the model was never confused about that turn, six items bought, the price stated five separate
 * times in plain text including the player's own "I hand over the 120k", and only the money DELTA
 * missing. A model that writes that scene writes `how: "bought"`; what it forgot was the row, which
 * is what the question exists to recover.
 *
 * The trigger is still in code, which is the part that was never in doubt.
 *
 * Measured twice on the live Solo Leveling chat: across 40 turns money moved up and never down,
 * and the second hand repair found the one purchase priced *five separate times* in plain text,
 * including the player's own "I hand over the 120k", with all six items credited and the balance
 * unmoved (`FOLD-REDESIGN.md` §0.1, §5). The first draft's remedy was a line in the delta
 * instruction; the correction that was accepted is that a prompt line is the weakest of the three
 * available fixes, by the same argument that moved adjudication into code, instructions decay,
 * triggers in code do not. So: code decides WHEN to ask, and the model only reads the scene and
 * answers, which is the division of labour `verdict.js:5-18` established.
 *
 * A purchase with no debit is mechanically detectable once the model has said which acquisitions
 * were purchases, and this is the detection. Categories stay excluded on top of the `bought` gate:
 * an ability learned and a property inherited are gains that legitimately cost nothing, and a model
 * that calls a taught technique a purchase is contradicting the place it filed it under.
 *
 * It is also the designed recovery for Phase A's known cost.
 *
 * `reject:already-recorded` refuses a genuine same-name re-acquisition, the bracers destroyed at
 * mid 38 and re-bought at 66 stay at ledger 1 (Phase A's LANDED note, `FOLD-REDESIGN.md` §10).
 * Nothing in `{item, dq, at}` distinguishes a re-buy from a re-report, so the refusal is the right
 * error to make at write time. But a refused credit *plus a payment in the window* is exactly this
 * function's trigger shape, which is why refusals are passed in beside the accepted deltas: the
 * question that comes back is the one that surfaces the purchase the gate declined to bill, and the
 * answer arrives as an ordinary validated money delta.
 *
 * The refusal branch had no gates at all, and it put a CURRENCY into the question.
 *
 * It pushed any `already-recorded` item name, without the place exclusion or the sign test the
 * accepted branch has applied since it was written. Two of the corpus's longest-lived questions are
 * that hole: Solo Leveling asked *"won, darkwood staff, shortsword, bracers, greaves, gloves,
 * trauma kit, coagulant"* for ten passes running, `won` is the currency itself, offered back to
 * the model as an unpaid acquisition to price, and Wuxia asked *"nine realms heavenly ascension
 * technique, silver wen"* for seven. A money row and an abilities row, both excluded four lines
 * above, both readmitted here. The refusal now faces every gate the acceptance does.
 *
 * @param {object} params Parameters.
 * @param {object[]} params.accepted Accepted inventory deltas from this pass, flattened.
 * @param {object[]} [params.refused] Rejections from this pass, so a refused purchase still counts.
 * @returns {string[]} Items bought with no money debit; empty when nothing is owed.
 */
export function creditsWithoutDebit({ accepted = [], refused = [] } = {}) {
    let debited = false;
    const credits = [];
    for (const change of accepted) {
        const place = normalizePlace(change?.at);
        const dq = Number(change?.dq ?? 0);
        if (place === MONEY) {
            // A restated total is the model's last word on the money, so there is nothing to ask.
            //
            // This read `if (dq < 0) debited = true`, on the argument that "a restated money total is
            // not a payment either way, `set` carries no sign". The premise is true and the
            // conclusion was backwards. `set` carrying no sign means a restatement cannot be read as
            // a CREDIT that still needs a debit; it does not mean the turn's money went unaccounted.
            // An absolute balance is the model reporting where the purse stands AFTER the turn it
            // just narrated, purchases included.
            //
            // So the question fired anyway, and the only thing the model could do with "you gained
            // these and paid nothing" was name the price a second time. Measured in the live Wuxia
            // ledger, replayed through `replay` rather than read from the panel, four double-bills,
            // each one the restatement's own arithmetic billed again:
            //
            //   mid 251 `set: 63`   (563 − 500)   then mid 253 review `dq: -500`
            //   mid 258 `set: 23`   ( 63 −  40)   then mid 260 review `dq:  -40`
            //   mid 266 `set: 173`                then mid 267 review `dq:  -80`
            //   mid 286 `set: 373`  (1273 − 900)  then mid 287 review `dq: -900`
            //
            // 373 − 900 is negative, `merge_qty` floors it at zero, and `deriveState` deletes an
            // emptied row, so the last one did not make the purse wrong, it made the purse GONE.
            // A campaign's whole fortune, deleted by a question. The same shape had already killed
            // the singular `low-grade spirit stone` row at mid 253, which is why the balance came
            // back under a plural spelling: fold's own split detector firing on its own bad delta.
            //
            // Money moving TOWARD you also accounts for the turn, and reading only debits billed a gift.
            //
            // This read `dq < 0 || set`, so a positive credit left `debited` false and the question
            // fired anyway. Measured in the live Wuxia chat of 2026-08-20, ledger `cac4153c`:
            //
            //   mid 40  Dr. Wáng doubles the reward to twenty taels AND promises wound medicine
            //   mid 80  "王大夫 paid ... twenty taels of silver and gave him a jar of wound medicine"
            //           delta: [{silver, dq: +20, at: money}, {wound medicine, dq: +1}]
            //   mid 82  review, `rev:`: "Paid 20 silver for wound medicine"  dq: -20
            //
            // The jar was the other half of the reward, in the same sentence as the payment. The
            // rule saw an item credited, no DEBIT beside it, and asked what it cost; the model,
            // handed an unpriced item and a purse holding exactly twenty, answered twenty. The
            // player's whole balance, spent on something he was given.
            //
            // A gift and an unpaid purchase are genuinely indistinguishable to "was there a debit?".
            // They are not indistinguishable to "did money move at all?", nobody is paid for a
            // thing in the same breath as paying for it. So ANY money movement in the delta means
            // the turn's money is accounted for and there is nothing left to ask, which is the same
            // conclusion the `set` branch above reached by the same reasoning one step earlier.
            //
            // A turn that moved no money at all is untouched, which is the case this was built for.
            if (dq !== 0 || Number.isFinite(change?.set)) debited = true;
            continue;
        }
        // A restatement is not an acquisition, it is the list you already had, re-read.
        if (Number.isFinite(change?.set) || dq <= 0 || CATEGORIES.has(place)) continue;
        // The line that turns 531 questions into the dozen that are real.
        //
        // `validateInventory` put this here from the model's own `how`, and it is read rather than
        // inferred. An entry fold was not told about ('', a block-parsed delta, a hand edit, a
        // ledger older than the field) is NOT a purchase: an unanswered row defaulting to `bought`
        // would take a rule that is wrong 95% of the time and make it wrong every time.
        if (String(change?.how ?? '') !== BOUGHT) continue;
        credits.push(String(change.item ?? ''));
    }
    for (const rejection of refused) {
        if (rejection?.reason !== 'already-recorded' || !rejection.item) continue;
        // The refusal carries the model's own proposal, so every gate the accepted branch applies
        // is available here and all three were missing. See the docblock for the two live questions
        // this hole produced.
        const raw = rejection.raw;
        if (CATEGORIES.has(normalizePlace(raw?.at))) continue;
        if (acquisitionOf(raw, Number(raw?.dq ?? 0)) !== BOUGHT) continue;
        credits.push(String(rejection.item));
    }
    return debited ? [] : [...new Set(credits.filter(Boolean))];
}

/** Scale words a narrator writes instead of zeros, and what each is worth. */
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

/**
 * What eviction is about to destroy, as a baseline correction, in BOTH directions.
 *
 * The measurement is a difference of two folds, and the difference has a sign.
 *
 * `demoteEvents` archives a summary and drops `d`, so the moment an event leaves the hot ledger its
 * delta is unrecoverable and the balance it contributed silently unwinds. `carryForward` measures
 * the loss as a difference of two folds of the shipped `deriveState`: the ledger as it stands
 * against the ledger with the doomed events gone, which is right, and by construction includes any
 * interaction with the zero-floor.
 *
 * Two things were wrong in the arithmetic on top of it, and a recurring cost is what makes both
 * ordinary rather than rare:
 *
 *   `lost <= 0` skipped   a batch whose net contribution to a key is NEGATIVE was dropped, so
 *                         evicting a run of spending made the player richer. Masked until now
 *                         because a real event stream mixes credits and debits and usually nets
 *                         positive; a rent is a pure-debit stream and nets negative every time.
 *
 *   iterating `now` only  `deriveState` deletes a row at `qty <= 0`, so a fully-spent key is ABSENT
 *                         from `now` while `after` still holds it. The largest debits, precisely
 *                         the ones that emptied a row, were the ones certain to be missed. The
 *                         keys have to be the union of both folds.
 *
 * A negative baseline entry is deliberate and not a guard failure: it means the visible events no
 * longer show spending that really happened, which is exactly what the baseline is for. It seeds
 * into `deriveState` summed rather than overwritten, so a later credit cancels it and the row
 * reappears at the right total.
 *
 * @param {Map<string, object>} now The inventory folded from every event, doomed ones included.
 * @param {Map<string, object>} after The inventory folded from the survivors alone.
 * @param {Map<string, object>} held The baseline as it stands.
 * @returns {{next: Map<string, object>, carried: number}} The new baseline and how much moved.
 */
export function carriedBaseline(now, after, held) {
    const before = now ?? new Map();
    const rest = after ?? new Map();
    const next = new Map(table_entries(held ?? new Map()));
    const keys = new Set([...before.keys(), ...rest.keys()]);

    let carried = 0;
    for (const key of keys) {
        const was = Number(lookup(before, key, { qty: 0 })?.qty) || 0;
        const kept = Number(lookup(rest, key, { qty: 0 })?.qty) || 0;
        const lost = was - kept;
        if (!lost) {
            continue;
        }
        insert_with(next, merge_b, key, { qty: (Number(lookup(next, key, { qty: 0 }).qty) || 0) + lost });
        // A magnitude, so the counter reads as "how much was rescued" rather than netting a
        // credit against a debit and reporting that nothing happened.
        carried += Math.abs(lost);
    }
    return { next, carried };
}
