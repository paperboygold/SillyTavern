import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

/*
 * The no-prose-regex gate.
 *
 * fold runs an LLM over every chat window. The model already read the prose, in whatever language
 * it was written, so fold must never re-read it with English word lists, stoplists, or substring
 * judgements. The governing law is `trigger-table.js:178-189`: fold's own vocabulary (schema enums,
 * protocol keys) may be English; reading the NARRATIVE never is.
 *
 * This file is the enforcement AGENTS.md promises. It reads every fold source file and refuses a
 * hardcoded pattern that would judge PROSE:
 *
 *   · English time phrases ("come morning", "hours later"), the model reports elapsed
 *     structurally; a regex that reads them is fold re-reading what it was told.
 *   · Scale words ("thousands", "millions"), the model reports magnitude.
 *   · English status-subject modifiers ("mild", "mostly", "severe"), the model reports subject.
 *   · An English interrogative/ignorance vocabulary deciding "is this a thread", the model
 *     reports `unresolved`.
 *   · Amount/scale/currency words ("thousand", "million"), the model reports numbers.
 *
 * Protocol vocabulary is ALLOWED: enum values (`carried`, `assets`, `money`, `open`, `settled`),
 * schema field names, block-field labels, punctuation shape, and `Intl.Segmenter` word counts. The
 * line is drawn by what a pattern decides: if it needs language understanding, it belongs in a
 * schema and the model answers it. If it is fold's own key space or pure shape, it stays.
 *
 * The patterns below are deliberately small and named for the measured failure each closes. They
 * are a gate against REGRESSION, not a style preference: every one of these existed in the tree and
 * was removed in the sweep that followed the Royal Succession / Time Stop / Star Wars noise.
 */

const FOLD = path.join(process.cwd(), '..', 'public', 'scripts', 'extensions', 'sanguine');
const SOURCES = fs.readdirSync(FOLD)
    .filter(file => file.endsWith('.js'))
    .map(file => ({ name: file, text: fs.readFileSync(path.join(FOLD, file), 'utf8') }));

/** Word-list classes that read narrative time, amount, or status, each with its replacement. */
const FORBIDDEN = [
    {
        name: 'English time phrases in a regex',
        // "come morning", "hours later", "overnight", "the next day", the scene probe reports
        // elapsed_days/minutes/phase structurally. A regex that recognises these phrases reads
        // the narrative.
        re: /(?:new RegExp|\.match|\.test|\.search)\([^)]*(?:come\s+the\s+next\s+(?:morning|day)|hours\s+later|overnight|first\s+light)/,
    },
    {
        name: 'English scale words deciding a magnitude',
        // "thousands", "millions", "dozens", the delta schema reports `magnitude`.
        re: /(?:new RegExp|\.test|\.match|\.search)\([^)]*(?:hundreds?|thousands?|millions?|billions?|dozens?)\b/,
    },
    {
        name: 'English interrogatives deciding "is this a thread"',
        // "whether", "unknown", "unresolved", "pending" as a gate over `open` text, the schema
        // reports `unresolved` as a boolean.
        re: /(?:new RegExp|\.test|\.match)\([^)]*(?:whether|unresolved|pending)\b[^)]*(?:open|thread|detail)/,
    },
    {
        name: 'English amount scale words in an answer parser',
        // "thousand"/"million" in parseAmount, the review schema reports `amount` as a number.
        re: /(?:new RegExp|\.test|\.match|\.search)\([^)]*(?:thousand|million|billion)\b/,
    },
    {
        name: 'A prose word-list mention gate',
        // The model's `mentions` report is the admission authority now. A NEW gate that builds an
        // English vocabulary and token-matches it against the window is a regression. (The token
        // fallbacks in `isMentioned`/`mentions`/`mentionsDial` are the sanctioned block-path
        // fallback and are NOT flagged, they match fold's OWN tracked names, not a vocabulary.)
        re: /(?:new RegExp|new Set|\.includes|\.test)\([^)]*(?:known|vocab|english|wordlist|word_list)\b/i,
    },
];

describe('no hardcoded prose judgements in the fold extension', () => {
    test('every forbidden prose-matching class is absent from the source', () => {
        const hits = [];
        for (const source of SOURCES) {
            for (const rule of FORBIDDEN) {
                const match = source.text.match(rule.re);
                if (match) {
                    const line = source.text.slice(0, match.index).split('\n').length;
                    hits.push(`${source.name}:${line}, ${rule.name}`);
                }
            }
        }
        expect(hits).toEqual([]);
    });

    test('the model-answered schema fields the sweep added are present', () => {
        // The replacements exist: if a future change removes one, this names the regression.
        const scenes = SOURCES.find(s => s.name === 'scene.js').text;
        const entities = SOURCES.find(s => s.name === 'entities.js').text;
        const clocks = SOURCES.find(s => s.name === 'clocks.js').text;
        const review = SOURCES.find(s => s.name === 'review-table.js').text;
        const state = SOURCES.find(s => s.name === 'state.js').text;
        expect(scenes).toContain('elapsed_days');
        expect(scenes).toContain('clock_hour');
        expect(entities).toContain('mentions:');
        expect(clocks).toContain('unresolved');
        expect(review).toContain('nothing:');
        // Identity is the model's answer: the delta schema carries `same_as` so the model names the
        // exact held item when restating, and fold merges only on that word.
        expect(state).toContain('same_as');
    });
});
