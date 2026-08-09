import { describe, expect, test } from '@jest/globals';

import {
    DISPOSITIONS,
    ELSEWHERE,
    ENTITY_STALE,
    GONE,
    HERE,
    LEAD,
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
    test('drops the lore the model returns when there is no stat block', () => {
        for (const detail of [
            'holy mark grants recovery, sunfire, resistance, and aggressive sword skill',
            'holy mark urges conquest near Demon Lord influence',
            'Paulette ordered Marote fed after horses',
        ]) {
            expect(isExposition({ detail, open: '' })).toBe(true);
        }
    });

    test('an empty open clause is the whole test — nothing unresolved, not a lead', () => {
        expect(isExposition({ detail: 'the cellar door is oak', open: '' })).toBe(true);
        expect(isExposition({})).toBe(true);
    });

    test('keeps a thread whose open clause reuses every noun in the detail', () => {
        // The reason the gate is grammatical and not an overlap check: {final, command, unknown}
        // are all already in the detail, so any restatement test rejects a genuine lead.
        expect(isExposition({
            detail: 'neck brand permits pain, paralysis, recall, and an unknown final command',
            open: 'the final command is unknown',
        })).toBe(false);
    });

    test('each family of marker is recognised', () => {
        const detail = 'the northward road';
        expect(isExposition({ detail, open: 'the orders are unspecified' })).toBe(false);
        expect(isExposition({ detail, open: 'nobody has searched the cellar' })).toBe(false);
        expect(isExposition({ detail, open: 'which clergy await him' })).toBe(false);
        expect(isExposition({ detail, open: 'the debt remains to be paid' })).toBe(false);
    });

    test('a confident statement dressed as an open clause is still exposition', () => {
        expect(isExposition({
            detail: 'Paulette runs the inn',
            open: 'she runs the inn',
        })).toBe(true);
    });

    test('a question written into detail instead of open still counts', () => {
        // The fields are guidance to a model, not a contract it signed.
        expect(isExposition({
            detail: 'nobody knows who set the fire',
            open: 'the arsonist',
        })).toBe(false);
    });
});

describe('the exposition gate, wired', () => {
    const window = 'The hero read his abilities in the mark: recovery, sunfire, resistance. '
        + 'Marote wore a neck brand with one final command nobody had spoken.';

    test('rejects lore and accepts the thread, in one batch', () => {
        const table = new Map();
        const result = foldEntities(table, [
            { kind: LEAD, name: 'hero abilities', detail: 'holy mark grants recovery, sunfire, resistance', open: '' },
            { kind: LEAD, name: 'marote brand', detail: 'neck brand, one command unspoken', open: 'the final command is unknown' },
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
describe('samePlace — subset, not intersection', () => {
    test('one name refining another is the same place', () => {
        expect(samePlace('the bedroom', 'manor bedroom')).toBe(true);
        expect(samePlace('the stableyard', 'stableyard gate')).toBe(true);
        expect(samePlace('in the dining hall', 'the dining hall')).toBe(true);
    });

    test('merely sharing a word is NOT the same place', () => {
        // Scribe compared places by bidirectional substring, which makes these one room because
        // they share "hall". That is the mechanism this replaces.
        expect(samePlace('the dining hall', 'the great hall')).toBe(false);
        expect(samePlace('north tower', 'south tower')).toBe(false);
    });

    test('articles, prepositions and possessives carry no place information', () => {
        expect(samePlace('in his bedroom', 'the bedroom')).toBe(true);
        expect(placeTokens('in the manor bedroom')).toEqual(new Set(['manor', 'bedroom']));
    });

    test('an unknown place matches nothing — including another unknown', () => {
        expect(samePlace('', 'the bedroom')).toBe(false);
        expect(samePlace('', '')).toBe(false);
    });
});

describe('presenceOf — the dispatch law applied honestly', () => {
    test('co-location decides', () => {
        expect(presenceOf({ place: 'manor bedroom' }, 'the bedroom')).toBe(HERE);
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
        for (const [name, place] of [
            ['Paulette', 'the bedroom'], ['Solomon', 'the bedroom'],
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
 * ── The exposition gate matches WORDS, not letter runs ──
 *
 * Found by Phase B while replaying the migration over the Raccoon City chat and left for Phase C as
 * the same class as `isNegation` keeping `functional` (FOLD-REDESIGN.md §0.1-4, and the LANDED note
 * in §10): `UNSETTLED` was compiled without anchors, so every member matched as a substring. `RPD
 * data shows escalating incidents` passed the gate on the `how` inside "s-how-s", and it was the ONE
 * clause in that campaign that routed — so the single measurable output of the block-shadow rule on
 * that chat was produced by an accident of spelling.
 */
describe('UNSETTLED has word boundaries', () => {
    test('the Raccoon City clause is exposition again', () => {
        expect(isExposition({ open: 'RPD data shows escalating incidents' })).toBe(true);
    });

    test('every interrogative that hides inside a common word', () => {
        // These are the shortest members and the most common English fragments, which is why they
        // are where the absence bit: each one below is a sentence with no question in it.
        for (const clause of [
            'the crowd shows no sign of thinning',        // how
            'the whole building is dark',                 // who
            'she showed him the way',                     // how, show
            'whatever happens, the shutters are down',    // what
            'whenever the radio crackles he flinches',    // when
            'the whys of it are beside the point',        // why
        ]) {
            expect(isExposition({ open: clause })).toBe(true);
        }
    });

    test('and a real open question still passes', () => {
        // The gate is grammatical rather than lexical, and the asymmetry is the whole of it: a real
        // open question reuses the nouns it is about, so overlap cannot separate them — only the one
        // word that turns a description into a question can.
        expect(isExposition({ open: 'the final command is unknown' })).toBe(false);
        expect(isExposition({ open: 'nobody has searched the cellar' })).toBe(false);
        expect(isExposition({ open: 'who took the keys is not established' })).toBe(false);
        expect(isExposition({ open: 'the orders have not been read' })).toBe(false);
        expect(isExposition({ open: 'payment is still outstanding' })).toBe(false);
        expect(isExposition({ open: 'awaiting the broker\'s answer' })).toBe(false);
    });

    test('an empty clause is still background — silence is not a question', () => {
        expect(isExposition({ open: '' })).toBe(true);
        expect(isExposition({})).toBe(true);
    });
});

/*
 * A review-confirmed merge, at the layer that owns the alias machinery. Kang existed twice for the
 * whole of the live chat and could not stop (FOLD-RPG-GAP.md §2); the broker pair reopened within 48
 * hours of being hand-fixed (§0.1).
 */
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
