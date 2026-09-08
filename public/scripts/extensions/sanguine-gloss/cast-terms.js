/**
 * sanguine-gloss/cast-terms.js — the story's own names, as glossary entries.
 *
 * ── The words you meet most are the ones no dictionary has ──
 *
 * Measured over a completed Xianxia campaign, the most frequently un-glossed runs on screen were,
 * in order: 池 (664), 德 (664), 凌香 (200), 烈阳城 (88), 赤焰居 (80). The first two are halves of the
 * PLAYER'S OWN NAME. No general dictionary will ever contain them, and no amount of curation
 * anticipates the names a story invents — so this is not a data problem that shipping a bigger
 * lexicon solves.
 *
 * It is a plumbing problem. Sanguine already tracks those names: every cast row carries a `name`
 * and an `aka` list, and between them a row routinely holds BOTH scripts —
 * `name: "Chí Guāngdé", aka: "池光德"` and `name: "凌香", aka: "Líng Xiāng, …"`. One is the term to
 * gloss, the other is how to say it. The gloss extension had a context tier built for exactly this
 * and nothing was feeding it.
 *
 * ── Reading the script, not the language ──
 *
 * Which form is the term and which is the reading is decided by Unicode script properties —
 * `\p{Script=Han}` for the term, tone diacritics for the reading. That is a question about writing
 * systems, answerable for any pair of scripts, and it is not the extension guessing at meaning from
 * an English word list. Sanguine's own rule against prose judgement is upheld: the model wrote both
 * forms into the cast table, and this only decides which alphabet each one is in.
 */

/** Any Han ideograph. The term side of a pair. */
const HAN = /\p{Script=Han}/u;

/** Tone marks. Their presence is what distinguishes a romanised READING from a translated name. */
const TONED = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜĀÁǍÀĒÉĚÈĪÍǏÌŌÓǑÒŪÚǓÙǕǗǙǛ]/u;

/** Longest first, so `insertTrie` sees the full name before any prefix of it. */
const byLength = (a, b) => b.length - a.length;

/**
 * Split a row's `name` and `aka` into the forms it offers.
 *
 * @param {object} row A cast row.
 * @returns {{terms: string[], readings: string[], plain: string[]}} Forms by script.
 */
export function formsOf(row) {
    const candidates = [
        String(row?.name ?? ''),
        ...String(row?.aka ?? '').split(','),
    ].map(part => part.trim()).filter(Boolean);

    const terms = [];
    const readings = [];
    const plain = [];
    for (const candidate of candidates) {
        if (HAN.test(candidate)) {
            terms.push(candidate);
        } else if (TONED.test(candidate)) {
            readings.push(candidate);
        } else {
            plain.push(candidate);
        }
    }
    return {
        terms: [...new Set(terms)].sort(byLength),
        readings: [...new Set(readings)],
        plain: [...new Set(plain)],
    };
}

/**
 * Turn a cast table into glossary entries for its Han-script names.
 *
 * A row contributes nothing unless it actually holds a Han form — most rows in a non-CJK story
 * hold none, and this returns an empty object for them rather than inventing anything.
 *
 * @param {Map<string, object>|Record<string, object>} cast The cast table.
 * @param {number} [limit] Most entries to produce, newest-touched first.
 * @returns {Record<string, {say?: string, mean: string, more?: string, source?: string}>} Entries.
 */
export function castTerms(cast, limit = 200) {
    const rows = cast instanceof Map ? [...cast.values()] : Object.values(cast ?? {});
    const entries = {};

    // Freshest first, so a capped harvest keeps the people currently on screen.
    const ordered = [...rows].sort((a, b) => (Number(b?.turn) || 0) - (Number(a?.turn) || 0));

    for (const row of ordered) {
        if (Object.keys(entries).length >= limit) break;
        const { terms, readings, plain } = formsOf(row);
        if (!terms.length) continue;

        // The reading is a romanisation when one was recorded; otherwise the plainest alternate,
        // which for a translated name ("Manager Qian") is still the most useful thing to show.
        const say = readings[0] ?? plain[0] ?? '';
        // What they ARE, preferring the other-script name over a description of what they look like.
        const mean = plain[0] ?? readings[0] ?? String(row?.detail ?? '').trim();
        const more = String(row?.facts ?? '').trim() || String(row?.wants ?? '').trim();

        for (const term of terms) {
            if (entries[term]) continue;
            entries[term] = {
                ...(say && say !== term ? { say } : {}),
                mean: mean || term,
                ...(more ? { more } : {}),
                source: 'cast',
            };
        }
    }

    return entries;
}
