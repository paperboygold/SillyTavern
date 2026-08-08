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
        // ── An empty reply is a BUDGET failure, not a garbage one ──
        //
        // `looksTruncated` cannot see this. It reports "cut off" by finding an unterminated `{` or
        // `[`, and a reply that emitted nothing at all has no open structure to find — so it
        // returned false, the caller filed the cycle under `unparseable`, and the one remedy that
        // would have worked (ask again with a bigger budget) was skipped precisely when it applied.
        //
        // Reasoning models make this the common case rather than an edge one: reasoning tokens are
        // charged against the same `max_tokens` as the answer, so a budget that is merely tight
        // produces a complete, empty, perfectly-well-formed nothing.
        return { value: null, truncated: false, empty: true, objects: [] };
    }

    // Tier 1: it is just JSON.
    const direct = tryParseObject(text);
    if (direct) {
        return { value: direct, truncated: false, empty: false, objects: [direct] };
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
            return { value: pickObject(objects), truncated: false, empty: false, objects };
        }
    }

    // Tier 3: the reply was cut off mid-structure. Close it and try again.
    //
    // This is cheaper than the retry it replaces — a truncated reply already contains everything
    // the model managed to say, and the only thing wrong with it is the brackets it never got to
    // write. Borrowed from Marinara's `closeUnbalancedJsonish`; measured on a real chat,
    // `extract:retry-truncated` fired twice in thirteen attempts, each costing a second call.
    if (looksTruncated(text)) {
        const repaired = tryParseObject(closeUnbalanced(text));
        if (repaired) {
            return { value: repaired, truncated: true, empty: false, objects: [repaired] };
        }
    }

    return { value: null, truncated: looksTruncated(text), empty: false, objects: [] };
}

/**
 * Choose between several objects found in one reply.
 *
 * ── Later beats richer ──
 *
 * This used to take the object with the most keys, reasoning that a model which restates often
 * emits an empty envelope beside the real one. That is true, and it is the wrong rule: a reasoning
 * model drafts a structure, reconsiders, and emits the corrected one *after* — so "richest" can
 * return the draft the model itself rejected, and the caller cannot tell, because a draft parses
 * exactly as well as an answer.
 *
 * Marinara's `jsonish.ts` tries the last region first for the same reason. Preferring the last
 * NON-EMPTY object keeps the original protection — an empty envelope never wins — while letting a
 * correction supersede the thing it corrects, which is what a later write means everywhere else in
 * this codebase.
 *
 * Fragments are merged only when their keys are disjoint. A model that emits `{"events": …}` and
 * `{"entities": …}` as two top-level objects has split one answer; a draft and its correction share
 * keys and are therefore never merged.
 *
 * @param {object[]} objects Parsed objects, in the order they appeared.
 * @returns {object} The one to use.
 */
export function pickObject(objects) {
    const filled = objects.filter(object => Object.keys(object).length);
    if (!filled.length) {
        return objects[objects.length - 1];
    }

    const merged = {};
    let disjoint = true;
    for (const object of filled) {
        for (const key of Object.keys(object)) {
            if (key in merged) {
                disjoint = false;
            }
            merged[key] = object[key];
        }
    }
    return disjoint && filled.length > 1 ? merged : filled[filled.length - 1];
}

/**
 * Close a reply that was cut off mid-structure.
 *
 * Replays the open-bracket stack: terminate a dangling string, drop the partial token after the
 * last comma, then close every structure still open, innermost first. What comes back is not the
 * reply the model meant to send — it is the longest prefix of it that is valid JSON, which is
 * strictly more than nothing.
 *
 * @param {string} text A truncated reply.
 * @returns {string} Something that may parse.
 */
export function closeUnbalanced(text) {
    const stack = [];
    let inString = false;
    let escaped = false;

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
        } else if (ch === '{' || ch === '[') {
            stack.push(ch === '{' ? '}' : ']');
        } else if (ch === '}' || ch === ']') {
            stack.pop();
        }
    }

    let out = String(text ?? '');
    if (inString) {
        // An unterminated string ends the reply mid-word. Closing it keeps the partial value, which
        // is usually a truncated summary — worth more than discarding the whole cycle.
        out += '"';
    }
    // Whatever followed the last comma is an incomplete member; JSON has no way to express half of
    // one, so it goes.
    out = out.replace(/,\s*("(?:[^"\\]|\\.)*"\s*:?\s*)?$/, '');
    return out + stack.reverse().join('');
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
        return { value, truncated: false, empty: false };
    }
    if (typeof value === 'string') {
        const analysis = analyzeJson(value);
        return { value: analysis.value, truncated: analysis.truncated, empty: !!analysis.empty };
    }
    // Neither an object nor a string: nothing came back at all, which is the same budget failure
    // an empty string is.
    return { value: null, truncated: false, empty: true };
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
