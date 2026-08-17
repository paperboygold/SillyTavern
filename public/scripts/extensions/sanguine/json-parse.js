/**
 * fold/json-parse.js — recovering an object from whatever the model actually said.
 *
 * Pure, dependency-free, and therefore unit-testable.
 *
 * SillyTavern's `jsonSchema` option is only *enforced* for chat completion and for TextGen with
 * Tabby or llama.cpp; elsewhere it is ignored and prose comes back. ST can pre-sanitize for us,
 * but its `returnInvalid: false` mode replaces anything it cannot parse with the string "{}" —
 * including fenced blocks and preambled objects that are perfectly recoverable. fold therefore
 * asks for the raw text and does its own recovery here.
 *
 * Region finding is a brace-depth scan that tracks string and escape state, not a regex. A greedy
 * `/\{[\s\S]*\}/` spans from the first brace to the LAST one anywhere in the reply, so it breaks
 * on two very ordinary replies: an object followed by prose containing a stray `}` (an emoticon
 * will do it), and two objects in one reply. Both produced invalid JSON and abandoned a cycle that
 * had usable output sitting in it. The scanning approach is borrowed from Marinara Engine's
 * `jsonish.ts` (AGPL-3.0, same licence as this fork).
 */

/**
 * Parse a model reply into an object.
 * @param {string} raw The model output.
 * @returns {object|null} The parsed object, or null when nothing usable was found.
 */
export function parseLooseJson(raw) {
    return analyzeJson(raw).value;
}

/**
 * Parse, and also report whether the reply looks cut off rather than merely unusable.
 *
 * Truncated-and-retryable is a different failure from garbage: the first is fixed by asking again
 * with a larger budget, the second by not asking again at all. Without the distinction both look
 * like "no usable JSON" and the caller can only ever give up.
 *
 * @param {string} raw The model output.
 * @returns {{value: object|null, truncated: boolean, objects: object[]}} The analysis.
 */
export function analyzeJson(raw) {
    const text = String(raw ?? '').trim();
    if (!text) {
        return { value: null, truncated: false, objects: [] };
    }

    // Tier 1: it is just JSON.
    const direct = tryParseObject(text);
    if (direct) {
        return { value: direct, truncated: false, objects: [direct] };
    }

    // Tier 2: JSON inside a fenced code block. Scan the fence body the same way, since a fence can
    // contain a preamble or several objects too.
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const bodies = fenced ? [fenced[1].trim(), text] : [text];

    for (const body of bodies) {
        const objects = balancedRegions(body)
            .map(tryParseObject)
            .filter(Boolean);
        if (objects.length) {
            // Several objects in one reply: prefer the richest, since a model that restates often
            // emits an empty envelope alongside the real one.
            const best = objects.reduce((a, b) =>
                Object.keys(b).length > Object.keys(a).length ? b : a);
            return { value: best, truncated: false, objects };
        }
    }

    return { value: null, truncated: looksTruncated(text), objects: [] };
}

/**
 * Every balanced `{...}` region in the text, outermost only.
 *
 * Tracks string and escape state so a brace inside a string value — or in prose after the object —
 * cannot open or close a region.
 *
 * @param {string} text Input.
 * @returns {string[]} Candidate JSON substrings, in order.
 */
export function balancedRegions(text) {
    const regions = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
        } else if (ch === '{') {
            if (depth === 0) start = i;
            depth++;
        } else if (ch === '}') {
            if (depth > 0) {
                depth--;
                if (depth === 0 && start !== -1) {
                    regions.push(text.slice(start, i + 1));
                    start = -1;
                }
            }
        }
    }

    return regions;
}

/**
 * Does this reply look cut off mid-structure?
 *
 * An unclosed object, array or string at the end of the input means the model ran out of budget
 * rather than refusing or rambling — the one failure worth retrying.
 *
 * @param {string} text Input.
 * @returns {boolean} True if the text ends inside an unterminated structure.
 */
export function looksTruncated(text) {
    let depth = 0;
    let brackets = 0;
    let inString = false;
    let escaped = false;
    let sawOpen = false;

    for (const ch of String(text ?? '')) {
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
        } else if (ch === '{') {
            depth++;
            sawOpen = true;
        } else if (ch === '}') {
            depth--;
        } else if (ch === '[') {
            brackets++;
            sawOpen = true;
        } else if (ch === ']') {
            brackets--;
        }
    }

    return sawOpen && (inString || depth > 0 || brackets > 0);
}

/**
 * Normalize whatever an extraction request returned into an object.
 *
 * The two request paths hand back different shapes: `generateRaw` returns a string, while a
 * connection-profile request with `json_schema` returns already-parsed content. Callers should
 * not have to care which one produced the value.
 *
 * @param {any} value Raw result from an extraction request.
 * @returns {object|null} The object, or null when nothing usable was found.
 */
export function coerceExtraction(value) {
    return analyzeExtraction(value).value;
}

/**
 * Coerce, and report truncation.
 * @param {any} value Raw result from an extraction request.
 * @returns {{value: object|null, truncated: boolean}} The analysis.
 */
export function analyzeExtraction(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return { value, truncated: false };
    }
    if (typeof value === 'string') {
        const analysis = analyzeJson(value);
        return { value: analysis.value, truncated: analysis.truncated };
    }
    return { value: null, truncated: false };
}

/**
 * JSON.parse, but only accepting non-null objects.
 * @param {string} text Candidate JSON.
 * @returns {object|null} The object, or null.
 */
function tryParseObject(text) {
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}
