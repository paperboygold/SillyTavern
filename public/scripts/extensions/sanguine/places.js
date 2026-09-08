/**
 * sanguine/places.js: where the places live, and everything that writes one.
 *
 * The storage half of `place-table.js`, mirroring `entities.js` and `flows.js`: the pure module
 * owns the law, this owns the table, the commits and the archive.
 *
 * Its own table, and the reason is arithmetic.
 *
 * `state.places`, never `state.cast`. `MAX_ENTITIES` is 48 and a home described room by room is
 * eight rows, so filing places among the cast would spend a sixth of the cast on cupboards and then
 * start evicting people to fit more of them. Two kinds of thing under one cap is the exact v1 shape
 * `migrate.js` exists to undo, `state.entities` held people and leads, and half of it turned out to
 * be threads.
 *
 * What reaches the prompt, and by exactly one path.
 *
 * Wave 1 shipped this file with nothing in it reaching the narrator. §7.3 changes that, and the
 * shape of the change is the important part: `renderState` (`state-table.js`) takes the place TABLE
 * and renders the tiers itself, so there is ONE definition of what the narrator is told about where
 * it is standing. This file deliberately does not carry a second `render()` beside it, two ways to
 * spell the injection is two chances for the panel and the prompt to describe the same house
 * differently, which is the class `itemHead` exists to close.
 *
 * The injection is empty by construction until a chat has a place record, which is every chat on
 * disk: `renderPlaces` answers '' when nothing resolves, and `renderState` pushes no line for ''.
 * Measured on the two live campaigns, `renderState`'s output is byte-identical with and without the
 * table passed.
 *
 * Why these are stored rather than derived.
 *
 * `entities.js` answers this for the cast and the answer transfers exactly: "the farmhouse has two
 * storeys" is not the RESULT of anything that happened, it is a standing fact about the world that
 * a turn happened to reveal. Folding it would mean inventing an event whose only content is that
 * something was mentioned. The cost is the same and is named the same: this table is not
 * branch-aware, so swiping away the turn that established the cellar leaves the cellar.
 */

import { turn } from './entities.js';
import { lookup, table_entries } from './lib/hash.js';
import {
    MAX_PLACES,
    MAX_PLACE_TRAIL,
    PLACE,
    PLACES_FULL,
    PLACE_DESTROYED,
    ancestorsOf,
    cascadeRetirement,
    childrenOf,
    destroyPlace,
    foldPlace,
    isGone,
    placeKey,
    prunePlaces,
    renderPlace,
    resolvePlace,
    rootsOf,
    sealedBy,
    unreachableBy,
    withinPlace,
    wouldCycle,
} from './place-table.js';
import * as cold from './cold-store.js';
import * as observe from './observe.js';
import { PRUNE_ARCHIVE, commit, commitValue, loadTable, loadValue, registerPruner } from './store.js';

/** Where the places live. */
const PLACES_PATH = 'state.places';

/**
 * The key of the place the scene is standing in.
 *
 * Why a stored key and not the scene's `location` string.
 *
 * `state.sceneLocation()` is the probe's DISPLAY string, and half of them are compound: measured
 * over 964 distinct location strings in the trace archive, 463 (48%) carry a containment marker,
 * `RPD break room`, `Nine-Tails Inn, common room`, `ramyeon shop in Sanggye-dong`. `resolvePlace`
 * cannot find the `break room` record from `RPD break room` and must not try: guessing a record from
 * a substring is the prose-matching this codebase refuses everywhere else.
 *
 * The scene probe now answers the innermost place BARE in its own field, so the key is known exactly
 * at the moment it is written, and the one place it can be known is here. Everything that wants "the
 * place the scene is in", the panel's Location section, the injected tier, reads `here()` instead
 * of re-deriving it from prose.
 */
const HERE_PATH = 'state.placeHere';

/** The cold-store domain places demote into, kept apart from 'person' and 'thread'. */
const COLD_KIND = 'place';

/** The place table as stored. @returns {Map<string, object>} The table. */
export function load() {
    return loadTable(PLACES_PATH);
}

/**
 * The record a place string names, if there is one.
 *
 * The app-facing fail-open resolver, and the only thing any other module should need. `null` means
 * no record exists and the caller must go on treating the string as the string it is, which is
 * what every chat written before this table existed does, and what it must keep doing.
 *
 * @param {string} said A place, as written.
 * @returns {{key: string, row: object}|null} The record, or null.
 */
export function resolve(said) {
    return resolvePlace(load(), said);
}

/**
 * A place's rendered description, from its own fields and its live children.
 * @param {string} key The table key.
 * @returns {string} One line, or ''.
 */
export function describe(key) {
    return renderPlace(load(), key);
}

/**
 * The destroyed place a free-text place string is sealed inside, if any.
 *
 * THE unreachability question, asked by everything that holds a place: an item's `at`, a cast row's
 * `place`, a thread's `where`. `null` means reachable, which is what a string with no record always
 * answers, and therefore what every row in every existing chat answers.
 *
 * @param {string} said A place, as written.
 * @returns {{key: string, row: object}|null} The retired record, or null.
 */
export function unreachable(said) {
    return unreachableBy(load(), said);
}

/**
 * The destroyed place a RECORD is inside, not counting itself.
 *
 * The refusal half: a change to something inside a destroyed place contradicts the record, while a
 * change to the destroyed place itself is how it gets rebuilt.
 *
 * @param {string} key A table key.
 * @returns {{key: string, row: object}|null} The retired ancestor, or null.
 */
export function sealed(key) {
    return sealedBy(load(), key);
}

/**
 * Is one place inside another, or the same one? Fail-open containment.
 * @param {string} inner The place to test, as written.
 * @param {string} outer The place that might contain it, as written.
 * @returns {boolean} Whether `inner` is at or inside `outer`.
 */
export function within(inner, outer) {
    return withinPlace(load(), inner, outer);
}

/**
 * Free one slot under `MAX_PLACES`, by demotion rather than by deletion.
 *
 * Why the cap needs relief at all.
 *
 * `foldPlace` answers a full table with `PLACES_FULL` and writes nothing, which was correct while
 * the only writer was a hand edit: a player who has typed 32 rooms can delete one. It is not correct
 * with a probe behind it. Measured over the trace archive, twelve of twenty-four chats produce more
 * than 32 distinct place keys and the largest produces 202, and `prunePlaces` cannot relieve any of
 * it: it fires at 200 turns and the longest chat ever reached 193 (`place-table.js` `PLACE_STALE`).
 * Without this the table would fill early and then refuse every place the campaign ever moved to.
 *
 * A LEAF, stalest first, for `prunePlaces`' reason restated: dropping a parent silently changes what
 * its children are, and the parent is the row least likely to be mentioned, nobody says "the
 * farmhouse" while standing in the kitchen of it. When every row is a parent this makes no room and
 * says so, and the refusal stands rather than becoming a cascade of orphans.
 *
 * Demotion, never deletion ([EVICT]): the row goes to the cold store whole, and `upsert` below asks
 * for it back by name on the way in, so walking into the room again restores its facts instead of
 * opening a second blank record for it.
 *
 * @param {Map<string, object>} table The place table, mutated.
 * @param {number} at Turn counter.
 * @param {string} [keep] A key that must survive, the row the caller is in the middle of writing.
 *   Its `turn` is still the OLD one at this point, so without this a place being walked back into
 *   after a long absence could be evicted to make room for its own parent.
 * @returns {boolean} Whether a slot was freed.
 */
function makeRoom(table, at, keep = '') {
    const [stalest] = table_entries(table)
        .filter(([key]) => key !== keep && !childrenOf(table, key).length)
        .sort((a, b) => (Number(a[1]?.turn) || 0) - (Number(b[1]?.turn) || 0));
    if (!stalest) {
        return false;
    }
    const [key, row] = stalest;
    cold.demote({ kind: COLD_KIND, key, row, at });
    table.delete(key);
    observe.noteCap('places-archived', 1);
    return true;
}

/**
 * Bring one cold place home before a write lands on a blank row beside it.
 *
 * The cast does this, `entities.applyExtraction` recalls before folding, and the reason carries:
 * without it, `makeRoom`'s demotion is a delete with extra steps, because the next mention opens a
 * fresh record and the facts the campaign established are stranded in the cold store forever.
 *
 * Coverage, never a substring scan ([ROUTER]): `cold.covered` matches the row's own `name`/`aka`
 * against names the MODEL wrote this pass. Both the raw name and its key form are offered, because
 * the cold row was stored under whichever article the story used that day and "the study" and
 * "study" are one place.
 *
 * @param {Map<string, object>} table The place table, mutated.
 * @param {string[]} names Place names the observation itself used.
 * @param {number} at Turn counter.
 * @param {string} [keep] The key the caller is about to write; never evicted to seat a recall.
 */
function recallInto(table, names, at, keep = '') {
    const asked = new Set();
    for (const name of names) {
        const said = String(name ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!said) {
            continue;
        }
        asked.add(said);
        asked.add(said.replace(/^(?:the|a|an)\s+/, ''));
    }
    if (!asked.size) {
        return;
    }
    for (const item of cold.covered(asked, cold.ofKind(COLD_KIND))) {
        // A full table is the ordinary case for a recall, not the exception: the row went cold
        // BECAUSE the table was full, so returning to it has to be able to buy the slot back the
        // same way. `makeRoom` takes the stalest leaf, which is never the row being recalled.
        if (!table.has(item.key) && (table.size < MAX_PLACES || makeRoom(table, at, keep))) {
            cold.promote(COLD_KIND, item.key, item.row, table, at);
            observe.note('places:recalled');
        }
    }
}

/**
 * Create or edit a place.
 *
 * The one writer for the record's prose fields. Field-wise through `foldPlace`, so an omitted
 * column is silence rather than an erasure, and stamped with the turn so the versioned merge treats
 * it as the newest claim.
 *
 * A named container is a claim that the container EXISTS.
 *
 * `place` holds a parent NAME, and every reader of the hierarchy resolves it through `resolvePlace`
 * (`ancestorsOf`, `childrenOf`, `withinPlace`, `rootsOf`). A parent nobody ever gave a row to
 * resolves to null, so `{name: 'break room', place: 'RPD'}` would store the word "RPD", answer
 * `ancestorsOf` with `[]`, and leave `break room` sitting at the top of the tree as a root. The
 * containment would be written and invisible, which is precisely the string-shaped state this record
 * exists to replace.
 *
 * So a parent that resolves to nothing gets a bare row seeded for it here, in the same table and
 * under the same commit. Bare, and deliberately: this write knows the container's NAME and nothing
 * else about it, and inventing facts for it would be fold asserting something nothing narrated.
 *
 * @param {object} observed The place, in `foldPlace`'s shape.
 * @param {number} [at] Turn counter.
 * @returns {{key: string, reason: string}} The key written and the reason anything was refused.
 */
export function upsert(observed, at = turn()) {
    const table = load();
    const parent = String(observed?.place ?? '').replace(/\s+/g, ' ').trim();
    const mine = resolvePlace(table, observed?.name)?.key ?? placeKey(observed?.name);

    recallInto(table, [observed?.name, parent], at, mine);

    // Seeded BEFORE the child folds, so `resolvePlace` can find it on the very first pass that names
    // it. Skipped when the parent is the child, `wouldCycle` refuses that parent anyway, and
    // seeding it would be a write to the row about to be written.
    if (parent && !resolvePlace(table, parent) && placeKey(parent) !== placeKey(observed?.name)) {
        foldPlace(table, {
            name: parent,
            source: observed?.source ?? '',
            turn: at,
            ...(Number.isFinite(observed?.mid) ? { mid: observed.mid } : {}),
        });
    }

    let outcome = foldPlace(table, { ...observed, turn: at });
    // One retry, never a loop. A second `PLACES_FULL` after a successful demotion would mean the
    // table is entirely parents, and `makeRoom` has already said so by answering false.
    if (outcome.reason === PLACES_FULL && makeRoom(table, at, mine)) {
        outcome = foldPlace(table, { ...observed, turn: at });
    }
    if (outcome.reason) {
        observe.noteRejections([{
            item: String(observed?.name ?? ''),
            reason: outcome.reason,
            raw: observed,
            turn: at,
        }]);
    }
    // Committed whenever the table was touched, which the seeded parent and the demotion both do
    // even on a pass whose child was refused.
    commit(PLACES_PATH, table);
    return outcome;
}

/**
 * Record which place the scene is standing in.
 *
 * @param {string} key A place table key, or '' to clear it.
 * @returns {boolean} Whether the stored value changed.
 */
export function setHere(key) {
    const said = String(key ?? '');
    if (said === String(loadValue(HERE_PATH, ''))) {
        return false;
    }
    commitValue(HERE_PATH, said);
    return true;
}

/**
 * The place the scene is standing in, resolved.
 *
 * The entry point for every reader that wants the CURRENT place, the panel's Location section, and
 * anything that wants to walk `ancestorsOf`/`childrenOf` from where the story actually is. Fails
 * open like every other reader of this table: `null` means no place record has been established for
 * this scene, which is every chat written before the scene probe carried `place_name`, and callers
 * must go on treating the scene's `location` string as the string it is.
 *
 * @returns {{key: string, row: object}|null} The record, or null.
 */
export function here() {
    const key = String(loadValue(HERE_PATH, ''));
    if (!key) {
        return null;
    }
    const row = lookup(load(), key, null);
    return row ? { key, row } : null;
}

/**
 * Set prose columns on a place by hand.
 *
 * The sibling of `entities.patch` and `clocks.set`: every value fold derives should be correctable
 * in place. Strings only; `place` goes through `setParent`, which owes the cycle check, and the
 * numbers go through `setDrive`, which owes the whole-record write.
 *
 * @param {string} key The place's table key.
 * @param {object} fields Columns to set.
 * @returns {boolean} Whether anything changed.
 */
export function patch(key, fields) {
    const table = load();
    const row = lookup(table, key, null);
    if (!row || !fields) {
        return false;
    }
    const patched = {};
    for (const [column, value] of Object.entries(fields)) {
        if (column !== 'place' && typeof value === 'string' && value !== row[column]) {
            patched[column] = value;
        }
    }
    if (!Object.keys(patched).length) {
        return false;
    }
    const at = turn();
    table.set(key, { ...row, ...patched, turn: at });
    // A hand edit that types "destroyed" into the status box is the same claim the extractor makes
    // when it reports one, and must have the same consequence. Without this the rooms of a house
    // burned down by hand would keep saying the stove is lit.
    if (typeof patched.status === 'string' && !isGone(row) && isGone({ status: patched.status })) {
        cascadeRetirement(table, key, { status: patched.status, turn: at });
    }
    commit(PLACES_PATH, table);
    return true;
}

/**
 * Retire a place and everything inside it, keeping every record.
 *
 * Destruction is a status, never a delete.
 *
 * The house burns and the record stays: rows still point at it, the cellar is still inside it, and
 * the trail is the only surface on which the burning is legible afterwards. What changes is the
 * status, on the record and on every descendant, each with its own trail entry carrying the turn and
 * the anchor of the message that caused it, which is what makes the click-through work.
 *
 * Items stored there are not touched at all. They become UNREACHABLE, which is derived from the
 * place record on every read (`unreachable`) and therefore corrects itself the moment the place is
 * rebuilt. Writing anything onto the items would be a second copy of a fact this table already
 * holds, and the two would disagree the first time somebody edited one of them.
 *
 * @param {string} key The place's table key.
 * @param {object} [options] Options.
 * @param {string} [options.status] The word to use; `destroyed` by default.
 * @param {number} [options.at] Turn counter.
 * @param {number} [options.mid] Anchor mid, for the trail's cause-link.
 * @returns {string[]} The keys that changed.
 */
export function destroy(key, { status = 'destroyed', at = turn(), mid } = {}) {
    const table = load();
    const outcome = destroyPlace(table, key, { status, turn: at, mid });
    if (outcome.reason) {
        observe.noteRejections([{ item: String(key ?? ''), reason: outcome.reason, raw: { key, status }, turn: at }]);
        return [];
    }
    if (outcome.changed.length) {
        commit(PLACES_PATH, table);
    }
    return outcome.changed;
}

/**
 * Put a place inside another one, or take it out of one.
 *
 * The nesting writer. An empty `said` clears the parent, which is why this cannot go through
 * `patch`: an empty string is silence to the merge, so releasing a room from its house has to be a
 * whole-record write, the same shape `entities.setThreat` uses to clear a threat to zero.
 *
 * @param {string} key The place's table key.
 * @param {string} said The parent, as written; '' to clear it.
 * @param {number} [at] Turn counter.
 * @returns {boolean} Whether anything was written.
 */
export function setParent(key, said, at = turn()) {
    const table = load();
    const row = lookup(table, key, null);
    if (!row) {
        return false;
    }
    const place = String(said ?? '').replace(/\s+/g, ' ').trim();
    if (place === String(row.place ?? '')) {
        return false;
    }
    // Nothing goes INSIDE somewhere that no longer stands. Taking a room out of a burned house is
    // the opposite move and stays legal, which is what makes the status recoverable rather than a
    // one-way door, see `destroy`.
    const shut = place ? unreachableBy(table, place) : null;
    if (shut) {
        observe.noteRejections([{
            item: String(row.name ?? key),
            reason: PLACE_DESTROYED,
            raw: { key, place, status: shut.row?.status ?? '' },
            turn: at,
        }]);
        return false;
    }
    if (place && wouldCycle(table, key, place, row.aka)) {
        observe.noteRejections([{
            item: String(row.name ?? key),
            reason: 'place-cycle',
            raw: { key, place },
            turn: at,
        }]);
        return false;
    }
    table.set(key, { ...row, place, turn: at });
    commit(PLACES_PATH, table);
    return true;
}

/**
 * Set or clear a place's standing off-screen change.
 *
 * Written whole for `entities.setThreat`'s reason, restated because it is the trap this record was
 * warned about: `merge_place` inherits `merge_entity`'s silence rule, which treats `''`, null and
 * undefined as "say nothing", and `0` is none of those on the way in but is falsy everywhere else.
 * A field-wise write of `driveSize: 0` is indistinguishable from a write that simply did not
 * mention it, so clearing one goes through a full-record set.
 *
 * `driveSize` is what lets `worldAsks` (`world-table.js:199-220`) advance a place while the camera
 * is away, a mine that floods, a district that gentrifies. Nothing reads it yet.
 *
 * @param {string} key The place's table key.
 * @param {number} size How far the change goes; 0 means there is none.
 * @param {number} [filled] How far it has come.
 * @param {number} [at] Turn counter.
 * @returns {boolean} Whether anything changed.
 */
export function setDrive(key, size, filled, at = turn()) {
    const table = load();
    const row = lookup(table, key, null);
    if (!row) {
        return false;
    }
    const next = Math.max(0, Math.trunc(Number(size) || 0));
    const drive = Number.isFinite(filled) ? Math.max(0, Math.trunc(filled)) : (Number(row.drive) || 0);
    if ((Number(row.driveSize) || 0) === next && (Number(row.drive) || 0) === drive) {
        return false;
    }
    table.set(key, { ...row, driveSize: next, drive: Math.min(drive, next), turn: at });
    commit(PLACES_PATH, table);
    return true;
}

/**
 * Everything a reader needs, with the containment resolved once.
 *
 * The tree is derived here rather than stored, for `childrenOf`'s reason: a stored child list is a
 * second copy of the parent field and the two disagree the first time something writes one without
 * knowing about the other.
 *
 * @returns {{turn: number, roots: object[], places: object[]}} The places, with `depth`, `children`
 *   and `stale` attached, and the roots called out.
 */
export function snapshot() {
    const table = load();
    const now = turn();
    const places = table_entries(table).map(([key, row]) => ({
        ...row,
        key,
        depth: ancestorsOf(table, key).length,
        children: childrenOf(table, key).map(child => child.key),
        stale: Math.max(0, now - (Number(row?.turn) || 0)),
        line: renderPlace(table, key),
        // Whether the story is finished with this one, and whether something CONTAINING it is. The
        // second is what seals the items stored here, and it is derived rather than stored so that
        // rebuilding the house frees the cellar on the next read.
        gone: isGone(row),
        sealed: sealedBy(table, key)?.row?.name ?? '',
    }));
    const roots = new Set(rootsOf(table).map(root => root.key));
    return {
        turn: now,
        roots: places.filter(place => roots.has(place.key)),
        places: places.sort((a, b) => a.depth - b.depth || a.stale - b.stale),
    };
}

/**
 * Drop a place outright, for a hand correction.
 *
 * Not the same as the staleness prune, which demotes so somewhere the story outran stays
 * recallable. This is the player saying the row is wrong, so it leaves nothing to recall, and it
 * leaves its children pointing at a name with no record, which is the fail-open state every place
 * string in every existing chat is already in.
 *
 * @param {string} key The place's table key.
 * @returns {boolean} Whether a row was removed.
 */
export function remove(key) {
    const table = load();
    if (!table.delete(key)) {
        return false;
    }
    commit(PLACES_PATH, table);
    return true;
}

/**
 * Retire places the story has finished with, keeping them recallable.
 *
 * `prunePlaces` decides what goes and refuses to orphan anything; this archives each shed row whole
 * to the cold store, so somewhere the campaign left behind comes back with its record if it is ever
 * mentioned again ([EVICT]: selection cannot bound a store, so eviction is demotion).
 *
 * @param {number} [at] Current turn.
 * @returns {number} How many were demoted.
 */
export function prune(at = turn()) {
    const table = load();
    const shed = prunePlaces(table, at);
    if (!shed.length) {
        return 0;
    }
    for (const dropped of shed) {
        cold.demote({ kind: COLD_KIND, key: dropped.key, row: dropped.row, at });
    }
    observe.noteCap('places-archived', shed.length);
    commit(PLACES_PATH, table);
    return shed.length;
}

/**
 * Bring back every cold place the model reports the window mentions.
 *
 * The same law as the cast and the threads: admission is COVERAGE, the model's own `mentions`
 * report: never a substring or a confidence score ([ROUTER]), and re-promotion is a WRITE into the
 * tracked table rather than a paste into the window ([AC-PRODUCT]).
 *
 * @param {Set<string>} mentioned Normalised names the model reports the excerpt uses.
 * @param {number} [at] Current turn.
 * @returns {number} How many came home.
 */
export function recall(mentioned, at = turn()) {
    const table = load();
    let restored = 0;
    for (const item of cold.covered(mentioned, cold.ofKind(COLD_KIND))) {
        if (cold.promote(COLD_KIND, item.key, item.row, table, at)) {
            restored++;
        }
    }
    if (restored) {
        observe.note('places:recalled');
        commit(PLACES_PATH, table);
    }
    return restored;
}

/** Forget every place. */
export function clear() {
    commit(PLACES_PATH, new Map());
}

/**
 * Over-budget pruning: shed a place's HISTORY before shedding the place.
 *
 * Priced with the archive pruners, and the two stages are why.
 *
 * `PRUNE_ARCHIVE`, between the diagnostics log and the chronicle. A place record is state a player
 * built by hand, so it must not go before a debug surface does; an evicted chronicle event is gone
 * with its delta and cannot be rebuilt from anything, so it must not go before this does.
 *
 * The first stage is free of that ordering question entirely: a trail is HISTORY, the current
 * description is already on the record, and `MAX_PLACE_TRAIL` exists because a full trail is the
 * largest thing a place row carries (~280 bytes an entry against ~300 for the rest of the row).
 * Halving trails costs a player nothing they are currently looking at.
 *
 * The second stage deletes, and it is stated plainly rather than dressed as a demotion: demoting
 * here would move the row to `state.cold`, which is INSIDE the same blob this is trying to shrink,
 * so it would free nothing and the loop would spin until `runBudgetPasses` gave up. This is the
 * same admission `cold-store.js`'s own pruner makes about the one hard delete left in fold's
 * storage. It takes the stalest leaf first, a leaf, because `prunePlaces`' rule holds here too:
 * dropping a parent silently changes what its children are.
 */
registerPruner((overBy) => {
    const table = load();
    if (!table.size) {
        return;
    }

    // Stage one: halve the longest trails. Lossless for everything anyone can currently see.
    const trailed = table_entries(table).filter(([, row]) => (row?.trail?.length ?? 0) > 1);
    if (trailed.length) {
        for (const [key, row] of trailed) {
            const keep = Math.max(1, Math.floor(row.trail.length / 2));
            table.set(key, { ...row, trail: row.trail.slice(-Math.min(keep, MAX_PLACE_TRAIL)) });
        }
        commit(PLACES_PATH, table);
        console.debug(`[sanguine] trimmed ${trailed.length} place trail(s) to fit the metadata budget`);
        return;
    }

    // Stage two: the stalest leaves, oldest first. A row is a few hundred bytes; always take one.
    const leaves = table_entries(table)
        .filter(([key]) => !childrenOf(table, key).length)
        .sort((a, b) => (a[1]?.turn ?? 0) - (b[1]?.turn ?? 0));
    const target = Math.max(1, Math.ceil(overBy / 400));
    let dropped = 0;
    for (const [key] of leaves) {
        if (dropped >= target) {
            break;
        }
        table.delete(key);
        dropped++;
    }
    if (dropped) {
        observe.noteCap('places-shed', dropped);
        commit(PLACES_PATH, table);
        console.debug(`[sanguine] shed ${dropped} place(s) to fit the metadata budget`);
    }
}, PRUNE_ARCHIVE);

// Re-exported so a caller that only needs the kind never has to import both halves.
export { PLACE };
