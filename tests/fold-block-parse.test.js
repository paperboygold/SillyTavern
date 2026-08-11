import { describe, expect, test } from '@jest/globals';

import {
    classifyBlock,
    restateInventory,
    findStateBlock,
    isEmptyValue,
    parseStateBlock,
    itemHead,
    sameItem,
    sameItemHead,
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
    test('recognises only structural emptiness', () => {
        // The English word list ("none", "nothing", "n/a", "uninjured", "unchanged", ...) is gone:
        // those words are prose in the card's language, and the model reads the block text. The
        // only refusal left is a genuinely empty string.
        expect(isEmptyValue('')).toBe(true);
        expect(isEmptyValue('   ')).toBe(true);
        expect(isEmptyValue('.')).toBe(true);
    });

    test('does not swallow real content', () => {
        expect(isEmptyValue('none')).toBe(false);
        expect(isEmptyValue('house keys, wallet')).toBe(false);
        expect(isEmptyValue('bleeding from the forearm')).toBe(false);
        expect(isEmptyValue('uninjured')).toBe(false);
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

    test('an empty value yields nothing', () => {
        expect(splitItems('')).toEqual([]);
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

    test('"uninjured" is a condition now — the reassurance list is gone', () => {
        // The old `isNegation` word list dropped "uninjured", "fine", "otherwise uninjured" and
        // "no injuries" as nothing-but-reassurance. Those are English words in the card's
        // language; whether a clause asserts the absence of harm is a reading the model answers
        // (`on: false` in the scene probe), not a list fold applies to block prose.
        expect(splitConditions('uninjured')).toEqual(['uninjured']);
        expect(splitConditions('mild hangover, otherwise uninjured')).toEqual(['mild hangover', 'otherwise uninjured']);
        expect(splitConditions('no injuries')).toEqual(['no injuries']);
        expect(splitConditions('nothing serious')).toEqual(['nothing serious']);
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

    test('a rewording is a NEW row — identity is exact, not English morphology', () => {
        // The old `resolveAlias` folded "m-65 military jacket" onto held "m-65 jacket" with a
        // stopword list. Whether two spellings name one thing is the model's reading: it reuses
        // the exact State-block name when restating, and the review probe answers `[same?]`.
        const held = new Map([['m-65 jacket', { qty: 1, at: 'carried' }]]);
        expect(restateInventory({ held, listed: ['m-65 military jacket'] }))
            .toEqual([{ item: 'm-65 military jacket', set: 1, at: 'carried' }]);
    });

    test('things that merely share a word stay separate', () => {
        const held = new Map([['silver coin', { qty: 3, at: 'carried' }]]);
        expect(restateInventory({ held, listed: ['gold coin'] }))
            .toEqual([{ item: 'gold coin', set: 1, at: 'carried' }]);
    });
});

describe('sameItem — exact-key identity, the English morphology is gone', () => {
    test('only the same string is the same thing', () => {
        // The old containment rule merged "m-65 military jacket" onto "m-65 jacket". fold no
        // longer decides identity from English stopwords; the model reports names and the review
        // probe answers `[same?]` for a pair fold cannot resolve.
        expect(sameItem('m-65 jacket', 'm-65 military jacket')).toBe(false);
        expect(sameItem('potion', 'healing potion')).toBe(false);
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
        expect(conditions).toEqual(['uninjured']);
        expect(context.get('location')).toBe('Ennerdale Street');
        expect(context.get('time')).toBe('7:22 AM');
    });

    test('picks up conditions when the narrator reports harm', () => {
        const fields = parseStateBlock('x\n[Health: bleeding from the forearm, exhausted | Inventory: none]');
        const { items, conditions } = classifyBlock(fields);
        expect(conditions).toEqual(['bleeding from the forearm', 'exhausted']);
        expect(items).toEqual(['none']);
    });

    test('keeps the health field verbatim as well as split', () => {
        // A bar cannot render "mild hangover, otherwise uninjured", and dropping the sentence in
        // favour of a flag threw away the only thing the card actually said about condition.
        const { context, conditions } = classifyBlock(
            parseStateBlock('x\n[Health: mild hangover, otherwise uninjured | Location: apartment]'));
        expect(context.get('health')).toBe('mild hangover, otherwise uninjured');
        expect(conditions).toEqual(['mild hangover', 'otherwise uninjured']);
    });

    test('does not carry empty fields into context', () => {
        const fields = parseStateBlock('x\n[Leads:  | Location: RPD lobby]');
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

    test('a rewording is a NEW row — identity is exact, not English morphology', () => {
        const held = new Map([['m-65 jacket', { qty: 1, at: 'apartment' }]]);
        expect(restateInventory({ held, listed: ['m-65 military jacket'] }))
            .toEqual([{ item: 'm-65 military jacket', set: 1, at: 'carried' }]);
    });
});

describe('sameItem — a hyphenated compound is not its parts', () => {
    test('a hyphenated compound is not matched to its parts by fold', () => {
        // The old rule split `all-black` into both the compound and its parts so containment could
        // merge `all-black dress clothes` onto `black dress clothes`. fold no longer decides
        // identity from English morphology; the model reports names and the review answers `[same?]`.
        expect(sameItem('all-black dress clothes', 'black dress clothes')).toBe(false);
    });

    test('a model number is not folded onto a reworded name', () => {
        expect(sameItem('m-65 jacket', 'm-65 military jacket')).toBe(false);
    });

    test('and things that merely share a word still stay apart', () => {
        expect(sameItem('silver coin', 'gold coin')).toBe(false);
        expect(sameItem('all-black dress clothes', 'all-weather jacket')).toBe(false);
    });
});

describe('itemHead — identity is exact, so there is no head to derive', () => {
    test('the name is returned unchanged', () => {
        expect(itemHead('healing potion')).toBe('healing potion');
        expect(itemHead('goblin knife (worn)')).toBe('goblin knife (worn)');
        expect(itemHead('m-65 military jacket')).toBe('m-65 military jacket');
        expect(itemHead('rusty hunter\'s knife with sheath')).toBe('rusty hunter\'s knife with sheath');
        expect(itemHead('')).toBe('');
    });
});

describe('sameItemHead — exact-key identity, the pair that forced the old rule', () => {
    test('a phone is not a phone number', () => {
        // The measured defect was `phone` being absorbed into `solomon's phone number`. Under
        // exact-key identity both of these hold trivially — and so does "one coat described
        // twice", which the old morphology merged by English head-token.
        expect(sameItem('phone', 'solomon\'s phone number')).toBe(false);
        expect(sameItemHead('phone', 'solomon\'s phone number')).toBe(false);
        expect(sameItemHead('phone', 'phone number')).toBe(false);
        expect(sameItemHead('m-65 jacket', 'm-65 military jacket')).toBe(false);
        expect(sameItemHead('rusty hunter\'s knife', 'rusty hunter\'s knife with sheath')).toBe(false);
    });

    test('only the same string is the same thing', () => {
        expect(sameItemHead('silver coin', 'silver coin')).toBe(true);
        expect(sameItemHead('kang\'s phone number', 'jin-woo\'s phone number')).toBe(false);
        expect(sameItemHead('iron sword', 'iron shield')).toBe(false);
        expect(sameItemHead('wrapped candy', 'wrapped candies')).toBe(false);
    });

    test('is total over junk', () => {
        expect(sameItemHead('', '')).toBe(true);
        expect(sameItemHead('', 'sword')).toBe(false);
    });
});
