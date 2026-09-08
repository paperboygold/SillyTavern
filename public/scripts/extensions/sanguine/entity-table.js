/**
 * fold/entity-table.js: the people and leads a scene contains, as objects rather than prose.
 *
 * Pure, dependency-free apart from ./lib/hash.js. Unit-testable.
 *
 * Why this file exists.
 *
 * A card's status block is a flat serializer. It writes
 *
 *     Immediate contacts: Maria, by email
 *
 * and by the time that reaches a panel it is a string. Split it on commas and you get two peers,
 * one of whom is not a person. Do not split it and you get a run-on. Neither is right, because the
 * information the block destroyed was the *pairing*: Maria is an object, and "by email" is a
 * property of her.
 *
 * Leads are worse, because there the commas are genuinely ambiguous:
 *
 *     Leads: RPD missing-persons cluster around Arklay County from September 15-18, Adele Ricci,
 *            nurse at the closed corner clinic, is missing, Umbrella contractor access is suspended
 *
 * Three of those commas separate leads and two of them are appositive. No splitter can tell which
 * is which, because the distinction was never encoded. So this module does not try to parse prose:
 * it takes structure from the extraction model, which reads the narrative rather than the block,
 * and is asked for objects in the first place.
 *
 * The shape.
 *
 * This is an ontology in the sense sanguine-ontology.js means it (object, property, link), and
 * deliberately the smallest one that pays for itself:
 *
 *     addObject(O, id, props)   →   foldEntity(table, {kind, name, detail, status})
 *     propertyOf(O, id)         →   lookup(table, entityKey(kind, name))
 *
 * One table, keyed by `kind␀name`, under a field-wise merge. The merge is the only interesting
 * choice here, and `merge_b` over the whole record is the wrong one: a later mention of Maria that
 * says only where she is would erase how to reach her. Fields merge; the record does not.
 */

import { insert_with, lookup, merge_graph, table_entries } from './lib/hash.js';
import { windowSnippet } from './diag.js';

/**
 * Entity kinds.
 *
 * Why a third kind cost nothing, and why it is deliberately the SMALLEST possible third kind.
 *
 * The key is `kind␀name`, so a third kind is free at the storage layer: nothing about the product
 * key, the merge or the alias resolution cares how many kinds there are. What it costs is the
 * question "what is a faction, and what does it have that a person does not?", and the answer
 * adopted here is **nothing** (FOLD-REDESIGN.md §7.3): `wants` is the guild's goal, `feels` is its
 * standing toward the player, `place` is its sphere of operation. Same fields, same jobs, same
 * renderer.
 *
 * That is the whole of SWN's faction layer that survives the drop of its economy (§11): "one actor
 * should cost one cast row, not a balance sheet." FacCreds, asset maintenance, faction hit points
 * and the fixed action menu exist so a human GM can resolve a sector without judgement calls; fold
 * has a model for the judgement and a ledger to bound it.
 *
 * An actor is deliberately NOT a thread. Actors persist across many stakes and do not close; what
 * an actor is currently doing is a thread, and threads close. Modelling White Tiger as a thread
 * would make "White Tiger exists" something that can become `settled`, which is a category error
 * the schema should make inexpressible.
 *
 * The caveat this docblock used to end on was that the cheapest layer, a *person* with a `wants`
 * who acts between scenes, needs no faction kind at all and covers most of the measured demand.
 * That was a reasonable call and a completed Xianxia campaign falsified it, so it is recorded here
 * rather than quietly dropped:
 *
 *   · 26 cast rows, every one `person`. Three trading houses and a cultivator alliance ran the
 *     entire mid-game economy and appear nowhere on the cast, only as substrings inside some
 *     shopkeeper's `wants`.
 *   · 22 of those 26 `wants` are OCCUPATIONS, not agendas: "selling herbs and answering customer
 *     inquiries", "sell books and maps for silver". None of them can advance, because `wants` is
 *     last-write per sighting and churns to whatever the actor is doing right now, the churn this
 *     file documents approvingly further down (`wants: "buy herbs" → "closing soon, spare a
 *     moment"`), which is exactly right for the panel and exactly wrong for a standing agenda.
 *   · the world-turn was armed 107 times and moved nothing, 0 rejections, because its root rule
 *     requires an actor already on the cast.
 *
 * So the person-with-a-wants layer covers the demand it was measured against and not this one. What
 * a faction has that a person does not is still nothing at the storage layer, same fields, same
 * merge, same renderer. What it has now is `drive`: a standing agenda's POSITION, which `wants`
 * cannot carry because `wants` is a sentence that gets overwritten and a position is an integer
 * that accumulates. Kang and Jin-Woo are still people.
 */
export const PERSON = 'person';
export const FACTION = 'faction';
export const LEAD = 'lead';

/**
 * The kinds that can WANT something and therefore can act off-screen.
 *
 * Read by `castAt` (so a guild whose sphere is the scene is present in it, the same way a person
 * standing there is) and by the world probe's rooted-move check (`world-table.js`): a move must
 * name an actor fold already knows, and this is the list of what counts as one. A lead is not on
 * it; a lead is a thread, and threads are the other half of the root rule.
 */
export const ACTOR_KINDS = Object.freeze([PERSON, FACTION]);

/**
 * The longest a standing agenda may be.
 *
 * Matches `thread-table.js` `MAX_TRACK_SIZE` in spirit: a drive is a progress track, but is stated
 * here because that file imports this one and the reverse would be a cycle. See `foldEntity`.
 */
export const MAX_DRIVE = 20;

/**
 * The shortest a standing agenda may be.
 *
 * Two, because a one-step agenda is a scene: it has no middle, so nothing the off-screen turn does
 * to it is ever an ADVANCE; it is either untouched or finished, and a dial with no intermediate
 * state is a boolean wearing a track's clothes.
 *
 * Stated once because it was previously a bare `2` in three places that had to agree and could not
 * be checked: `foldEntity`'s clamp below, the floor in `planNominations` (`world-table.js`), and
 * two prompt descriptions quoting the range to the model. A schema that tells the model "2 to 20"
 * while the code floors somewhere else is a schema that lies, and the model answering 1 seven times
 * is what made the disagreement visible.
 */
export const MIN_DRIVE = 2;

/**
 * Which actor kind the probe said this is.
 *
 * The read side was finished; nothing ever wrote a faction.
 *
 * `FACTION` has been declared, listed in `ACTOR_KINDS`, accepted by `foldEntity` and resolved by
 * the world probe (`world-table.js`) for as long as those existed. No faction was ever stored,
 * because the cast probe spread `kind: PERSON` over every entry it returned (`entities.js`), so the
 * model's answer, if it had been asked for one, was overwritten on the way in.
 *
 * Measured in the retired Wuxia campaign: 26 cast rows, every one `person`. 万仙盟, 万通商行 and
 * 灵丹阁 ran the mid-game economy and appear nowhere on the cast, only as substrings inside some
 * shopkeeper's `wants`. The world-turn requires a move to name an actor already on the cast, so
 * faction motion was unreachable by construction: the rule that stops the model inventing actors
 * also stopped factions from ever becoming actors.
 *
 * An enum, deliberately, and not a guess from the name. Deciding "万通商行 sounds like an
 * organisation" would be fold reading a name in one language; the model classifies, fold checks the
 * answer is a vocabulary member. Anything else falls back to `PERSON` rather than being refused,
 * because a mis-tagged actor is still an actor, and refusing the row would lose a person over a
 * label.
 *
 * @param {string} said The probe's answer.
 * @returns {string} An `ACTOR_KINDS` member.
 */
export function actorKind(said) {
    const kind = String(said ?? '').trim().toLowerCase();
    return ACTOR_KINDS.includes(kind) ? kind : PERSON;
}

/** Separator between kind and name. Not typeable, so a name can never forge a kind. */
const KIND_SEP = '\u0000';

/**
 * Context labels each kind supersedes once extraction has produced structure.
 *
 * A card writes "Immediate contacts: Maria, by email" into its block, and fold keeps that string as
 * scene context so nothing is lost when extraction has not run. Once real entities exist, the
 * string is the same information in a worse shape, so both the panel and the injected block skip
 * it rather than showing the pairing twice, once correctly and once flattened.
 */
export const PERSON_LABELS = ['immediate contacts', 'contacts', 'people', 'present'];
export const LEAD_LABELS = ['leads', 'objectives', 'threads', 'open questions'];

/** Bounds, matching state-table's reasoning: generous for play, tight enough to bound the blob. */
export const MAX_NAME = 64;
export const MAX_DETAIL = 120;
export const MAX_ENTITIES = 48;

/**
 * What somebody LOOKS like, and why one field could not hold it.
 *
 * `facts` was asked to be appearance, clothing, rank, bloodline and standing truth at once, in 120
 * characters, for everybody. Measured on the two live chats, that is exactly what it returns:
 *
 *     Raccoon City   facts: "officer"
 *                    facts: "mid-forties, civilian clothes, bloody arm wrapped in torn shirt"
 *                    facts: ""                                            (7 of 16 rows)
 *     Wuxia World    facts: "burly man with forearms like tree roots"
 *                    facts: "wiry woman with sharp eyes, wears a faded blue headscarf"
 *
 * The Wuxia rows are the field working as well as it can, and they are still one clause. There is
 * nowhere in that to put "almond-brown eyes, straight brows, sharp cheekbones, pale-gold skin.
 * Black bob cut" AND "partial to a red dress when she wants to be remembered" AND "says less than
 * she knows", and the second and third are not the same KIND of thing as the first, which is the
 * substantive reason this is four fields and not one longer one:
 *
 *   · `look`: build, features, colouring, hair, scars. PERMANENT. Eye colour does not change
 *                 because somebody walked into another room, so a sighting that re-describes the
 *                 room must not be able to churn it.
 *   · `wearing`: what they have on RIGHT NOW, and what visible state they are in. This is the one
 *                 that must churn: the whole complaint is that the narrator has "no idea what
 *                 they're wearing", and a coat changed two scenes ago is worse than no answer.
 *   · `bearing`: voice, movement, manner, the personality the surface shows. PERMANENT, and the
 *                 field the owner's standard spends most of its words on ("calm, dry, economical
 *                 with words, observant; says less than she knows").
 *   · `history`: where they came from and what they have done. PERMANENT, and the only one of the
 *                 four that is not observable in the room.
 *
 * Splitting permanent from current is not tidiness; it is the merge. `merge_entity` is last-write
 * per field, so one field holding both means every sighting that mentions a coat rewrites the face.
 *
 * The budget, and why only a flagged row carries the long form.
 *
 * MEASURED on the live chats, this repository, at the time of writing:
 *
 *     Raccoon City   sanguine blob 125,851 B of MAX_FOLD_BYTES 131,072, 96% full, 16 cast rows
 *     Wuxia World     sanguine blob  88,460 B, 10 cast rows
 *
 * What the four fields can add at their ceilings, counting the key names and quoting:
 *
 *                          16 rows (Raccoon City)     48 rows (MAX_ENTITIES)
 *     plain caps                    4.2 KB                   12.4 KB
 *     dossier caps                 22.6 KB                   67.9 KB
 *
 * The second row is unaffordable and the first is not. On Raccoon City, 22.6 KB against 5 KB of
 * headroom means the store's pruner starts shedding chronicle events to pay for a description of a
 * dead mail carrier; 4.2 KB is inside what the cast already costs, and most of it is appearance
 * that was already being written into `facts`. That is the trade stated plainly: the cast cannot
 * afford rich detail for everybody, and it does not need to, the story returns to four or five
 * people and walks past the rest.
 *
 * So the person-of-interest flag, which already existed and already bought a fuller prompt line
 * (`renderEntities`), now also buys the long form at rest. An unflagged row keeps `look` and
 * `wearing` at the ordinary `MAX_DETAIL`: the same budget appearance already had inside `facts`,
 * so nothing anyone has today gets smaller, and carries no `bearing` and no `history` at all.
 * Worst case at 48 unflagged rows is 48 × 240 B ≈ 11 KB, and the realistic 16-row cast is 3.8 KB.
 *
 * Nothing is lost by flagging late. The fields are re-derived from prose on every sighting, and the
 * probe is TOLD who is flagged (`entities.context`), so a person flagged on turn 40 is described in
 * full on turn 41 rather than needing to have been flagged on turn 1.
 */
export const MAX_DOSSIER = 400;

/**
 * The cap on what a flagged person is currently WEARING.
 *
 * Half the dossier cap, deliberately, and the asymmetry is the churn. `look`, `bearing` and
 * `history` are written once and re-confirmed; `wearing` is rewritten every time the story changes
 * a coat, and each rewrite is a fresh 200-plus bytes through the merge and out to the prompt. A
 * sentence is enough to say what somebody has on, the owner's own standard spends one on it
 * ("Beneath trench coat and dress: narrow waist, strong thighs") and three on the face.
 */
export const MAX_WEARING = 200;

/**
 * The dossier fields, and which cap each takes at each tier.
 *
 * `look` and `wearing` are the everyone tier: capped at `MAX_DETAIL` for an unflagged row, at the
 * dossier caps for a flagged one. `bearing` and `history` are flagged-only, `dossier: false` omits
 * them from the record entirely rather than storing an empty string, because `merge_entity` reads
 * `''` and absence identically and the blob is 96% full on the largest live chat.
 */
const DOSSIER_FIELDS = Object.freeze({
    look: { flagged: MAX_DOSSIER, plain: MAX_DETAIL },
    wearing: { flagged: MAX_WEARING, plain: MAX_DETAIL },
    bearing: { flagged: MAX_DOSSIER, plain: 0 },
    history: { flagged: MAX_DOSSIER, plain: 0 },
});

/**
 * Apply the dossier tier to a set of hand-written columns.
 *
 * The tier has to hold on the hand path too, or it is not a tier.
 *
 * `foldEntity` clamps what the MODEL proposes, and that was the whole enforcement. `entities.patch`
 *, the hand path behind the row editor, wrote whatever string it was given straight onto the
 * record, so a player editing an unflagged person could store a 4,000-character `bearing` on a row
 * that is supposed to carry none at all. Not malicious and not unlikely: the editor is a textarea.
 *
 * That matters more than it looks, because the tier is not cosmetic. It is the only thing keeping
 * the long form off 48 rows in a blob that is 96% full on the largest live chat, where going over
 * makes the store shed chronicle events to pay for it.
 *
 * Returns a NEW object; flagged-only columns are dropped rather than emptied, for `merge_entity`'s
 * reason: `''` and absence read identically to it, and an empty string is bytes that buy nothing.
 *
 * @param {object} fields Columns as written by hand.
 * @param {boolean} flagged Whether this row is a person of interest.
 * @returns {object} The columns, clamped to the tier.
 */
export function clampDossierFields(fields, flagged = false) {
    const out = {};
    for (const [column, value] of Object.entries(fields ?? {})) {
        const cap = DOSSIER_FIELDS[column];
        if (!cap) {
            out[column] = value;
            continue;
        }
        const limit = flagged ? cap.flagged : cap.plain;
        if (!limit) {
            // Flagged-only column on an unflagged row: not stored, not emptied.
            continue;
        }
        out[column] = String(value ?? '').slice(0, limit);
    }
    return out;
}

/** How many turns an unmentioned entity survives before it stops being rendered. */
export const ENTITY_STALE = 20;

/**
 * How long a row with no relational field survives.
 *
 * Age was never the thing that separated a person from the furniture.
 *
 * MEASURED, live Raccoon City campaign at turn 88: 14 of 22 cast rows had no `wants`, no `knows`, no
 * `reach` and `threat: 0`. Two of them were corpses, `the mail carrier` and `the man in coveralls`,
 * both `facts: "dead"`: still rendering a five-pip affinity meter, and the player cleared nine rows
 * by hand. `ENTITY_STALE` could not catch them: a narrator walking past the same body describes it
 * again, and any sighting refreshes the clock.
 *
 * What distinguishes them is not recency. It is that nothing on the record connects them to
 * anything: `identity_not_local` and `identity_in_the_edge`
 * (`sanguine/proof/Substrate/Algebra/Web/WebOfNodes.lean:92,101`), a node whose only content is a
 * local readout is a blur, and is individuated only by an edge. A row with no edge is a description,
 * and a description belongs in the scene, not in the cast.
 *
 * A quarter of the window, and full length the moment an edge appears. Deliberately not zero and
 * deliberately not a deletion: a person the story has not characterised YET is exactly the person it
 * may characterise next turn, and eviction demotes to the cold store either way, so a name that
 * returns comes back with its record.
 */
export const SCENERY_STALE = Math.max(1, Math.round(ENTITY_STALE / 4));

/**
 * How long the story has kept coming back to this record.
 *
 * `turn - first` over fold's own keys, the distance between the first sighting and the latest one.
 * Both fields are present on 165 of 165 cast rows across all 17 live chats, including the thirteen
 * still written under the legacy `fold` metadata key, so this is available everywhere and uncapped.
 *
 * Extracted rather than restated. The expression lived inline inside `hasEdge`, which reads it as
 * evidence of CONNECTEDNESS ("a record the narrative has returned to across a long arc is connected
 * to it"), and `driveOf` below reads the same number as evidence of STANDING-ness. That is one
 * measurement serving two questions, and two copies of it would drift the moment either question
 * moved.
 *
 * @param {object} row An entity record.
 * @returns {number} Turns between first sighting and latest, never negative.
 */
export function agendaSpan(row) {
    return Math.max(0, (Number(row?.turn) || 0) - (Number(row?.first) || 0));
}

/**
 * Does this record connect to anything, or is it only a description?
 *
 * Four relational fields plus a standing agenda: what they want, what they know, how you reach them,
 * whether they are dangerous, and whether the world-turn has anything to advance for them. Any ONE
 * is an edge. Read as presence-or-absence, never for content, no word is inspected, so this means
 * the same thing in every language.
 *
 * Persistence is an edge too, and leaving it out was measurably wrong.
 *
 * The first cut asked only about fields, and dropping it on the live Raccoon City cast evicted
 * `Dr. W. Birkin`, `Dr. A. Hargrove`, `Chief B. Irons` and `Brad Vickers`: the Umbrella conspiracy
 * the entire campaign is about, because extraction had never given any of them a `wants`. It kept
 * both corpses. A rule that removes the antagonists and retains the scenery is not the rule.
 *
 * What separates them is in fold's own keys: the story kept coming back. Those four span 23 to 42
 * turns between `first` and their latest sighting; the mail carrier and the man in coveralls span 9,
 * and the priest, the police officer and the woman with the first aid kit span 0. A record the
 * narrative has returned to across a long arc is connected to it, whether or not any probe thought
 * to ask what they want.
 *
 * Turn arithmetic on fold's own fields, no prose, no names, no morphology.
 *
 * @param {object} row An entity record.
 * @returns {boolean} True when the record carries at least one edge.
 */
export function hasEdge(row) {
    const span = agendaSpan(row);
    return !!String(row?.wants ?? '').trim()
        || !!String(row?.knows ?? '').trim()
        || !!String(row?.reach ?? '').trim()
        || (Number(row?.threat) || 0) > 0
        || (Number(row?.driveSize) || 0) > 0
        || span >= ENTITY_STALE;
}

/**
 * How many relationship changes one cast row remembers.
 *
 * What the trail is, and why the cap is twelve.
 *
 * `merge_entity` is last-write per field and rightly so, what someone currently wants is one value,
 * not a history. The trail is the sibling record of what each last write REPLACED
 * (`FOLD-REDESIGN.md` §1.1), stamped with the anchor mid of the pass that saw the change, so §8's
 * Relationships tab can render *"friendly, doubled your cut from her own share"* with a click
 * through to the message that caused it. It is the Graph face: append-only, bounded, never merged.
 *
 * Twelve, and the number is not a guess about play, it is a guess about READING, which is what the
 * trail is for. The measurement that exists: across four live campaigns and ~500 assistant turns,
 * `feels` is written on nearly every entity re-report and CHANGES about as often as a relationship
 * changes in fiction, Kang goes wary → friendly once in 40 turns; Park Min-ji arrives neutral and
 * stays. So twelve entries is many campaigns' worth for one person, and a tab that shows more than a
 * dozen steps of one relationship is a tab nobody scrolls. The cost of being wrong is bounded and
 * visible: 48 rows × 12 entries × ~80 bytes ≈ 46 KB worst case in the metadata blob, against a
 * realistic 9, 14 rows. Oldest entries drop first, because the current state is already on the row,
 * what a trail loses at the far end is the beginning of a story whose ending is still readable.
 *
 * Same shape and same reasoning as MAX_SHADOW (`state.js`), which bounds another append-only
 * keep-the-evidence list at twelve.
 */
export const MAX_TRAIL = 12;

/**
 * Fields whose changes the relationship trail records.
 *
 * Why appearance is NOT on this list, though a haircut is a story event.
 *
 * It plainly is one, and the argument for trailing `look` writes itself: the field is declared
 * permanent, so a change to it can only be news. The reason it stays off is that the trail is not
 * per-field. Twelve entries, shared, oldest dropped first, and the fields already on it are free
 * text a model re-derives from prose every pass, which means the trail records PARAPHRASE as
 * readily as it records events.
 *
 * MEASURED, live Raccoon City cast, Officer Martinez's row at turn 141. Her trail is FULL, twelve
 * of twelve, the opening entry already evicted, and one of the twelve is
 *
 *     wants: "to move on their own before the generator runs out"
 *         →  "to move on their own before generator runs out"
 *
 * which is the same sentence with an article removed. The Wuxia cast has the same shape on the
 * pendant spirit: `knows` oscillates "danger in the water" → "the terrain and dangers higher up the
 * mountain" → "danger in the water" across three consecutive entries. Across both chats, 45 trail
 * entries each, and neither row has room left for its own beginning.
 *
 * A 400-character prose field added to that list would fill twelve slots from re-wordings of a face
 * inside a handful of turns, and what it evicted would be the disposition history `MAX_TRAIL` was
 * sized for, "friendly, doubled your cut from her own share", the one thing the trail exists to
 * be able to show. Trading a relationship arc for "black bob cut → black bob, cut short" is a bad
 * trade at any cap.
 *
 * The haircut is not lost. It happened in a message, so it is in the chronicle, where events go;
 * `look` holds the current truth, which is what the narrator needs and what the trail is not for.
 * If it is ever worth having, the change is a per-field cap on the trail, not another member here.
 */
export const TRAILED = ['feels', 'wants', 'knows'];

/**
 * How long an agenda must have held before the world-turn will ask about it.
 *
 * Eight is a floor on ATTENTION, not a judgement about the agenda.
 *
 * MEASURED across all 22 chat files on disk, 17 with a cast, 165 actor rows (150 once the pov is
 * excluded). Rows carrying a `wants`, as the threshold moves:
 *
 *     span >=  1 → 125 rows     span >= 12 → 96 rows
 *     span >=  4 → 118 rows     span >= 20 → 82 rows
 *     span >=  8 → 102 rows     span >= 48 → 47 rows
 *
 * Eight keeps 102 of 125, 90% of every agenda that will ever turn out to be real, and that is the
 * property `nominates` wants, because what this bound is for is stopping fold from spending the
 * model's attention on somebody the story met once. The median row spans 35 and the longest 192, so
 * eight is nothing in campaign terms; what it does exclude is the introduction scene, which is the
 * sighting where nobody could know the answer and the 288/288 zeros came from.
 */
export const DRIVE_SPAN = 8;

/**
 * Reduce an agenda to what two spellings of it have in common.
 *
 * Lowercased, then everything that is not a letter or a number removed. No word list, no verb
 * table, no stopwords, no stemming, nothing that knows what language it is reading.
 *
 * The trade, measured, and why the neutral side wins it.
 *
 * `absorb-table.js` records the opposite choice and its cost: its retired `splitClauses` decided
 * which comma-separated fragment was its own statement with a `FINITE_VERB` English verb list, "a
 * grammar that could only read one language". The Wuxia campaign's `wants` values are written in
 * Chinese (凌香, 陆小天), so any word-level English rule reads them as one undifferentiated blob and
 * would call every Chinese agenda stable by accident, the failure would be silent and it would be
 * exactly the campaign with the most eligible rows.
 *
 * The neutral normaliser costs something and it is small. MEASURED across 799 trail entries on
 * disk: this one catches 2 pure rewordings, both case-only, `Serve customers` → `serve customers`
 * and `retrieve crate from Sable Dusk` → `Retrieve crate from Sable Dusk`: where an
 * English-stopword normaliser catches roughly three dozen (37 under one plausible list), the extra
 * ones being dropped articles and infinitive `to`: "to move on their own before the generator runs
 * out" → "…before generator runs out", "make the goblin tribe stronger" → "make goblin tribe
 * stronger". Carried through to `agendaStable` that is 47% of long-lived rows reading as stable
 * versus 42%. That difference used to decide who got a drive and now decides only how a line is
 * PHRASED for the model and whether a judged row is re-asked, so the cost of the neutral side fell
 * to almost nothing while its benefit, being able to read the Chinese fifth of the corpus, did not
 * move at all.
 *
 * Two callers depend on it beyond that phrasing, and both are about identity rather than quality:
 * `merge_entity` resets a drive when the agenda genuinely changes rather than when it is re-typed,
 * and `needsDriveJudgement` re-asks the model on the same test. Those are the reuses this function
 * was built for.
 *
 * @param {string} a One agenda.
 * @param {string} b Another.
 * @returns {boolean} True when they are the same agenda spelled two ways.
 */
export function sameAgenda(a, b) {
    return normalizeAgenda(a) === normalizeAgenda(b);
}

/**
 * The normaliser behind `sameAgenda`, shared with `agendaStable`'s distinct-value count.
 *
 * @param {string} text An agenda.
 * @returns {string} Its language-neutral form.
 */
function normalizeAgenda(text) {
    return String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Has this row's agenda held still, or has it churned?
 *
 * This was a gate, it was measurably the wrong one, and it survives as EVIDENCE.
 *
 * The argument for it as a gate was good and the measurement refuted it. `wants` is last-write per
 * sighting and churns to whatever the actor is doing right now, the churn `foldEntity` documents
 * approvingly ("buy herbs" → "closing soon, spare a moment"), so a `wants` that never moved looked
 * like the signature of a standing agenda. Of the 133 actor rows spanning 6 turns or more, 56 (42%)
 * hold exactly one distinct normalised value.
 *
 * They are the wrong 56. Labelling every distinct `wants` in the corpus by whether it names
 * something that can COMPLETE, 25% of rows carrying a `wants` are terminal; this rule as a gate
 * admitted 36 rows of which 28% were terminal. It selected nothing. It is worse than that: it is
 * anti-correlated with its own target, because a shopkeeper's `wants` is stable precisely BECAUSE it
 * is a routine, and a developing plot agenda gets re-worded precisely BECAUSE it is developing. The
 * rule admitted eleven Wuxia shopkeepers and missed `open the sealed door`, `break the seal and
 * discover what is buried` and `win the Foundation Building Pill`. See `nominates` for the full
 * table and for what replaced the whole approach.
 *
 * What it is still good for is describing a row to the model. "Held unchanged for 40 turns" and
 * "on the cast 40 turns, restated 4 times" are different facts about an agenda and the second is
 * worth knowing when judging whether the first is real, so this decides which sentence
 * `worldBlock` prints, and `needsDriveJudgement` uses `sameAgenda` (not this) to decide when a
 * judged row is asked again. Evidence for a reader, never a verdict on its own.
 *
 * Both `from` and `to` are read, because the trail records transitions and the value a row STARTED
 * with only ever appears as somebody's `from`. Empties are dropped: `changesBetween` writes
 * `from: ''` for the first time anyone reads what somebody wants, and "nothing recorded → X" is the
 * agenda becoming legible, not the agenda changing.
 *
 * A missing or empty trail means nothing ever changed, which is stable, the strongest form of it.
 *
 * Note what this is NOT reading: `MAX_TRAIL` is 12 and shared across `feels`/`wants`/`knows`, so a
 * busy row's trail is a bounded recent window with its own beginning already evicted (Officer
 * Martinez's is full at twelve). That is the right window anyway. The question is whether this
 * agenda is holding NOW, not whether the actor ever wanted anything else in act one.
 *
 * @param {object} row An entity record.
 * @returns {boolean} True when the recorded trail holds at most one distinct agenda.
 */
export function agendaStable(row) {
    const seen = new Set();
    for (const entry of Array.isArray(row?.trail) ? row.trail : []) {
        if (entry?.field !== 'wants') {
            continue;
        }
        for (const value of [entry.from, entry.to]) {
            const normalized = normalizeAgenda(value);
            if (normalized) {
                seen.add(normalized);
            }
        }
    }
    return seen.size <= 1;
}

/**
 * Is this row worth ASKING about? Not: does this row have a standing agenda.
 *
 * The measurement that turned a judge into a nominator.
 *
 * `drive_size` was once a property on the entity probe, "how many steps does their standing
 * ambition take", asked on a sighting, usually the first. MEASURED across 288 traced proposals the
 * model answered 0 in 288 of them, leaving `driveSize > 0` on 0 of 165 cast rows in every live chat,
 * so the world turn's actor half never ran once. The model was right to answer 0: at first contact a
 * shopkeeper who wants to sell books and a trading house cornering a market are the same
 * observation, and standing-ness is visible only in retrospect.
 *
 * The obvious repair was to stop asking and derive the answer from the row, `wants` non-empty, a
 * long `turn - first` span, and a `wants` trail that never named a second agenda. That shipped, and
 * then it was measured against a hand label of every distinct `wants` in the corpus, scored by
 * whether the phrase names something that can COMPLETE. Baseline: of the 125 rows carrying a `wants`
 * (pov excluded), 31 are terminal, 25%. Every arithmetic gate that was tried, precision then recall:
 *
 *     wants + span>=8 + stable (the derivation)  28%   32%      place moved >= 1        30%   65%
 *     knows non-empty                            27%   68%      place moved >= 2        33%   42%
 *     reach non-empty                            43%   19%      2+ distinct wants       27%   58%
 *     feels non-neutral                          22%   42%      aka non-empty           23%   74%
 *     ever threat > 0                            56%   32%      span >= 8 alone         27%   90%
 *
 * Nothing separates. Against a 25% baseline every rule with usable recall lands between 22% and 39%,
 * and the best combination found (2+ wants AND knows AND place moved twice) reaches 39%, which is
 * a coin-flip dressed as a rule. `ever threat > 0` looks like the exception at 56% and is not: its
 * terminal hits are `kill the party`, `to kill Ike`, `kill Solomon and the hunters`: monsters
 * mid-fight, terminal in the trivial sense and gone when the scene ends.
 *
 * The reason no gate works is that the question is semantic. "Run her inn" and "win the Foundation
 * Building Pill" differ in whether there is a state of the world where the actor STOPS, and nothing
 * in fold's own fields encodes that. Reading it out of the phrase would mean reading prose in an
 * arbitrary language, which this codebase forbids for the reason `absorb-table.js` records.
 *
 * So arithmetic nominates and the model adjudicates.
 *
 * This function no longer answers the question. It shortlists candidates for `world-table.js` to put
 * in front of the model with their evidence attached, and the model, asked LATE, about a specific
 * actor, with "this agenda has held for 40 turns" on the line, answers whether it completes and in
 * how many steps. That is a different question from the one that got 288 zeros, asked at a different
 * time, and the answer becomes stored state rather than a reading.
 *
 * Therefore: optimised for recall and boundedness, and DELIBERATELY not for precision.
 *
 * This is the part a future reader will want to "improve", so it is stated plainly: making this
 * stricter is not an upgrade, it is a regression. Precision here buys nothing, because a wrong
 * nomination costs one line of prompt and gets a `false` back; recall here is everything, because a
 * row this function drops is never judged by anything. `wants` non-empty plus `span >= DRIVE_SPAN`
 * keeps 102 of 125 rows, 90% of every agenda that turns out to be real, and the table above is the
 * evidence that any tighter rule trades that recall for precision it does not actually deliver.
 *
 * What bounds the cost is not this function but `MAX_NOMINATIONS` (`world-table.js`) and
 * `needsDriveJudgement` below: three questions per armed pass, and a row is asked once per agenda
 * rather than once per skip. 102 candidates is a queue that drains, not a prompt that bloats.
 *
 * @param {object} row An entity record.
 * @returns {boolean} True when this row is worth one line of the model's attention.
 */
export function nominates(row) {
    return !!String(row?.wants ?? '').trim() && agendaSpan(row) >= DRIVE_SPAN;
}

/**
 * Has this row's agenda been put to the model yet, and does it need putting again?
 *
 * Asked once per AGENDA, not once per skip.
 *
 * Without a marker the world turn would re-pose the same shopkeeper on every time skip forever: the
 * answer is `false`, nothing is written, `nominates` still holds next pass, and the queue never
 * drains. `driveAsked` is the turn the question was answered, for ANY answer, including the `false`
 * that means "this is a routine". A negative verdict is a result and has to be remembered, or the
 * whole point of asking is lost.
 *
 * Re-asked when the agenda genuinely changes, on `sameAgenda` rather than inequality, because a
 * re-typing is not a new ambition, the same distinction `merge_entity` makes when it resets a
 * drive's position. The trail carries the turn of each change, so "changed since we asked" is a
 * comparison against `driveAsked` with no second stored copy of the old value. `MAX_TRAIL` evicts
 * OLDEST first, so the entries this reads, the ones newer than `driveAsked`, are exactly the ones
 * that survive.
 *
 * A stored `driveSize: 0` is NOT a judgement, and must not be read as one.
 *
 * 40 rows in the corpus carry a literal `driveSize: 0` written by the retired entity probe. Those
 * are answers to the bad question, from the sighting where nobody could know, and treating them as
 * "already judged" would permanently exclude the 40 rows most likely to deserve asking. The absent
 * `driveAsked` is what distinguishes them, which is the whole reason the marker is its own field
 * rather than an inference from the size.
 *
 * Cost: one small integer, written only onto rows that got nominated. Three chats sit at 96% of
 * `MAX_FOLD_BYTES`, so this is not free, but a row that is judged is a row that stops being asked,
 * and the alternative is spending prompt on the same question every skip for the life of the
 * campaign.
 *
 * @param {object} row An entity record.
 * @returns {boolean} True when the model should be asked about this row's agenda.
 */
export function needsDriveJudgement(row) {
    if (!nominates(row)) {
        return false;
    }
    const asked = Number(row?.driveAsked);
    if (!Number.isFinite(asked)) {
        return true;
    }
    return (Array.isArray(row?.trail) ? row.trail : []).some(entry => entry?.field === 'wants'
        && (Number(entry?.turn) || 0) > asked
        && !sameAgenda(entry?.from, entry?.to));
}

/**
 * The largest threat integer a cast row may carry.
 *
 * Scarlet Heroes' one-integer-per-adversary, kept small on purpose: `FOLD-REDESIGN.md` §3 asks for
 * "one small integer on a cast row, present only while an adversary is active", and §12.3 says
 * plainly that no live combat has ever run under this schema, so the first real fight is the
 * measurement. Six is the ceiling rather than the scale, a hobgoblin is not a percentage, and the
 * value is meaningless in isolation; what it is for is telling six enemies apart at a glance, which
 * is what the six-message Nowon battle needed and got as two stalled clocks (`FOLD-RPG-GAP.md` §6).
 */
export const MAX_THREAT = 6;

/**
 * Statuses that mean an entity is finished with and should stop taking up panel space.
 *
 * Exported so `place-table.js` can extend rather than restate it: a place is finished with in the
 * same four ways a person is, plus two of its own, and two copies of one vocabulary diverge.
 */
export const RETIRED = new Set(['closed', 'resolved', 'gone', 'dead']);

/**
 * How someone feels about you, as a WORD.
 *
 * Every tracker in this space models this as a 0, 100 meter, and every one of them is wrong for a
 * substrate where an LLM does the writing. A phrase survives a round trip; a number silently
 * drifts. "Wary" mutated to "guarded" has lost nothing, the fiction still says the same thing and
 * the next extraction re-derives it. `trust: 62` mutated to `trust: 58` has forked the game, and
 * nothing in the prose can tell you which value was right.
 *
 * Ordinal because the order carries the meaning and nothing else needs to: Blades gets an entire
 * faction system out of one integer from −3 to +3, because the value has mechanical teeth rather
 * than decimal places. Five steps is the most a reader distinguishes at a glance, and each one has
 * to name a recognisably different way of being treated.
 *
 * Deliberately NOT a scale that goes to 100. There is no question this design can answer that
 * "friendly (67)" answers better than "friendly", and every extra digit is another thing for a
 * model to get wrong.
 */
export const DISPOSITIONS = ['hostile', 'wary', 'neutral', 'friendly', 'devoted'];

/**
 * Where a disposition sits on the scale.
 * @param {string} word A disposition.
 * @returns {number} 0, 4, or 2 (neutral) when unknown.
 */
export function dispositionRank(word) {
    const index = DISPOSITIONS.indexOf(String(word ?? '').trim().toLowerCase());
    return index === -1 ? DISPOSITIONS.indexOf('neutral') : index;
}

/**
 * Presence is DERIVED, never stored.
 *
 * `OntologyClosure.lean:127` names `merge_NB`, the Set face, "membership/presence", and proves it
 * converges precisely BECAUSE it is monotone: once true, always true. `only_four_merges`
 * (`song/lean/Song/kernel/Table.lean:57-59`) proves there is no fifth merge to reach for. So a
 * presence bit, stored, cannot be retracted, which is why a tracker built on one lists seven
 * people in a bedroom, four of whom are in a dining hall the story left an hour ago.
 *
 * Every reference implementation has this bug. Scribe's prompt says "REMOVE them" and its
 * reconciler logs "Preserving NPC omitted by LLM" and keeps them. Marinara's Roleplay mode has no
 * exit field at all. fold wrote "left to find Kit" into a free-text field nothing read.
 *
 * The fix five independent sources converge on: a person is present iff their place matches the
 * scene's. ScenePulse exempts its cast from carry-forward; Graphiti infers departure from a newer
 * co-location claim rather than an exit event; `whispering-tides/src/ecs.slang:418-437`
 * (`ecsInArc`) recomputes hit geometry per resolution and holds no spatial index at all, the
 * earlier version of this line cited those same lines as "recomputes spatial membership every
 * frame", which is a claim about a structure that file does not contain; ontology SCD-2 closes the
 * row when an entity "vanished from incoming". `LevelOfDetail.detail_is_not_preserved` supplies
 * the warrant:
 * "you are NOT allowed to expect the same person to be standing in the same doorway."
 *
 * Nobody is deleted. They stop being HERE.
 */
export const HERE = 'here';
export const ELSEWHERE = 'elsewhere';
export const GONE = 'gone';
export const UNPLACED = 'unplaced';

/**
 * The content words of a place name.
 * @param {string} raw A place, as written.
 * @returns {Set<string>} Content tokens, lowercased.
 */
export function placeTokens(raw) {
    return new Set(String(raw ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean));
}

/**
 * Do these two place names refer to the same place?
 *
 * Exact equality. The old subset test ("the bedroom" ⊂ "manor bedroom") was a string algebra
 * deciding locality with an English stopword list; that is gone. fold compares what the model
 * reported, exactly, the entities probe says a differently-worded place makes a person vanish
 * from the room, and a pair the model wrote differently is resolved by the review probe, never
 * guessed by fold.
 *
 * @param {string} a One place.
 * @param {string} b Another.
 * @returns {boolean} True only if they are the same string.
 */
export function samePlace(a, b) {
    return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

/**
 * Does a proposed place tell this record anything it does not already hold?
 *
 * Why a question must not restamp its own subject.
 *
 * `turn` carries two jobs on an entity row. It is the merge version that makes last-write
 * order-independent (`merge_entity`, and `resolution_max_converges` behind it), and it is the
 * staleness clock every reader subtracts from, `entitiesOfKind` computes `stale = turn - row.turn`
 * and `prune` drops a row past `ENTITY_STALE * 2`. Writing it is therefore never free: it says both
 * "this is the newer claim" and "this person is current".
 *
 * MEASURED, live Raccoon City campaign: `review:placed` fired 85 times over 88 turns on a cast of
 * 22. The review poses `[where now?]` about exactly the people fold cannot place, and eight rows sat
 * at `place: "unknown"` sharing one turn stamp, the model answered "unknown" again and again, and
 * each answer was written back as a fresh sighting. So the mechanism for noticing that a row had
 * stopped mattering was the mechanism keeping it alive, and the cast filled with a dead mail
 * carrier, a corpse in coveralls and a child seen once, all of which had to be deleted by hand.
 *
 * Same law as the inventory's `already-recorded` gate and the marks' `already-held`: an observation
 * that changes no derived proposition is the identity (`zero_residual_is_fixed`: no surprise, no
 * move). An empty answer is silence and never news, which is the existing rule for every field in
 * `merge_entity`; an unchanged answer is silence wearing a value.
 *
 * @param {object} row The entity record as it stands.
 * @param {string} place The proposed place.
 * @returns {boolean} True when writing it would change something.
 */
export function placeIsNews(row, place) {
    const said = String(place ?? '').trim();
    return !!said && !samePlace(said, row?.place);
}

/**
 * Where an entity stands relative to the current scene.
 *
 * Returns UNPLACED rather than guessing when either place is unknown. That is `the_dispatch_law`
 * (`SelectionDispatch.lean:223`) applied honestly: in the band where the evidence cannot decide,
 * a dispatcher must take a third action rather than pick a default it has no warrant for. Treating
 * "we don't know where the scene is" as "nobody is here" would empty the panel every time the
 * narration stops naming rooms.
 *
 * @param {object} entity An entity record.
 * @param {string} at The scene's current location.
 * @returns {string} HERE, ELSEWHERE, GONE or UNPLACED.
 */
export function presenceOf(entity, at) {
    if (RETIRED.has(String(entity?.status ?? '').toLowerCase())) {
        return GONE;
    }
    const place = entity?.place;
    if (!place || !at) {
        return UNPLACED;
    }
    return samePlace(place, at) ? HERE : ELSEWHERE;
}

/**
 * Build an entity key.
 * @param {string} kind Entity kind.
 * @param {string} name Normalized name.
 * @returns {string} The table key.
 */
export function entityKey(kind, name) {
    return `${kind}${KIND_SEP}${name}`;
}

/**
 * Split an entity key back into its parts.
 * @param {string} key A table key.
 * @returns {{kind: string, name: string}} The parts.
 */
export function splitEntityKey(key) {
    const index = String(key ?? '').indexOf(KIND_SEP);
    return index === -1
        ? { kind: LEAD, name: String(key ?? '') }
        : { kind: key.slice(0, index), name: key.slice(index + 1) };
}

/**
 * Normalize a name for keying, without destroying it for display.
 *
 * Lowercased and stripped of trailing punctuation so "Maria." and "maria" are one person; the
 * display form is kept on the record, because a panel that renders "maria" has traded one legibility
 * problem for another.
 *
 * @param {string} raw Raw name.
 * @returns {{key: string, display: string}|null} Normalized parts, or null if unusable.
 */
export function normalizeEntityName(raw) {
    const display = String(raw ?? '')
        .replace(/[*_`~]/g, '')
        .replace(/\s+/g, ' ')
        .replace(/^[\s>*\-•]+/, '')
        // Trim BEFORE stripping trailing punctuation: "Adele Ricci. " ends in a space, so the
        // punctuation class never matches and the full stop survives into the key.
        .trim()
        .replace(/[.,;:]+$/, '')
        .trim()
        .slice(0, MAX_NAME);
    if (!display || /^(none|nothing|nil|empty|n\/a|na|unknown|unspecified)\b/i.test(display)) {
        return null;
    }
    // A leading article carries no identity. The scene probe answers "Hero" while the cast probe
    // writes "the Hero", and without this they key apart, so the point-of-view character stays
    // listed among the people he is observing, which is exactly the bug the alias set exists to
    // close. Stripped from the KEY only; the display form keeps the article it was written with.
    return { key: display.toLowerCase().replace(/^(?:the|a|an)\s+/, ''), display };
}

/**
 * Field-wise merge: a later sighting updates what it mentions and leaves the rest alone.
 *
 * `merge_b` over the whole record is the tempting choice and the wrong one. A turn that establishes
 * only that Maria has gone quiet would, under last-write-wins, erase the fact that she is reachable
 * by email, information nothing in the narrative retracted. Fields are last-write; the record is
 * not.
 *
 * @param {object} nu Incoming record.
 * @param {object} old Existing record.
 * @returns {object} Merged record.
 */
export const merge_entity = (nu, old) => {
    if (!old) {
        // `insert_with` does not call a merge on a key it has never seen (`lib/hash.js`), so this
        // branch is only reached by a direct call. The trail's OPENING entry, "nothing recorded →
        // wary", is therefore seeded by `foldEntity`, which is the one caller that knows whether
        // the key is new.
        return { ...nu };
    }

    // Versioned, because resolution made the order matter.
    //
    // `sanguine/proof/Substrate/Algebra/Security/KeyResolution.lean`:
    // `resolution_breaks_key_independence`: writes to DISTINCT keys never interact, so under
    // last-write their order is irrelevant. Collapsing two keys onto one is what puts them in
    // competition. `normalizeEntityName` is exactly such a resolver: "Maria" and "maria" would be
    // two independent records without it, and are one record with it.
    //
    // Plain last-write was therefore unsound here, and unlike inventory this table has no ordered
    // ledger to hide behind, extraction is async and fire-and-forget, so two sightings can land
    // in either order. `resolution_max_converges` is the repair: last-write becomes
    // order-independent once the value carries its own order. `turn` is that order.
    const older = (nu?.turn ?? 0) < (old?.turn ?? 0);
    const [newer, earlier] = older ? [old, nu] : [nu, old];

    const merged = { ...earlier };
    for (const [field, value] of Object.entries(newer ?? {})) {
        // An empty field is silence, not a retraction, the earlier sighting's value stands. Only
        // `status` may look falsy, and its vocabulary has no empty member, so this is safe.
        if (value !== undefined && value !== null && value !== '') {
            merged[field] = value;
        }
    }

    // Aliases are the one Set-face field here, and legitimately so.
    //
    // Everything else on this record must be retractable: a place changes, a status clears, a
    // detail is superseded. A name someone was called does NOT stop being a name they were called,
    // so `merge_nb`'s "once in, always in" is exactly right, the property that made it wrong for
    // presence is what makes it correct here.
    //
    // The superseded display name joins the set too. When "Solomon" lands on the record "the Hero"
    // opened, the record renames itself, and without this the title it used to answer to would be
    // lost, so the next mention of "the Hero" would open a second record and undo the merge.
    // First-seen is the earliest claim, not the latest. Under plain field-wise last-write every
    // re-report would reset it and nothing would ever read as new for more than one tick.
    const firsts = [earlier?.first, newer?.first, earlier?.turn, newer?.turn]
        .filter(value => Number.isFinite(value));
    if (firsts.length) {
        merged.first = Math.min(...firsts);
    }

    // The relationship trail: what the last write replaced, kept beside the value.
    //
    // Appended HERE and nowhere else, because this is the only place that sees both the old value
    // and the new one, `foldEntity` sees an observation, and the panel sees a result. Recorded only
    // when the FRESHER record is the incoming one: a late-arriving sighting from an earlier turn is
    // not a change, it is news from the past, and treating it as one would write the story backwards.
    // Extraction is async and unordered, which is why `merge_entity` is versioned at all.
    const changes = newer === nu ? changesBetween(earlier, newer) : [];
    const trail = [...(earlier?.trail ?? []), ...changes];
    if (trail.length) {
        // Oldest first, newest kept: a bounded Graph face (`FOLD-REDESIGN.md` §1.1). See MAX_TRAIL
        // for why twelve, and what it costs to be wrong about it.
        merged.trail = trail.slice(-MAX_TRAIL);
    }

    // A new agenda starts at zero, because BOTH numbers belonged to the old one.
    //
    // `drive` is the position and `driveSize` is how far it goes; the model authors the size on the
    // world probe (`world-table.js`) and the off-screen turn accumulates the position. Neither
    // number means anything except in relation to the sentence in `wants`. An actor who abandons
    // cornering the pill trade to hunt the person who ruined them would otherwise arrive at the new
    // ambition four steps into a six-step track that was measured for the old one, and the world
    // turn would report them nearly finished with something they have not started.
    //
    // The size is cleared to 0 rather than deleted, which reads as "no standing agenda right now"
    //, `worldAsks` skips the row and `needsDriveJudgement` re-nominates it, so the next armed pass
    // asks the model about the NEW ambition and the row comes back with a size that fits it. That
    // is also why clearing the size cannot be confused with the 40 legacy `driveSize: 0` rows: the
    // stale `driveAsked` is older than this change, so the re-ask rule fires either way.
    //
    // Gated on `sameAgenda` rather than on inequality, and that is the whole reason `sameAgenda`
    // exists: the trail is full of pure rewordings ("…before the generator runs out" → "…before
    // generator runs out"), and resetting on those would mean a drive that never fills because
    // paraphrase alone knocks it back to zero.
    //
    // Written only over numbers that exist. `merge_entity`'s callers pay for every field on the
    // record, the largest live chat's blob is at 96% of `MAX_FOLD_BYTES`, and stamping a `drive: 0`
    // onto the majority of rows that have never had one would be bytes bought for nothing.
    if (changes.some(change => change.field === 'wants' && !sameAgenda(change.from, change.to))) {
        if ((Number(merged.drive) || 0) > 0) {
            merged.drive = 0;
        }
        if ((Number(merged.driveSize) || 0) > 0) {
            merged.driveSize = 0;
        }
    }

    const names = new Set([...aliasKeys(earlier), ...aliasKeys(newer)]);
    names.delete(normalizeEntityName(merged.name)?.key);
    const written = new Map();
    for (const raw of [earlier?.name, newer?.name, earlier?.aka, newer?.aka]) {
        for (const part of String(raw ?? '').split(/[,;/|]/)) {
            const parsed = normalizeEntityName(part);
            if (parsed && names.has(parsed.key)) {
                written.set(parsed.key, parsed.display);
            }
        }
    }
    merged.aka = [...written.values()].join(', ').slice(0, MAX_DETAIL);
    return merged;
};

/**
 * The trail entries one sighting adds: every tracked field it actually changed.
 *
 * A change is a value that DIFFERS and is not empty, an empty incoming field is silence, which
 * `merge_entity` already treats as no retraction, so it cannot be a change either. `from` may be
 * empty (the first time anyone reads what somebody wants, there was nothing there before), and that
 * is worth recording: "wants: (nothing recorded) → supplies for the northern march" is the moment
 * the agenda became legible.
 *
 * @param {object} earlier The older record.
 * @param {object} newer The fresher record.
 * @returns {Array<{field: string, from: string, to: string, turn: number, mid: number}>} Entries.
 */
function changesBetween(earlier, newer) {
    const out = [];
    for (const field of TRAILED) {
        const to = String(newer?.[field] ?? '').trim();
        const from = String(earlier?.[field] ?? '').trim();
        if (!to || to === from) {
            continue;
        }
        out.push({
            field,
            from,
            to,
            turn: Number(newer?.turn) || 0,
            // The pass's anchor mid, so §8's cause-link can scroll the chat to the message that
            // caused it. `-1` means the write had no anchor, a hand edit, or a migration.
            mid: Number.isFinite(newer?.mid) ? newer.mid : -1,
        });
    }
    return out;
}

/**
 * The trail entries a hand write adds: every TRAILED field it actually changed.
 * Mirrors `changesBetween` for the direct-write path (`entities.patch`), same `{field, from, to}`
 * shape with `mid: -1` because a hand write has no anchor, and an undo is just a hand write whose
 * `to` is the value it is reverting to, which is what makes a reversal legible in the history.
 *
 * @param {object} row The prior record.
 * @param {object} patched The fields being written, `{column: value}`.
 * @param {number} turn The current turn.
 * @returns {Array<object>} Trail entries, in `TRAILED` order.
 */
export function handTrailEntries(row, patched, turn) {
    const out = [];
    for (const field of TRAILED) {
        if (!Object.prototype.hasOwnProperty.call(patched ?? {}, field)) {
            continue;
        }
        const to = String(patched[field] ?? '').trim();
        const from = String(row?.[field] ?? '').trim();
        if (to === from) {
            continue;
        }
        out.push({ field, from, to, turn: Number(turn) || 0, mid: -1 });
    }
    return out;
}

/**
 * Append entries to a row's trail, bounded like the merge path.
 * The model path bounds in `merge_entity`; a hand write must apply the same `MAX_TRAIL` bound or a
 * busy row's trail grows past the window the cap exists for.
 *
 * @param {Array<object>|undefined} trail The row's trail, oldest first.
 * @param {object|Array<object>} entries One entry or several.
 * @returns {Array<object>} The bounded trail.
 */
export function appendTrail(trail, entries) {
    const base = Array.isArray(trail) ? trail : [];
    const added = Array.isArray(entries) ? entries : [entries];
    return [...base, ...added].slice(-MAX_TRAIL);
}

/**
 * The separators that divide one written string into several names.
 *
 * The ASCII set was `[,;/|]`. The ideographic and fullwidth commas are added because they ARE the
 * comma: the same punctuation mark, written in the script the sentence around it is written in.
 * Leaving them out is fold deciding that only names punctuated in ASCII may be split, which is the
 * substring-proxy failure ([ROUTER]) wearing different clothes: a rule that works in the languages
 * fold happened to spell out and silently stops working in the others.
 */
const NAME_SEPARATORS = /[,;/|、，；]/;

/**
 * The distinct ways one written name reads.
 *
 * One name in two scripts is one name, and the brackets say so.
 *
 * `bilingual.js` `render()` rule 3 is fold's OWN format contract for a target-language campaign:
 * "NAMES of people and places are written in [the target language]'s script wherever they appear …
 * The first time each name appears, follow it once with its pronunciation and meaning in
 * parentheses; afterwards use the script alone." So a narration fold asked for writes the same
 * person as `刘三（Liú Sān）` on first sight and `刘三` thereafter, two strings, one name, by a
 * rule fold wrote.
 *
 * Measured in the live Wuxia campaign (`Wuxia World RPG - 2026-08-20@19h08m26s160ms.jsonl`,
 * 149 traced passes): the cast probe answered `name: "刘三（Liú Sān）"` while its own coverage
 * report said `mentions: ["刘三", …]` at turns 74 and 76. The gate below compared one string to the
 * other, found them different, and refused a person the model had explicitly named, dropping the
 * place, disposition and wants of that pass with him.
 *
 * This reads no language. It is the split `aliasKeys` has always done on commas, extended to the
 * other punctuation mark that separates two writings of one thing: a bracket. The whole string, the
 * stem outside the brackets, and each bracketed part are all forms of the same name, so a report
 * carrying ANY of them is a report about this name. It cannot admit a name the model did not write,
 * because every form is a substring the model itself put inside one field.
 *
 * @param {string} raw A name, as written.
 * @returns {string[]} The distinct forms, raw. Longest-first is not promised; callers normalise.
 */
export function nameForms(raw) {
    const written = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!written) {
        return [];
    }
    const forms = [written];
    // The stem: what is left when every bracketed aside is removed. `刘三（Liú Sān）` → `刘三`.
    const stem = written.replace(/[（([【][^）)\]】]*[）)\]】]/g, ' ').replace(/\s+/g, ' ').trim();
    if (stem && stem !== written) {
        forms.push(stem);
    }
    // The asides themselves, each split on the separators, because rule 3 asks for pronunciation
    // AND meaning: `青云门 (Qīngyún Mén, Azure Cloud Sect)` is three writings of one sect.
    for (const match of written.matchAll(/[（([【]([^）)\]】]*)[）)\]】]/g)) {
        for (const part of String(match[1]).split(NAME_SEPARATORS)) {
            const inner = part.trim();
            if (inner) {
                forms.push(inner);
            }
        }
    }
    return [...new Set(forms)];
}

/**
 * Every name a record answers to, normalised.
 *
 * Each declared name is expanded through `nameForms` first, so a record written `刘三（Liú Sān）`
 * answers to `刘三` and to `liú sān` as well as to the whole string. That is what stops one person
 * written two ways from becoming two rows, and, at the coverage gate, what stops them being
 * refused outright.
 *
 * @param {object} entity An entity record.
 * @returns {string[]} Normalised keys.
 */
export function aliasKeys(entity) {
    return [entity?.name, ...String(entity?.aka ?? '').split(NAME_SEPARATORS)]
        .flatMap(name => nameForms(name))
        .map(name => normalizeEntityName(name)?.key)
        .filter(Boolean);
}

/**
 * Aliases more than one record answers to.
 *
 * An alias two people share is not evidence about either of them.
 *
 * `canonicalKey` scans the table and takes the FIRST row whose alias set intersects the incoming
 * one, so a shared alias resolved by Map iteration order, a silent coin-flip, and then every later
 * sighting under that alias accreted onto whichever row happened to win. Measured across the live
 * chats, three collisions in two of them:
 *
 *   New Eldoria    "dwarf"          Grimble | Armorer
 *   Solo Leveling  "ji gwang-deok"  Solomon Winters | The doctor
 *   Solo Leveling  "woman"          Kang | Park Min-ji
 *
 * New Eldoria says what it costs. Grimble is a stooped apothecary on Coinchanger's Row; the story
 * has three dwarves and he is not one. His row now reads `place: "Borin's general store"`,
 * `detail: "showing spears and staves"`, `facts: "burly dwarf, singed apron"` and a trail whose
 * turn-63 entry is `wants: "buy herbs" → "closing soon, spare a moment"`: the armorer's line, on
 * the apothecary's row, because every later "the dwarf" landed on him.
 *
 * Structure, not prose: a set intersection over fold's OWN keys, deciding nothing about what any
 * name means. The pair is handed to the review (`entities.questions`), which is the standing answer
 * whenever the evidence cannot decide, ask rather than default.
 *
 * @param {Map<string, object>} table Entity table.
 * @param {string} kind Entity kind.
 * @returns {Map<string, string[]>} Alias key -> the record keys claiming it, two or more.
 */
export function contestedAliases(table, kind) {
    const claims = new Map();
    for (const [key, value] of table_entries(table)) {
        if (splitEntityKey(key).kind !== kind) {
            continue;
        }
        for (const alias of new Set(aliasKeys(value))) {
            insert_with(claims, merge_graph, alias, [key]);
        }
    }
    return new Map([...claims].filter(([, keys]) => keys.length > 1));
}

/**
 * The key an observation should be written to, following aliases.
 *
 * Why an alias field and not a similarity measure.
 *
 * A card calls its protagonist "the Hero"; the narration calls him "Solomon". Both reach the
 * entity table, both are placed in the same bedroom, and the panel shows two people who are one
 * person. No string metric can fix this: the two names share not one character, so token overlap,
 * edit distance and substring tests all correctly report that they are unrelated. The information
 * that they are the same man exists only in the prose, so the model is asked for it directly,
 * exactly as it is asked for anything else it can read and fold cannot.
 *
 * Resolution is deliberately one-hop and first-match. A transitive alias graph would need cycle
 * detection and a merge order, and `KeyResolution.lean`'s warning applies with more force the more
 * keys a resolver collapses: every merge puts previously independent writes into competition.
 *
 * @param {Map<string, object>} table Entity table.
 * @param {string} kind Entity kind.
 * @param {string} nameKey Normalised incoming name.
 * @param {string} [aka] Aliases the observation itself declares.
 * @returns {string} The table key to write.
 */
export function canonicalKey(table, kind, nameKey, aka = '') {
    const direct = entityKey(kind, nameKey);
    if (table.has(direct)) {
        return direct;
    }

    // An alias more than one row answers to decides nothing, see `contestedAliases`. Dropped from
    // BOTH sides: the incoming observation may be the one carrying the ambiguous word, and a stored
    // row must not win a coin-flip on it either. The direct key hit above already ran, so a record
    // whose own NAME somebody else claims as an alias still answers to it.
    const contested = contestedAliases(table, kind);
    const said = new Set(aliasKeys({ aka }).filter(alias => !contested.has(alias)));
    for (const [key, value] of table_entries(table)) {
        if (splitEntityKey(key).kind !== kind) {
            continue;
        }
        const answers = aliasKeys(value).filter(alias => !contested.has(alias));
        // One side must NAME the other.
        //
        // Either direction counts, and that has not changed: the stored record may answer to the
        // newcomer's name, or the newcomer may name the stored record. What is gone is the third
        // case, an ALIAS-TO-ALIAS match, where each side keeps a primary name the other has never
        // heard of and the only thing joining them is a description they share.
        //
        // That case is not identity and the live data says so. New Eldoria's armorer arrived as
        // `{name: "Armorer", aka: "the dwarf"}` while Grimble the apothecary already carried "the
        // dwarf"; neither answered to the other's name, and the armorer was written straight into
        // Grimble's row, which is how an apothecary on Coinchanger's Row ended up with a forge,
        // a rack of spears and `wants: "closing soon"`. A proper name is a rigid designator: it
        // picks the same person every time it is used. A description picks whoever fits it in this
        // scene, and a story with three dwarves has three of them.
        //
        // The two safe directions still cover every case the alias field was built for. "the woman"
        // arriving against a stored `widow (aka: the woman)` is the newcomer's own NAME on the
        // stored row's list. "Solomon (aka: the Hero)" arriving against a stored `the Hero` is the
        // newcomer naming the stored row. Only two strangers holding one adjective are refused,
        // and they get a row each and an identity question rather than a silent merge.
        const namesTheStored = answers.includes(nameKey);
        const namedByIncoming = said.has(normalizeEntityName(value?.name)?.key ?? '');
        if (namesTheStored || namedByIncoming) {
            return key;
        }
    }
    return direct;
}

/**
 * Find the record a name refers to, following aliases.
 * @param {Map<string, object>} table Entity table.
 * @param {string} kind Entity kind.
 * @param {string} raw A name, as written.
 * @returns {{key: string, entity: object}|null} The record, or null.
 */
export function resolveEntity(table, kind, raw) {
    const parsed = normalizeEntityName(raw);
    if (!parsed) {
        return null;
    }
    const key = canonicalKey(table, kind, parsed.key);
    const entity = lookup(table, key, null);
    return entity ? { key, entity } : null;
}

/**
 * Fold one observed entity into a table.
 *
 * @param {Map<string, object>} table Entity table, mutated.
 * @param {object} observed The observation.
 * @param {string} observed.kind PERSON or LEAD.
 * @param {string} observed.name Name or title, raw.
 * @param {string} [observed.detail] One-line predicate: how to reach them, what the lead says.
 * @param {string} [observed.status] Vocabulary term, kind-dependent.
 * @param {number} [observed.turn] Monotonic turn counter, for staleness.
 * @param {Set<string>|null} [poi] Flagged entity keys. Anything with `has` will do. A row the set
 *   names carries the long form; everybody else keeps the ordinary caps. Passed IN rather than read
 *   from here, exactly as `renderEntities` takes it and for the same reason: the flag table lives in
 *   `state.js`, and `state.js` imports this file.
 * @returns {string|null} The key written, or null if the observation was unusable.
 */
export function foldEntity(table, { kind, name, detail = '', open = '', place = '', aka = '',
    reach = '', feels = '', wants = '', knows = '', secret = '', status = '', source = '', turn = 0,
    threat = 0, mid, marks = null, facts = '', drive, driveSize, driveAsked,
    look = '', wearing = '', bearing = '', history = '' }, { poi = null } = {}) {
    const parsed = normalizeEntityName(name);
    if (!parsed || (!ACTOR_KINDS.includes(kind) && kind !== LEAD)) {
        return null;
    }

    // Follow aliases before writing, so "Solomon" lands on the record "the Hero" already occupies
    // rather than beside it.
    const key = canonicalKey(table, kind, parsed.key, aka);
    if (!table.has(key) && table.size >= MAX_ENTITIES) {
        return null;
    }

    // The flag is resolved against the CANONICAL key, after aliasing. Flagging "Kang Min-seo" and
    // then having the story call her "Kang" must not silently drop her back to the short form,
    // that is the whole defect the alias set exists to close, and a tier that keyed off the raw
    // name would reintroduce it on the one row somebody cared enough to flag.
    const flagged = Boolean(poi?.has?.(key));
    // Written into the record only when there is something to write. `merge_entity` reads `''` and
    // absence identically, so an empty field costs bytes and buys nothing, and the largest live
    // chat's blob is at 96% of `MAX_FOLD_BYTES` (see `MAX_DOSSIER`).
    const dossier = {};
    for (const [field, caps] of Object.entries(DOSSIER_FIELDS)) {
        const cap = flagged ? caps.flagged : caps.plain;
        const said = String({ look, wearing, bearing, history }[field] ?? '').replace(/\s+/g, ' ').trim();
        if (cap > 0 && said) {
            dossier[field] = said.slice(0, cap);
        }
    }

    const record = {
        kind,
        name: parsed.display,
        // The turn this first appeared, so the panel can tell NEW from UPDATED. Merged under `min`
        // rather than last-write, see merge_entity; a thing does not become newly-introduced by
        // being mentioned again.
        first: turn,
        // Other names this character answers to. Accumulated rather than replaced, see merge_aka.
        aka: String(aka ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL),
        detail: String(detail ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL),
        // How you reach them, which is NOT a thing in a pocket.
        //
        // "Kang's phone number" spent the live Solo Leveling chat as an inventory row in a place
        // the model invented for itself (`state-table.js:104-110` keeps the name only so it can be
        // refused). It is not an object; it is a standing capability of the relationship, and it
        // belongs on the person it reaches. Merged field-wise like `detail`, so a turn that says
        // only where Kang is standing does not erase the fact that you can call her.
        reach: String(reach ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL),
        // What acting would settle. Only leads carry it; see `isExposition`.
        open: String(open ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL),
        // The social state, in three fields and not one number.
        //
        // What they think of you, what they are after, and what they know. This is the most
        // consequential hidden variable in any negotiation scene and fold tracked none of it,
        // Marinara doesn't either, keeping relationships only in a summariser prompt that never
        // reaches live state. For romance play it is not a gap, it is the product.
        feels: DISPOSITIONS.includes(String(feels ?? '').trim().toLowerCase())
            ? String(feels).trim().toLowerCase()
            : '',
        wants: String(wants ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL),
        knows: String(knows ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL),
        // What they know that the point-of-view character does not. Sent to the model plainly (it
        // has to roleplay around the secret), blurred in the player-facing surfaces until revealed.
        secret: String(secret ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL),
        // Where they are, a place name, kept apart from `detail` so it can be COMPARED. This was
        // the whole defect: the location lived inside a prose field, the scene's location lived in
        // another table, and nothing could relate them. A place in its own field is a place a
        // predicate can read.
        place: String(place ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME),
        status: String(status ?? '').toLowerCase().trim(),
        // The standing agenda's POSITION, which `wants` cannot carry.
        //
        // `wants` is the agenda's text and stays exactly what it was. It is last-write per sighting,
        // which is right for the panel ("what are they after right now") and fatal for anything that
        // has to persist and accumulate: measured across a completed campaign, 22 of 26 `wants` had
        // decayed into occupations, and an occupation has no next state to advance to.
        //
        // So the agenda gets a number. `drive` is how far it has come, `driveSize` how far it goes;
        // `driveSize: 0` means this actor has no standing agenda, which is every row in every
        // existing chat, so nothing changes for them.
        //
        // OMITTED rather than defaulted when not supplied, the way `mid` and `marks` above are.
        // `merge_entity` treats an empty field as silence but `0` is not empty, a sighting that
        // merely says where somebody is standing would otherwise reset their agenda to nothing.
        // That is the same trap `threat` documents below and solves a different way (`setThreat`
        // writes the whole record); here the sighting simply stays quiet.
        //
        // The size rule is `normalizeSize`'s PROGRESS branch, written out rather than imported:
        // `thread-table.js` imports THIS file, so importing it back would close a cycle. A drive is
        // always a progress track, an agenda filling is the actor getting what they want, so the
        // doom vocabulary never applies and only the one branch is needed.

        ...(Number.isFinite(driveSize)
            ? { driveSize: driveSize <= 0 ? 0 : Math.max(MIN_DRIVE, Math.min(MAX_DRIVE, Math.round(driveSize))) }
            : {}),
        ...(Number.isFinite(drive) ? { drive: Math.max(0, Math.min(MAX_DRIVE, Math.trunc(drive))) } : {}),
        // The turn the model was asked whether this agenda completes, see `needsDriveJudgement`.
        // Omitted when absent for the same reason `driveSize` is, and the absence is load-bearing:
        // 40 corpus rows carry a `driveSize: 0` from the retired sighting probe, and only a missing
        // `driveAsked` distinguishes "never judged" from "judged and it is a routine".
        ...(Number.isFinite(driveAsked) ? { driveAsked: Math.max(0, Math.trunc(driveAsked)) } : {}),
        // One small integer, present only while an adversary is active.
        //
        // Scarlet Heroes' adversary number, and once the only number on this record, `drive` above
        // is the second, and they are deliberately different things: a threat is how dangerous
        // somebody is to you RIGHT NOW and clears the moment a fight ends, an agenda is what they
        // are getting done over a campaign and never clears, it completes. The six-message
        // Nowon battle was represented as two stalled clocks and nothing legible about the six
        // things trying to kill the player (`FOLD-RPG-GAP.md` §6). Zero means "not a threat", which
        // is what every peaceful row carries and what the review writes when a fight ends, and it
        // is deliberately falsy, so `merge_entity`'s "an empty field is silence" rule leaves a
        // standing threat alone on a turn that merely says where somebody is. Clearing it therefore
        // goes through `setThreat` (`entities.js`), which writes the whole record.
        threat: threatOf(threat),
        // Standing truths that never age.
        //
        // `rank: "E-Rank Hunter"` and `mana: "negligible"` sat in scene context at t: 2 for
        // thirty-three turns, and `contextBand` (`state-table.js`) dropped them from the prompt on
        // every render, a large share of `cap:context-stale` was fold repeatedly discarding two
        // facts the fiction says are FIXED AT AWAKENING (`FOLD-REDESIGN.md` §0). Permanence was
        // inexpressible, so it was billed as staleness. Here it is expressible: a fact on the row,
        // with no `t` to age against.
        facts: String(facts ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL),
        // What they look like, what they have on, how they carry themselves, where they came
        //    from.
        //
        // Spread rather than listed, because which of the four are present and how long each may be
        // are both decisions the flag already made above. `look` and `wearing` for everybody,
        // `bearing` and `history` only for a person of interest. See `MAX_DOSSIER` for the budget
        // this is paying, and for why `facts` could not simply have been made longer.
        ...dossier,
        // The anchor mid of the pass that wrote this, for the relationship trail's cause-link. Not
        // rendered anywhere; read only by `changesBetween`.
        ...(Number.isFinite(mid) ? { mid } : {}),
        // Marks seeded by migration from pre-ledger context fields, and written by nothing else,
        // live marks are events (`state-table.js` `deriveState`, the swipe argument). Passed through
        // rather than defaulted, so an ordinary sighting never erases them.
        ...(Array.isArray(marks) ? { marks } : {}),
        // Where it was learned. Field-wise merge means a later sighting that omits it keeps the
        // original provenance rather than erasing it, you do not un-learn where you heard a thing.
        source: String(source ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL),
        turn,
    };

    // The trail's opening entry: "nothing recorded → wary" is the moment a disposition became
    // legible, and §8's Relationships tab wants the message that caused it as much as it wants the
    // turn she softened. Seeded here because `insert_with` never calls the merge on a new key, so
    // `merge_entity`, which owns every subsequent entry, cannot see the first one.
    const opening = table.has(key) ? [] : changesBetween({}, record);
    insert_with(table, merge_entity, key, opening.length ? { ...record, trail: opening } : record);
    return key;
}

/**
 * Bound a proposed threat integer.
 * @param {any} raw Anything.
 * @returns {number} 0..MAX_THREAT.
 */
export function threatOf(raw) {
    const value = Math.trunc(Number(raw));
    return Number.isFinite(value) && value > 0 ? Math.min(value, MAX_THREAT) : 0;
}

/**
 * Fold a batch of observations, rejecting anything the narrative did not actually mention.
 *
 * The gate is COVERAGE BY THE MODEL'S REPORT when one exists (`mentioned`): a Set of the names
 * the model says the new excerpt actually uses. Admission is membership in that set, the model
 * read the window, and its structural answer is the authority ([ROUTER]: coverage, not a
 * substring proxy). A name absent from the report was not in the excerpt.
 *
 * The block path (`absorb-table.js`) carries no report; it falls back to the structural mention
 * test against the block's own text, which is the card-author's declared field, not free prose.
 *
 * @param {Map<string, object>} table Entity table, mutated.
 * @param {object[]} observations Observations.
 * @param {object} options Options.
 * @param {string} [options.windowText] Narrative window, for the mention gate.
 * @param {Set<string>} [options.mentioned] Names the model reports the excerpt uses.
 * @param {number} [options.turn] Turn counter.
 * @param {Set<string>|null} [options.poi] Flagged entity keys, forwarded to `foldEntity` so a
 *   flagged row stores the long form and nobody else does.
 * @returns {{accepted: number, rejected: object[], byForm: number}} Outcome. `byForm` counts the
 *   admissions the report granted through a bracketed form or a declared alias rather than through
 *   the `name` string as written, a gate statistic, raised by the caller as `covered:by-form`.
 */
export function foldEntities(table, observations, { windowText = '', turn = 0, mid, mentioned = null, poi = null } = {}) {
    const rejected = [];
    let accepted = 0;
    // The window excerpt every rejection records, for the caret-level diagnostics log.
    const snippet = windowSnippet(windowText);

    // Normalize the model's coverage report into the same key space the alias keys use, so a
    // report of "the hooded figure" matches the alias key "hooded figure" and vice versa. The
    // report may arrive already-normalized (from `entities.js`) or raw (from a test or other
    // caller); one key space makes both work.
    //
    // Expanded through `nameForms` on BOTH sides. The report is as free to write `刘三（Liú Sān）`
    // as the proposal is, and a rule that reads the brackets in one field and not the other is
    // half a rule, it would close the measured direction and leave its mirror open.
    const mentionedKeys = mentioned
        ? new Set(Array.from(mentioned)
            .flatMap(name => nameForms(String(name)))
            .map(name => normalizeEntityName(name)?.key)
            .filter(Boolean))
        : null;

    // Proposals admitted by a bracketed second writing of their own name rather than by the whole
    // string, the count this change exists to move. Returned rather than noted, because this file
    // imports nothing but `lib/hash.js` and the counter table lives behind `observe.js`; the caller
    // that already owns the probe's bookkeeping raises it (`entities.js`, `covered:by-form`).
    let byForm = 0;

    for (const observed of Array.isArray(observations) ? observations : []) {
        const parsed = normalizeEntityName(observed?.name);
        if (!parsed) {
            rejected.push({ item: String(observed?.name ?? ''), reason: 'unusable-name', raw: observed, snippet });
            continue;
        }
        // Coverage by the model's report when one exists; the structural block-path test otherwise.
        //
        // The report is the floor, not the whole answer.
        //
        // The model's `mentions` list is authoritative for admission, but it is often INCOMPLETE:
        // measured in the Wuxia RP, the model omitted the point-of-view character from its own
        // cast coverage ("Chí Guāngdé" rejected as not-mentioned at turn 16 while the snippet shows
        // him narrating) and omitted the fight actors it changed ("the bandit", "the big man", "the
        // archer" at turns 6-12). A proposal is valid if the model's report names it OR the window
        // literally contains it, the window test that already admits the block path and is
        // token-precise enough to refuse "dragon egg" against "Dragon Keep".
        //
        // Admission is by the alias SET, not by the single `name` string.
        //
        // `aliasKeys` over the whole proposal, its name AND its declared aliases, each expanded
        // through `nameForms`. The `name` field is one of the ways the model wrote this person;
        // `aka` is asked for precisely because it holds the others ("EVERY name this excerpt
        // actually uses for them … exactly as written", `entities.js` `instruction()`). Gating on
        // `name` alone refuses a person whose OTHER declared form the report carries, which is the
        // gate rejecting the very thing its own schema asked for.
        const forms = aliasKeys({ name: observed?.name, aka: observed?.aka });
        const covered = (mentionedKeys && forms.some(key => mentionedKeys.has(key)))
            || (!windowText || mentions(windowText, parsed.key, observed?.aka));
        if (!covered) {
            rejected.push({ item: parsed.display, reason: 'not-mentioned', raw: observed, snippet });
            continue;
        }
        // Admitted, and NOT by the name as written: something a bracket or an alias supplied carried
        // it. A count that climbs says the probe is still wording `name` and `mentions` differently
        // despite being asked not to, and that the structural floor is what is holding the campaign
        // up, which is the number that decides whether the ask needs strengthening again.
        if (mentionedKeys && !mentionedKeys.has(parsed.key) && forms.some(key => mentionedKeys.has(key))) {
            byForm++;
        }
        if (observed?.kind === LEAD && isExposition(observed)) {
            rejected.push({ item: parsed.display, reason: 'exposition', raw: observed, snippet });
            continue;
        }
        if (foldEntity(table, { ...observed, turn, mid }, { poi })) {
            accepted++;
        } else {
            rejected.push({ item: parsed.display, reason: 'entities-full', raw: observed, snippet });
        }
    }

    return { accepted, rejected, byForm };
}


/**
 * Is this "lead" actually background?
 *
 * Extraction has no stat block to anchor on in most chats, so asked for "information worth acting
 * on" it returns the most salient thing it read, which in a fantasy scene is lore. What a mark
 * grants, what a brand permits, what someone was told to do and then did: all true, all new to the
 * scene, none of them threads. A panel full of those is a panel nobody reads.
 *
 * The decision is the model's, not a word list's.
 *
 * The probe schema (`clocks.js` `schema()`) carries `unresolved: boolean`, and the instruction tells
 * the model to set it false for exposition however the `open` field is phrased. The gate reads that
 * answer. Before this, it re-read the model's OWN `open` text against an English interrogative
 * word-list, which failed exactly where a language difference hid the question: the Star Wars chat's
 * "Survive the fight, the fight has just started" was dropped as "exposition" because an ongoing
 * fight was phrased as a status rather than a question. The model already read the prose; fold asked
 * it, and the schema answer is the contract.
 *
 * @param {object} observed A lead observation.
 * @param {boolean} [observed.unresolved] The model's own answer: true if genuinely open.
 * @param {string} [observed.open] The gap, as free text, display only, never gated on.
 * @returns {boolean} True if it should be discarded.
 */
export function isExposition({ open = '', unresolved } = {}) {
    // The model answered: an explicit false is lore whatever the phrasing.
    if (typeof unresolved === 'boolean') {
        return !unresolved;
    }
    // The card-block path (`absorb-table.js`) and legacy rows carry no boolean. An empty gap is
    // structurally "nothing unresolved", that check is shape, not vocabulary.
    return !String(open ?? '').trim();
}

/**
 * Does the window mention this entity?
 *
 * Full name first, then any single token of it long enough to be discriminating, a scene that
 * says only "Ricci" is still talking about Adele Ricci. That is looser than the inventory gate,
 * which heads on the last token, and deliberately so: people are referred to by parts of their
 * names in a way that objects are not.
 *
 * The aliases the observation itself declares are checked too. A person the excerpt calls "the
 * widow" is not mentioned by their proper key when the window words it as "the woman", but the
 * `aka` are the names the same model read, so a window that carries them is a window about this
 * person. Refusing a person whose own aliases appear is the gate rejecting the very thing its
 * window was about (`itemHead`'s discipline, `block-parse.js`).
 *
 * @param {string} windowText The narrative window.
 * @param {string} name Normalized name.
 * @param {string} [aka] Comma-separated aliases the observation declares.
 * @returns {boolean} True if mentioned.
 */
function mentions(windowText, name, aka = '') {
    const haystack = String(windowText).toLowerCase();
    const names = [name, ...String(aka ?? '').split(/[,;/|]/)];
    return names.some(alias => {
        const key = String(alias ?? '').trim().toLowerCase();
        if (key && haystack.includes(key)) {
            return true;
        }
        return key.split(/[^a-z0-9']+/).filter(token => token.length > 3).some(token => haystack.includes(token));
    });
}

/**
 * Read the entities of one kind, freshest first, with retired and stale ones dropped.
 *
 * Each carries a derived `presence` when a scene location is supplied. Staleness still hides very
 * old records, but it is no longer the mechanism that decides who is in the room, it could never
 * be, because the probe is instructed to re-report anything still true and every re-report refreshed
 * the very counter that was supposed to expire it.
 *
 * @param {Map<string, object>} table Entity table.
 * @param {string} kind PERSON or LEAD.
 * @param {number} turn The current turn counter.
 * @param {object} [options] Options.
 * @param {string} [options.at] The scene's current location, for the presence predicate.
 * @returns {object[]} Entities, with `stale` and `presence` attached.
 */
export function entitiesOfKind(table, kind, turn = 0, { at = '' } = {}) {
    return table_entries(table)
        .filter(([key]) => splitEntityKey(key).kind === kind)
        .map(([key, value]) => ({
            ...value,
            key,
            stale: Math.max(0, turn - (value?.turn ?? 0)),
            presence: presenceOf(value, at),
        }))
        // A thing that resolved THIS turn stays one more turn, struck through, so the completion is
        // seen rather than silently vanishing. ScenePulse does the same for quests; a change nobody
        // witnessed reads as a tracker that lost something.
        // An edgeless ACTOR gets the short window (`SCENERY_STALE`): what separates a person from
        // the furniture is whether anything on the record connects them to the story, not how
        // recently the narrator described them walking past.
        //
        // Actors only. A lead is a different kind of thing and already has its own admission gate,
        // a non-empty `open` (`isExposition`, and the ungated-legacy sweep in `prune`), so the
        // relational fields this asks about are ones a thread was never going to carry.
        .filter(entity => (entity.presence !== GONE || entity.stale === 0)
            && entity.stale < (!ACTOR_KINDS.includes(kind) || hasEdge(entity) ? ENTITY_STALE : SCENERY_STALE))
        .sort((a, b) => a.stale - b.stale);
}

/**
 * The cast the record positively places somewhere other than here.
 *
 * Absence, not presence, and the asymmetry is the whole point.
 *
 * `castAt` splits three ways and only `elsewhere` is EVIDENCE. `unplaced` means fold does not know
 * where somebody is, the review asks `[where now?]` about exactly those people, so treating them
 * as away would be the presence guess `castAt` exists to stop making. With no scene location
 * nothing can be placed at all, and the set is empty.
 *
 * Read by the review, which can only settle what the excerpt touches: a mark on somebody two scenes
 * away is a question with one possible answer, asked every pass, out of a budget the people in the
 * room need. Midoriya carried `stunned` from mid 69 of the live My Hero Academia RP through two
 * in-story days of story that never mentioned him again, re-posed every time.
 *
 * Bounding the QUESTION is all this does. The mark itself stays exactly where it is, a wound does
 * not heal because the story looked away, and nothing here pretends otherwise. What it stops is the
 * waste.
 *
 * @param {Map<string, object>} table Entity table.
 * @param {number} turn Current turn.
 * @param {string} at Scene location.
 * @returns {Set<string>} Owner keys (`ownerKey`-shaped) the record puts elsewhere.
 */
export function absentKeys(table, turn = 0, at = '') {
    if (!String(at ?? '').trim()) {
        return new Set();
    }
    return new Set(castAt(table, turn, at).elsewhere
        .map(person => normalizeEntityName(person?.name)?.key)
        .filter(Boolean));
}

/**
 * The people the scene contains, the people it does not, and the people it cannot decide about.
 *
 * Three values in, three values out.
 *
 * The earlier version of this function returned two lists and folded UNPLACED into `here`, on this
 * argument, kept because it is half right:
 *
 *   > UNPLACED counts as here. With no place on the record, or no location on the scene, there
 *   > is no evidence of absence, and "absence is not a retraction" is the same asymmetry that
 *   > governs inventory: a block is evidence of what it states, not of what it omits.
 *
 * The asymmetry is real. The conclusion is not, and the second hand repair of the live chat found
 * the reason: absence of evidence became an ASSERTION. `presenceOf` takes care to return UNPLACED
 * as a distinct answer for "the evidence cannot decide", that is `the_dispatch_law`
 * (`SelectionDispatch.lean:223`), a third action where a default has no warrant, and one function
 * later the third value was spent placing people in a room the narration never put them in. A
 * three-valued derivation with a two-valued consumer keeps none of the honesty it paid for.
 *
 * "Not retracted" and "in the room" are different claims. The first is what the evidence supports;
 * the second is what the panel and the prompt were saying. So the third value survives to the
 * consumers, all of which are obliged to hedge it: `renderEntities` never asserts an UNPLACED
 * person plainly, the panel dims them and says "whereabouts unstated", and Phase C's review asks
 * where they actually are instead of anyone guessing.
 *
 * GONE stays in `here` for exactly one turn, which is not an oversight: a departure nobody
 * witnessed reads as a tracker that lost someone (see `entitiesOfKind`).
 *
 * @param {Map<string, object>} table Entity table.
 * @param {number} turn Current turn.
 * @param {string} at Scene location.
 * @returns {{here: object[], unplaced: object[], elsewhere: object[]}} The cast, split three ways.
 */
export function castAt(table, turn, at) {
    // Both actor kinds, since Phase W. A guild whose sphere of operation is this district is a
    // presence in the scene in exactly the sense a person standing here is, and the presence
    // predicate is the same comparison either way. Inert on every chat that exists: no live chat
    // has a faction row, so this changes nothing anyone has until the entity probe writes one.
    // Re-sorted after the concatenation: `entitiesOfKind` sorts within a kind, and two sorted lists
    // laid end to end are not a sorted list, freshest-first is the order every consumer downstream
    // assumes.
    const people = ACTOR_KINDS
        .flatMap(kind => entitiesOfKind(table, kind, turn, { at }))
        .sort((a, b) => a.stale - b.stale);
    return {
        here: people.filter(p => p.presence !== ELSEWHERE && p.presence !== UNPLACED),
        unplaced: people.filter(p => p.presence === UNPLACED),
        elsewhere: people.filter(p => p.presence === ELSEWHERE),
    };
}

/**
 * Render entities for the prompt.
 *
 * Deliberately terse and deliberately paired, `Maria (reachable by email)` is the shape that made
 * the flat block wrong, so it is the shape that has to survive into what the model reads back.
 *
 * Only the people actually HERE reach the prompt. This is the half of the presence fix that matters
 * most, and not merely for tidiness: `InsertEmission.the_insert_law` (`:322`) makes an insert at
 * full weight a *projection* when its influence exceeds half the margin, it can absorb the emission
 * rather than nudge it. So injecting "Lord Everard (in the dining hall)" into a bedroom scene does
 * not just misinform the reader; it actively holds a departed character in the room, and the model
 * dutifully writes him there. Stale state is corrosive, not inert.
 *
 * Marks ride beside the person, which is the point of owning them.
 *
 * `describe` gains `hurt: …` and `threat …` when the caller supplies the marks table. Both belong
 * HERE rather than on a line of their own: the injection's job is to say what the narrator is
 * writing about, and "the broker (behind the counter, wants your won, hurt: split lip)" is one
 * person the model can act on, where a separate `Wounded:` list is a second table it has to join.
 * The pov's own marks are on the `Condition:`/`Status:` line, because he is not in this list.
 *
 * `holds: …` arrives the same way and for the same argument. Once an item can belong to somebody
 * (`state-table.js` `itemKey`), "Kaelira (wants an ironwood branch)" and "Kaelira holds an ironwood
 * branch" are the same person and must be one line, otherwise the narrator has her still looking
 * for the thing she is carrying, which is the mid-82 beat New Eldoria lost.
 *
 * People of interest get a longer clause, and nobody else's line moves.
 *
 * `poi` is the flag table `state.js` owns (`loadPoi`, and its own docblock for why it is a side
 * table rather than a field). Passed IN as a set of keys rather than read from here, exactly as
 * `hurt` and `holds` are passed in as functions and for the same reason: `state.js` imports this
 * file, so this file reaching back for the flag would close a cycle. The caller that holds both is
 * the one that already assembles the block.
 *
 * What the flag buys is the alias set and the dossier. The alias first: a narrator who only ever
 * sees `Kang Min-seo` writes `Kang` back as a stranger, and the next extraction opens a second row
 * for her (`FOLD-RPG-GAP.md` §2). The dossier second, and it is the larger half, `wearing`,
 * `bearing` and `history`, which no unflagged line carries and no flagged row even stores
 * (`MAX_DOSSIER`, and `foldEntity`'s tier). `look` is on every line either way, because appearance
 * was already on every line inside `facts`; what the flag lengthens is how much of it there is.
 *
 * The cost is bounded three times over. Per field, by the caps. Per person, by the flag, which the
 * player sets by hand. And per turn, by PRESENCE, `elsewhere` never reaches the prompt at all, so
 * a flagged character two scenes away is free.
 *
 * MEASURED on the live Raccoon City cast at turn 141, Martinez's row (five aliases: "Officer
 * Martinez, the officer, Police officer, RPD officer, the woman"), rendered in the break room:
 *
 *     unflagged, exactly as she stands today                   172 chars   ~43 tokens
 *     unflagged, with the probe filling `look` to its cap       301 chars   ~75 tokens
 *     flagged, alias only, what the flag bought before        257 chars   ~64 tokens
 *     flagged, a realistic dossier                             904 chars  ~226 tokens
 *     flagged, every dossier field at its cap (the ceiling)   1,697 chars  ~424 tokens
 *
 * So a flagged present character costs ~180 tokens more than an unflagged one in practice and ~380
 * at the ceiling, and every other person on the line is byte-identical either way. The whole
 * injected cast block for that scene, sixteen rows, six of them in the room, goes from 226 tokens
 * to 918 with FOUR of the six flagged and fully described, which is the worst case a player can
 * construct by hand and still a fraction of a block that runs to several thousand.
 *
 * The unflagged row grows too, by ~32 tokens, and only because `look` is filled: that is the
 * appearance budget moving out of `facts` into a field named for it, not a new spend.
 *
 * @param {Map<string, object>} table Entity table.
 * @param {number} turn The current turn counter.
 * @param {object} [options] Options.
 * @param {string} [options.exclude] A name to omit, the point-of-view character.
 * @param {string} [options.at] Scene location, for the presence predicate.
 * @param {Function|null} [options.hurt] `name => phrases[]`, supplied by the caller that holds the
 *   marks table. A FUNCTION rather than the table, because `state-table.js` imports this file to
 *   normalise owner names and the reverse import would close a cycle; the caller that has both is
 *   `entities.js`, which is where the two are joined.
 * @param {Function|null} [options.holds] `name => phrases[]` over the inventory, injected for the
 *   identical cycle reason.
 * @param {Set<string>|null} [options.poi] Entity keys the player has flagged as people of interest.
 *   Anything with a `has` method will do; omitted means nobody is flagged, and the output is then
 *   byte-identical to what it was before the flag existed.
 * @returns {string} Lines for the injected block, or ''.
 */
export function renderEntities(table, turn = 0, { exclude = '', at = '', hurt = null, holds = null, poi = null } = {}) {
    const lines = [];
    // Resolved through the alias set rather than compared as a string. `pov` comes from a different
    // probe than the cast does, and the two never agreed on a vocabulary, "Hero" versus "Solomon"
    // is not a near-miss a fuzzy comparison could close, it is one man under two names.
    const skip = resolveEntity(table, PERSON, exclude)?.key ?? '';

    const cast = castAt(table, turn, at);
    const mine = list => list.filter(person => !skip || person.key !== skip);
    // Disposition and agenda lead, because they are what the narrator has to act on. Where someone
    // is standing is scenery; what they want from you is the scene.
    const hurts = p => (hurt ? hurt(p.name) ?? [] : []);
    const carries = p => (holds ? holds(p.name) ?? [] : []);
    // Duck-typed on `has` so a Set, a Map or anything else key-shaped works, and a missing table is
    // simply nobody. An unflagged row's clause is `''`, which `filter(Boolean)` drops, so every
    // line this function has ever produced for an unflagged person is produced unchanged.
    const flagged = p => Boolean(poi?.has?.(p.key));
    // The dossier clauses, and which of them a line is allowed to carry.
    //
    // `look` is on every line, flagged or not, and that is not the flag leaking: appearance was
    // already on every line, unlabelled, inside `facts`: "burly man with forearms like tree roots"
    // is a live Wuxia row. Moving it to a field of its own and labelling it changes what the value
    // is CALLED, not how much of the line it occupies, because an unflagged row is capped at
    // `MAX_DETAIL` exactly as `facts` is. The narrator sees what it always saw, in a slot that can
    // hold more when there is more to hold.
    //
    // `wearing`, `bearing` and `history` are the flag's purchase. They are the answer to "only
    // persons of interest should get a larger physical description and history, shown when they're
    // in the same scene as you", and PRESENCE is already enforced one layer up, because
    // `cast.elsewhere` never reaches this function's output at all. A flagged person in another
    // room costs nothing, which is the property `the_insert_law` makes non-negotiable: a reading
    // preference must never buy a departed character his way back into the room.
    //
    // Ordered last on the line, after what they want and what they know. `renderEntities` has said
    // since it was written that disposition and agenda lead because they are what the narrator has
    // to ACT on; a face is what he has to describe, and description follows action.
    //
    // The trailing full stop comes off each one. These four are the only fields on the line that
    // are written as SENTENCES rather than as clauses, and the line joins with commas, so left
    // alone they read "…across the left forearm., wearing Torn RPD uniform", which is a punctuation
    // error in the middle of a prompt the narrator is being asked to write from.
    const sentence = value => String(value ?? '').trim().replace(/\.$/, '');
    const dossier = p => (flagged(p)
        ? [p.wearing && `wearing ${sentence(p.wearing)}`,
            p.bearing && `manner: ${sentence(p.bearing)}`,
            p.history && `history: ${sentence(p.history)}`]
        : []);
    // Identity leads, ahead of where they are standing: the alias is how the narrator addresses
    // them, and an alias printed after the wound reads as an afterthought.
    const said = p => [flagged(p) && p.aka ? `also known as ${p.aka}` : '',
        p.place, p.detail, p.reach && `reachable: ${p.reach}`,
        p.feels && `regards you as ${p.feels}`, p.wants && `wants ${p.wants}`,
        p.knows && `knows ${p.knows}`, p.secret && `secret: ${p.secret}`, p.facts,
        p.look && `looks: ${sentence(p.look)}`,
        ...dossier(p),
        p.threat ? `threat ${p.threat}` : '',
        carries(p).length ? `has ${carries(p).join(', ')}` : '',
        hurts(p).length ? `hurt: ${hurts(p).join(', ')}` : ''].filter(Boolean).join(', ');
    const describe = p => (said(p) ? `${p.name} (${said(p)})` : p.name);

    const people = mine(cast.here);
    if (people.length) {
        lines.push(`People: ${people.map(describe).join('; ')}`);
    }

    // The hedge is the whole point of this line.
    //
    // These are people fold has not retracted and cannot place. Listing them under `People:` is
    // what put the scarred broker in a room the narration had left, and worse: `the_insert_law`
    // (`InsertEmission.lean:277-283`) says an insert at full weight can PROJECT, absorb the
    // emission rather than nudge it, so an asserted presence does not merely misinform the
    // narrator, it holds the character there and the model dutifully writes them in.
    //
    // A separate heading with the uncertainty stated in words is the cheapest correct thing: the
    // information survives (the narrator may still use them), and nothing about the sentence reads
    // as a claim about the room. Phase C's review turns the hedge into a question.
    const unplaced = mine(cast.unplaced);
    if (unplaced.length) {
        lines.push(`Whereabouts unstated, do not place them in the scene unless the story does: ${unplaced.map(describe).join('; ')}`);
    }

    const leads = entitiesOfKind(table, LEAD, turn);
    if (leads.length) {
        lines.push(`Leads: ${leads.map(l => {
            let body = l.detail ? `${l.name}, ${l.detail}` : l.name;
            // The unresolved part is the reason the lead is in the prompt at all; without it the
            // model reads back a statement and has nothing to push against.
            if (l.open) {
                body += `; ${l.open}`;
            }
            return l.source ? `${body} (${l.source})` : body;
        }).join('; ')}`);
    }

    return lines.join('\n');
}

/**
 * Is this entity worth drawing attention to?
 * @param {object} entity An entity from entitiesOfKind.
 * @returns {boolean} True if it changed within the last couple of turns.
 */
export function isRecent(entity) {
    return (entity?.stale ?? Infinity) <= 1;
}

/**
 * Look one up by any name it answers to.
 *
 * Delegates to `resolveEntity` rather than keying directly. Two lookups with different semantics,
 * one alias-aware, one not, is a trap: the exact-match version silently fails to find Solomon when
 * asked for "the Hero", which is the bug the alias set was added to close. Either both follow
 * aliases or there is only one of them.
 *
 * @param {Map<string, object>} table Entity table.
 * @param {string} kind Entity kind.
 * @param {string} name Raw name.
 * @returns {object|null} The record, or null.
 */
export function findEntity(table, kind, name) {
    return resolveEntity(table, kind, name)?.entity ?? null;
}

/**
 * Merge two cast rows the review has confirmed are one person.
 *
 * The merge is a WRITE, and the closure it accompanies is a read-time overlay; that asymmetry
 * is deliberate.
 *
 * Thread closures survive swipes by being events the state fold reads back (`FOLD-REDESIGN.md` §2,
 * and `overlayClosures` in thread-table.js). A merge does not get that treatment, and the reason is
 * `merge_entity`'s own argument about the alias set: "a name someone was called does NOT stop being
 * a name they were called", so aliases are the Set face, once in, always in. A confirmed identity
 * is not a fact about the branch; it is a fact about the world, and the very swipe that would
 * retract it is a swipe that also removes the sentence in which the two names appeared. Recording it
 * as a write means the second sighting of "Kang" lands on the Kang Min-seo row for the rest of the
 * chat, which is the defect this closes (`FOLD-RPG-GAP.md` §2: two Kang records, permanently). The
 * audit event that accompanies it says who merged them and when.
 *
 * Which row survives.
 *
 * The one with the LONGER display name, and the earlier `first` on a tie. `broker` and `scarred
 * broker` are one man behind one counter; `Kang` and `Kang Min-seo` are one woman. In both the
 * longer name is the more specific one, and the shorter is the abbreviation that opened a duplicate
 *, so keeping the longer name and demoting the shorter to `aka` is the direction that makes the
 * next abbreviation resolve. The loser's fields are folded in under the ordinary field-wise merge,
 * so the fresher of the two sightings wins per field exactly as a re-report would.
 *
 * @param {Map<string, object>} table Entity table, mutated.
 * @param {string} left One table key.
 * @param {string} right Another.
 * @returns {{key: string, dropped: string}|null} What survived and what was folded into it.
 */
export function mergeEntities(table, left, right) {
    if (!left || !right || left === right) {
        return null;
    }
    const a = lookup(table, left, null);
    const b = lookup(table, right, null);
    if (!a || !b || splitEntityKey(left).kind !== splitEntityKey(right).kind) {
        return null;
    }
    const longer = String(a.name ?? '').length !== String(b.name ?? '').length
        ? (String(a.name ?? '').length > String(b.name ?? '').length ? left : right)
        : ((a.first ?? 0) <= (b.first ?? 0) ? left : right);
    const [keepKey, dropKey] = longer === left ? [left, right] : [right, left];
    const keep = lookup(table, keepKey, {});
    const drop = lookup(table, dropKey, {});

    // Folded in as though the loser had been sighted under the keeper's name. `merge_entity`'s
    // alias accumulation then does the rest, the loser's own name is not in the keeper's alias
    // set, so it joins it, and the turn ordering decides every other field, which is why the
    // aliases are declared here rather than assembled by hand.
    insert_with(table, merge_entity, keepKey, {
        ...drop,
        name: keep.name,
        aka: [drop.name, drop.aka].filter(Boolean).join(', ').slice(0, MAX_DETAIL),
    });
    table.delete(dropKey);
    return { key: keepKey, dropped: dropKey };
}
