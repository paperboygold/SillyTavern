import { describe, expect, test } from '@jest/globals';

import {
    classifyBlock,
    restateInventory,
    findStateBlock,
    isEmptyValue,
    parseStateBlock,
    itemHead,
    resolveAlias,
    sameItem,
    sameItemHead,
    splitClauses,
    splitConditions,
    splitItems,
    stripStateBlock,
} from '../public/scripts/extensions/fold/block-parse.js';

/** A reply in the shape the Raccoon City card actually produces. */
const REPLY = `The woman flinches at your voice, then covers the receiver with one hand.

"My brother works nights at Spencer Memorial," she says.

---
[Time: 7:22 AM | Date: Wednesday, September 23, 1998 | Location: Ennerdale Street | Conditions: cool, overcast | Health: uninjured | Inventory: house keys, wallet, bus pass | Immediate contacts: anxious woman at payphone | Leads: Spencer Memorial has stopped answering]`;

describe('findStateBlock', () => {
    test('finds a trailing block after a horizontal rule', () => {
        const found = findStateBlock(REPLY);
        expect(found).not.toBeNull();
        expect(found.inner).toContain('Time: 7:22 AM');
    });

    test('finds a block with no rule above it', () => {
        expect(findStateBlock('Prose.\n[Time: 8:00 AM | Health: fine]')).not.toBeNull();
    });

    test('ignores a bracketed aside in the middle of prose', () => {
        // Only a trailing block is bookkeeping; mid-prose brackets are dialogue or stage direction.
        expect(findStateBlock('He said [pointedly: no] and then walked on into the rain.')).toBeNull();
    });

    test('ignores a trailing bracket that is not labelled fields', () => {
        expect(findStateBlock('The door closes.\n[a distant siren]')).toBeNull();
    });

    test('is total over junk', () => {
        expect(findStateBlock('')).toBeNull();
        expect(findStateBlock(null)).toBeNull();
        expect(findStateBlock('no block here at all')).toBeNull();
    });
});

describe('stripStateBlock', () => {
    test('removes the block and its rule, leaving clean prose', () => {
        const stripped = stripStateBlock(REPLY);
        expect(stripped).not.toContain('[Time:');
        expect(stripped).not.toMatch(/-{3,}\s*$/);
        expect(stripped).toContain('Spencer Memorial,"');
        expect(stripped.endsWith('she says.')).toBe(true);
    });

    test('leaves a message with no block untouched', () => {
        expect(stripStateBlock('Just prose.')).toBe('Just prose.');
    });
});

describe('parseStateBlock', () => {
    test('parses labelled fields', () => {
        const fields = parseStateBlock(REPLY);
        expect(fields.get('location')).toBe('Ennerdale Street');
        expect(fields.get('health')).toBe('uninjured');
    });

    test('keeps colons inside values, so times survive', () => {
        // Splitting on every colon would turn "7:22 AM" into a label and a fragment.
        expect(parseStateBlock(REPLY).get('time')).toBe('7:22 AM');
    });

    test('returns null when there is no block', () => {
        expect(parseStateBlock('Just prose.')).toBeNull();
    });
});

describe('isEmptyValue', () => {
    test('recognises the many ways a narrator says nothing', () => {
        for (const value of ['none', 'None.', 'nothing', 'n/a', 'uninjured', '-', '',
            'as established by {{user}}', 'unchanged from before', 'no change']) {
            expect(isEmptyValue(value)).toBe(true);
        }
    });

    test('does not swallow real content', () => {
        expect(isEmptyValue('house keys, wallet')).toBe(false);
        expect(isEmptyValue('bleeding from the forearm')).toBe(false);
    });
});

describe('splitItems', () => {
    test('splits a plain list', () => {
        expect(splitItems('house keys, wallet, bus pass'))
            .toEqual(['house keys', 'wallet', 'bus pass']);
    });

    test('keeps a parenthesised qualifier with its item', () => {
        // "Beretta (12 rounds, one spare)" is one item, not three.
        expect(splitItems('Beretta M92F (12 rounds, one spare magazine), crowbar'))
            .toEqual(['Beretta M92F (12 rounds, one spare magazine)', 'crowbar']);
    });

    test('splits on semicolons too', () => {
        expect(splitItems('rope; flint; tinderbox')).toEqual(['rope', 'flint', 'tinderbox']);
    });

    test('yields nothing for an empty value', () => {
        expect(splitItems('none')).toEqual([]);
        expect(splitItems('as established by {{user}}')).toEqual([]);
    });
});

describe('splitConditions', () => {
    test('splits on punctuation only — the measured shape of a real health line', () => {
        expect(splitConditions('bleeding from the forearm, exhausted'))
            .toEqual(['bleeding from the forearm', 'exhausted']);
        expect(splitConditions('hangover mostly eased; mild arm fatigue'))
            .toEqual(['hangover mostly eased', 'mild arm fatigue']);
    });

    test('"and" joins one affliction, and every live occurrence proves it', () => {
        // Pulled from the raw messages of all four live chats: every "and" in a Health/Conditions
        // line joins a compound predicate about one wound, and none separates two. Splitting them
        // is what put `lacerations cleaned` beside `bandaged` and `calf scabbed` beside
        // `rebandaged` in the live header — one wound filed twice, two of three slots spent.
        expect(splitConditions('lacerations cleaned and bandaged'))
            .toEqual(['lacerations cleaned and bandaged']);
        expect(splitConditions('calf scabbed and rebandaged, left arm bruised shoulder to elbow'))
            .toEqual(['calf scabbed and rebandaged', 'left arm bruised shoulder to elbow']);
        expect(splitConditions('left arm bruised and sore')).toEqual(['left arm bruised and sore']);
    });

    test('yields nothing for uninjured', () => {
        expect(splitConditions('uninjured')).toEqual([]);
    });

    test('drops a clause that is nothing but reassurance', () => {
        // Narrators habitually qualify: "mild hangover, otherwise uninjured". Keeping both halves
        // put "otherwise uninjured" in the panel as though it were an affliction.
        expect(splitConditions('mild hangover, otherwise uninjured')).toEqual(['mild hangover']);
        expect(splitConditions('no injuries')).toEqual([]);
        expect(splitConditions('nothing serious')).toEqual([]);
    });

    test('a concessive clause is ONE condition, kept whole — the §0.1-4 fix', () => {
        // This used to split on "but" and keep both halves, then rely on `isNegation`'s enumerated
        // English to drop the reassuring one. "Functional" was not on the list, so the live panel
        // carried the good news as a wound for the rest of the session (FOLD-REDESIGN.md §0.1-4).
        // The split is gone: the affliction survives with its qualifier attached.
        expect(splitConditions('left arm heavily bruised but functional'))
            .toEqual(['left arm heavily bruised but functional']);
        // And the case the old split got right by accident now succeeds for a reason: the wound is
        // kept rather than being rescued from a fragment by a word list.
        expect(splitConditions('winded but unhurt')).toEqual(['winded but unhurt']);
    });
});

describe('restateInventory — a block reports TOTALS, not changes', () => {
    test('a listed item becomes an absolute quantity', () => {
        expect(restateInventory({ held: new Map(), listed: ['rope'] }))
            .toEqual([{ item: 'rope', set: 1, at: 'carried' }]);
    });

    test('a repeated name is a count, not two entries', () => {
        expect(restateInventory({ held: new Map(), listed: ['coin', 'coin', 'coin'] }))
            .toEqual([{ item: 'coin', set: 3, at: 'carried' }]);
    });

    test('an item merely absent from the list is NOT removed', () => {
        // The block is evidence, not authority. A narrator that forgets the crowbar has not
        // destroyed it, so nothing at all is proposed for it.
        const held = new Map([['crowbar', { qty: 1, at: 'carried' }]]);
        expect(restateInventory({ held, listed: ['rope' ] }))
            .toEqual([{ item: 'rope', set: 1, at: 'carried' }]);
    });

    test('a rewording lands on the item already held', () => {
        const held = new Map([['m-65 jacket', { qty: 1, at: 'carried' }]]);
        expect(restateInventory({ held, listed: ['m-65 military jacket'] }))
            .toEqual([{ item: 'm-65 jacket', set: 1, at: 'carried' }]);
    });

    test('things that merely share a word stay separate', () => {
        const held = new Map([['silver coin', { qty: 3, at: 'carried' }]]);
        expect(restateInventory({ held, listed: ['gold coin'] }))
            .toEqual([{ item: 'gold coin', set: 1, at: 'carried' }]);
    });
});

describe('sameItem', () => {
    test('containment means one thing', () => {
        expect(sameItem('m-65 jacket', 'm-65 military jacket')).toBe(true);
        expect(sameItem('potion', 'healing potion')).toBe(true);
    });

    test('overlap alone does not', () => {
        expect(sameItem('silver coin', 'gold coin')).toBe(false);
        expect(sameItem('iron sword', 'iron shield')).toBe(false);
    });
});

describe('classifyBlock', () => {
    test('routes fields to inventory, conditions and context', () => {
        const { items, conditions, context } = classifyBlock(parseStateBlock(REPLY));
        expect(items).toEqual(['house keys', 'wallet', 'bus pass']);
        expect(conditions).toEqual([]);
        expect(context.get('location')).toBe('Ennerdale Street');
        expect(context.get('time')).toBe('7:22 AM');
    });

    test('picks up conditions when the narrator reports harm', () => {
        const fields = parseStateBlock('x\n[Health: bleeding from the forearm, exhausted | Inventory: none]');
        const { items, conditions } = classifyBlock(fields);
        expect(conditions).toEqual(['bleeding from the forearm', 'exhausted']);
        expect(items).toEqual([]);
    });

    test('keeps the health field verbatim as well as split', () => {
        // A bar cannot render "mild hangover, otherwise uninjured", and dropping the sentence in
        // favour of a flag threw away the only thing the card actually said about condition.
        const { context, conditions } = classifyBlock(
            parseStateBlock('x\n[Health: mild hangover, otherwise uninjured | Location: apartment]'));
        expect(context.get('health')).toBe('mild hangover, otherwise uninjured');
        expect(conditions).toEqual(['mild hangover']);
    });

    test('does not carry empty fields into context', () => {
        const fields = parseStateBlock('x\n[Leads: none | Location: RPD lobby]');
        const { context } = classifyBlock(fields);
        expect(context.has('leads')).toBe(false);
        expect(context.get('location')).toBe('RPD lobby');
    });

    test('is total over a null block', () => {
        expect(classifyBlock(null)).toEqual({ items: [], conditions: [], context: new Map() });
    });
});

describe('the restatement leak — the x7 flat cap', () => {
    /**
     * Fold restated totals into a held table, the way deriveState does.
     * @param {Map<string, {qty: number}>} held Held items.
     * @param {string[]} listed Listed names.
     */
    const applyRestatement = (held, listed) => {
        for (const { item, set } of restateInventory({ held, listed })) {
            held.set(item, { qty: set });
        }
    };

    test('twenty restatements of the same list still hold one of each', () => {
        // The actual failure: the count climbed by one per turn, forever, and survived a relaunch
        // because the +1s were real events in the ledger.
        const held = new Map([['grey flat cap', { qty: 1 }]]);
        for (let turn = 0; turn < 20; turn++) {
            applyRestatement(held, ['grey flat cap']);
        }
        expect(held.get('grey flat cap')).toEqual({ qty: 1 });
    });

    test('a restatement REPAIRS an already-corrupted count', () => {
        // This is what makes the fix retroactive: an existing chat heals on its next turn rather
        // than needing the ledger migrated.
        const held = new Map([['grey flat cap', { qty: 7 }]]);
        applyRestatement(held, ['grey flat cap']);
        expect(held.get('grey flat cap')).toEqual({ qty: 1 });
    });

    test('a genuine second one is still believed', () => {
        const held = new Map([['grey flat cap', { qty: 1 }]]);
        applyRestatement(held, ['grey flat cap', 'grey flat cap']);
        expect(held.get('grey flat cap')).toEqual({ qty: 2 });
    });

    test('resolveAlias leaves an unknown name alone', () => {
        expect(resolveAlias(new Map(), 'crowbar')).toBe('crowbar');
    });
});

describe('splitClauses — recovering the list a comma-joined field lost', () => {
    const LEADS = 'Locally saved RPD records confirm a September 15-18 missing-persons cluster in '
        + 'Arklay County, Adele Ricci of the closed corner clinic is missing, Umbrella contractor '
        + 'access remains suspended pending review, RPD has publicly cited a systems issue and '
        + 'increased call volume, county sheriff has issued an Arklay trail warning, Spencer '
        + 'Memorial is difficult to reach, with limited lines and restricted emergency-department '
        + 'visitors';

    test('finds each lead the run actually contains', () => {
        expect(splitClauses(LEADS)).toHaveLength(6);
    });

    test('keeps a continuation attached to the clause it belongs to', () => {
        // "with limited lines and restricted visitors" has no finite verb, so it is not a lead —
        // it is the tail of the sentence before it.
        expect(splitClauses(LEADS)[5])
            .toBe('Spencer Memorial is difficult to reach, with limited lines and restricted emergency-department visitors');
    });

    test('each statement stands on its own', () => {
        expect(splitClauses(LEADS)[1]).toBe('Adele Ricci of the closed corner clinic is missing');
        expect(splitClauses(LEADS)[2]).toBe('Umbrella contractor access remains suspended pending review');
    });

    test('a genuine list is left as a list', () => {
        // No finite verb anywhere, so every comma is a delimiter. Without this check the clause
        // rule would glue two contacts into one.
        expect(splitClauses('Ramen shop owner, older man in raincoat'))
            .toEqual(['Ramen shop owner', 'older man in raincoat']);
    });

    test('a single statement stays single', () => {
        expect(splitClauses('Spencer Memorial has stopped answering routine calls'))
            .toEqual(['Spencer Memorial has stopped answering routine calls']);
    });

    test('is total over empty input', () => {
        expect(splitClauses('')).toEqual([]);
        expect(splitClauses(null)).toEqual([]);
    });
});

describe('a restated total lands where the item already is', () => {
    test('a block listing something you shelved does not drag it back to your pockets', () => {
        // The complaint, exactly: groceries put away in the apartment kept reading as "Carrying".
        // The card's block says what you HAVE; it has no opinion on where.
        const held = new Map([
            ['canned tuna', { qty: 1, at: 'apartment' }],
            ['m-65 jacket', { qty: 1, at: 'carried' }],
        ]);
        expect(restateInventory({ held, listed: ['canned tuna', 'm-65 jacket'] })).toEqual([
            { item: 'canned tuna', set: 1, at: 'apartment' },
            { item: 'm-65 jacket', set: 1, at: 'carried' },
        ]);
    });

    test('something never seen before defaults to carried', () => {
        expect(restateInventory({ held: new Map(), listed: ['crowbar'] }))
            .toEqual([{ item: 'crowbar', set: 1, at: 'carried' }]);
    });

    test('a rewording inherits the place of the item it resolves onto', () => {
        const held = new Map([['m-65 jacket', { qty: 1, at: 'apartment' }]]);
        expect(restateInventory({ held, listed: ['m-65 military jacket'] }))
            .toEqual([{ item: 'm-65 jacket', set: 1, at: 'apartment' }]);
    });
});

describe('a hyphen split one garment into two', () => {
    test('a hyphenated compound matches its own parts', () => {
        // `all-black dress clothes` and `black dress clothes` sat in the panel as two items,
        // because `all-black` is one token and `black` is not inside it.
        expect(sameItem('all-black dress clothes', 'black dress clothes')).toBe(true);
    });

    test('a model number survives — it is not shredded into letters and digits', () => {
        expect(sameItem('m-65 jacket', 'm-65 military jacket')).toBe(true);
    });

    test('and things that merely share a word still stay apart', () => {
        expect(sameItem('silver coin', 'gold coin')).toBe(false);
        expect(sameItem('all-black dress clothes', 'all-weather jacket')).toBe(false);
    });
});

describe('itemHead — what a noun phrase is actually about', () => {
    test('the last significant token, parentheticals ignored', () => {
        expect(itemHead('healing potion')).toBe('potion');
        expect(itemHead('goblin knife (worn)')).toBe('knife');
        expect(itemHead('m-65 military jacket')).toBe('jacket');
    });

    test('a prepositional phrase modifies the head, it is not the head', () => {
        // The live ledger holds `rusty hunter's knife with sheath`. Heading it on `sheath` made the
        // mention gate refuse a window that says "reaching weakly for the knife in its belt".
        expect(itemHead('rusty hunter\'s knife with sheath')).toBe('knife');
        expect(itemHead('trauma kit with extra coagulant')).toBe('kit');
        expect(itemHead('reinforced bracers and greaves')).toBe('bracers');
    });

    test('names too short to have a significant token still have a head', () => {
        // Falling back to '' would give every short name a head that matches everything.
        expect(itemHead('hp')).toBe('hp');
        expect(itemHead('axe')).toBe('axe');
        expect(itemHead('')).toBe('');
    });
});

describe('sameItemHead — the strict merge, and the pair that forced it', () => {
    test('a phone is not a phone number', () => {
        // The measured defect: a block listing `phone` was absorbed into the ledger's
        // `solomon's phone number`, because {phone} ⊆ {solomon, phone, number}.
        expect(sameItem('phone', 'solomon\'s phone number')).toBe(true);
        expect(sameItemHead('phone', 'solomon\'s phone number')).toBe(false);
        expect(sameItemHead('phone', 'phone number')).toBe(false);
    });

    test('one coat described twice still merges', () => {
        // The case the containment rule was built for. Narrowing must not cost it.
        expect(sameItemHead('m-65 jacket', 'm-65 military jacket')).toBe(true);
        expect(sameItemHead('all-black dress clothes', 'black dress clothes')).toBe(true);
        expect(sameItemHead('potion', 'healing potion')).toBe(true);
        expect(sameItemHead('rusty hunter\'s knife', 'rusty hunter\'s knife with sheath')).toBe(true);
    });

    test('contradicting qualifiers keep two things apart', () => {
        expect(sameItemHead('silver coin', 'gold coin')).toBe(false);
        expect(sameItemHead('kang\'s phone number', 'jin-woo\'s phone number')).toBe(false);
        expect(sameItemHead('mana-shackle bracers', 'reinforced bracers and greaves')).toBe(false);
        expect(sameItemHead('sword of dawn', 'sword of night')).toBe(false);
    });

    test('different heads are different things, however much else they share', () => {
        expect(sameItemHead('iron sword', 'iron shield')).toBe(false);
        expect(sameItemHead('wrapped candy', 'wrapped candies')).toBe(false);
    });

    test('is total over junk', () => {
        expect(sameItemHead('', '')).toBe(true);
        expect(sameItemHead('', 'sword')).toBe(false);
    });
});
