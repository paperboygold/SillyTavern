import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A rejection without its raw proposal is a tally, not a diagnostic.
 *
 * `observe.noteRejections` writes every refusal to the diagnostics log with the raw fragment and
 * the window it was read from, and the panel's "N rejected" footer opens it. That is the whole
 * mechanism for answering "what did the model actually send?", and it only works if the raw is
 * there.
 *
 * It was not, in two files. `review-table.js` pushed `{item, reason}` at eight sites, and
 * `world-table.js` pushed `{who, reason}` at two, where `noteRejections` reads `item`, so those
 * logged with a blank subject as well as a blank body. The cost is measured: `review-wrong-shape`
 * fired 19 times in the Time Stop chat and 7 more in New Eldoria, twenty-six recorded refusals of
 * which not one says what was refused. Diagnosing it meant reasoning about the schema instead of
 * reading the ledger.
 *
 * This is the gate that pins the class, in the shape `fold-no-prose-regex.test.js` uses: it reads
 * every source file and fails on a rejection literal with no `raw`. Adding a site without one
 * cannot pass review, which is the only enforcement that survives the next person in a hurry.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FOLD = path.join(HERE, '..', 'public', 'scripts', 'extensions', 'sanguine');

/** Source files to read: fold's own modules, not `lib/` (which rejects nothing). */
const sources = fs.readdirSync(FOLD)
    .filter(name => name.endsWith('.js'))
    .map(name => ({ name, text: fs.readFileSync(path.join(FOLD, name), 'utf8') }));

/**
 * Every rejection literal in a file, as `{line, text}`.
 *
 * Reads the whole STATEMENT rather than the line. The first version matched one line, which is how
 * `auditLedger`'s `noteRejections([...])` slipped past it and put 94 raw-free entries into a
 * 120-slot diagnostics log; a multi-line literal would have slipped past it in exactly the same
 * way. Balance the brackets from the match and the shape stops mattering.
 *
 * @param {string} text File contents.
 * @returns {Array<{line: number, text: string}>} Rejection statements.
 */
function rejections(text) {
    const lines = text.split('\n');
    const out = [];
    // Two shapes reach `noteRejections`: a validator collecting into `rejected` and returning it,
    // and a caller handing one straight over. Both are gated.
    const opens = /rejected\.push\(\{|noteRejections\(\[\{/;
    for (let at = 0; at < lines.length; at++) {
        if (!opens.test(lines[at])) {
            continue;
        }
        // Accumulate until the parentheses opened on this line balance again, the statement, not
        // the line. Bounded so an unbalanced file cannot hang the suite.
        let depth = 0;
        const parts = [];
        for (let n = at; n < Math.min(lines.length, at + 40); n++) {
            parts.push(lines[n].trim());
            for (const ch of lines[n]) {
                if (ch === '(') depth++;
                else if (ch === ')') depth--;
            }
            if (depth <= 0) break;
        }
        out.push({ line: at + 1, text: parts.join(' ') });
    }
    return out;
}

describe('every rejection carries what was rejected', () => {
    test('the gate can see the sites at all', () => {
        // A floor, so a refactor that renames `rejected.push` turns this suite red instead of
        // silently passing over nothing. Measured at the time of writing: 39 sites, down from 44
        // because collapsing the review's two arrays into one deleted three refusal paths outright.
        const total = sources.reduce((sum, file) => sum + rejections(file.text).length, 0);
        expect(total).toBeGreaterThanOrEqual(35);
    });

    test('no rejection is pushed without its raw proposal', () => {
        // The PROPERTY, not the identifier: `{item: String(raw?.id ?? ''), reason}` mentions `raw`
        // and carries none, which is exactly the site this gate exists to catch.
        const carries = text => /[,{(]\s*raw\s*[,:}]/.test(text);
        const bare = [];
        for (const file of sources) {
            for (const site of rejections(file.text)) {
                if (!carries(site.text)) {
                    bare.push(`${file.name}:${site.line}  ${site.text}`);
                }
            }
        }
        expect(bare).toEqual([]);
    });

    test('no rejection is pushed without the subject the log reads', () => {
        // `noteRejections` reads `rejection.item`. `world-table.js` pushed `{who, reason}`, so two
        // rules logged with an empty subject, the tally said how often, and nothing said about what.
        const bare = [];
        for (const file of sources) {
            for (const site of rejections(file.text)) {
                if (!/\bitem\b/.test(site.text)) {
                    bare.push(`${file.name}:${site.line}  ${site.text}`);
                }
            }
        }
        expect(bare).toEqual([]);
    });
});
