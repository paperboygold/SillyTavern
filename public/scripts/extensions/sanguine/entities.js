/**
 * fold/entities.js: people and leads, persisted and folded.
 *
 * The pure logic is in entity-table.js; this file is the half that touches storage and the
 * extraction pass.
 *
 * Why these are stored rather than derived.
 *
 * Inventory is a fold over the chronicle because every change to it was caused by an event. People
 * and leads are not like that. "Maria is reachable by email" is not the *result* of anything that
 * happened; it is a standing fact about the world that a turn happened to reveal. Folding it would
 * mean inventing an event whose only content is that something was mentioned, which inflates the
 * ledger with non-events and makes the audit trail worse rather than better.
 *
 * The cost is honest and worth naming: this table is not branch-aware. Swipe away the turn that
 * introduced Adele Ricci and she stays on the panel. That matches how scene context already
 * behaves, and the alternative, an event per mention, buys correctness on a rare case by
 * degrading the common one.
 */

import { lookup, table_entries } from './lib/hash.js';
import {
    appendTrail,
    clampDossierFields,
    ACTOR_KINDS,
    DISPOSITIONS,
    ENTITY_STALE,
    FACTION,
    LEAD,
    MAX_DRIVE,
    MAX_THREAT,
    PERSON,
    actorKind,
    castAt,
    foldEntities,
    foldEntity,
    handTrailEntries,
    mergeEntities,
    normalizeEntityName,
    placeIsNews,
    renderEntities,
    contestedAliases,
    dispositionRank,
    resolveEntity,
    splitEntityKey,
    threatOf,
} from './entity-table.js';
// The join between the cast table and the marks table happens here and only here: `state-table.js`
// imports `entity-table.js` (to normalise owner names), so the reverse import would be a cycle, and
// this file already depends on both halves.
import { itemPhrases, markPhrases } from './state-table.js';
import { identityPairs } from './thread-table.js';
import { noteCoverage, oneSpelling } from './coverage.js';
import * as cold from './cold-store.js';
import * as lore from './lore.js';
import * as observe from './observe.js';
import { commit, loadTable, loadValue } from './store.js';

/**
 * Where the cast lives under v2.
 *
 * Renamed from `state.entities` by the migration (`migrate.js`), and the rename is not cosmetic:
 * the old table held two kinds of thing under one key space, and half of them, leads, are now
 * threads. `cast` is what is left once that is true, and a key that means one thing is a key a
 * reader can trust. The v1 key survives beside this one until the v2 blob has come back off disk
 * (FOLD-REDESIGN.md §9), so a rollback loses nothing.
 */
const ENTITIES_PATH = 'state.cast';
const TURN_PATH = 'state.turn';

/** @returns {Map<string, object>} The entity table. */
export function load() {
    return loadTable(ENTITIES_PATH);
}

/**
 * The turn counter used for staleness.
 *
 * Stored rather than taken from `chat.length`, because a chat can be trimmed, branched or loaded
 * mid-way and an entity's age must not jump when that happens.
 *
 * @returns {number} The current turn.
 */
export function turn() {
    const value = Number(lookup(loadTable(TURN_PATH), 'n', 0));
    return Number.isFinite(value) ? value : 0;
}

/**
 * Advance the turn counter.
 * @returns {number} The new turn.
 */
export function advanceTurn() {
    const next = turn() + 1;
    const table = loadTable(TURN_PATH);
    table.set('n', next);
    commit(TURN_PATH, table);
    return next;
}

/**
 * The schema fragment for the entity probe.
 *
 * Every nested object carries `additionalProperties: false` and lists every property in `required`,
 * because OpenAI's strict mode demands it on EVERY object and one omission fails the shared call
 * for every probe at once.
 *
 * @returns {object} A JSON Schema fragment.
 */
export function schema() {
    return {
        type: 'object',
        description: 'People and leads the excerpt establishes.',
        properties: {
            people: {
                type: 'array',
                description: 'People the excerpt places somewhere, in the scene or elsewhere. Not people merely talked about.',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'The person\'s name, or a short description if unnamed.' },
                        // An organisation that acts is an actor, and had no way to say so.
                        //
                        // fold has held a `faction` kind for as long as it has held `person`, and
                        // nothing ever wrote one because this field did not exist and the fold
                        // hardcoded `person` on the way in. Measured in a completed Xianxia
                        // campaign: 26 cast rows, all `person`, while three trading houses and a
                        // cultivator alliance ran the entire mid-game economy, present in the
                        // record only as substrings inside some shopkeeper's `wants`.
                        //
                        // An enum, because the alternative is fold deciding "万通商行 sounds like a
                        // company", which is a judgement about a name in one language. The model
                        // classifies; `actorKind` checks the answer is a vocabulary member.
                        // No empty member: Google's schema converter rejects one outright
                        // (`src/prompt-converters.js` `toGeminiSchema`), and there is no third
                        // answer worth having, an unsure model should say `person`.
                        kind: {
                            type: 'string',
                            enum: [PERSON, FACTION],
                            description: `"${FACTION}" for a group that acts as one, a guild, sect, company, crew, house, agency. "${PERSON}" for an individual, including a creature or a named beast. When unsure, say "${PERSON}".`,
                        },
                        aka: {
                            type: 'string',
                            // This asked about the EXCERPT, and the excerpt is the wrong scope.
                            //
                            // Cast aliasing's commonest shape by far is a person described before
                            // they are named: "the tiefling fighter" for ten turns, then "Kaelira".
                            // The two share no tokens, so `nearIdentity` is structurally blind to
                            // the pair and can never raise it, verified against the shipped
                            // detector on all three pairs in a live chat.
                            //
                            // The model was not blind. Measured on that chat's trace: at mid 0 it
                            // reported `tiefling fighter` with `aka: "the fighter, the tiefling,
                            // the first woman"`, using this field exactly as written. At mid 4 it
                            // reported `Kaelira` with `aka: ""`, while the pinned People list in
                            // that same prompt still read "tiefling fighter (…)". It answered the
                            // question asked: within that excerpt she IS only called one thing.
                            // The result was three people stored twice, 55 people reported across
                            // 19 passes and 3 non-empty `aka` values, all from the first pass.
                            //
                            // So the field now points at fold's own list, the way the delta
                            // schema's `same_as` points at the State block. That is the difference
                            // between "what else did this excerpt call her" and "who is this, of
                            // the people you already hold", and only the second one merges.
                            description: 'Other names for this same person, comma-separated. TWO kinds, and the second matters most: (1) other names or titles the excerpt itself uses; (2) the EXACT name this person is listed under in the people list above, when the excerpt has revealed who a previously-described person is, a name learned for someone recorded only by description ("the tall guard" turning out to be "Marek") goes here as "the tall guard". Empty only when neither applies. Never repeat the name itself.',
                        },
                        place: {
                            type: 'string',
                            description: 'The bare place name where they are now, worded as the narration words it: "the stableyard", "manor bedroom". No prepositions, no activity. Empty only if the excerpt truly does not say.',
                        },
                        detail: {
                            type: 'string',
                            description: 'What they are doing right now, as a short phrase: "sparring with Marote". NOT where they are (that is "place").',
                        },
                        reach: {
                            type: 'string',
                            description: 'How the point-of-view character can contact them at a distance: "phone number", "reachable by email". A standing capability, never an item.',
                        },
                        feels: {
                            type: 'string',
                            enum: ['hostile', 'wary', 'neutral', 'friendly', 'devoted', ''],
                            description: 'How they currently regard the point-of-view character, from how they act. Empty if no sign. Change only when the narration gives a reason.',
                        },
                        wants: {
                            type: 'string',
                            description: 'What they are trying to get, as a short phrase: "supplies for the northern march". Their goal, not the player\'s. Empty if no agenda is revealed.',
                        },
                        knows: {
                            type: 'string',
                            description: 'What they know about the point-of-view character that matters: a secret, a debt, a suspicion. Empty if nothing.',
                        },
                        secret: {
                            type: 'string',
                            description: 'What they know that the point-of-view character does NOT, the hidden fact that shapes their choices: a betrayal, a plan, a truth the PC would act on differently if they knew. Empty if nothing.',
                        },
                        status: {
                            type: 'string',
                            enum: ['present', 'remote', 'unreachable', 'gone'],
                            description: 'present if in the scene, remote if contactable at a distance, unreachable if not, gone ONLY if they left the story for good. Someone who walked into another room is still present.',
                        },
                        // `drive_size` was asked here, and is derived now.
                        //
                        // The property read: "how many steps their standing ambition takes to
                        // achieve, 2 to N. 0 for anyone with no long-running ambition." It was put
                        // here on the argument that an agenda's length is a fact about WHO SOMEBODY
                        // IS, established when they are first understood to have an ambition,
                        // which is a good division of labour and the wrong place to stand.
                        //
                        // MEASURED: 288 traced proposals, answer 0 in 288 of them. `driveSize > 0`
                        // on 0 of 165 cast rows across all 17 live chats, 40 of them storing an
                        // explicit 0. `worldAsks`' `size > 0` gate therefore never admitted an
                        // actor and the actor half of the off-screen world turn has never run once.
                        //
                        // The model was answering honestly. This is asked on a SIGHTING, usually
                        // the first, and at first contact a shopkeeper who wants to sell books and
                        // a trading house cornering a market are indistinguishable. Standing-ness
                        // is not visible when a character walks on; it is visible only in
                        // retrospect, because an agenda is standing precisely when it is still
                        // there forty turns later. Asked that early the question has no answer, and
                        // 0 is the right one.
                        //
                        // So it stops being asked. `entity-table.js` `driveOf` derives it from what
                        // the row already carries, a non-empty `wants`, a `turn - first` span, and
                        // a `wants` trail that never named a second agenda, which is the
                        // retrospective evidence a sighting cannot have. The field itself survives:
                        // `foldEntity` still accepts and clamps `driveSize` for hand edits, and
                        // `places.js` keeps its own.
                        threat: {
                            type: 'integer',
                            description: `How dangerous RIGHT NOW, 1 to ${MAX_THREAT}, while actively hostile. 0 for anyone who is not currently a threat (nearly everyone), and 0 again the moment a fight ends.`,
                        },
                        facts: {
                            type: 'string',
                            // Appearance moved OUT of here, into `look`.
                            //
                            // For a while this field was asked for appearance as well as rank and
                            // bloodline, on the argument that it was already rendered, already
                            // merged field-wise and already bounded. It is all three, and it is
                            // still 120 characters carrying five jobs. Measured on the live chats
                            // that yields `facts: "officer"` and `facts: ""` on seven of sixteen
                            // Raccoon City rows, and at its best `facts: "wiry woman with sharp
                            // eyes, wears a faded blue headscarf"`, one clause, with the eyes and
                            // the headscarf competing for the same bytes although one of them is
                            // permanent and the other is today's outfit.
                            //
                            // So the field goes back to what it was for and the appearance fields
                            // below take the rest. Asking one field for two kinds of thing is how
                            // it came to answer for neither.
                            description: 'Standing truths that are NOT about how they look: rank, role, title, species, bloodline, profession, allegiance, "E-Rank Hunter", "second-year", "Qi Gathering stage 10", "RPD officer". A few words. Never mood, location, activity, appearance or clothing.',
                        },
                        // The four fields the owner's complaint is actually about.
                        //
                        // "I see almost no physical descriptors for anyone, no idea what they're
                        // wearing or what they look like." Half of that was a schema with nowhere
                        // to put the answer and half was a prompt that never asked; this is the
                        // asking half. The split between them is `entity-table.js` `MAX_DOSSIER`:
                        // permanent things must not churn when somebody changes a coat, and the
                        // coat must churn.
                        //
                        // Every description tells the model to write in the register the narration
                        // is already using. A tracker that answers "Subject: female, 30s, dark
                        // hair" to a scene written in close third person hands the narrator prose
                        // he cannot put in the story, and he re-invents her rather than use it.
                        look: {
                            type: 'string',
                            description: 'What they PERMANENTLY look like, in the narration\'s own voice: build, height, face, eyes, hair, skin, scars, anything that would let someone pick them out of a crowd. "Slim, toned frame built for speed. Almond-brown eyes, straight brows, sharp cheekbones, pale-gold skin. Black bob cut." Never clothing (that is "wearing"), never mood, never what they are doing. Give this the first time the excerpt describes someone and whenever it adds to or contradicts what is already recorded; otherwise leave it empty.',
                        },
                        wearing: {
                            type: 'string',
                            description: 'What they have on RIGHT NOW and what visible state they are in: "trench coat over a red dress, heels", "torn RPD uniform, left sleeve soaked through". One sentence. Report it whenever the excerpt says or changes it, clothes change and the record has to change with them. Empty if the excerpt does not say.',
                        },
                        bearing: {
                            type: 'string',
                            description: 'How they come across, permanently: voice, how they speak, how they move, temperament, the personality the surface shows. "Calm, dry, economical with words; says less than she knows. Every movement liquid and deliberate, even in heels." In the narration\'s register, not a trait list. Empty unless the excerpt shows it.',
                        },
                        history: {
                            type: 'string',
                            description: 'Where they came from and what they have done, as the story has revealed it: origin, past work, old debts, who they used to be. Only what the excerpt or the dialogue actually establishes, never invented, never inferred from a role. Empty if nothing is known.',
                        },
                    },
                    // `drive_size` left this list with the property above it. The schema is strict,
                    // `additionalProperties: false` with every property required, so a property and
                    // its `required` entry are one edit, not two, and dropping only one of them
                    // fails the whole shared call for every probe.
                    required: ['name', 'kind', 'aka', 'place', 'detail', 'reach', 'feels', 'wants', 'knows', 'secret', 'status', 'threat', 'facts', 'look', 'wearing', 'bearing', 'history'],
                    additionalProperties: false,
                },
            },
            // Coverage, not a substring proxy ([ROUTER]).
            //
            // The mention gate used to decide "did the window mention this person?" by token-matching
            // the window text, which fails on paraphrase and on any language fold did not spell out.
            // The model already READ the window; it is the authority on what it names. `mentions`
            // is that reading, returned structurally, the names the new excerpt actually uses, and
            // fold admits a proposal only when its name is in this set. Admission by coverage.
            //
            // The wording half, which this probe was missing.
            //
            // `chronicle.js` has asked for one spelling across `mentions` and its delta since the
            // coverage rule landed; this probe never did, and the live Wuxia campaign priced the
            // omission. Replaying all 149 traced passes of
            // `Wuxia World RPG - 2026-08-20@19h08m26s160ms.jsonl`: 6 `reject:not-mentioned` from
            // this gate, 5 of them one person written two ways in one call,
            // `name: "刘三（Liú Sān）"` against `mentions: ["刘三", …]` at turns 74 and 76,
            // `name: "Zhāng Lín" | "Lǐ Qī" | "Ling Xiang"` against
            // `mentions: [… "张林", "李七", "凌香" …]` at turn 112. Every one was a person the model
            // had explicitly reported, refused because the gate saw two strings; the place,
            // disposition and wants of that sighting went with them.
            //
            // The clause is `coverage.js` `oneSpelling`, shared with the chronicle and thread probes
            // rather than reworded here, because three wordings of one rule is how they drift.
            mentions: {
                type: 'array',
                description: `Every name or title the NEW excerpt actually uses for a person, exactly as written, "the woman", "the widow", "Vesk", "Sol". One entry per distinct name, including the aliases. This is what proves the excerpt was about someone; a name absent here was not in the excerpt. When you also report that person in "people", ${oneSpelling({ field: 'their "name"', thing: 'person' })}`,
                items: { type: 'string' },
            },
        },
        required: ['people', 'mentions'],
        additionalProperties: false,
    };
}

/**
 * Prompt guidance for the entity probe.
 *
 * `leads` left this probe in Phase B. A lead was only ever a thread nobody could measure, and it
 * now shares a table, and a probe fragment, with clocks and progress tracks, because the live
 * chat carried one stake as a lead AND as a clock and neither could close (FOLD-REDESIGN.md §4).
 * See `clocks.js` `schema()`.
 *
 * @returns {string} Prompt guidance for the probe.
 */
export function instruction() {
    return [
        'The people the excerpt places somewhere, as objects rather than a list of phrases.',
        'One person, one entry: name in "name", the bare place name in "place" (worded exactly as the narration words it, a differently-worded place makes a person vanish from the room), what they are doing in "detail", how to contact them in "reach".',
        'Give "feels" (how they regard the point-of-view character), "wants" (their own agenda), "knows" (what they know about him that matters). These drive behaviour.',
        // The half the owner named first: the probe never asked, so it never got an answer.
        //
        // `facts` carried a clause about appearance for a while and the result was one clause. The
        // fields exist now; this is what makes them fill. Written as an instruction about the
        // NARRATOR, not about the tracker, because that is what the fields are for, the record is
        // read back into the prompt and a narrator who is told "mid-forties, civilian clothes"
        // writes a different scene from one who is told nothing and invents her afresh every turn.
        'Describe people properly. "look" is what they permanently are, build, face, eyes, hair, skin, scars; "wearing" is what they have on right now and what state they are visibly in; "bearing" is voice, manner and temperament; "history" is where they came from. Write all four in the same register the narration is written in, as prose the story could use, never as a form or a trait list.',
        'The division matters: eye colour does not change when someone puts on a coat. Permanent things go in "look" and "bearing" and are given once and then left alone; "wearing" changes whenever the story changes it and must be re-reported when it does.',
        'Never invent any of it. If the excerpt does not describe someone, leave those fields empty, a face guessed from a job title is worse than no face, because the narrator will keep it.',
        'A character called by a title and a name, "the Hero" and "Solomon", is ONE person: proper name in "name", every other form in "aka".',
        'Put EVERY name this excerpt actually uses for them in "aka", exactly as written, "the woman", "the widow", "Elin\'s mother", because an alias is how the reader proves the excerpt was about them. A person whose spoken name is "the woman" and whose stored name is "the widow" is not mentioned unless the alias carries it.',
        // The aka rule was already right and was already being ignored.
        //
        // Every example above is a DESCRIPTION in English, so the rule reads as being about titles,
        // and a name written in a second script does not look like a title. Measured: at turn 112 of
        // the live Wuxia campaign the probe answered `name: "Zhāng Lín", aka: ""` for a man the
        // excerpt writes `张林` and its own `mentions` list carries as `张林`: the alias field, which
        // the gate has consulted all along, was simply left empty. `aka` was empty on 5 of the 6
        // refusals. Naming the case is the whole fix; the machinery behind it already exists.
        'A second writing of the same name is an alias: a different script, a spelling with the pronunciation beside it, an initial, a shortening. If the excerpt writes one person\'s name more than one way, put every way in "aka", exactly as written.',
        'Give "place" for anyone whose position the excerpt establishes; if they walked out, give the place they walked TO. Do not mark them "gone" unless they left the story for good.',
        'Give "reach" whenever the excerpt establishes a way to contact someone, a number exchanged, an address. Contact details are never items.',
        'Give "threat" only while someone is actively dangerous, and set it back to 0 the moment they stop being, defeated, fled, calmed down. Everyone else is 0.',
        'Report ONLY people the NEW excerpt names or places, never someone merely carried over from the already-recorded block. A person the new text does not name is not reported, whatever the record shows. Use an empty array when the new excerpt establishes nobody.',
        `List EVERY name the NEW excerpt actually uses for anyone, including people you do not otherwise report, in "mentions", exactly as written: "the woman", "Vesk", "Gorak". A name the excerpt does not contain is never listed. This is the coverage proof: only a name in "mentions" may be changed. ${oneSpelling({ field: 'each reported person\'s "name"', thing: 'person' })}`,
    ].join(' ');
}

/**
 * Per-pass guidance: who the player has flagged, and what that changes about the answer.
 *
 * Why this is `context()` and not part of `instruction()`.
 *
 * `registerProbe`'s docblock has the measurement: instruction blocks are 90% byte-identical
 * sentence mass, and one interpolated clause in a 2,700-token block costs the whole block's prefix
 * cache every pass. A list of names the player edits by hand is exactly such a clause, so it rides
 * below the breakpoint where it costs only itself, the same place `scene.context` and
 * `world.context` put their moving state.
 *
 * Why naming them is worth a per-pass clause at all.
 *
 * The flag is a claim about what the narrator should be told, and until now it was only ever read
 * at RENDER time: `renderEntities` gave a flagged person a longer line out of whatever happened to
 * be on the record. Nothing ever asked for more to be on the record. So flagging somebody bought a
 * fuller sentence about a row that was thin for the same reason every other row was thin.
 *
 * Telling the extractor closes that. A person flagged on turn 40 gets described in full on turn 41,
 * which is also why the storage tier (`foldEntity`) losing nothing by flagging late is true rather
 * than merely convenient, the long form the flag unlocks is refilled by the next sighting.
 *
 * Names, not keys. The key is `person␀kang min-seo`, which is fold's spelling of her; the model is
 * being asked about a story, so it is given the display name the story uses.
 *
 * @param {object} [options] Options.
 * @param {Set<string>|null} [options.poi] Flagged entity keys, `state.poiKeys()` as a set.
 * @returns {string} A line for the per-pass block, or '' when nobody is flagged.
 */
export function context({ poi = null, at = '' } = {}) {
    const table = load();
    const named = [];
    for (const key of poi ?? []) {
        const name = String(lookup(table, key, null)?.name ?? '').trim();
        if (name) {
            named.push(name);
        }
    }
    // The characters whose face is already written, and must not be guessed at again.
    //
    // `instruction()` already says "a face guessed from a job title is worse than no face, because
    // the narrator will keep it". That rule has a blind spot: it can only be obeyed about people the
    // EXCERPT does not describe. A character whose dossier the player authored in a lorebook, "Slim,
    // toned frame built for speed and precision. Almond-brown eyes, straight brows, sharp
    // cheekbones, pale-gold skin", will still be described in the excerpt, thinly and in passing,
    // and the probe will dutifully re-derive a paler copy of an original it has never been told
    // exists. Then `merge_entity` writes the copy over the record and the panel shows the copy.
    //
    // A link is sanguine knowing which characters those are. Naming them here is the cheapest
    // possible use of that knowledge: the model stops answering a question somebody already
    // answered, and the extraction budget goes to the people nobody has written up.
    //
    // Below the prefix-cache breakpoint with the flag list, and for the same reason, it is a list
    // the player edits by hand, so it must not sit inside the 2,700-token static block.
    const authored = lore.authoredNames().slice(0, 12);
    const canon = authored.length
        ? `Already described elsewhere, ${authored.join(', ')} ${authored.length === 1 ? 'has' : 'have'} an authored `
            + 'description the narrator already receives. Leave "look", "bearing" and "history" EMPTY for them unless '
            + 'this excerpt genuinely changes what is true. Keep reporting "wearing", which changes with the scene. '
        : '';

    // The scene's own words for the room, so presence can actually match.
    //
    // `samePlace` is exact equality on purpose: whether two spellings name one place is the model's
    // reading, never a fold guess from an English word list (see its docblock). That rule is right
    // and it has been failing, because nothing ever told THIS probe what the SCENE probe called the
    // room. Both answers come from the same model in the same pass about the same place.
    //
    // Measured on the live Raccoon City chat: the scene wrote `RPD break room`, the cast rows wrote
    // `break room` and `break room floor`, and `samePlace` correctly said no to all of them, so
    // `here` was EMPTY with nine people standing in the room. The narrator was never told anyone was
    // present, and every feature gated on presence (the person-of-interest detail, the lorebook
    // carry, the panel's Here section) was dead on arrival for want of the letters "RPD ".
    //
    // The fix is not to weaken the comparison, it is to stop asking two probes the same question
    // without telling one what the other said. The model still decides; it is simply told which
    // string it already chose.
    const here = String(at ?? '').trim();
    const room = here
        ? `The scene is at "${here}". When someone is in that place, write "place" as exactly `
            + `"${here}", the same words, so they read as being in the same room. Somewhere else is `
            + 'worded as the narration words it. '
        : '';

    if (!named.length) {
        return `${room}${canon}`;
    }
    // Bounded, and the bound is not defensive tidiness, this string is in the prompt on every
    // pass. A player who flags thirty people has said the flag means nothing, and the first few are
    // still the ones the story is about.
    const shown = named.slice(0, 8);
    return `${room}${canon}People of interest, the player has asked for these characters in full: ${shown.join(', ')}. `
        + 'When the excerpt shows one of them, describe them properly: fill "look", "wearing", "bearing" and "history" '
        + 'with as much as the story has actually established, in the narration\'s own voice. Still never invent, and '
        + 'still report only what is new or changed.';
}

/**
 * Apply a probe fragment.
 * @param {any} fragment The probe's slice of the extraction.
 * @param {object} context Context from the extraction pass.
 * @param {string} [context.windowText] Narrative window, for the mention gate.
 * @param {Set<string>|null} [context.poi] Flagged entity keys, injected by the probe registration
 *   for `render`'s cycle reason, the flag table lives in `state.js`, which imports this module.
 *   A flagged row stores the long appearance form; everybody else keeps the ordinary caps.
 * @returns {{people: number, rejected: object[]}} What was applied.
 */
export function applyExtraction(fragment, { windowText = '', turn: at = turn(), sources = [], poi = null } = {}) {
    const table = load();

    // The anchor mid of this pass, stamped onto every relationship change the fold records
    // (`entity-table.js` `changesBetween`). Newest live source, the same anchor the review's closure
    // events use, so a trail entry and a closure written by one pass point at one message.
    const mid = sources[sources.length - 1]?.mid;

    // Coverage by the model's own report, never a substring proxy ([ROUTER]).
    //
    // The model read the window; `mentions` is its structural answer for what the new excerpt
    // actually names. Fold admits a proposal only when its name (or an alias) is in that set. The
    // mention gate that used to token-match the window text, failing on paraphrase and on any
    // language fold did not spell out, is replaced by membership in this report. The report is
    // also persisted, so the NEXT pass's review hot set and presence questions read it instead of
    // token-matching the window themselves.
    //
    // Members are normalized through the same `normalizeEntityName` the alias keys use, so a
    // report of "the hooded figure" matches the alias key "hooded figure", the article mismatch
    // that otherwise splits one person into two.
    const mentioned = new Set((fragment?.mentions ?? [])
        .map(name => normalizeEntityName(String(name ?? ''))?.key)
        .filter(Boolean));
    noteCoverage('cast', mentioned);

    // Re-promotion by coverage: a cold person the report names comes home.
    //
    // Same rule as the thread table (clocks.js): a person archived by staleness is written back the
    // moment the window mentions them, a WRITE into the tracked state, never a paste
    // ([AC-PRODUCT]), admitted by coverage, not a confidence score ([ROUTER]). The coverage is the
    // model's own `mentions` report, not a substring test of the window.
    const restored = cold.covered(mentioned, cold.ofKind('person'));
    for (const item of restored) {
        if (cold.promote('person', item.key, item.row, table, at)) {
            observe.note('cast:recalled');
        }
    }

    // `kind` LAST and resolved, not spread-over. This line used to end `{ ...entry, kind: PERSON }`,
    // which overwrote whatever the probe answered, so the faction kind, complete on the read side
    // since it was declared, could never be written. `actorKind` checks the answer against
    // `ACTOR_KINDS` and falls back to `PERSON`, so a mis-tagged actor is still an actor.
    const people = foldEntities(
        table,
        (fragment?.people ?? []).map(entry => ({
            ...entry,
            kind: actorKind(entry?.kind),
            // `drive_size` used to be threaded through here, `driveSize` on the row. Nothing is
            // threaded now because nothing is asked: the size is derived from the row by
            // `entity-table.js` `driveOf`, for the reason the retired schema property above records.
            // A sighting that says nothing about an agenda's length stays quiet, exactly as before,
            // the difference is that every sighting says nothing about it now.
        })),
        { windowText, turn: at, mid, mentioned, poi });

    // Admitted, but not by the `name` string as written, a bracketed second writing of it, or a
    // declared alias, is what the report carried. Raised here rather than in `entity-table.js`
    // because that file imports nothing but `lib/hash.js`; `foldEntities` returns the number so the
    // counter can live where every other probe statistic lives. A count that keeps climbing means
    // the probe is still wording `name` and `mentions` differently despite `oneSpelling` asking it
    // not to, and that the structural floor is carrying the campaign on its own.
    for (let n = 0; n < (people.byForm ?? 0); n++) {
        observe.note('covered:by-form');
    }

    // Stale entities demote, they do not vanish.
    //
    // `prune` returns the rows it shed; each is archived to the cold store whole, so a person or
    // lead the story has outrun is preserved for recall rather than destroyed (cold-store.js,
    // [EVICT]: selection cannot bound a store, so eviction is demotion).
    const shed = prune(table, at);
    for (const dropped of shed) {
        // Any ACTOR kind archives to the cast bucket, not just `person`. Keyed off `ACTOR_KINDS`
        // rather than a PERSON comparison, or a shed faction would be filed away as a thread.
        const kind = ACTOR_KINDS.includes(splitEntityKey(dropped.key).kind) ? 'person' : 'thread';
        cold.demote({ kind, key: dropped.key, row: dropped.row, at });
        observe.noteCap(kind === 'person' ? 'cast-archived' : 'threads-archived');
    }
    commit(ENTITIES_PATH, table);

    // Anchored here, recorded once, by the caller.
    //
    // This used to call `observe.noteRejections` itself while `index.js` ALSO passed the same rows
    // to `state.noteRejections`, so every cast refusal was counted twice and logged twice, while
    // `state-table.js`'s refusals counted once, which quietly skewed every cross-rule comparison in
    // the corpus. Neither channel was complete on its own: this one carried the `mid` the log's
    // cause-link needs and never reached `state.rejects`; the caller's reached the table and
    // dropped the `mid`.
    //
    // So the anchor stays here, only this function knows which source the pass ended on, and the
    // recording moves wholly to the caller. `state.noteRejections` spreads the row before adding its
    // own `turn`, so the `mid` survives the trip.
    const anchored = people.rejected.map(rejection => ({
        ...rejection,
        mid: sources[sources.length - 1]?.mid,
        turn: at,
    }));

    return { people: people.accepted, rejected: anchored };
}

/**
 * Cast rows whose names raise the identity question.
 *
 * Data only, in this phase: the pairs are computed and handed to whoever asks, and nothing merges
 * anything. `person␀broker` and `person␀scarred broker` are one man behind one counter and became
 * two rows in a live chat within 48 hours of being hand-fixed (FOLD-REDESIGN.md §0.1); the merge
 * itself waits for the review pass, because "one name containing another is not identity"
 * (`FOLD-RPG-GAP.md` §4) and a wrong merge cannot be undone by silence.
 *
 * @returns {Array<{a: string, b: string, why: string}>} Pairs, by table key.
 */
export function questions() {
    const table = load();
    const people = table_entries(table).filter(([key]) => splitEntityKey(key).kind === PERSON);
    const pairs = identityPairs(people.map(([key, row]) => ({ key, name: row?.name ?? '' })));

    // A contested alias is a stronger signal than a token subset, and it was invisible.
    //
    // `identityPairs` compares NAMES by token containment, so `broker` ⊂ `scarred broker` raises and
    // `Grimble` against `Armorer` never can. But those two both answer to "the dwarf", the model
    // itself put the word on both rows, and `canonicalKey` now refuses to resolve it either way
    // rather than coin-flip. Refusing silently would leave the ambiguity standing forever, so the
    // pair is asked. Measured: three such collisions across the live chats, none of which any
    // name-based test could ever have raised.
    const seen = new Set(pairs.map(pair => `${pair.a}${pair.b}`));
    for (const [alias, keys] of contestedAliases(table, PERSON)) {
        for (let i = 0; i < keys.length; i++) {
            for (let j = i + 1; j < keys.length; j++) {
                const [a, b] = [keys[i], keys[j]].sort();
                if (seen.has(`${a}${b}`)) continue;
                seen.add(`${a}${b}`);
                pairs.push({ a, b, why: `both answer to "${alias}"` });
            }
        }
    }
    return pairs;
}

/**
 * Drop entities nothing has mentioned for long enough that they will never render again.
 *
 * Soft-hiding is the right default while an entity might come back, `entitiesOfKind` already stops
 * rendering at ENTITY_STALE, but a table that only ever grows eventually dominates the metadata
 * blob. Deletion is at double the hide threshold, so anything the panel could still show survives.
 *
 * @param {Map<string, object>} table Entity table, mutated.
 * @param {number} at Current turn.
 */
function prune(table, at) {
    const dropped = [];
    let legacy = 0;
    for (const [key, value] of table_entries(table)) {
        if (at - (value?.turn ?? 0) > ENTITY_STALE * 2) {
            dropped.push({ key, row: value });
            table.delete(key);
            continue;
        }
        // One-time heal for leads written before the exposition gate existed.
        //
        // Asked for "information worth acting on", extraction returned lore: what a holy mark
        // grants, what a brand permits, what someone was told to do and then did. All true, none of
        // them threads. Those chats still hold them.
        //
        // The test is exact rather than heuristic. `foldEntities` now rejects any lead with an
        // empty `open`, so every lead written since carries a non-empty one; a lead without it can
        // only predate the gate. Done here rather than in `entitiesOfKind` deliberately, filtering
        // on read would re-judge records that already passed the gate, so a genuine lead whose
        // `open` the model happened to omit would vanish on every repaint with no way back.
        if (splitEntityKey(key).kind === LEAD && !value?.open) {
            dropped.push({ key, row: value });
            table.delete(key);
            legacy++;
        }
    }
    if (legacy) {
        observe.noteCap('leads-ungated', legacy);
    }
    // ENTITY_STALE decides who the panel forgets. Counted, so the number can be judged.
    if (dropped.length) {
        observe.noteCap('entities-pruned', dropped.length);
    }
    // The rows that lost their slots are RETURNED, not lost: the caller demotes them to the cold
    // store, so a person the story left behind is still there to be recalled the moment they return
    // (cold-store.js, [EVICT]).
    return dropped;
}

/**
 * Render entities into the injected block.
 *
 * `poi` rides through untouched for `marks`/`inv`'s reason: the flag table lives in `state.js`,
 * `state.js` imports this module, and this module reaching back for it would close a cycle. The
 * caller that already holds all three passes all three.
 *
 * @param {object} [options] Options.
 * @param {string} [options.exclude] The point-of-view character's name.
 * @param {string} [options.at] Scene location.
 * @param {Map|null} [options.marks] The marks table.
 * @param {Map|null} [options.inv] The inventory table.
 * @param {Set<string>|null} [options.poi] Flagged entity keys, `state.poiKeys()` as a set. Omitted
 *   means nobody is flagged, which is exactly the block as it read before the flag existed.
 * @returns {string} Lines, or ''.
 */
export function render({ exclude = '', at = '', marks = null, inv = null, poi = null } = {}) {
    return renderEntities(load(), turn(), {
        exclude,
        at,
        hurt: marks ? name => markPhrases(marks, name) : null,
        holds: inv ? name => itemPhrases(inv, name) : null,
        poi,
    });
}

/**
 * Marks parked on cast rows by the migration, as seeds for the fold.
 *
 * The only reader of `row.marks`, and `migrate.js` is the only writer, see `state-table.js`
 * `seedMarks` for why a mark that predates the ledger cannot be an event. Live marks never come
 * from here.
 *
 * @returns {object[]} Seed marks, each carrying the owner's name.
 */
export function markSeeds() {
    const out = [];
    for (const [, row] of table_entries(load())) {
        for (const mark of Array.isArray(row?.marks) ? row.marks : []) {
            out.push({ ...mark, who: mark?.who ?? row?.name ?? '' });
        }
    }
    // The other half: marks a migration had nowhere to put, because the chat has body-state prose
    // and no cast row for whoever it is about. Raccoon City is the measured case, `health:
    // "hangover faded; mild fatigue"` with an empty entity table, since extraction never ran there
    // (`migrate.js` `migrateBody`). They carry `who: ''`, which the fold reads as the pov's.
    for (const mark of loadValue('state.migrated', null)?.marks ?? []) {
        out.push({ ...mark, who: mark?.who ?? '' });
    }
    return out;
}

/**
 * Set or clear a cast row's threat integer.
 *
 * Written whole rather than merged, because 0 is falsy and `merge_entity` reads a falsy field as
 * silence: which is right for an ordinary sighting that simply does not mention danger, and wrong
 * for the review saying a fight is over. `FOLD-REDESIGN.md` §3: an adversary's row is closed by the
 * review, and this is where that lands.
 *
 * @param {string} key The cast row's table key.
 * @param {number} threat The new value; 0 clears it.
 * @param {number} [at] Turn counter.
 * @returns {boolean} True if anything changed.
 */
export function setThreat(key, threat, at = turn()) {
    const table = load();
    const row = lookup(table, key, null);
    if (!row) {
        return false;
    }
    const value = threatOf(threat);
    if ((row.threat ?? 0) === value) {
        return false;
    }
    table.set(key, { ...row, threat: value, turn: at });
    commit(ENTITIES_PATH, table);
    return true;
}

/**
 * Advance an actor's standing agenda, because time passed and somebody used it.
 *
 * Writes the whole record for `setThreat`'s reason: `drive` is a number, and `merge_entity` treats
 * only `''`/null/undefined as silence, so a field-wise write of `0` would be indistinguishable from
 * a sighting that said nothing about it. The full write also stamps `turn`, which is what
 * `worldAsks` orders its queue by, an agenda that just moved goes to the back.
 *
 * Clamped at the size: a drive stops at full and does not wrap. What a FULL drive means is the
 * caller's business, `world.js` records it as an event the narrator has to reckon with, because
 * "the guild finished what it was doing" is a story beat, not a table operation.
 *
 * The size is read exactly as `worldAsks` reads it, and that is not decoration.
 *
 * `worldAsks` poses a line only for a row whose stored `driveSize` is positive, and this function
 * moves the position on that same row. The two reads must be the SAME read or they disagree in the
 * one direction that is silent: the block poses a line, the model answers it, `planWorld` accepts
 * the advance, `world.js` records the chronicle event, and then this function returns null because
 * it disagreed about whether the row had an agenda. `world:ticked` sits at zero and the record holds
 * a summary with no state under it, which is precisely the failure the drive exists to end.
 *
 * The expression is simple on both sides because the size is authored state now. It was briefly a
 * derivation, and this line briefly had to mirror the derivation to stay in step; that whole
 * apparatus went away when the model started judging drives on the world probe
 * (`world-table.js` `nominationAsks`), which is the better reason for two expressions to match,
 * there is only one of them. `tests/sanguine-world-table.test.js` pins the agreement by reading the
 * source, because this module cannot be imported under test.
 *
 * @param {string} key The cast row's key.
 * @param {number} steps How far to advance. Clamped to the row's remaining room.
 * @param {number} [at] The turn.
 * @returns {{filled: number, size: number, full: boolean}|null} The new position, or null if the
 *   row is missing, has no agenda, or did not move.
 */
export function advanceDrive(key, steps, at = turn()) {
    const table = load();
    const row = lookup(table, key, null);
    const size = Number(row?.driveSize) || 0;
    const move = Math.trunc(Number(steps) || 0);
    if (!row || size <= 0 || move <= 0) {
        return null;
    }
    const before = Math.max(0, Number(row.drive) || 0);
    const filled = Math.min(size, before + move);
    if (filled === before) {
        return null;
    }
    table.set(key, { ...row, drive: filled, turn: at });
    commit(ENTITIES_PATH, table);
    return { filled, size, full: filled >= size };
}

/**
 * Record the model's judgement of whether an actor's agenda completes, and how long it is.
 *
 * The write that ends the 288 zeros.
 *
 * `driveSize` was once answered by the entity probe on a sighting, 0 in 288 of 288 traced
 * proposals, because at first contact the question has no answer. It was then derived from the row,
 * which measured no better than chance (28% precision against a 25% baseline). Now it is judged: the
 * world probe poses a shortlisted agenda with its evidence attached and the model answers whether
 * there is a state of the world where the actor stops. This is where that answer lands.
 *
 * Two fields, and both are written on EVERY judgement including a negative one:
 *
 *   · `driveAsked`: the turn the question was answered. Written even when the answer is "this is a
 *     routine", because a negative verdict is a result: without it `needsDriveJudgement` re-poses
 *     the same shopkeeper on every time skip forever and the queue never drains.
 *   · `driveSize`: written only when the agenda completes. A routine keeps whatever it had, which
 *     for every row that reaches here is nothing at all or a legacy zero.
 *
 * Writes the whole record for `setThreat`'s and `advanceDrive`'s reason: these are numbers, and
 * `merge_entity` treats only `''`/null/undefined as silence, so a field-wise write of `0` could not
 * be told apart from a sighting that said nothing. Deliberately does NOT stamp `turn`: unlike an
 * advance, a judgement is fold answering a question about the record rather than the story
 * returning to this person, and bumping the sighting clock would make an actor look freshly seen
 * because a probe thought about them.
 *
 * @param {string} key The cast row's key.
 * @param {object} verdict The judgement.
 * @param {number} verdict.size Steps to completion, or 0 when the agenda is a routine.
 * @param {number} [verdict.at] The turn the judgement was made.
 * @returns {boolean} Whether the row was written.
 */
export function judgeDrive(key, { size = 0, at = turn() } = {}) {
    const table = load();
    const row = lookup(table, key, null);
    if (!row) {
        return false;
    }
    const asked = Math.max(0, Math.trunc(Number(at) || 0));
    const steps = Math.trunc(Number(size) || 0);
    table.set(key, {
        ...row,
        driveAsked: asked,
        // The same clamp `foldEntity` applies, so a judged size and a hand-edited one cannot end up
        // in different ranges. A drive is always a progress track, so only that branch is needed.
        ...(steps > 0 ? { driveSize: Math.max(2, Math.min(MAX_DRIVE, steps)) } : {}),
    });
    commit(ENTITIES_PATH, table);
    return true;
}

/**
 * Move somebody's disposition by one step, because of something that just happened.
 *
 * A social cost has to land on the person, or it did not happen.
 *
 * A verdict against a named person could already cost "someone's trust", in the directive, as
 * prose, for the narrator to write and the next extraction to maybe re-read. That is a cost that
 * evaporates: after twenty verdicts the trust-dings are wallpaper, and nothing in the record ever
 * moved, so the next verdict against the same person starts from the same disposition as the first.
 *
 * Stepping the scale here makes it stick. It is one step, never more, and it is arithmetic over
 * `DISPOSITIONS`, fold's own enum, an index moved by one, so nothing here reads narrative text.
 * WHY it moved is prose and stays the model's job: the trail carries the cause the entity probe
 * records on the next pass.
 *
 * Clamped at both ends: a hostile person cannot become more hostile through a scale that has no
 * word for it, and the ceiling is `devoted`.
 *
 * @param {string} key The cast row's key.
 * @param {number} steps How far to move, positive or negative. Rounded and clamped to ±1.
 * @param {number} [at] The turn.
 * @returns {string} The new disposition, or '' when nothing moved.
 */
export function stepFeels(key, steps, at = turn()) {
    const table = load();
    const row = lookup(table, key, null);
    const move = Math.sign(Number(steps) || 0);
    if (!row || !move || !row.feels) {
        return '';
    }
    const next = DISPOSITIONS[Math.max(0, Math.min(DISPOSITIONS.length - 1, dispositionRank(row.feels) + move))];
    if (next === row.feels) {
        return '';
    }
    table.set(key, { ...row, feels: next, turn: at });
    commit(ENTITIES_PATH, table);
    return next;
}

/**
 * Cast rows that are currently a threat, for the review to close.
 * @returns {Array<{key: string, name: string, threat: number}>} Active adversaries.
 */
export function threats() {
    return table_entries(load())
        .filter(([key, row]) => splitEntityKey(key).kind === PERSON && (row?.threat ?? 0) > 0)
        .map(([key, row]) => ({ key, name: row?.name ?? key, threat: row.threat }));
}

/**
 * Everything the panel needs.
 * @returns {{people: object[], unplaced: object[], elsewhere: object[]}} The lists, freshest first.
 */
export function snapshot({ at = '', pov = '' } = {}) {
    const table = load();
    const now = turn();
    const cast = castAt(table, now, at);
    // Resolved here rather than in the panel, so the panel never has to know that a name and a
    // title can be the same person.
    const self = resolveEntity(table, PERSON, pov)?.key ?? '';
    const notSelf = person => !self || person.key !== self;
    return {
        povKey: self,
        // The current tick, so the panel can tell a change from a restatement.
        turn: now,
        // Split rather than filtered. The people who have walked out are still known, still worth
        // showing, and still where the story left them, they are simply not in the room. Deleting
        // them would lose the one thing that makes a returning character feel remembered.
        people: cast.here.filter(notSelf),
        // Kept as its own list all the way to the renderer. The panel shows them inside Here,
        // dimmed and marked "whereabouts unstated", because merging them into `people` here would
        // be the same collapse `castAt` used to perform one layer down (FOLD-REDESIGN.md §0.1-1).
        unplaced: cast.unplaced.filter(notSelf),
        elsewhere: cast.elsewhere.filter(notSelf),
    };
}

/**
 * Merge two cast rows the review confirmed are one person.
 *
 * The rule and its argument live in `entity-table.js` `mergeEntities`; this is the storage half.
 * Kang existed twice for the whole of the live Solo Leveling chat and could not stop
 * (`FOLD-RPG-GAP.md` §2), and the broker pair reopened within 48 hours of being hand-fixed, both
 * are one confirmed answer away from being one row, and this is where that answer lands.
 *
 * @param {string} a One table key.
 * @param {string} b Another.
 * @returns {{key: string, dropped: string}|null} What survived, or null if nothing merged.
 */
export function merge(a, b) {
    const table = load();
    const done = mergeEntities(table, a, b);
    if (done) {
        commit(ENTITIES_PATH, table);
        // A merge is the one place a cast row's KEY changes, so it is the one place a lorebook link
        // can be orphaned by something other than deletion. Kang and Kang Min-seo were one woman for
        // the whole of the live Solo Leveling chat; the person who finally merged them should not
        // also lose the dossier they had paired to one of the halves.
        lore.rekey(done.dropped, done.key);
    }
    return done;
}

/**
 * Record where an unplaced person actually is.
 *
 * The other half of the three-valued `castAt` (`entity-table.js`): the derivation keeps UNPLACED as
 * a distinct answer all the way to the consumers, the renderers hedge it, and the review resolves
 * it. A place written here is a place the presence predicate can compare, which is the whole reason
 * `place` is its own field rather than prose.
 *
 * @param {string} key The cast row's table key.
 * @param {string} place The place, as the story words it.
 * @param {number} [at] Turn counter.
 * @returns {boolean} True if it was written.
 */
/**
 * Drop a cast row outright, for a hand correction.
 *
 * Not the same as the staleness prune, which demotes to the cold store so somebody the story
 * outran stays recallable. This is the player saying the row is wrong, a person the model
 * invented, or one duplicate of a pair, so it leaves nothing to recall.
 *
 * @param {string} key The cast row's key.
 * @returns {boolean} Whether a row was removed.
 */
/**
 * Set prose columns on a cast row by hand.
 *
 * The sibling of `clocks.set`, "every value fold derives should be correctable in place", for the
 * fields that have no dedicated writer. Field-wise, so an omitted column is silence rather than an
 * erasure, and stamped with the turn so the versioned merge treats it as the newest claim and a
 * later out-of-order sighting cannot quietly undo it.
 *
 * @param {string} key The cast row's key.
 * @param {object} fields Columns to set.
 * @returns {boolean} Whether anything changed.
 */
export function patch(key, fields, { flagged = false } = {}) {
    const table = load();
    const row = lookup(table, key, null);
    if (!row || !fields) {
        return false;
    }
    // The dossier tier is enforced on the hand path too. `foldEntity` clamps what the model
    // proposes; this used to write whatever the row editor's textarea contained, so an unflagged
    // person could carry a long `bearing` the storage tier exists to keep off 48 rows.
    const allowed = clampDossierFields(fields, flagged);
    const patched = {};
    for (const [column, value] of Object.entries(allowed)) {
        if (typeof value === 'string' && value !== row[column]) {
            patched[column] = value;
        }
    }
    if (!Object.keys(patched).length) {
        return false;
    }
    // A hand write records what it replaced, the same shape the model path's `changesBetween`
    // produces, so a hand edit or an undo is visible in the history instead of a value that
    // changed for no visible reason. `mid: -1`, a hand write has no anchor.
    const trail = appendTrail(row.trail, handTrailEntries(row, patched, turn()));
    table.set(key, { ...row, ...patched, trail, turn: turn() });
    commit(ENTITIES_PATH, table);
    return true;
}

export function remove(key) {
    const table = load();
    if (!table.delete(key)) {
        return false;
    }
    commit(ENTITIES_PATH, table);
    return true;
}

export function setPlace(key, place, at = turn()) {
    const table = load();
    const row = lookup(table, key, null);
    const said = String(place ?? '').trim();
    // An answer that repeats what the row already says is not a sighting. Writing it would bump
    // `turn`, which is the staleness clock as well as the merge version, so the review's
    // `[where now?]` was keeping alive exactly the rows it exists to notice have gone quiet.
    // See `placeIsNews`; measured at 85 fires over 88 turns in the Raccoon City cast.
    if (!row || !placeIsNews(row, said)) {
        return false;
    }
    // Through `foldEntity` rather than by assignment, so the write is versioned and merges with a
    // concurrent sighting the way any other observation would. A bare assignment would be the one
    // write in this table that `resolution_max_converges` does not cover.
    return !!foldEntity(table, { ...row, place: said, turn: at }) && (commit(ENTITIES_PATH, table), true);
}

/** Forget everything. */
export function clear() {
    commit(ENTITIES_PATH, new Map());
}
