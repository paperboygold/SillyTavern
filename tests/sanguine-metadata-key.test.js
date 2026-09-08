import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

/*
 * The metadata-key gate.
 *
 * Everything sanguine persists per chat lives under one property of `chat_metadata`. The name of
 * that property is a PROTOCOL constant: change it and every chat on disk changes shape.
 *
 * The rename from `fold` to `sanguine` moved the definition (`store.js`) and missed two modules
 * that had spelled the key as a literal, `ledger.js` read `chat_metadata?.fold` and `harvest.js`
 * read `obj?.chat_metadata?.fold`. Nothing threw. `campaignId()` simply returned `''` for every
 * chat, `isHydrated()` was permanently false, and the durable server-side ledger stopped hydrating
 * and stopped appending, silently, for every chat created after the rename. Measured on the live
 * Raccoon City campaign: 211 events and 127.7 KB crammed into a `chat_metadata` blob whose hard cap
 * is 128 KB, because the store that exists to relieve that cap was switched off.
 *
 * Patching those two reads is the INSTANCE. The class is that a protocol constant had more than one
 * spelling, so a rename could move one and leave the others pointing at nothing. This gate makes the
 * class impossible: `chat_metadata` may only ever be indexed by a COMPUTED key, and the literal
 * itself may appear in exactly one file.
 *
 * Structural, not a word list, it reads property-access shape, never narrative. RULE 1 clean.
 */

const SANGUINE = path.join(process.cwd(), '..', 'public', 'scripts', 'extensions', 'sanguine');
const SOURCES = fs.readdirSync(SANGUINE)
    .filter(file => file.endsWith('.js'))
    .map(file => ({ name: file, text: fs.readFileSync(path.join(SANGUINE, file), 'utf8') }));

/** The one module allowed to spell the key. Everything else imports it. */
const DEFINING_MODULE = 'metadata-key.js';

/**
 * A member access on `chat_metadata` with a literal property name.
 *
 * Catches `chat_metadata.fold`, `chat_metadata?.fold` and `obj.chat_metadata?.sanguine` alike,
 * the receiver does not matter, because a chat blob read out of a JSONL file on disk is the same
 * protocol as the live object and gets the key wrong in exactly the same way.
 */
const LITERAL_ACCESS = /\bchat_metadata\s*\??\s*\.\s*([A-Za-z_$][\w$]*)/g;

/** `chat_metadata['fold']`: the same mistake wearing brackets. */
const LITERAL_BRACKET = /\bchat_metadata\s*\??\s*\[\s*['"`]/g;

/** Code, minus comments. A docblock that mentions the old key is history, not a defect. */
function code(text) {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('the chat metadata key has exactly one spelling', () => {
    test('no module indexes chat_metadata with a literal property', () => {
        const offenders = [];
        for (const source of SOURCES) {
            const body = code(source.text);
            for (const match of body.matchAll(LITERAL_ACCESS)) {
                offenders.push(`${source.name}: chat_metadata.${match[1]}`);
            }
            if (LITERAL_BRACKET.test(body)) {
                offenders.push(`${source.name}: chat_metadata['…']`);
            }
            LITERAL_BRACKET.lastIndex = 0;
        }
        // A literal here is a key that a rename can miss. The import cannot be missed: it fails loud.
        expect(offenders).toEqual([]);
    });

    test('the key is defined once, in the module that owns it', () => {
        const definers = SOURCES.filter(source => /SANGUINE_METADATA_KEY\s*=\s*['"`]/.test(code(source.text)));
        expect(definers.map(source => source.name)).toEqual([DEFINING_MODULE]);
    });

    test('the defining module is a leaf, so anything may import it', () => {
        // `harvest.js` runs under node and cannot import `store.js` (which pulls in `script.js`),
        // which is exactly why it carried its own copy of the key and exactly why it went stale.
        // A leaf with no imports is importable from every side of the extension.
        const leaf = SOURCES.find(source => source.name === DEFINING_MODULE);
        expect(leaf).toBeDefined();
        expect(code(leaf.text)).not.toMatch(/^\s*import\s/m);
    });
});
