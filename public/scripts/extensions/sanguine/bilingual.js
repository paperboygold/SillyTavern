/**
 * fold/bilingual.js: dialogue in a language you are learning, with English underneath.
 *
 * What this is for.
 *
 * Roleplay is the best comprehensible-input machine anybody has built: hours of motivated reading,
 * in context, about things you care about, with a partner who will say it again differently if you
 * ask. What it normally lacks is the target language. This turns that on: the characters speak
 * Mandarin (or whatever you set), and every line carries an English gloss immediately after it, so
 * you read the Chinese first and check yourself against the English rather than the other way
 * round.
 *
 * Dialogue, not narration.
 *
 * The narration stays in English on purpose. Krashen's i+1 argument in one sentence: input teaches
 * when it is slightly beyond you and understood anyway, and the way to keep it understood is to
 * leave the scaffolding in place. Narration is the scaffolding; it tells you what is happening, so
 * that when 「你敢碰我妹妹？」 arrives you already know who is angry and why. Translating everything
 * produces a wall of characters and an English wall beside it, which is a bilingual text, not a
 * lesson.
 *
 * Names are the exception that has to be in-script: a character called 陈小龙 whose name renders as
 * "Chen Xiaolong" is a character you never learn to read. So names are written in the target script
 * with a pronunciation gloss on first appearance only.
 *
 * What this costs fold, honestly.
 *
 * fold's extraction is language-agnostic by construction: RULE 1 forbids deciding anything about
 * the fiction from English words, so every judgement of meaning is a schema answer from the model,
 * which reads Chinese as happily as English. What degrades is the residual token arithmetic used by
 * the DUPLICATE detectors: `nearIdentity`, `statusKeyFor` and `contentTokens` all split on
 * whitespace, and Han does not space its words. `invariant-table.js:67-76` measures it:
 * `二十银两` shares no token with `银两` and the pair is missed.
 *
 * That failure is quiet and safe: a missed pair is a merge that does not happen, never a wrong
 * merge, and the review probe (which asks the model rather than counting tokens) is the designed
 * backstop for exactly this. Expect slightly more duplicate rows in a Chinese campaign and a review
 * that earns its keep.
 */

import { extension_settings } from '../../extensions.js';

/** The module's settings namespace, matching the rest of fold. */
const MODULE = 'sanguine';

/**
 * The default target language.
 *
 * A string rather than an enum because the narrator is a language model and will do Japanese,
 * Korean, Spanish or Classical Chinese on the same instruction. Naming a default that is not
 * English is the point of the feature; naming a LIST would be fold deciding what is learnable.
 */
export const DEFAULT_LANGUAGE = 'Mandarin Chinese (simplified characters)';

/** @returns {{enabled: boolean, language: string}} The current settings, with defaults applied. */
export function settings() {
    const stored = extension_settings[MODULE]?.bilingual ?? {};
    return {
        enabled: !!stored.enabled,
        language: String(stored.language ?? '').trim() || DEFAULT_LANGUAGE,
    };
}

/**
 * The injected directive.
 *
 * Written as a format contract rather than a request, for the reason every other fold directive is:
 * a narrator told "try to include some Chinese" produces one line in three and drifts back to
 * English within a scene. The rules are numbered, the gloss position is fixed, and the failure mode
 * the model is most likely to reach for, translating the narration too, is named and forbidden.
 *
 * @returns {string} The block, or '' when the toggle is off.
 */
export function render() {
    const { enabled, language } = settings();
    if (!enabled) {
        return '';
    }
    return [
        `[Language mode: the player is learning ${language}]`,
        `1. Every line of SPOKEN DIALOGUE is written in ${language}, in that language's own script.`,
        '   Immediately after each spoken line, give a natural English translation in italics and parentheses.',
        '   Example shape: 「原文在这里。」 *(The English translation goes here.)*',
        '2. NARRATION, action and description stay in English. Do not translate them, and do not write',
        '   them in both languages; the English narration is what makes the dialogue understandable.',
        `3. NAMES of people and places are written in ${language}'s script wherever they appear,`,
        '   including in the English narration and translations. The first time each name appears,',
        '   follow it once with its pronunciation and meaning in parentheses; afterwards use the',
        '   script alone.',
        '4. Keep the dialogue at the level of a determined beginner: everyday vocabulary, short',
        '   sentences, and the same words reused across a scene rather than a thesaurus. When a',
        '   character must say something complex, let them say it simply and let the narration carry',
        '   the nuance.',
        '5. Never comment on the language, never break character to teach, and never omit the English',
        '   gloss on a spoken line; a line the player cannot check is a line they cannot learn from.',
    ].join('\n');
}
