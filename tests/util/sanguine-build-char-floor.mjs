/*
 * Build the per-character floor from Unicode's Unihan database.
 *
 * Source: https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip -> Unihan_Readings.txt
 * Fields: kMandarin (the reading) and kDefinition (the gloss). Unicode's own data, permissively
 * licensed, and the only source that covers EVERY ideograph rather than a curated subset.
 */
import { readFileSync, writeFileSync } from 'fs';

const SRC = process.env.UNIHAN ?? './Unihan_Readings.txt';
const OUT = new URL('../../public/scripts/extensions/sanguine-gloss/data/char-floor.js', import.meta.url).pathname;

/** Definitions run long ("central; center, middle; in the midst of; hit (target); attain"). A hover
 *  wants the first couple of senses, not a dictionary column. */
const MAX_SENSES = 3;
const MAX_LEN = 72;

const rows = new Map();
for (const line of readFileSync(SRC, 'utf8').split('\n')) {
    if (!line || line[0] === '#') continue;
    const [code, field, ...rest] = line.split('\t');
    if (field !== 'kMandarin' && field !== 'kDefinition') continue;
    const value = rest.join('\t').trim();
    if (!value) continue;
    const cp = parseInt(code.slice(2), 16);
    // BMP CJK Unified Ideographs + Extension A. Beyond this is rare/historic and would double the
    // file for characters a story will not use.
    const inRange = (cp >= 0x3400 && cp <= 0x9FFF) || (cp >= 0xF900 && cp <= 0xFAFF);
    if (!inRange) continue;
    const row = rows.get(cp) ?? {};
    if (field === 'kMandarin') row.say = value.split(/\s+/)[0];
    else row.mean = value;
    rows.set(cp, row);
}

const trim = (text) => {
    const senses = text.split(/\s*;\s*/).filter(Boolean).slice(0, MAX_SENSES).join('; ');
    return senses.length > MAX_LEN ? `${senses.slice(0, MAX_LEN - 1).trimEnd()}…` : senses;
};

const out = [];
for (const [cp, row] of [...rows].sort((a, b) => a[0] - b[0])) {
    if (!row.say && !row.mean) continue;
    const ch = String.fromCodePoint(cp);
    const say = row.say ? JSON.stringify(row.say) : null;
    const mean = row.mean ? JSON.stringify(trim(row.mean)) : null;
    const parts = [say && `say:${say}`, mean && `mean:${mean}`].filter(Boolean).join(',');
    out.push(`${JSON.stringify(ch)}:{${parts}}`);
}

const header = `/**
 * sanguine-gloss/data/char-floor.js — a reading and a gloss for EVERY ideograph.
 *
 * GENERATED. Do not hand-edit; rebuild with \`tests/util/sanguine-build-char-floor.mjs\`.
 *
 * ── Why this file exists, and why it is not "more entries" ──
 *
 * The curated lexicons hold what somebody thought to type. Measured against a completed campaign,
 * that was 187 entries covering 37.6% of the hanzi on screen and 134 of 1123 distinct characters —
 * 989 characters could never be hovered at all, including both halves of the player's own name.
 *
 * Adding entries chases an infinite tail. This closes it instead. \`segmentText\` falls through to
 * plain text only when NOTHING matches at a position, and the shortest possible match is one
 * character — so once every character has an entry, the segmenter cannot fail. Coverage stops being
 * a number that can regress and becomes a property of the structure.
 *
 * Source: Unicode's Unihan database (kMandarin, kDefinition), BMP ideographs and Ext A.
 * https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip
 *
 * @type {Record<string, {say?: string, mean?: string}>}
 */
export const CHAR_FLOOR = {
`;

writeFileSync(OUT, header + out.join(',\n') + ',\n};\n', 'utf8');
console.log('characters:', out.length);
console.log('bytes:', readFileSync(OUT).length.toLocaleString());
console.log('rebuild: UNIHAN=/path/to/Unihan_Readings.txt node tests/util/sanguine-build-char-floor.mjs');
