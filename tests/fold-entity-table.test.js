import { describe, expect, test } from '@jest/globals';

import {
    ACTOR_KINDS,
    actorKind,
    DISPOSITIONS,
    ELSEWHERE,
    FACTION,
    ENTITY_STALE,
    GONE,
    HERE,
    LEAD,
    MAX_DRIVE,
    MAX_ENTITIES,
    MAX_THREAT,
    MAX_TRAIL,
    PERSON,
    UNPLACED,
    aliasKeys,
    castAt,
    dispositionRank,
    entitiesOfKind,
    entityKey,
    findEntity,
    foldEntities,
    absentKeys,
    contestedAliases,
    foldEntity,
    isExposition,
    mergeEntities,
    isRecent,
    merge_entity,
    normalizeEntityName,
    placeTokens,
    presenceOf,
    renderEntities,
    resolveEntity,
    samePlace,
    splitEntityKey,
} from '../public/scripts/extensions/fold/entity-table.js';
import { nearIdentity } from '../public/scripts/extensions/fold/thread-table.js';

describe('normalizeEntityName', () => {
    test('keys lowercase and displays as written', () => {
        expect(normalizeEntityName('Maria')).toEqual({ key: 'maria', display: 'Maria' });
        expect(normalizeEntityName('  Adele  Ricci. ')).toEqual({ key: 'adele ricci', display: 'Adele Ricci' });
    });

    test('strips the decoration models emit', () => {
        expect(normalizeEntityName('**Maria**')?.display).toBe('Maria');
        expect(normalizeEntityName('- Adele Ricci')?.display).toBe('Adele Ricci');
    });

    test('rejects the ways a model says there is nobody', () => {
        expect(normalizeEntityName('none')).toBeNull();
        expect(normalizeEntityName('None present')).toBeNull();
        expect(normalizeEntityName('')).toBeNull();
    });
});

describe('merge_entity — fields are last-write, the record is not', () => {
    test('an update that mentions one field leaves the others alone', () => {
        // The whole reason this is not merge_b. A turn establishing only that Maria has gone quiet
        // must not erase the fact that she is reachable by email; nothing retracted it.
        const merged = merge_entity(
            { status: 'unreachable', turn: 4 },
            { kind: PERSON, name: 'Maria', detail: 'reachable by email', status: 'remote', turn: 1 });
        expect(merged).toEqual({
            kind: PERSON, name: 'Maria', detail: 'reachable by email', status: 'unreachable', turn: 4,
            // Recomputed on every merge; empty when the record has only ever had one name.
            aka: '',
            // Earliest claim, not the latest — so a re-report never makes a thing newly introduced.
            first: 1,
        });
    });

    test('an empty field is silence, not a retraction', () => {
        const merged = merge_entity({ detail: '' }, { name: 'Maria', detail: 'by email' });
        expect(merged.detail).toBe('by email');
    });
});

describe('keys', () => {
    test('round-trip through kind and name', () => {
        const key = entityKey(PERSON, 'adele ricci');
        expect(splitEntityKey(key)).toEqual({ kind: PERSON, name: 'adele ricci' });
    });

    test('a person and a lead of the same name are two entities', () => {
        expect(entityKey(PERSON, 'umbrella')).not.toBe(entityKey(LEAD, 'umbrella'));
    });
});

describe('foldEntities — the Maria bug, fixed', () => {
    const WINDOW = 'Maria replied to the email overnight. Adele Ricci, a nurse at the corner clinic, is missing.';

    test('a person and their channel are ONE row, not two', () => {
        const table = new Map();
        foldEntities(table, [{ kind: PERSON, name: 'Maria', detail: 'reachable by email', status: 'remote' }],
            { windowText: WINDOW, turn: 1 });

        const people = entitiesOfKind(table, PERSON, 1);
        expect(people).toHaveLength(1);
        expect(people[0]).toMatchObject({ name: 'Maria', detail: 'reachable by email' });
    });

    test('a lead keeps its specifics beside its title rather than in a comma run-on', () => {
        const table = new Map();
        foldEntities(table, [{
            kind: LEAD, name: 'Adele Ricci missing', detail: 'nurse, corner clinic',
            open: 'nobody knows where she went', status: 'open',
        }], { windowText: WINDOW, turn: 1 });

        expect(entitiesOfKind(table, LEAD, 1)[0]).toMatchObject({
            name: 'Adele Ricci missing', detail: 'nurse, corner clinic', status: 'open',
        });
    });

    test('the mention gate refuses a person the excerpt never had', () => {
        const table = new Map();
        const { accepted, rejected } = foldEntities(
            table,
            [{ kind: PERSON, name: 'Chief Irons', detail: 'at the station', status: 'remote' }],
            { windowText: WINDOW, turn: 1 });

        expect(accepted).toBe(0);
        expect(rejected[0].reason).toBe('not-mentioned');
        expect(table.size).toBe(0);
    });

    test('a surname alone is enough — people are referred to by parts of their names', () => {
        const table = new Map();
        const { accepted } = foldEntities(table, [{ kind: PERSON, name: 'Ricci', detail: 'missing', status: 'unreachable' }],
            { windowText: WINDOW, turn: 1 });
        expect(accepted).toBe(1);
    });

    test('an alias the observation declares is enough — "Elin\'s mother" mentions the widow', () => {
        // Measured in the Time Stop RPG chat: the model proposed the widow with `aka: "Elin's
        // mother"` and the gate refused on the name alone even though the excerpt used that alias.
        // The aliases are declared by the same model that read the window, so a window carrying
        // them is a window about this person.
        const table = new Map();
        const { accepted, rejected } = foldEntities(table, [{
            kind: PERSON, name: 'widow', aka: 'Elin\'s mother', place: 'garden gate', status: 'present',
        }], { windowText: 'Sol finds Elin\'s mother at the garden gate.', turn: 1 });
        expect(accepted).toBe(1);
        expect(rejected).toEqual([]);
    });

    test('a mere title in aka is still refused when the window names nothing of the sort', () => {
        // A fabricated aka ("a mysterious woman") must not smuggle a person in when neither the
        // name nor any alias appears in the window. The window here names nobody of the sort.
        const table = new Map();
        const { accepted, rejected } = foldEntities(table, [{
            kind: PERSON, name: 'the widow', aka: 'a mysterious woman', place: 'garden gate', status: 'present',
        }], { windowText: 'Sol walks to the garden gate and opens it.', turn: 1 });
        expect(accepted).toBe(0);
        expect(rejected[0].reason).toBe('not-mentioned');
    });

    test('a person the window names is accepted even when the model under-reported its mentions', () => {
        // Measured in the Wuxia RP (turn 16): the model's `entities.mentions` omitted the
        // point-of-view character ("Chí Guāngdé") entirely, and the old gate — which admitted
        // ONLY by membership in that report — rejected him as `not-mentioned` even though the
        // snippet shows him narrating. The window test rescues a name the report forgot.
        const table = new Map();
        const { accepted, rejected } = foldEntities(table, [{
            kind: PERSON, name: 'Chí Guāngdé', place: 'cave', detail: 'settling to sleep', status: 'present',
        }], {
            windowText: 'Chí Guāngdé: I find somewhere to lay down and roll over onto my side.',
            turn: 16,
            mentioned: new Set(['Ling Xiang', 'little sprout']),
        });
        expect(accepted).toBe(1);
        expect(rejected).toEqual([]);
    });

    test('a person neither reported nor in the window is still refused', () => {
        // The OR must not admit everything: an entity the model did not report AND the window does
        // not name is still a fabrication, exactly as before the fix.
        const table = new Map();
        const { accepted, rejected } = foldEntities(table, [{
            kind: PERSON, name: 'Gorak the Unseen', place: 'the alley', status: 'present',
        }], {
            windowText: 'Chí Guāngdé walks through the empty market.',
            turn: 1,
            mentioned: new Set(['Chí Guāngdé', 'the market']),
        });
        expect(accepted).toBe(0);
        expect(rejected[0].reason).toBe('not-mentioned');
    });

    test('a person the report names is accepted even when the window test would fail', () => {
        // The report remains authoritative: a paraphrased name the model declares (and the window
        // cannot token-match) is still admitted — the whole point of coverage over substring.
        const table = new Map();
        const { accepted, rejected } = foldEntities(table, [{
            kind: PERSON, name: 'the visitor', aka: 'the hooded figure', place: 'the gate', status: 'present',
        }], {
            windowText: 'A silhouette waits by the wrought-iron gate, its face hidden.',
            turn: 1,
            mentioned: new Set(['the hooded figure']),
        });
        expect(accepted).toBe(1);
        expect(rejected).toEqual([]);
    });


    test('re-reporting updates in place rather than duplicating', () => {
        const table = new Map();
        foldEntities(table, [{ kind: PERSON, name: 'Maria', detail: 'reachable by email', status: 'remote' }],
            { windowText: WINDOW, turn: 1 });
        foldEntities(table, [{ kind: PERSON, name: 'maria', status: 'unreachable' }],
            { windowText: WINDOW, turn: 5 });

        const people = entitiesOfKind(table, PERSON, 5);
        expect(people).toHaveLength(1);
        expect(people[0]).toMatchObject({ status: 'unreachable', detail: 'reachable by email' });
    });

    test('the table is bounded', () => {
        const table = new Map();
        for (let i = 0; i < MAX_ENTITIES + 5; i++) {
            foldEntity(table, { kind: LEAD, name: `lead ${i}`, turn: 1 });
        }
        expect(table.size).toBe(MAX_ENTITIES);
    });
});

describe('reading back', () => {
    /**
     * A table with one fresh and one long-unmentioned lead.
     * @returns {Map<string, object>} The table.
     */
    const built = () => {
        const table = new Map();
        foldEntity(table, { kind: LEAD, name: 'fresh thread', detail: 'today', status: 'open', turn: 10 });
        foldEntity(table, { kind: LEAD, name: 'forgotten thread', detail: 'ages ago', status: 'open', turn: 0 });
        foldEntity(table, { kind: LEAD, name: 'done thread', detail: 'wrapped', status: 'closed', turn: 10 });
        return table;
    };

    test('freshest first', () => {
        expect(entitiesOfKind(built(), LEAD, 11).map(l => l.name))
            .toEqual(['fresh thread', 'forgotten thread']);
    });

    test('a resolved lead is witnessed closing, then stops taking up panel space', () => {
        // It resolved on turn 10, so on turn 10 it is still shown — struck through — and gone by 11.
        // A completion nobody saw reads as a tracker that lost something.
        expect(entitiesOfKind(built(), LEAD, 10).some(l => l.name === 'done thread')).toBe(true);
        expect(entitiesOfKind(built(), LEAD, 11).some(l => l.name === 'done thread')).toBe(false);
    });

    test('staleness hides rather than deletes', () => {
        const table = built();
        expect(entitiesOfKind(table, LEAD, ENTITY_STALE - 1).map(l => l.name))
            .toContain('forgotten thread');
        expect(table.has(entityKey(LEAD, 'forgotten thread'))).toBe(true);
    });

    test('isRecent marks only what changed in the last turn or two', () => {
        expect(isRecent({ stale: 0 })).toBe(true);
        expect(isRecent({ stale: 5 })).toBe(false);
    });

    test('findEntity looks up by raw name', () => {
        expect(findEntity(built(), LEAD, 'Fresh Thread')?.detail).toBe('today');
        expect(findEntity(built(), PERSON, 'Fresh Thread')).toBeNull();
    });
});

describe('renderEntities — the pairing has to survive into the prompt', () => {
    test('a person is written with their channel attached', () => {
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'Maria', place: 'the study', detail: 'reachable by email', turn: 1 });
        expect(renderEntities(table, 1, { at: 'the study' }))
            .toBe('People: Maria (the study, reachable by email)');
    });

    test('reach is carried beside the description, not inside it', () => {
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'Kang', place: 'the gate site', reach: 'phone number', turn: 1 });
        expect(renderEntities(table, 1, { at: 'the gate site' }))
            .toBe('People: Kang (the gate site, reachable: phone number)');
    });

    test('leads are titled and qualified', () => {
        const table = new Map();
        foldEntity(table, { kind: LEAD, name: 'Missing-persons cluster', detail: 'Arklay County, 15-18 Sep', status: 'open', turn: 1 });
        expect(renderEntities(table, 1)).toBe('Leads: Missing-persons cluster — Arklay County, 15-18 Sep');
    });

    test('an empty table injects nothing at all', () => {
        expect(renderEntities(new Map(), 0)).toBe('');
    });
});

describe('resolution and order — the case sanguine KeyResolution predicts', () => {
    // `Substrate/Algebra/Security/KeyResolution.lean`:
    //   resolution_breaks_key_independence — writes to DISTINCT keys never interact, so under
    //   last-write their order is irrelevant. Collapse two keys onto one and it stops being
    //   irrelevant: resolution converts independent writes into competing ones.
    //
    // `normalizeEntityName` is exactly such a resolver, and `merge_entity` was exactly last-write.
    // Extraction is async and fire-and-forget, so the two orders below are both reachable.

    const WINDOW = 'Maria said she would be at the door.';

    /**
     * Fold two sightings in the given order.
     * @param {object[]} order The sightings.
     * @returns {object} Maria's record.
     */
    const foldBoth = (order) => {
        const table = new Map();
        for (const sighting of order) {
            foldEntities(table, [sighting.entry], { windowText: WINDOW, turn: sighting.turn });
        }
        return findEntity(table, PERSON, 'Maria');
    };

    const early = { turn: 1, entry: { kind: PERSON, name: 'Maria', detail: 'reachable by email', status: 'remote' } };
    const late = { turn: 2, entry: { kind: PERSON, name: 'maria', detail: '', status: 'present' } };

    test('without a resolver the two spellings would be independent keys', () => {
        // The premise of the theorem: distinct keys never interact, so order cannot matter.
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'Maria', status: 'remote', turn: 1 });
        expect(entityKey(PERSON, 'maria')).toBe(entityKey(PERSON, 'Maria'.toLowerCase()));
        // …but the resolver DOES collapse them, which is what puts them in competition.
        expect(normalizeEntityName('maria').key).toBe(normalizeEntityName('Maria').key);
    });

    test('the same two sightings in either order give the same record', () => {
        // Under plain last-write this failed: arrival order decided the status.
        expect(foldBoth([early, late]).status).toBe(foldBoth([late, early]).status);
        expect(foldBoth([early, late]).detail).toBe(foldBoth([late, early]).detail);
    });

    test('the NEWER sighting wins regardless of which arrived first', () => {
        for (const order of [[early, late], [late, early]]) {
            expect(foldBoth(order)).toMatchObject({ status: 'present', turn: 2 });
        }
    });

    test('a field the newer sighting left empty falls back, it is not erased', () => {
        // Silence is not a retraction — the older record still knows how to reach her.
        for (const order of [[early, late], [late, early]]) {
            expect(foldBoth(order).detail).toBe('reachable by email');
        }
    });
});

/*
 * Every fixture below is verbatim from a real chat — a fantasy card with no stat block, where
 * extraction had nothing mechanical to latch onto and returned the most salient thing it read.
 * All five "leads" were lore. The panel showed them as threads to pull, and none of them were.
 */
describe('isExposition — a lead needs something unresolved in it', () => {
    test('drops the lore the model itself says is not unresolved', () => {
        // The decision is the model's: `unresolved: false` means lore whatever the phrasing.
        for (const detail of [
            'holy mark grants recovery, sunfire, resistance, and aggressive sword skill',
            'holy mark urges conquest near Demon Lord influence',
            'Paulette ordered Marote fed after horses',
        ]) {
            expect(isExposition({ detail, open: 'something', unresolved: false })).toBe(true);
        }
    });

    test('an explicit unresolved:true is a thread, however it is phrased', () => {
        // The Star Wars failure: "Survive the fight — the fight has just started" was dropped as
        // exposition because an ongoing fight was phrased as a status, not a question. The schema
        // answer decides, not the wording.
        expect(isExposition({
            detail: 'Sol vs. Vesk in Nar Shaddaa pits',
            open: 'the fight has just started',
            unresolved: true,
        })).toBe(false);
    });

    test('a confident statement dressed as an open clause is exposition when the model says so', () => {
        expect(isExposition({
            detail: 'Paulette runs the inn',
            open: 'she runs the inn',
            unresolved: false,
        })).toBe(true);
    });

    test('the block path carries no boolean and falls back to the structural empty-gap check', () => {
        // `absorb-table.js` feeds card-block clauses straight into `foldThreads` with no
        // `unresolved`. Absent, an empty `open` is "nothing unresolved" — shape, not vocabulary.
        expect(isExposition({ detail: 'the cellar door is oak', open: '' })).toBe(true);
        expect(isExposition({ detail: 'the cellar door is oak', open: 'the lock is jammed' })).toBe(false);
        expect(isExposition({})).toBe(true);
    });
});

describe('the exposition gate, wired', () => {
    const window = 'The hero read his abilities in the mark: recovery, sunfire, resistance. '
        + 'Marote wore a neck brand with one final command nobody had spoken.';

    test('rejects lore and accepts the thread, in one batch', () => {
        const table = new Map();
        const result = foldEntities(table, [
            { kind: LEAD, name: 'hero abilities', detail: 'holy mark grants recovery, sunfire, resistance', open: 'what it grants', unresolved: false },
            { kind: LEAD, name: 'marote brand', detail: 'neck brand, one command unspoken', open: 'the final command is unknown', unresolved: true },
        ], { windowText: window, turn: 1 });

        expect(result.accepted).toBe(1);
        expect(result.rejected).toEqual([expect.objectContaining({ item: 'hero abilities', reason: 'exposition' })]);
        expect(entitiesOfKind(table, LEAD, 1).map(l => l.name)).toEqual(['marote brand']);
    });

    test('people are never gated on it — a person is not a thread', () => {
        const table = new Map();
        const result = foldEntities(table, [
            { kind: PERSON, name: 'Paulette', detail: 'nearby in the inn', open: '' },
        ], { windowText: 'Paulette crossed the inn.', turn: 1 });

        expect(result.accepted).toBe(1);
    });

    test('an accepted lead always carries the clause the heal keys on', () => {
        // entities.js prunes pre-gate leads by testing for an empty `open`. That is only exact
        // because the gate makes a non-empty one a precondition of storage — if a lead could ever
        // be accepted without it, the heal would delete live records.
        const table = new Map();
        foldEntities(table, [
            { kind: LEAD, name: 'marote brand', detail: 'neck brand', open: 'the final command is unknown' },
        ], { windowText: window, turn: 1 });

        for (const lead of entitiesOfKind(table, LEAD, 1)) {
            expect(lead.open).toBeTruthy();
        }
    });

    test('reading back does not re-judge what the gate already passed', () => {
        // Double-jeopardy would make a genuine lead vanish on every repaint with no way back.
        const table = new Map();
        foldEntity(table, { kind: LEAD, name: 'fresh thread', detail: 'today', status: 'open', turn: 1 });
        expect(entitiesOfKind(table, LEAD, 1).map(l => l.name)).toEqual(['fresh thread']);
    });

    test('the open clause reaches the prompt, since it is why the lead is there', () => {
        const table = new Map();
        foldEntity(table, {
            kind: LEAD, name: 'marote brand', detail: 'neck brand, one command unspoken',
            open: 'the final command is unknown', source: 'meditation', turn: 1,
        });

        expect(renderEntities(table, 1))
            .toBe('Leads: marote brand — neck brand, one command unspoken; the final command is unknown (meditation)');
    });
});

/*
 * Presence. The fixture is the user's real Evil Hero Party chat: scene location "manor bedroom",
 * with Lord Everard, the Marshal, Corvin and Captain Harlan all still listed in the panel as being
 * in the dining hall — a room the story had left many turns earlier.
 */
describe('samePlace — exact equality, the model words it exactly', () => {
    test('the identical name is the same place', () => {
        expect(samePlace('the stableyard', 'the stableyard')).toBe(true);
        expect(samePlace('manor bedroom', 'Manor Bedroom')).toBe(true);
    });

    test('merely sharing a word is NOT the same place', () => {
        expect(samePlace('the dining hall', 'the great hall')).toBe(false);
        expect(samePlace('north tower', 'south tower')).toBe(false);
        expect(samePlace('bedroom', 'manor bedroom')).toBe(false);
    });

    test('the English stopword list is gone — no word is stripped', () => {
        // "in his bedroom" and "the bedroom" used to be one place because a list of English
        // articles, prepositions and possessives stripped the words. fold no longer decides
        // locality from words: the model is told to word a place exactly as the narration words
        // it, and a differently-worded pair is the review probe's `[same?]`/`[where now?]`
        // question, never a fold guess.
        expect(samePlace('in his bedroom', 'the bedroom')).toBe(false);
        expect(placeTokens('in the manor bedroom')).toEqual(new Set(['in', 'the', 'manor', 'bedroom']));
    });

    test('an unknown place matches nothing — including another unknown', () => {
        expect(samePlace('', 'the bedroom')).toBe(false);
        expect(samePlace('', '')).toBe(true);
    });
});

describe('presenceOf — the dispatch law applied honestly', () => {
    test('co-location decides, on the exact name the model reports', () => {
        // The entities instruction says "the bare place name ... worded exactly as the narration
        // words it — a differently-worded place makes a person vanish from the room." fold compares
        // what the model reported; it no longer strips English articles to guess two wordings are
        // the same room.
        expect(presenceOf({ place: 'the bedroom' }, 'the bedroom')).toBe(HERE);
        expect(presenceOf({ place: 'the dining hall' }, 'manor bedroom')).toBe(ELSEWHERE);
    });

    test('missing evidence returns UNPLACED rather than guessing', () => {
        // SelectionDispatch: in the band where the evidence cannot decide, take a third action
        // rather than a default you have no warrant for.
        expect(presenceOf({ place: '' }, 'manor bedroom')).toBe(UNPLACED);
        expect(presenceOf({ place: 'the dining hall' }, '')).toBe(UNPLACED);
    });

    test('leaving the STORY is different from leaving the room', () => {
        expect(presenceOf({ place: 'manor bedroom', status: 'gone' }, 'manor bedroom')).toBe(GONE);
        expect(presenceOf({ place: 'the dining hall', status: 'present' }, 'manor bedroom')).toBe(ELSEWHERE);
    });
});

describe('castAt — the Lord Everard case', () => {
    /** @returns {Map<string, object>} The real chat's cast, as recorded. */
    const evilHeroParty = () => {
        const table = new Map();
        // The model is told to word a place "exactly as the narration words it" — Paulette and
        // Solomon are in the manor bedroom, everyone else in the dining hall. The names must match
        // the scene's location exactly; fold no longer strips articles to guess.
        for (const [name, place] of [
            ['Paulette', 'manor bedroom'], ['Solomon', 'manor bedroom'],
            ['Lord Everard', 'the dining hall'], ['Marshal', 'the dining hall'],
            ['Corvin', 'the dining hall'], ['Captain Harlan', 'the dining hall'],
        ]) {
            foldEntity(table, { kind: PERSON, name, place, status: 'present', turn: 10 });
        }
        return table;
    };

    test('a location change moves people out of the room', () => {
        const { here, elsewhere } = castAt(evilHeroParty(), 10, 'manor bedroom');
        expect(here.map(p => p.name)).toEqual(['Paulette', 'Solomon']);
        expect(elsewhere.map(p => p.name).sort())
            .toEqual(['Captain Harlan', 'Corvin', 'Lord Everard', 'Marshal']);
    });

    test('they are demoted, not deleted — a returning character is remembered', () => {
        const table = evilHeroParty();
        expect(castAt(table, 10, 'manor bedroom').elsewhere[0].place).toBe('the dining hall');
        // Walk back into the hall and the cast reverses, with no new extraction needed.
        expect(castAt(table, 10, 'the dining hall').here.map(p => p.name).sort())
            .toEqual(['Captain Harlan', 'Corvin', 'Lord Everard', 'Marshal']);
    });

    test('an unknown scene location keeps everyone — but as UNPLACED, not as here', () => {
        // Absence of evidence is still not absence: nobody is dropped. What changed is that the
        // third value survives instead of being spent asserting six people into a room the
        // narration never named (FOLD-REDESIGN.md §0.1-1).
        const cast = castAt(evilHeroParty(), 10, '');
        expect(cast.here).toHaveLength(0);
        expect(cast.unplaced).toHaveLength(6);
        expect(cast.elsewhere).toHaveLength(0);
    });

    test('only the people HERE reach the prompt', () => {
        const rendered = renderEntities(evilHeroParty(), 10, { at: 'manor bedroom' });
        expect(rendered).toContain('Paulette');
        expect(rendered).not.toContain('Lord Everard');
    });

    test('re-reporting someone does NOT put them back in the room', () => {
        // The loop that made staleness unfireable: the probe re-reports anything still true, and
        // every re-report refreshed the counter meant to expire it. Presence no longer reads that
        // counter at all — only the place.
        const table = evilHeroParty();
        foldEntity(table, { kind: PERSON, name: 'Lord Everard', place: 'the dining hall', turn: 99 });
        expect(castAt(table, 99, 'manor bedroom').here.map(p => p.name)).not.toContain('Lord Everard');
    });
});

/*
 * The third value, all the way to the consumer. `presenceOf` paid for UNPLACED and `castAt` used
 * to spend it: someone with no recorded place was asserted into the room. FOLD-REDESIGN.md §0.1-1.
 */
describe('UNPLACED is hedged, never asserted', () => {
    /** @returns {Map<string, object>} A scene with one placed person and one unplaceable one. */
    const brokerShop = () => {
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'the scarred broker', place: 'the broker\'s shop', turn: 10 });
        foldEntity(table, { kind: PERSON, name: 'Kang Min-seo', detail: 'texted after the raid', turn: 10 });
        return table;
    };

    test('castAt separates "here" from "cannot say"', () => {
        const cast = castAt(brokerShop(), 10, 'the broker\'s shop');
        expect(cast.here.map(p => p.name)).toEqual(['the scarred broker']);
        expect(cast.unplaced.map(p => p.name)).toEqual(['Kang Min-seo']);
    });

    test('the prompt never lists an unplaced person under People:', () => {
        const rendered = renderEntities(brokerShop(), 10, { at: 'the broker\'s shop' });
        const people = rendered.split('\n').find(line => line.startsWith('People:'));
        expect(people).toBe('People: the scarred broker (the broker\'s shop)');
        expect(people).not.toContain('Kang');
    });

    test('but it does not lose them either — they are stated as unstated', () => {
        const rendered = renderEntities(brokerShop(), 10, { at: 'the broker\'s shop' });
        const hedged = rendered.split('\n').find(line => line.startsWith('Whereabouts unstated'));
        expect(hedged).toContain('Kang Min-seo');
        expect(hedged).toContain('do not place them in the scene');
    });

    test('the point-of-view character is excluded from the hedge too', () => {
        const table = brokerShop();
        foldEntity(table, { kind: PERSON, name: 'Solomon', aka: 'the Hero', turn: 10 });
        const rendered = renderEntities(table, 10, { at: 'the broker\'s shop', exclude: 'the Hero' });
        expect(rendered).not.toContain('Solomon');
    });
});

/*
 * Identity. The user's chat listed "Hero" and "Solomon" as two people standing in the same bedroom.
 * They are one man: the card's title and the narration's proper name. No string metric can join
 * them — they share not one character — so the alias comes from the model.
 */
describe('aliases — one man under two names', () => {
    test('a later proper name lands on the record the title opened', () => {
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'the Hero', place: 'the bedroom', turn: 1 });
        foldEntity(table, { kind: PERSON, name: 'Solomon', aka: 'the Hero', place: 'the bedroom', turn: 2 });

        const people = entitiesOfKind(table, PERSON, 2);
        expect(people).toHaveLength(1);
        expect(people[0].name).toBe('Solomon');
    });

    test('the superseded name is kept, so the title still resolves later', () => {
        // Without this the record renames itself and forgets what it used to answer to — so the
        // next mention of "the Hero" opens a second record and undoes the merge.
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'the Hero', turn: 1 });
        foldEntity(table, { kind: PERSON, name: 'Solomon', aka: 'the Hero', turn: 2 });
        foldEntity(table, { kind: PERSON, name: 'the Hero', place: 'the stableyard', turn: 3 });

        expect(entitiesOfKind(table, PERSON, 3)).toHaveLength(1);
        expect(resolveEntity(table, PERSON, 'the Hero')?.entity.place).toBe('the stableyard');
    });

    test('aliases accumulate — a name you were called stays a name you were called', () => {
        // The one Set-face field on the record. Everything else must be retractable; this must not.
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'Solomon', aka: 'the Hero', turn: 1 });
        foldEntity(table, { kind: PERSON, name: 'Solomon', aka: 'the marked one', turn: 2 });

        // Keyed without the leading article, so "the Hero" and "Hero" are one name.
        const keys = aliasKeys(resolveEntity(table, PERSON, 'Solomon').entity);
        expect(keys).toEqual(expect.arrayContaining(['solomon', 'hero', 'marked one']));
    });

    test('a record never lists its own name as an alias', () => {
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'Solomon', aka: 'Solomon, the Hero', turn: 1 });
        foldEntity(table, { kind: PERSON, name: 'Solomon', turn: 2 });
        expect(resolveEntity(table, PERSON, 'Solomon').entity.aka).toBe('the Hero');
    });

    test('unrelated people are not merged', () => {
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'Solomon', aka: 'the Hero', turn: 1 });
        foldEntity(table, { kind: PERSON, name: 'Paulette', turn: 1 });
        expect(entitiesOfKind(table, PERSON, 1)).toHaveLength(2);
    });

    test('a person and a lead sharing a name stay distinct', () => {
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'Umbrella', turn: 1 });
        foldEntity(table, { kind: LEAD, name: 'Umbrella', open: 'who runs it is unknown', turn: 1 });
        expect(entitiesOfKind(table, PERSON, 1)).toHaveLength(1);
        expect(entitiesOfKind(table, LEAD, 1)).toHaveLength(1);
    });

    test('the point of view is excluded from the prompt under EITHER of his names', () => {
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'Solomon', aka: 'the Hero', place: 'the bedroom', turn: 1 });
        foldEntity(table, { kind: PERSON, name: 'Paulette', place: 'the bedroom', turn: 1 });

        for (const pov of ['Solomon', 'the Hero', 'HERO']) {
            const rendered = renderEntities(table, 1, { exclude: pov, at: 'the bedroom' });
            expect(rendered).toBe('People: Paulette (the bedroom)');
        }
    });
});

/*
 * Change, as distinct from restatement. `BayesFilter.zero_residual_is_fixed`: a measurement equal to
 * the prediction carries no information, and most of the panel is restatement.
 */
describe('first-seen — telling NEW from UPDATED', () => {
    test('a record remembers the turn it first appeared', () => {
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'Amelina', turn: 3 });
        expect(entitiesOfKind(table, PERSON, 3)[0].first).toBe(3);
    });

    test('re-reporting does not make something newly introduced again', () => {
        // Under plain field-wise last-write every re-report resets it, and nothing ever reads as
        // new for more than a single tick.
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'Amelina', turn: 3 });
        foldEntity(table, { kind: PERSON, name: 'Amelina', place: 'the hall', turn: 9 });

        const [amelina] = entitiesOfKind(table, PERSON, 9);
        expect(amelina.first).toBe(3);
        expect(amelina.stale).toBe(0);
    });

    test('first-seen is a minimum, so out-of-order arrivals converge', () => {
        // Extraction is async; a turn-3 sighting can land after a turn-9 one.
        const late = new Map();
        foldEntity(late, { kind: PERSON, name: 'Amelina', turn: 9 });
        foldEntity(late, { kind: PERSON, name: 'Amelina', turn: 3 });
        expect(entitiesOfKind(late, PERSON, 9)[0].first).toBe(3);
    });
});

describe('resolved things are witnessed before they go', () => {
    test('a lead closed THIS turn stays one more turn', () => {
        const table = new Map();
        foldEntity(table, { kind: LEAD, name: 'the cellar', open: 'nobody has searched it', status: 'open', turn: 4 });
        foldEntity(table, { kind: LEAD, name: 'the cellar', status: 'closed', turn: 5 });

        const [lead] = entitiesOfKind(table, LEAD, 5);
        expect(lead.name).toBe('the cellar');
        expect(lead.presence).toBe(GONE);
    });

    test('and is gone the turn after', () => {
        const table = new Map();
        foldEntity(table, { kind: LEAD, name: 'the cellar', open: 'nobody has searched it', status: 'open', turn: 4 });
        foldEntity(table, { kind: LEAD, name: 'the cellar', status: 'closed', turn: 5 });
        expect(entitiesOfKind(table, LEAD, 6)).toHaveLength(0);
    });

    test('a departed person is seen leaving, then drops out of the cast', () => {
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'the serving girl', place: 'the hall', turn: 4 });
        foldEntity(table, { kind: PERSON, name: 'the serving girl', status: 'gone', turn: 5 });

        expect(castAt(table, 5, 'the hall').here.map(p => p.name)).toContain('the serving girl');
        expect(castAt(table, 7, 'the hall').here).toHaveLength(0);
    });
});

/*
 * Social state. The most consequential hidden variable in any negotiation scene, and fold tracked
 * none of it. Every tracker in this space models it as a 0–100 meter; on a substrate where an LLM
 * does the writing, that is the one representation guaranteed to drift.
 */
describe('disposition — a word, not a meter', () => {
    test('the scale is ordinal and reads low to high', () => {
        expect(DISPOSITIONS).toEqual(['hostile', 'wary', 'neutral', 'friendly', 'devoted']);
        expect(dispositionRank('hostile')).toBeLessThan(dispositionRank('neutral'));
        expect(dispositionRank('neutral')).toBeLessThan(dispositionRank('devoted'));
    });

    test('an unknown word sits at neutral rather than at zero', () => {
        // Zero would read as hostile, which is a claim the evidence does not support.
        for (const junk of ['', undefined, 'ambivalent', 'SUSPICIOUS']) {
            expect(dispositionRank(junk)).toBe(DISPOSITIONS.indexOf('neutral'));
        }
    });

    test('a value outside the vocabulary is not stored', () => {
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'Lord Everard', feels: 'quite cross actually', turn: 1 });
        expect(entitiesOfKind(table, PERSON, 1)[0].feels).toBe('');
    });

    test('casing does not fork the vocabulary', () => {
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'Lord Everard', feels: 'WARY', turn: 1 });
        expect(entitiesOfKind(table, PERSON, 1)[0].feels).toBe('wary');
    });

    test('agenda and leverage are kept as phrases and survive a partial update', () => {
        const table = new Map();
        foldEntity(table, {
            kind: PERSON, name: 'Lord Everard', feels: 'wary',
            wants: 'supplies for the northern march', knows: 'is owed two hundred crowns', turn: 1,
        });
        // A later sighting that only re-reads his mood must not erase what he is after.
        foldEntity(table, { kind: PERSON, name: 'Lord Everard', feels: 'friendly', turn: 2 });

        expect(entitiesOfKind(table, PERSON, 2)[0]).toMatchObject({
            feels: 'friendly',
            wants: 'supplies for the northern march',
            knows: 'is owed two hundred crowns',
        });
    });

    test('motive reaches the prompt, because it is what the narrator must act on', () => {
        const table = new Map();
        foldEntity(table, {
            kind: PERSON, name: 'Lord Everard', place: 'the dining hall', feels: 'wary',
            wants: 'supplies for the northern march', turn: 1,
        });
        const rendered = renderEntities(table, 1, { at: 'the dining hall' });
        expect(rendered).toContain('regards you as wary');
        expect(rendered).toContain('wants supplies for the northern march');
    });
});

describe('findEntity follows aliases too', () => {
    test('both lookups agree, so neither is a trap', () => {
        // Two lookups with different semantics is how "the Hero" silently fails to find Solomon.
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'Solomon', aka: 'the Hero', turn: 1 });
        expect(findEntity(table, PERSON, 'the Hero')?.name).toBe('Solomon');
        expect(findEntity(table, PERSON, 'Solomon')).toBe(resolveEntity(table, PERSON, 'Hero').entity);
        expect(findEntity(table, PERSON, 'nobody at all')).toBeNull();
    });
});

/*
 * ── The exposition gate is the model's answer, not a word list ──
 *
 * It used to re-read the model's `open` text against an English interrogative list (`UNSETTLED`).
 * The Star Wars chat showed the boundary failing: "Survive the fight — the fight has just started"
 * was dropped as "exposition" because an ongoing fight was phrased as a status rather than a
 * question. The gate now reads the schema boolean the model answers directly.
 */
describe('the exposition gate is the model\'s `unresolved` answer', () => {
    test('lore is whatever the model marks unresolved:false, however the open text reads', () => {
        for (const open of [
            'RPD data shows escalating incidents',
            'the crowd shows no sign of thinning',
            'the whole building is dark',
            'she showed him the way',
        ]) {
            expect(isExposition({ open, unresolved: false })).toBe(true);
        }
    });

    test('a real open thread is unresolved:true, however it is phrased', () => {
        for (const open of [
            'the fight has just started',
            'the final command is unknown',
            'nobody has searched the cellar',
            'who took the keys is not established',
        ]) {
            expect(isExposition({ open, unresolved: true })).toBe(false);
        }
    });

    test('without a boolean the structural empty-gap check still guards the block path', () => {
        expect(isExposition({ open: '' })).toBe(true);
        expect(isExposition({})).toBe(true);
    });
});

/*
 * A review-confirmed merge, at the layer that owns the alias machinery. Kang existed twice for the
 * whole of the live chat and could not stop (FOLD-RPG-GAP.md §2); the broker pair reopened within 48
 * hours of being hand-fixed (§0.1).
 */
describe('an alias two people answer to decides nothing', () => {
    // Measured across the live chats, three collisions in two of them:
    //
    //   New Eldoria   "dwarf"          Grimble | Armorer
    //   Solo Leveling "ji gwang-deok"  Solomon Winters | The doctor
    //   Solo Leveling "woman"          Kang | Park Min-ji
    //
    // `canonicalKey` scanned the table and took the FIRST row whose alias set intersected, so each
    // of those resolved by Map iteration order — a silent coin-flip. New Eldoria shows what it
    // costs: Grimble the apothecary carries the armorer's `wants` ("closing soon, spare a moment"),
    // the armorer's `detail` ("showing spears and staves") and the armorer's shop as his place,
    // because every later "the dwarf" in a story with three dwarves landed on him.

    test('a contested alias resolves to nobody rather than to whoever iterates first', () => {
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'Grimble', aka: 'the old man, the dwarf', turn: 1 });
        foldEntity(table, { kind: PERSON, name: 'Armorer', aka: 'the dwarf', turn: 2 });
        expect(resolveEntity(table, PERSON, 'the dwarf')).toBe(null);
        // Insertion order must not change the answer — that is the whole complaint.
        const other = new Map();
        foldEntity(other, { kind: PERSON, name: 'Armorer', aka: 'the dwarf', turn: 1 });
        foldEntity(other, { kind: PERSON, name: 'Grimble', aka: 'the old man, the dwarf', turn: 2 });
        expect(resolveEntity(other, PERSON, 'the dwarf')).toBe(null);
    });

    test('an alias only one person answers to still resolves', () => {
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'Grimble', aka: 'the old man, the dwarf', turn: 1 });
        foldEntity(table, { kind: PERSON, name: 'Armorer', aka: 'the dwarf', turn: 2 });
        expect(resolveEntity(table, PERSON, 'the old man')?.entity?.name).toBe('Grimble');
    });

    test('a newcomer that NAMES a stored row still merges into it', () => {
        // The direction the alias field exists for, and it is untouched. A card calls its
        // protagonist "the Hero" and the narration calls him "Solomon"; the observation that says
        // so is the model answering an identity question directly, which is the one authority fold
        // has. Only two strangers holding one adjective are refused.
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'the Hero', turn: 1 });
        foldEntity(table, { kind: PERSON, name: 'Solomon', aka: 'the Hero', turn: 2 });
        expect(table.size).toBe(1);
        expect(resolveEntity(table, PERSON, 'the Hero')?.entity?.name).toBe('Solomon');
    });

    test('a name is never contested away from its own row', () => {
        // The direct key hit precedes the alias scan, so a row whose actual NAME somebody else
        // claims as an alias still answers to it. Solo Leveling is that case: `ji gwang-deok` is
        // claimed by both "Solomon Winters" and "The doctor" in the live cast table, so the alias
        // decides nothing — but the doctor's own name still finds the doctor.
        const table = new Map([
            ['person\u0000ji gwang-deok', { kind: PERSON, name: 'Ji Gwang-deok', aka: 'the doctor' }],
            ['person\u0000solomon winters', { kind: PERSON, name: 'Solomon Winters', aka: 'ji gwang-deok' }],
        ]);
        expect(contestedAliases(table, PERSON).has('ji gwang-deok')).toBe(true);
        expect(resolveEntity(table, PERSON, 'Ji Gwang-deok')?.entity?.name).toBe('Ji Gwang-deok');
        // And the doctor's own row is reachable by the alias only she claims.
        expect(resolveEntity(table, PERSON, 'the doctor')?.entity?.name).toBe('Ji Gwang-deok');
    });

    test('a new sighting under a contested alias opens its own row instead of joining one', () => {
        // `canonicalKey` is the write path too. Landing on the wrong row is how Grimble acquired a
        // forge; a row of its own is recoverable, and the review is told to ask about the pair.
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'Grimble', aka: 'the dwarf', turn: 1 });
        foldEntity(table, { kind: PERSON, name: 'Armorer', aka: 'the dwarf', turn: 2 });
        foldEntity(table, { kind: PERSON, name: 'the dwarf', detail: 'behind the counter', turn: 3 });
        expect(table.get('person\u0000grimble').detail).not.toBe('behind the counter');
        expect(table.get('person\u0000armorer').detail).not.toBe('behind the counter');
    });

    test('the collision is reported, so the review can settle it', () => {
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'Grimble', aka: 'the old man, the dwarf', turn: 1 });
        foldEntity(table, { kind: PERSON, name: 'Armorer', aka: 'the dwarf', turn: 2 });
        expect(contestedAliases(table, PERSON).get('dwarf'))
            .toEqual(['person\u0000grimble', 'person\u0000armorer']);
        // One claimant is not a contest.
        expect(contestedAliases(table, PERSON).has('old man')).toBe(false);
    });
});

describe('mergeEntities — the answer to an identity question', () => {
    /** Two rows, the fuller name written second so neither order is privileged by accident. */
    function pair() {
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'Kang', place: 'the chamber', detail: 'catching her breath', turn: 3 });
        foldEntity(table, { kind: PERSON, name: 'Kang Min-seo', place: 'the Nowon gate site', feels: 'friendly', turn: 5 });
        return table;
    }

    test('the fuller name survives and the shorter becomes an alias', () => {
        const table = pair();
        expect(table.size).toBe(2);
        const done = mergeEntities(table, entityKey(PERSON, 'kang'), entityKey(PERSON, 'kang min-seo'));
        expect(table.size).toBe(1);
        expect(done.key).toBe(entityKey(PERSON, 'kang min-seo'));
        const row = table.get(done.key);
        expect(row.name).toBe('Kang Min-seo');
        expect(row.aka.toLowerCase()).toContain('kang');
    });

    test('and the next sighting of the short name lands on the merged row', () => {
        // The point of the whole exercise: `canonicalKey` follows the alias set, so the abbreviation
        // that opened the duplicate can no longer open another.
        const table = pair();
        mergeEntities(table, entityKey(PERSON, 'kang'), entityKey(PERSON, 'kang min-seo'));
        foldEntity(table, { kind: PERSON, name: 'Kang', place: 'the ramen shop', turn: 7 });
        expect(table.size).toBe(1);
        expect(table.get(entityKey(PERSON, 'kang min-seo')).place).toBe('the ramen shop');
    });

    test('the fresher sighting wins per field, exactly as a re-report would', () => {
        const table = pair();
        mergeEntities(table, entityKey(PERSON, 'kang'), entityKey(PERSON, 'kang min-seo'));
        const row = table.get(entityKey(PERSON, 'kang min-seo'));
        expect(row.place).toBe('the Nowon gate site');
        // And nothing the later sighting was silent about is erased — silence is not retraction.
        expect(row.detail).toBe('catching her breath');
    });

    test('first-seen is the earliest claim, so a merged row does not read as newly introduced', () => {
        const table = pair();
        mergeEntities(table, entityKey(PERSON, 'kang'), entityKey(PERSON, 'kang min-seo'));
        expect(table.get(entityKey(PERSON, 'kang min-seo')).first).toBe(3);
    });

    test('order does not matter — the same pair merges the same way either way round', () => {
        const left = pair();
        const right = pair();
        mergeEntities(left, entityKey(PERSON, 'kang'), entityKey(PERSON, 'kang min-seo'));
        mergeEntities(right, entityKey(PERSON, 'kang min-seo'), entityKey(PERSON, 'kang'));
        expect([...left.keys()]).toEqual([...right.keys()]);
        expect(left.get(entityKey(PERSON, 'kang min-seo')).name)
            .toBe(right.get(entityKey(PERSON, 'kang min-seo')).name);
    });

    test('nothing merges when a row is missing, or when the kinds differ', () => {
        const table = pair();
        expect(mergeEntities(table, entityKey(PERSON, 'kang'), entityKey(PERSON, 'nobody'))).toBeNull();
        expect(mergeEntities(table, entityKey(PERSON, 'kang'), entityKey(PERSON, 'kang'))).toBeNull();
        expect(table.size).toBe(2);
    });
});

/*
 * ── Relationship trails (Phase D) ──
 *
 * `FOLD-REDESIGN.md` §1.1: "per-row history of `feels`/`wants`/`knows` changes, stamped with the
 * extracting pass's anchor mid so each change is attributable to the message that caused it —
 * `merge_entity` is last-write per field and rightly so; the trail is the sibling record of what the
 * last write replaced". Recorded from this phase on so §8's Relationships tab has data to render.
 */
describe('the relationship trail — what the last write replaced', () => {
    const sight = (table, fields, turn, mid) =>
        foldEntity(table, { kind: PERSON, name: 'Kang Min-seo', turn, mid, ...fields });

    test('nothing is recorded until something actually changes', () => {
        const table = new Map();
        sight(table, { feels: 'wary' }, 1, 10);
        expect(findEntity(table, PERSON, 'Kang Min-seo').trail)
            .toEqual([expect.objectContaining({ field: 'feels', from: '', to: 'wary', mid: 10 })]);

        // A re-report of the same value is a restatement, not a change. The probe is instructed to
        // re-report everything still true, so without this the trail would be one entry per turn.
        sight(table, { feels: 'wary' }, 2, 12);
        expect(findEntity(table, PERSON, 'Kang Min-seo').trail).toHaveLength(1);
    });

    test('a change records both ends, the turn and the anchor mid', () => {
        const table = new Map();
        sight(table, { feels: 'wary' }, 1, 10);
        sight(table, { feels: 'friendly', wants: 'a reliable second for the next raid' }, 4, 30);

        const trail = findEntity(table, PERSON, 'Kang Min-seo').trail;
        expect(trail).toHaveLength(3);
        expect(trail[1]).toEqual({ field: 'feels', from: 'wary', to: 'friendly', turn: 4, mid: 30 });
        expect(trail[2]).toMatchObject({ field: 'wants', from: '', turn: 4, mid: 30 });
    });

    test('an empty field is silence, so it neither overwrites nor records', () => {
        const table = new Map();
        sight(table, { feels: 'friendly' }, 1, 10);
        sight(table, { place: 'the Nowon gate site' }, 2, 12);
        const row = findEntity(table, PERSON, 'Kang Min-seo');
        expect(row.feels).toBe('friendly');
        expect(row.trail).toHaveLength(1);
    });

    test('a late sighting from an EARLIER turn is news from the past, not a change', () => {
        // Extraction is async and unordered, which is why `merge_entity` is versioned at all
        // (`resolution_max_converges`). Recording a backwards write as a change would write the
        // story backwards.
        const table = new Map();
        sight(table, { feels: 'friendly' }, 5, 40);
        sight(table, { feels: 'wary' }, 2, 20);
        const row = findEntity(table, PERSON, 'Kang Min-seo');
        expect(row.feels).toBe('friendly');
        expect(row.trail).toHaveLength(1);
    });

    test('and it is bounded, oldest first — the current value is already on the row', () => {
        const table = new Map();
        const words = ['hostile', 'wary', 'neutral', 'friendly', 'devoted'];
        for (let at = 0; at < MAX_TRAIL + 4; at++) {
            sight(table, { feels: words[at % words.length] }, at + 1, at + 1);
        }
        const trail = findEntity(table, PERSON, 'Kang Min-seo').trail;
        expect(trail).toHaveLength(MAX_TRAIL);
        expect(trail[trail.length - 1].turn).toBe(MAX_TRAIL + 4);
    });
});

/*
 * ── Adversary threat (Phase D, §3) ──
 *
 * One small integer, present only while an adversary is active. §12.3 is explicit that no live
 * combat has run under this schema, so this is deliberately the smallest thing that can be right.
 */
describe('threat — one small integer, and only while it is true', () => {
    test('bounded, and 0 for the overwhelming majority of rows', () => {
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'the ahjumma', turn: 1 });
        foldEntity(table, { kind: PERSON, name: 'the hobgoblin', threat: 99, turn: 1 });
        expect(findEntity(table, PERSON, 'the ahjumma').threat).toBe(0);
        expect(findEntity(table, PERSON, 'the hobgoblin').threat).toBe(MAX_THREAT);
    });

    test('a re-report of 0 clears it — a danger nobody confirms this turn is over', () => {
        // The one field where silence IS a retraction, and the asymmetry is argued on the record:
        // the probe is asked for `threat` on every person on every pass, so a raised weapon nobody
        // mentions has been lowered. That inference would be wrong for `wants` and is right here.
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'the hobgoblin', threat: 4, turn: 1 });
        foldEntity(table, { kind: PERSON, name: 'the hobgoblin', place: 'the gate mouth', turn: 2 });
        expect(findEntity(table, PERSON, 'the hobgoblin').threat).toBe(0);
    });

    test('and it reaches the injected block, where six enemies become six legible things', () => {
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'the hobgoblin', threat: 4, place: 'the gate mouth', turn: 1 });
        expect(renderEntities(table, 1, { at: 'the gate mouth' })).toContain('threat 4');
    });
});

describe('a person named after being described — the commonest aliasing shape', () => {
    test('the name learned later merges onto the description, keeping one row', () => {
        // Live failure: `tiefling fighter` (turn 14) and `Kaelira` (turn 19) stood as two people,
        // as did `elven wizard`/`Sylanna` and `dark elf rogue`/`Vexia`. The merge path was never
        // the problem — this is what it does when the back-link arrives.
        const cast = new Map();
        foldEntity(cast, { kind: PERSON, name: 'tiefling fighter', place: 'clearing', wants: 'defeat the goblins' });
        foldEntity(cast, { kind: PERSON, name: 'Kaelira', aka: 'tiefling fighter', place: 'inn\'s back yard' });
        expect(cast.size).toBe(1);
        expect([...cast.values()][0].name).toBe('Kaelira');
    });

    test('the earlier row keeps what the later report does not restate', () => {
        // A name reveal usually says nothing about goals; silence must not erase them.
        const cast = new Map();
        foldEntity(cast, { kind: PERSON, name: 'the tall guard', wants: 'keep the gate', place: 'gate' });
        foldEntity(cast, { kind: PERSON, name: 'Marek', aka: 'the tall guard', place: 'barracks' });
        const row = [...cast.values()][0];
        expect(row.name).toBe('Marek');
        expect(row.wants).toBe('keep the gate');
    });

    test('token overlap cannot find these pairs, which is why the field has to', () => {
        // The detector is a token-subset trigger over fold's own keys. A name and the description
        // it replaces share nothing, so no structural rule reaches them — pinned so nobody tries.
        // `nearIdentity` returns the reason it fired, or a falsy value when it did not.
        expect(nearIdentity('kaelira', 'tiefling fighter')).toBeFalsy();
        expect(nearIdentity('sylanna', 'elven wizard')).toBeFalsy();
        expect(nearIdentity('vexia', 'dark elf rogue')).toBeFalsy();
        // …while the case it IS for still works.
        expect(nearIdentity('ling xiang', 'xiang')).toBeTruthy();
    });

    test('an aka naming nobody held creates no phantom', () => {
        const cast = new Map();
        foldEntity(cast, { kind: PERSON, name: 'Kaelira', aka: 'someone never recorded' });
        expect(cast.size).toBe(1);
        expect([...cast.values()][0].name).toBe('Kaelira');
    });
});

describe('absentKeys — who the record positively places somewhere else', () => {
    // The review can only settle what the excerpt touches. Midoriya has been `stunned` since mid 69
    // of the live My Hero Academia RP; the exercise ended at mid 71 and the story moved on for two
    // in-story days, but `markLines` posed his mark every single pass — a question the excerpt was
    // never going to answer, spending a slot out of a budget the present cast needs.
    //
    // Deliberately ABSENT rather than "present": `castAt` splits three ways, and only `elsewhere` is
    // positive evidence that somebody is not here. `unplaced` means fold does not know — the review
    // asks `[where now?]` about exactly those people — so their marks stay posed. Skipping on
    // ignorance would be the presence guess `castAt` was built to stop making.
    const cast = () => {
        const table = new Map();
        foldEntity(table, { kind: PERSON, name: 'Midoriya', place: 'Gym Gamma', status: 'present', turn: 5 });
        foldEntity(table, { kind: PERSON, name: 'Kirishima', place: 'his room at U.A.', status: 'present', turn: 5 });
        foldEntity(table, { kind: PERSON, name: 'Tokoyami', turn: 5 });
        return table;
    };

    test('somebody the record puts elsewhere is absent', () => {
        expect(absentKeys(cast(), 5, 'his room at U.A.').has('midoriya')).toBe(true);
    });

    test('somebody here is not', () => {
        expect(absentKeys(cast(), 5, 'his room at U.A.').has('kirishima')).toBe(false);
    });

    test('somebody unplaced is not absent — not knowing is not evidence', () => {
        expect(absentKeys(cast(), 5, 'his room at U.A.').has('tokoyami')).toBe(false);
    });

    test('with no scene location nobody is absent', () => {
        // `castAt` cannot place anyone against a location it does not have, and a review that went
        // quiet whenever the scene probe missed a beat would lose marks it should still be asking about.
        expect(absentKeys(cast(), 5, '').size).toBe(0);
    });
});

/*
 * ── The faction kind was readable and never writable ──
 *
 * `FACTION` is declared (`entity-table.js:71`), included in `ACTOR_KINDS` (:82), accepted by
 * `foldEntity` (:592) and resolved by the world probe (`world-table.js:182`). Nothing ever wrote
 * one, because the cast probe hardcoded `kind: PERSON` onto every entry it returned
 * (`entities.js:285`).
 *
 * Measured in the retired Wuxia campaign (`e8416d96`): 26 cast rows, all `person`. 万仙盟, 万通商行
 * and 灵丹阁 drove the whole mid-game economy and existed only as substrings inside a shopkeeper's
 * `wants`. The world-turn's rule — "a move must name a person or faction FROM THE CAST" — therefore
 * made faction motion unreachable by construction: the rule that prevents inventing actors also
 * prevented factions from ever being actors.
 */
describe('a faction is an actor the cast can hold', () => {
    test('a faction folds under its own kind and is not silently a person', () => {
        const table = new Map();
        const key = foldEntity(table, { kind: FACTION, name: '万通商行', wants: 'corner the Rank-4 pill trade', place: '烈阳城', turn: 1 });
        expect(key).toBeTruthy();
        expect(splitEntityKey(key)).toEqual({ kind: FACTION, name: expect.any(String) });
        expect(table.get(key).kind).toBe(FACTION);
    });

    test('a faction counts as an actor wherever people do', () => {
        // `ACTOR_KINDS` is what `castAt` and the world probe's root check read. A faction whose
        // sphere is the scene is present in it, the same way a person standing there is.
        expect(ACTOR_KINDS).toContain(FACTION);
        expect(ACTOR_KINDS).toContain(PERSON);
        const table = new Map();
        foldEntity(table, { kind: FACTION, name: '万仙盟', place: 'blazing sun city', turn: 1 });
        expect(entitiesOfKind(table, FACTION)).toHaveLength(1);
    });

    test('a person is untouched — every existing chat folds exactly as before', () => {
        const table = new Map();
        const key = foldEntity(table, { kind: PERSON, name: 'Líng Xiāng', turn: 1 });
        expect(splitEntityKey(key).kind).toBe(PERSON);
    });

    test('the probe\'s answer decides the kind, and is checked against the vocabulary', () => {
        // The seam that was actually shut: `entities.js` spread `kind: PERSON` over every entry, so
        // the model's answer could not have survived even once it was asked for.
        expect(actorKind('faction')).toBe(FACTION);
        expect(actorKind('FACTION')).toBe(FACTION);
        expect(actorKind('person')).toBe(PERSON);
        // A mis-tagged actor is still an actor — losing a person over a label would be worse than
        // holding them under the commoner kind.
        expect(actorKind('guild')).toBe(PERSON);
        expect(actorKind('')).toBe(PERSON);
        expect(actorKind(undefined)).toBe(PERSON);
        // And never a lead: a lead is a thread, and threads are the other half of the root rule.
        expect(actorKind(LEAD)).toBe(PERSON);
    });

    test('a kind outside the vocabulary is refused, not coerced to person', () => {
        // The existing `ACTOR_KINDS` guard already does this; the gate pins that opening the field
        // to the model did not turn it into a place where anything can be written.
        const table = new Map();
        expect(foldEntity(table, { kind: 'guild', name: 'the smiths', turn: 1 })).toBeNull();
        expect(foldEntity(table, { kind: '', name: 'the smiths', turn: 1 })).toBeNull();
        expect(table.size).toBe(0);
    });
});

/*
 * ── A standing agenda needs a position, and `wants` cannot hold one ──
 *
 * `wants` is last-write per sighting. Measured across a completed Xianxia campaign, that churn had
 * decayed 22 of 26 `wants` into occupations — "selling herbs and answering customer inquiries" —
 * and an occupation has no next state, so the world-turn's rule ("root each move in that actor's
 * stated wants; an agenda with no advance contributes no move") had nothing to work with on any
 * of the 107 passes it was armed for.
 *
 * `drive`/`driveSize` is the position. The text stays in `wants`.
 */
describe('drive — the integer a standing agenda moves along', () => {
    test('an actor can carry an agenda position', () => {
        const table = new Map();
        const key = foldEntity(table, {
            kind: FACTION, name: '万通商行', wants: 'corner the Rank-4 pill trade',
            drive: 2, driveSize: 6, turn: 1,
        });
        expect(table.get(key)).toMatchObject({ drive: 2, driveSize: 6 });
    });

    test('a sighting that says only where they are does NOT reset the agenda', () => {
        // The trap `threat` documents and solves a different way. `merge_entity` treats '' as
        // silence but 0 is not '', so a defaulted `drive: 0` would clobber. The field is omitted
        // when unsupplied instead, exactly as `mid` and `marks` are.
        const table = new Map();
        const key = foldEntity(table, { kind: FACTION, name: '万仙盟', drive: 3, driveSize: 8, turn: 1 });
        foldEntity(table, { kind: FACTION, name: '万仙盟', place: 'blazing sun city', turn: 2 });
        expect(table.get(key)).toMatchObject({ drive: 3, driveSize: 8, place: 'blazing sun city' });
    });

    test('no agenda is the default, so every existing row is untouched', () => {
        const table = new Map();
        const key = foldEntity(table, { kind: PERSON, name: 'innkeeper', wants: 'earning silver from lodgers', turn: 1 });
        expect(table.get(key).driveSize).toBeUndefined();
        expect(table.get(key).drive).toBeUndefined();
    });

    test('the size is bounded the way a progress track is', () => {
        const table = new Map();
        const a = foldEntity(table, { kind: FACTION, name: 'a', driveSize: 900, turn: 1 });
        const b = foldEntity(table, { kind: FACTION, name: 'b', driveSize: 1, turn: 1 });
        const c = foldEntity(table, { kind: FACTION, name: 'c', driveSize: 0, turn: 1 });
        expect(table.get(a).driveSize).toBe(MAX_DRIVE);
        expect(table.get(b).driveSize).toBe(2);
        // Zero is not rounded up to two — it is the "no standing agenda" answer.
        expect(table.get(c).driveSize).toBe(0);
    });

    test('a later turn wins, because the merge is versioned', () => {
        const table = new Map();
        const key = foldEntity(table, { kind: FACTION, name: 'x', drive: 1, driveSize: 6, turn: 5 });
        foldEntity(table, { kind: FACTION, name: 'x', drive: 4, driveSize: 6, turn: 9 });
        expect(table.get(key).drive).toBe(4);
        // …and an out-of-order older sighting does not undo it.
        foldEntity(table, { kind: FACTION, name: 'x', drive: 2, driveSize: 6, turn: 6 });
        expect(table.get(key).drive).toBe(4);
    });

    test('a person may carry one too — a rival is an actor with an agenda', () => {
        const table = new Map();
        const key = foldEntity(table, { kind: PERSON, name: 'Líng Xiāng', drive: 1, driveSize: 4, turn: 1 });
        expect(table.get(key)).toMatchObject({ kind: PERSON, drive: 1, driveSize: 4 });
    });
});
