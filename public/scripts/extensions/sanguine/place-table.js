/**
 * sanguine/place-table.js: the rooms a campaign is played in, as records rather than strings.
 *
 * Pure, and testable without touching storage. `places.js` is the half that owns the table, the
 * same split `entity-table.js`/`entities.js` and `flow-table.js`/`flows.js` already use.
 *
 * What fold had, and what it could not say.
 *
 * fold has always had place NAMES and never a place. An item is keyed by the string it is at
 * (`state-table.js` `itemKey`), a cast row carries `place` (`entity-table.js:784`), a thread
 * carries `where` (`thread-table.js`), the scene carries `location`: four fields holding free
 * text, compared with `samePlace`, which is equality after trim and case-fold and deliberately
 * nothing more (`entity-table.js:346`, and the copy at `thread-table.js:897`).
 *
 * That is enough to ask *is this person in this room* and not enough to say anything about the
 * room. Three things follow, and they are the reason this file exists:
 *
 *   built    a home cannot be built room by room, because there is nowhere to put the second room.
 *            "the farmhouse" and "the farmhouse kitchen" are two unrelated strings, and the only
 *            relation between them that fold could express, `samePlace`, is false.
 *   resolved an item at "the kitchen" and a person at "the farmhouse kitchen" are in different
 *            places, forever, and no amount of narration can join them.
 *   changed  a place cannot CHANGE. A burned-out east wing is a NEW STRING, so every row still
 *            pointing at the old one points at somewhere that no longer exists, and the change
 *            itself, the thing the player did, is recorded nowhere at all.
 *
 * A record fixes the third, which is the one that loses information: the description carries
 * forward under one key, and what it replaced goes on the trail beside it.
 *
 * Nesting is a FIELD, not a tree.
 *
 * A room is a place whose `place` is the house. That is the whole of the containment model: the
 * parent is a place NAME, in the same field shape a cast row already uses, resolved through the
 * same alias machinery and compared with the same `samePlace`. Arbitrary depth falls out of
 * repeated resolution (`ancestorsOf`), so there is no tree structure to keep consistent, no second
 * key space, no schema for a hierarchy, and nothing to migrate when the fiction turns out to have a
 * cellar under the cellar.
 *
 * What a field cannot do by construction is refuse a loop, so `wouldCycle` does it explicitly and
 * `foldPlace` drops the parent, not the sighting, when a proposed one would close one.
 *
 * Resolution fails OPEN, and that is the entire compatibility story.
 *
 * Places are free text today on item keys, cast rows, threads and scene context, and every chat
 * that exists was written that way. `resolvePlace` therefore answers with a record when one exists
 * and `null` when one does not, and `null` means *keep treating this as the string it is*. A chat
 * that never establishes a place record behaves exactly as it does today, because nothing here is
 * ever consulted for an answer it cannot give. This is the same shape `presenceOf` uses when it
 * returns UNPLACED rather than guessing, `the_dispatch_law`
 * (`SelectionDispatch.lean:223`): in the band where the evidence cannot decide, take a third action
 * rather than a default nothing warrants.
 *
 * Keyed in the entity key space, which is why almost none of this file is new.
 *
 * A place row is keyed `entityKey(PLACE, name)`, `place␀farmhouse`, even though this table holds
 * exactly one kind. The prefix costs six bytes a row and buys the identity layer verbatim:
 * `canonicalKey` (alias resolution, one-hop, first-match), `contestedAliases` behind it (an alias
 * two rows answer to decides nothing, and is dropped from both sides) and `resolveEntity` all read
 * `splitEntityKey(key).kind`, and all are correct here with no argument re-made and no judgement
 * copied. `samePlace` is the sibling case `thread-table.js:795` copies rather than imports, and its
 * reason applies in reverse: six lines of equality may be copied, a judgement that took a
 * measurement to tune may not.
 *
 * The one thing that is genuinely new is the trail's field list. `TRAILED` is `feels`/`wants`/
 * `knows`, a relationship's history, and a place has none of those; what a place's history is
 * made of is `facts`, `detail`, `status` and its parent, so `PLACE_TRAILED` names those and
 * `placeChanges` is `changesBetween` over them.
 */

import {
    ENTITY_STALE,
    MAX_DETAIL,
    MAX_DRIVE,
    MAX_NAME,
    RETIRED,
    aliasKeys,
    canonicalKey,
    entityKey,
    merge_entity,
    normalizeEntityName,
    resolveEntity,
    samePlace,
    splitEntityKey,
} from './entity-table.js';
import { insert_with, lookup, table_entries } from './lib/hash.js';
import { windowSnippet } from './diag.js';

/**
 * The kind every row in this table carries.
 *
 * A fourth entity kind in name only: it never reaches `foldEntity`, which refuses anything outside
 * `ACTOR_KINDS` and `LEAD`, and it never shares `state.cast`. It exists so the entity key space's
 * identity functions apply unchanged, see the header.
 */
export const PLACE = 'place';

/**
 * How many places one chat may hold.
 *
 * A serialisation guard on the 128 KiB metadata blob (`store.js` `MAX_FOLD_BYTES`), not a play
 * limit. It stood UNMEASURED while nothing produced a place; the scene probe produces one now, and
 * the trace archive says what the arrival rate is.
 *
 * Measured, on 2064 located passes across 24 chats.
 *
 * Every pass since fold began carried a `location` string, and 95% of them were non-empty. Reduced
 * by `normalizeEntityName`'s key rule (lowercase, leading article dropped), the DISTINCT keys one
 * chat produces run: 202 and 99 (Wuxia), 68 (Raccoon City), 59 (Solo Leveling), 59 and 52 (Time
 * Stop), 45, 40, 37, twelve of the twenty-four chats clear 32, and the largest clears it sixfold.
 *
 * The cap is not the thing to move. Most of that count is phrasing churn on ONE room, "the
 * chamber", "tomb chamber", "burial chamber" are three keys and one place, so a bigger cap buys
 * more copies of the same room rather than more rooms. What the arrival rate does say is that the
 * refusal below cannot be the end of the story: at 32 rows `foldPlace` refuses every new place
 * forever, and `prunePlaces` (below, at `PLACE_STALE`) cannot relieve it. So `places.upsert` answers
 * `PLACES_FULL` by demoting the stalest LEAF to the cold store and folding again, eviction is
 * demotion ([EVICT]), so the room is recallable the moment the story walks back into it.
 *
 * Deliberately far below `MAX_ENTITIES`, and this table is deliberately not `state.cast`. A house
 * described room by room is eight rows; filed among the cast those eight would take a sixth of the
 * 48 entity slots and start evicting people to make room for cupboards. Two kinds of thing under
 * one cap is the v1 mistake `migrate.js` exists to undo (`entities` held people and leads, and the
 * leads are threads now).
 */
export const MAX_PLACES = 32;

/**
 * How many changes one place record remembers.
 *
 * Shorter than `MAX_TRAIL`'s twelve, and the arithmetic is why. A trail entry carries two prose
 * values bounded at `MAX_DETAIL` (120), so a full one serialises to roughly 280 bytes; twelve of
 * them on every one of `MAX_PLACES` rows is ~107 KiB against a 128 KiB blob, which is a worst case
 * that could evict the chronicle on its own. Six halves it, and the pruner in `places.js` sheds
 * trails before it sheds rows for the same reason, a trail is history, and the current
 * description is already on the record.
 *
 * Unmeasured, like the cap above. What would move it is a campaign that actually rebuilds a place
 * more than six times.
 */
export const MAX_PLACE_TRAIL = 6;

/**
 * Fields whose changes the place trail records.
 *
 * The place equivalent of `TRAILED`, and a different list because a place has a different history.
 * `facts` is what is permanently true of it, `detail` is what is true of it now, `status` is
 * whether it still stands, and `place` is what it is inside, the four things that can be revised
 * about somewhere, and the four a player would want the record of.
 */
export const PLACE_TRAILED = ['facts', 'detail', 'status', 'place'];

/**
 * The refusal for a write that would put something inside a place that no longer stands.
 *
 * Named here rather than spelled at each of its three call sites.
 *
 * `places.setParent`, `parts.set` and `edits.addItem`/`moveItemTo` all raise it, and it is one
 * refusal with one explanation, a caller that spelled it differently would open a second entry in
 * the diagnostics log for the same fact. `place-cycle` still gets away with a literal because
 * `foldPlace` is its only producer and nothing outside this file tests for it.
 *
 * Declared in `observe.js` `KNOWN_RULES` (`reject:place-destroyed`), so the gap this docblock used
 * to report is closed.
 */
export const PLACE_DESTROYED = 'place-destroyed';

/**
 * The refusal for a place that cannot fit under `MAX_PLACES`.
 *
 * Named rather than spelled, because `places.upsert` now READS it: the storage half answers a full
 * table by demoting the stalest leaf and folding again, which it can only do if it can tell that
 * particular refusal apart from `unusable-name`. Declared as `reject:places-full`.
 */
export const PLACES_FULL = 'places-full';

/**
 * Statuses that mean a place is finished with.
 *
 * `RETIRED` unchanged plus the two words a place can be finished in that a person cannot. Protocol
 * vocabulary, in the sense RULE 1 allows, fold's own enum, which a later probe will be instructed
 * to emit and which is never matched against narrative. UNMEASURED: no probe writes it yet, so the
 * only writer today is a hand edit.
 *
 * A retired place is not deleted and its children are not orphaned. It stops being summarised as
 * live (`renderPlace`) and nothing else about it changes, a burned farmhouse is still where the
 * cellar is.
 */
export const PLACE_RETIRED = new Set([...RETIRED, 'destroyed', 'ruined']);

/**
 * How long an untouched place survives before `prunePlaces` demotes it.
 *
 * Five times `ENTITY_STALE`, and the multiplier is the point rather than the number. Staleness on a
 * cast row asks "is this person still in the story"; a place is not a sighting, it is a standing
 * fact: a house you built is still yours across a hundred turns in which nobody walks into it, and
 * a place that ages out the way a passer-by does is a home the tracker forgets while you live in
 * it. Biased long on purpose: demotion is recoverable ([EVICT]), forgetting the player's own house
 * is not.
 *
 * Now measured, and the measurement says this clock alone cannot hold the table under `MAX_PLACES`:
 * `prunePlaces` fires at `PLACE_STALE * 2` = 200 turns, and the longest chat in the corpus reached
 * turn 193. Nothing has ever been old enough to demote. That is the right answer for a staleness
 * rule and the wrong one for a cap, which is why the cap has its own relief in `places.upsert`
 * rather than a shorter clock here.
 */
export const PLACE_STALE = ENTITY_STALE * 5;

/** How many children `renderPlace` names before it counts the rest. */
const MAX_NAMED_CHILDREN = 8;

/** How long a mentioned place's one-line gist may run in the injected block. */
const MAX_GIST = 72;

/**
 * Whether the story is finished with a record.
 *
 * The one reading of `PLACE_RETIRED`, so the tree, the injection, the cascade and the unreachability
 * test can never disagree about what "destroyed" means.
 *
 * @param {object} row A place record.
 * @returns {boolean} True when it is retired, ruined or destroyed.
 */
export function isGone(row) {
    return PLACE_RETIRED.has(String(row?.status ?? '').toLowerCase().trim());
}

/**
 * A place's stable table key, from a name as written.
 * @param {string} raw A place name.
 * @returns {string} The table key, or '' when the name is unusable.
 */
export function placeKey(raw) {
    const parsed = normalizeEntityName(raw);
    return parsed ? entityKey(PLACE, parsed.key) : '';
}

/**
 * The record a place string names, if there is one.
 *
 * THE fail-open resolver. Every caller that holds a place string, an item's `at`, a cast row's
 * `place`, a thread's `where`, the scene's `location`: may ask this, and a `null` answer means the
 * string is just a string and must be treated exactly as it is today. Nothing downstream is
 * permitted to read `null` as "nowhere".
 *
 * Alias-aware through `resolveEntity`, so "home", "the farmhouse" and "Solomon's place" reach one
 * record once the record says they do, and reach nothing at all when it does not, rather than
 * guessing from words.
 *
 * @param {Map<string, object>} table The place table.
 * @param {string} said A place, as written anywhere in fold.
 * @returns {{key: string, row: object}|null} The record, or null when none exists.
 */
export function resolvePlace(table, said) {
    const found = resolveEntity(table, PLACE, said);
    return found ? { key: found.key, row: found.entity } : null;
}

/**
 * The key an observation about a place should be written to, following aliases.
 * @param {Map<string, object>} table The place table.
 * @param {string} nameKey A normalised place name.
 * @param {string} [aka] Aliases the observation itself declares.
 * @returns {string} The table key to write.
 */
export function canonicalPlaceKey(table, nameKey, aka = '') {
    return canonicalKey(table, PLACE, nameKey, aka);
}

/**
 * The place a record is inside, resolved.
 * @param {Map<string, object>} table The place table.
 * @param {string} key A table key.
 * @returns {{key: string, row: object}|null} The parent record, or null when it names none, or
 *   names one that has no record, which is the same answer and for the same reason.
 */
export function parentOf(table, key) {
    return resolvePlace(table, lookup(table, key, null)?.place);
}

/**
 * Every place a record is inside, innermost first.
 *
 * The walk that makes depth arbitrary without a tree. Bounded by `MAX_PLACES` and by a seen-set, so
 * a table that already contains a loop, a hand edit, or data written before `wouldCycle`, is
 * walked once and left alone rather than hanging the panel that asked.
 *
 * @param {Map<string, object>} table The place table.
 * @param {string} key A table key.
 * @returns {Array<{key: string, row: object}>} Ancestors, nearest first.
 */
export function ancestorsOf(table, key) {
    const out = [];
    const seen = new Set([key]);
    let row = lookup(table, key, null);
    while (row && out.length < MAX_PLACES) {
        const up = resolvePlace(table, row.place);
        if (!up || seen.has(up.key)) {
            break;
        }
        seen.add(up.key);
        out.push(up);
        row = up.row;
    }
    return out;
}

/**
 * The places directly inside this one, freshest first.
 *
 * Derived by scanning, never stored. A stored child list is a second copy of the parent field, and
 * the two disagree the first time a row is written by anything that does not know to update both,
 * which is the class `presenceOf` exists to avoid on the cast (presence is derived, never stored).
 * The scan is O(n²) over a table capped at 32.
 *
 * @param {Map<string, object>} table The place table.
 * @param {string} key A table key.
 * @returns {Array<{key: string, row: object}>} The children.
 */
export function childrenOf(table, key) {
    const out = [];
    for (const [child, row] of table_entries(table)) {
        if (child === key) {
            continue;
        }
        const up = resolvePlace(table, row?.place);
        if (up && up.key === key) {
            out.push({ key: child, row });
        }
    }
    return out.sort((a, b) => (b.row?.turn ?? 0) - (a.row?.turn ?? 0));
}

/**
 * Every place inside this one, at any depth, nearest first.
 *
 * Breadth-first over `childrenOf`, bounded by `MAX_PLACES` and a seen-set for `ancestorsOf`'s
 * reason: a table that already contains a loop, a hand edit, or data written before `wouldCycle`,
 * is walked once and left alone rather than hanging the caller that asked.
 *
 * @param {Map<string, object>} table The place table.
 * @param {string} key A table key.
 * @returns {Array<{key: string, row: object}>} The descendants.
 */
export function descendantsOf(table, key) {
    const out = [];
    const seen = new Set([key]);
    const queue = [key];
    while (queue.length && out.length < MAX_PLACES) {
        for (const child of childrenOf(table, queue.shift())) {
            if (seen.has(child.key)) {
                continue;
            }
            seen.add(child.key);
            out.push(child);
            queue.push(child.key);
        }
    }
    return out;
}

/**
 * The places nothing contains, the tops of every chain.
 * @param {Map<string, object>} table The place table.
 * @returns {Array<{key: string, row: object}>} The roots.
 */
export function rootsOf(table) {
    return table_entries(table)
        .filter(([, row]) => !resolvePlace(table, row?.place))
        .map(([key, row]) => ({ key, row }));
}

/**
 * Would giving this record that parent put it inside itself?
 *
 * Why the check cannot just walk the stored table.
 *
 * The obvious implementation resolves the proposed parent and walks up from it looking for `key`.
 * That misses the two-row case where the OTHER row's parent does not resolve yet: a stored
 * `house (in the kitchen)` names a place with no record, so the walk stops, and the moment
 * `kitchen (in the house)` is written, the record it was waiting for exists and the loop closes
 * behind the check. So the walk resolves parent names against the row being written as well as
 * against the table, including the aliases that write declares. The pending row is the only thing
 * the table does not yet know, and it is exactly the thing the loop needs.
 *
 * A loop that does NOT pass through `key` is somebody else's, pre-existing data, or a hand edit,
 * and this returns false for it. Refusing an unrelated write because the table is already damaged
 * would spread the damage.
 *
 * @param {Map<string, object>} table The place table.
 * @param {string} key The record's table key.
 * @param {string} said The proposed parent, as written.
 * @param {string} [aka] Aliases the same write declares.
 * @returns {boolean} True when the parent must be refused.
 */
export function wouldCycle(table, key, said, aka = '') {
    const mine = new Set(aliasKeys({ name: splitEntityKey(key).name, aka }));
    /**
     * Resolve one parent string, counting the row being written even though it is not stored yet.
     * @param {string} text A parent name.
     * @returns {{key: string, row: object|null}|null} The record it names.
     */
    const step = (text) => {
        const parsed = normalizeEntityName(text);
        if (!parsed) {
            return null;
        }
        if (mine.has(parsed.key)) {
            return { key, row: null };
        }
        return resolvePlace(table, text);
    };

    const seen = new Set();
    let at = step(said);
    while (at && seen.size <= MAX_PLACES) {
        if (at.key === key) {
            return true;
        }
        if (seen.has(at.key)) {
            return false;
        }
        seen.add(at.key);
        at = step(at.row?.place);
    }
    return false;
}

/**
 * The trail entries one write adds: every tracked field it actually changed.
 *
 * `changesBetween` (`entity-table.js:564`) over `PLACE_TRAILED` instead of `TRAILED`. Same law: an
 * empty incoming value is silence and cannot be a change, and an empty `from` IS worth recording,
 * because the first time anybody says what a place is made of there was nothing there before.
 *
 * Sameness is `samePlace` for every field rather than `===` for three of them. It is equality after
 * trim and case-fold, which is what fold already means by "the same place"; applied to prose it
 * says a restatement in different casing is not news, which is the same rule `placeIsNews` states
 * for the cast, an unchanged answer is silence wearing a value.
 *
 * @param {object} earlier The older record.
 * @param {object} newer The fresher record.
 * @returns {Array<{field: string, from: string, to: string, turn: number, mid: number}>} Entries.
 */
export function placeChanges(earlier, newer) {
    const out = [];
    for (const field of PLACE_TRAILED) {
        const to = String(newer?.[field] ?? '').trim();
        const from = String(earlier?.[field] ?? '').trim();
        if (!to || samePlace(to, from)) {
            continue;
        }
        out.push({
            field,
            from,
            to,
            turn: Number(newer?.turn) || 0,
            // The pass's anchor mid, so a later tab can scroll to the message that caused it. `-1`
            // means the write had no anchor, a hand edit, or a migration.
            mid: Number.isFinite(newer?.mid) ? newer.mid : -1,
        });
    }
    return out;
}

/**
 * Field-wise merge for a place, with the place trail appended.
 *
 * `merge_entity` does all of the work that is not the trail, and does it unchanged: silence
 * semantics (`''`/null/undefined is not a retraction), the `turn` version that makes late-arriving
 * writes order-independent (`resolution_max_converges`), `first` under `min`, and the Set-face
 * `aka` accumulation that is what makes "home" and "the farmhouse" survive as one record. All four
 * are correct for a place for the reasons they were correct for a person, so none of them is
 * restated here.
 *
 * The trail is recomputed rather than inherited, because `merge_entity`'s own trail pass is over
 * `TRAILED` and a place has no `feels`: it contributes nothing and this supplies the entries.
 * Recorded only when the FRESHER record is the incoming one, exactly as `merge_entity` does: a
 * write from an earlier turn is news from the past, not a change.
 *
 * @param {object} nu Incoming record.
 * @param {object} old Existing record.
 * @returns {object} Merged record.
 */
export const merge_place = (nu, old) => {
    const merged = merge_entity(nu, old);
    if (!old) {
        return merged;
    }
    const older = (nu?.turn ?? 0) < (old?.turn ?? 0);
    const [newer, earlier] = older ? [old, nu] : [nu, old];
    const trail = [...(earlier?.trail ?? []), ...(newer === nu ? placeChanges(earlier, newer) : [])];
    if (trail.length) {
        merged.trail = trail.slice(-MAX_PLACE_TRAIL);
    }
    return merged;
};

/**
 * Fold one observed place into a table.
 *
 * A cycle refuses the PARENT, never the sighting.
 *
 * The observation that would close a loop still carries everything else it said, that the east
 * wing is rubble, that the cellar floods. Dropping the whole write to punish one field would lose
 * true statements to protect a structural invariant, so the parent is simply not written and the
 * caller is told. Omission is already how this record says nothing: `merge_entity` reads an absent
 * field as silence, so the parent the record already had stands.
 *
 * Numeric fields are omitted-when-absent for the same reason and the trap is the same one
 * `foldEntity` documents at `entity-table.js:797-811`: `merge_entity` treats `''`, null and
 * undefined as silence, and `0` is none of those, a write that merely renames a room would
 * otherwise reset its standing agenda to nothing.
 *
 * @param {Map<string, object>} table The place table, mutated.
 * @param {object} observed The observation.
 * @param {string} observed.name The place, as the story words it.
 * @param {string} [observed.aka] Other names it answers to.
 * @param {string} [observed.facts] Standing truths, two storeys, north-facing, always cold.
 * @param {string} [observed.detail] What is true of it now, the east wing is rubble.
 * @param {string} [observed.place] The place this one is inside.
 * @param {string} [observed.status] A `PLACE_RETIRED`-shaped term, or any word the writer used.
 * @param {string} [observed.source] Where it was learned.
 * @param {number} [observed.turn] Turn counter, the merge version and the staleness clock.
 * @param {number} [observed.mid] Anchor mid of the pass, for the trail's cause-link.
 * @param {number} [observed.drive] How far a standing off-screen change has come.
 * @param {number} [observed.driveSize] How far it goes; 0 means the place has no such change.
 * @returns {{key: string, reason: string}} The key written (or '' when nothing was), and the reason
 *   something was refused (or '' when nothing was). A key AND a reason is the cycle case.
 */
export function foldPlace(table, { name, aka = '', facts = '', detail = '', place = '', status = '',
    source = '', turn = 0, mid, drive, driveSize } = {}) {
    const parsed = normalizeEntityName(name);
    if (!parsed) {
        return { key: '', reason: 'unusable-name' };
    }

    // Follow aliases before writing, so "home" lands on the record "the farmhouse" already occupies.
    const key = canonicalPlaceKey(table, parsed.key, aka);
    if (!table.has(key) && table.size >= MAX_PLACES) {
        return { key: '', reason: PLACES_FULL };
    }

    const said = String(place ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
    const cycles = !!said && wouldCycle(table, key, said, aka);

    const record = {
        name: parsed.display,
        // The turn this first appeared. Merged under `min` by `merge_entity`; a place does not
        // become newly-discovered by being walked into again.
        first: turn,
        aka: String(aka ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL),
        // Standing truths that never age, in the sense `entity-table.js:825-833` means: a fact with
        // no `t` to be judged stale against. A two-storey farmhouse has two storeys in every scene.
        facts: String(facts ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL),
        // What is true of it NOW, and the field the whole record was worth building for: the east
        // wing burns down and the description carries forward under the same key.
        detail: String(detail ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL),
        // The parent. Omitted entirely when it would close a loop, see the docblock.
        ...(cycles ? {} : { place: said }),
        status: String(status ?? '').toLowerCase().trim(),
        // Omitted-when-absent, never defaulted. See the docblock, and `entity-table.js:808-811`.
        ...(Number.isFinite(driveSize)
            ? { driveSize: driveSize <= 0 ? 0 : Math.max(2, Math.min(MAX_DRIVE, Math.round(driveSize))) }
            : {}),
        ...(Number.isFinite(drive) ? { drive: Math.max(0, Math.min(MAX_DRIVE, Math.trunc(drive))) } : {}),
        ...(Number.isFinite(mid) ? { mid } : {}),
        source: String(source ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL),
        turn,
    };

    // The trail's opening entry, seeded here for `foldEntity`'s reason: `insert_with` never calls
    // the merge on a key it has not seen, so `merge_place` cannot see the first write.
    const opening = table.has(key) ? [] : placeChanges({}, record);
    insert_with(table, merge_place, key, opening.length ? { ...record, trail: opening } : record);

    // The cascade rides the ordinary write, so every writer gets it.
    //
    // A probe that reports "the farmhouse is destroyed" must take the rooms with it, and the probe
    // does not know there are rooms. Read back the STORED status rather than the proposed one: the
    // merge is versioned by turn, so a write arriving out of order may not be the one that decides,
    // and cascading the losing claim would retire a house the table says still stands.
    const cascaded = cascadeRetirement(table, key, { status: lookup(table, key, null)?.status, turn, mid });

    return { key, reason: cycles ? 'place-cycle' : '', ...(cascaded.length ? { cascaded } : {}) };
}

/**
 * Retire everything inside a place that has just been retired.
 *
 * Cascade, and NEVER delete.
 *
 * Burn the farmhouse and the kitchen is still in it. The record has to say so, because everything
 * downstream reads status: `renderPlace` stops listing a retired child as something the parent
 * contains, `unreachableBy` seals the items stored there, and the tree dims it. Leaving the rooms
 * `status: ''` would leave fold asserting a lit stove inside a building that no longer exists.
 *
 * Deletion is the sin this codebase avoids and it would be worse here than usual: the trail is the
 * only surface on which a destruction is legible afterwards, and deleting the row deletes the trail
 * with it. So every touched record keeps its name, its facts, its parent, its contents and its
 * history, and gains one more trail entry saying what it became and which message said so.
 *
 * Idempotent: a record already carrying the status is skipped, so re-reading the same window does
 * not stack six identical trail entries against `MAX_PLACE_TRAIL`.
 *
 * Destruction cascades; REPAIR does not, and the asymmetry is deliberate.
 *
 * Burning the house makes the kitchen burned, because containment makes it true. Rebuilding the
 * shell says nothing whatsoever about whether the cellar under it was dug out again, and propagating
 * a revival would be fold inventing work nobody narrated. So a place comes back one record at a
 * time: the extractor writes any status that is not a retirement word ("rebuilt", "reopened"), or
 * `places.patch` clears it outright, which is the hand path, and the only one that can write an
 * empty field, because `merge_entity` reads `''` as silence everywhere else.
 *
 * Written whole rather than through `merge_place`, for `places.setParent`'s reason, the write has
 * to be able to name a value the field-wise merge would read as silence, and the trail is appended
 * here for `foldPlace`'s reason: `insert_with` only calls the merge on a collision, and this is not
 * one.
 *
 * @param {Map<string, object>} table The place table, mutated.
 * @param {string} key The record that was retired.
 * @param {object} [options] Options.
 * @param {string} [options.status] The word to carry down; the parent's own by default.
 * @param {number} [options.turn] Turn counter, the merge version and the trail's stamp.
 * @param {number} [options.mid] Anchor mid, for the trail's cause-link.
 * @returns {string[]} The keys that changed.
 */
export function cascadeRetirement(table, key, { status = '', turn = 0, mid } = {}) {
    const said = String(status || lookup(table, key, null)?.status || '').toLowerCase().trim();
    if (!said || !PLACE_RETIRED.has(said)) {
        return [];
    }
    const changed = [];
    for (const child of descendantsOf(table, key)) {
        if (samePlace(String(child.row?.status ?? ''), said)) {
            continue;
        }
        const next = {
            ...child.row,
            status: said,
            turn,
            ...(Number.isFinite(mid) ? { mid } : {}),
        };
        const trail = [...(child.row?.trail ?? []), ...placeChanges(child.row, next)];
        table.set(child.key, trail.length ? { ...next, trail: trail.slice(-MAX_PLACE_TRAIL) } : next);
        changed.push(child.key);
    }
    return changed;
}

/**
 * Retire a place and everything in it.
 *
 * The direct writer, for a hand edit and for the panel. The extraction path does not need it:
 * `foldPlace` cascades on its own whenever a write lands a retiring status, so a probe that reports
 * "the farmhouse is destroyed" takes the rooms with it without anything else having to know.
 *
 * @param {Map<string, object>} table The place table, mutated.
 * @param {string} key The record to retire.
 * @param {object} [options] Options.
 * @param {string} [options.status] The word to use. `destroyed` when nothing is given.
 * @param {number} [options.turn] Turn counter.
 * @param {number} [options.mid] Anchor mid, for the trail's cause-link.
 * @returns {{changed: string[], reason: string}} What changed, and why nothing did.
 */
export function destroyPlace(table, key, { status = 'destroyed', turn = 0, mid } = {}) {
    const row = lookup(table, key, null);
    if (!row) {
        return { changed: [], reason: 'unusable-name' };
    }
    const said = String(status ?? '').toLowerCase().trim() || 'destroyed';
    if (!PLACE_RETIRED.has(said)) {
        return { changed: [], reason: 'unusable-name' };
    }
    const changed = [];
    if (!samePlace(String(row.status ?? ''), said)) {
        const next = { ...row, status: said, turn, ...(Number.isFinite(mid) ? { mid } : {}) };
        const trail = [...(row.trail ?? []), ...placeChanges(row, next)];
        table.set(key, trail.length ? { ...next, trail: trail.slice(-MAX_PLACE_TRAIL) } : next);
        changed.push(key);
    }
    return { changed: [...changed, ...cascadeRetirement(table, key, { status: said, turn, mid })], reason: '' };
}

/**
 * The destroyed place a string is inside, if any.
 *
 * Unreachable, not gone.
 *
 * An item's `at` is a free-text place. When that place, or anything containing it, has been
 * retired, the item is not deleted and its quantity does not change: it is UNREACHABLE, which is a
 * word this codebase already uses for exactly this idea (`entities.js:192`, the presence enum:
 * present / remote / unreachable / gone). The row renders, dimmed, with the reason attached.
 *
 * The alternative was measured and is the largest silent intervention fold ever made. `isFresh` hid
 * carried items from the narrator on a staleness clock and counted itself doing it: `cap:stale-hidden`
 * read 198 in the live Solo Leveling chat and **540 in Raccoon City**, and the things it hid, a
 * knife, an E-rank licence, a hunter pamphlet, were all real and all in the character's pockets
 * (`state-table.js`, the retirement note). Hiding a held thing is never acceptable; saying why it
 * cannot be got at is.
 *
 * FAILS OPEN, like every other reader of this table: a place string with no record answers `null`,
 * which means the string is just a string and behaves exactly as it does today. Every chat that
 * exists is in that state.
 *
 * @param {Map<string, object>} table The place table.
 * @param {string} said A place, as written on an item, a cast row or a thread.
 * @returns {{key: string, row: object}|null} The retired record that seals it, or null.
 */
export function unreachableBy(table, said) {
    const found = resolvePlace(table, said);
    if (!found) {
        return null;
    }
    if (isGone(found.row)) {
        return found;
    }
    for (const up of ancestorsOf(table, found.key)) {
        if (isGone(up.row)) {
            return up;
        }
    }
    return null;
}

/**
 * The destroyed place a RECORD is inside, not counting itself.
 *
 * The refusal `unreachableBy` cannot be: a change to the destroyed record itself must stay legal, or
 * a burned house could never be rebuilt and the status would be a one-way door. What is refused is a
 * change to something INSIDE it, repainting a kitchen in a house that burned down is a claim the
 * record already contradicts.
 *
 * @param {Map<string, object>} table The place table.
 * @param {string} key A table key.
 * @returns {{key: string, row: object}|null} The retired ancestor, or null.
 */
export function sealedBy(table, key) {
    for (const up of ancestorsOf(table, key)) {
        if (isGone(up.row)) {
            return up;
        }
    }
    return null;
}

/**
 * Is one place inside another, or the same one?
 *
 * Containment, resolved, the question `samePlace` cannot answer and the reason the record exists.
 * A person in the kitchen IS in the farmhouse; the two strings are not equal and never will be.
 *
 * Asymmetric on purpose: the farmhouse is not in the kitchen. Callers that want the symmetric
 * question are asking about identity, and `samePlace` plus record identity already answers it.
 *
 * @param {Map<string, object>} table The place table.
 * @param {string} inner The place to test.
 * @param {string} outer The place that might contain it.
 * @returns {boolean} True when `inner` is `outer` or is somewhere inside it.
 */
export function withinPlace(table, inner, outer) {
    if (samePlace(inner, outer)) {
        return true;
    }
    const here = resolvePlace(table, inner);
    const there = resolvePlace(table, outer);
    // Fail open: with no record on either side the strings were the whole of the evidence, and they
    // disagreed. This may never invent a containment the table does not record.
    if (!here || !there) {
        return false;
    }
    return here.key === there.key || ancestorsOf(table, here.key).some(up => up.key === there.key);
}

/**
 * Two place strings that name one record, or one string.
 *
 * The fail-open upgrade of `samePlace` (`entity-table.js:346`) for every caller that holds a place
 * and wants to know whether it is the same place as another: an item's `at`, a cast row's `place`, a
 * thread's `where`, the scene's `location`. Equality first, so a chat with no place records behaves
 * byte-identically to today; record identity second, so "home" and "the farmhouse" finally agree
 * once something has said they are the same building.
 *
 * @param {Map<string, object>} table The place table.
 * @param {string} a One place, as written.
 * @param {string} b Another.
 * @returns {boolean} Whether they name the same place.
 */
export function samePlaceResolved(table, a, b) {
    if (samePlace(a, b)) {
        return true;
    }
    const left = resolvePlace(table, a);
    const right = resolvePlace(table, b);
    return !!left && !!right && left.key === right.key;
}

/**
 * One line about somewhere the story merely mentioned.
 *
 * The far tier of the injection: a name and the single most current thing known about it. What is
 * true NOW beats what is permanently true, because a mentioned place is being mentioned for a
 * reason and "the bridge is out" is the reason far more often than "stone, two spans" is.
 *
 * @param {object} row A place record.
 * @returns {string} `name, gist`, or just the name.
 */
export function placeGist(row) {
    const said = String(row?.detail || row?.status || row?.facts || '').trim().slice(0, MAX_GIST);
    return said ? `${row?.name ?? ''}, ${said}` : String(row?.name ?? '');
}

/**
 * The places, tiered by proximity, for the injected block.
 *
 * Why a tier and not a list.
 *
 * `renderPlace` is a full description: standing truths, current state, status and every live child.
 * Eight of those is most of a prompt's state budget spent on scenery, and `renderState`'s own
 * docblock is explicit that what the narrator reads is what every live chat has been written
 * against. So proximity decides the resolution:
 *
 *   here       the place the scene says you are in, in full, with its rooms named. This is the one
 *              the narrator is about to write, and the one where a room that exists NOW and a room
 *              that burned last turn have to be told apart.
 *   elsewhere  everywhere else the pass touched: a name and one line. Enough to keep a name stable
 *              and a stake alive; not enough to spend the budget on somewhere nobody is.
 *
 * A retired place still renders, `renderPlace` says its status out loud, because rows still point
 * at it and a burned farmhouse is still where the cellar is.
 *
 * @param {Map<string, object>} table The place table.
 * @param {object} [options] Options.
 * @param {string} [options.here] The scene's own location, as written.
 * @param {Iterable<string>} [options.mentioned] Other places this pass touched, as written.
 * @returns {string} Up to two lines, or '' when nothing resolves.
 */
export function renderPlaces(table, { here = '', mentioned = [] } = {}) {
    const lines = [];
    const said = new Set();

    const at = resolvePlace(table, here);
    if (at) {
        lines.push(`Here: ${renderPlace(table, at.key)}`);
        said.add(at.key);
        // The children are already inside that line, and the ancestors are its `in …` clause. Naming
        // either again under Elsewhere would spend the budget restating the line above it.
        for (const near of [...ancestorsOf(table, at.key), ...childrenOf(table, at.key)]) {
            said.add(near.key);
        }
    }

    const far = [];
    for (const name of mentioned ?? []) {
        const found = resolvePlace(table, name);
        if (!found || said.has(found.key)) {
            continue;
        }
        said.add(found.key);
        far.push(placeGist(found.row));
    }
    if (far.length) {
        lines.push(`Elsewhere: ${far.join(' · ')}`);
    }
    return lines.join('\n');
}

/**
 * Fold a batch of observed places.
 *
 * @param {Map<string, object>} table The place table, mutated.
 * @param {object[]} observations Proposed places.
 * @param {object} [options] Options.
 * @param {number} [options.turn] Turn counter.
 * @param {string} [options.windowText] Narrative window, for the diagnostics record.
 * @returns {{accepted: number, rejected: object[]}} What happened.
 */
export function foldPlaces(table, observations, { turn = 0, windowText = '' } = {}) {
    const rejected = [];
    let accepted = 0;
    const snippet = windowSnippet(windowText);

    for (const observed of Array.isArray(observations) ? observations : []) {
        const outcome = foldPlace(table, { ...observed, turn });
        if (outcome.key) {
            accepted++;
        }
        if (outcome.reason) {
            rejected.push({
                item: String(observed?.name ?? ''),
                reason: outcome.reason,
                raw: observed,
                snippet,
            });
        }
    }

    return { accepted, rejected };
}

/**
 * Drop places nothing has touched for long enough that they have left the story.
 *
 * A place with children is never dropped.
 *
 * The cellar's record says it is inside the farmhouse. Drop the farmhouse and the cellar is still a
 * record, still says "in the farmhouse", and now says it about nothing, `resolvePlace` returns
 * null and the cellar silently becomes a root. That is a change to what the cellar IS, made by a
 * staleness clock that was never asked about it, and the parent is the row LEAST likely to be
 * mentioned: nobody says "the farmhouse" while they are in the kitchen of it.
 *
 * So containment pins a record. What ages out is a leaf the story has finished with.
 *
 * @param {Map<string, object>} table The place table, mutated.
 * @param {number} at Current turn.
 * @returns {Array<{key: string, row: object}>} The rows shed, for the caller to demote whole.
 */
export function prunePlaces(table, at = 0) {
    const dropped = [];
    for (const [key, row] of table_entries(table)) {
        if (at - (Number(row?.turn) || 0) <= PLACE_STALE * 2) {
            continue;
        }
        if (childrenOf(table, key).length) {
            continue;
        }
        dropped.push({ key, row });
        table.delete(key);
    }
    return dropped;
}

/**
 * A place's description: what it permanently is, what it currently is, and what is in it.
 *
 * Deliberately the same shape `renderEntities` uses for a person, `name (a, b, c)`, because the
 * two end up beside each other in whatever reads them, and one shape is one thing for a model to
 * parse. The children summary is what a nested place has that a flat string never did: "the
 * farmhouse (two storeys; the east wing is rubble; contains the kitchen, the cellar)" is the room
 * count that used to live in prose somebody had to re-read.
 *
 * Retired children are left out, a burned barn is not something the farmhouse contains, while a
 * retired PLACE still renders, with its status said out loud. The record surviving its own
 * destruction is the point: rows still point at it.
 *
 * @param {Map<string, object>} table The place table.
 * @param {string} key A table key.
 * @returns {string} One line, or '' when there is no such record.
 */
export function renderPlace(table, key) {
    const row = lookup(table, key, null);
    if (!row) {
        return '';
    }
    const live = childrenOf(table, key).filter(child => !isGone(child.row));
    const named = live.slice(0, MAX_NAMED_CHILDREN).map(child => child.row?.name).filter(Boolean);
    const rest = live.length - named.length;
    const said = [
        row.place ? `in ${row.place}` : '',
        row.facts,
        row.detail,
        row.status,
        named.length ? `contains ${named.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}` : '',
    ].filter(Boolean).join('; ');
    return said ? `${row.name} (${said})` : String(row.name ?? '');
}
