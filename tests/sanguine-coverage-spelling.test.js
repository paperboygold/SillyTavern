import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import {
    PERSON,
    aliasKeys,
    foldEntities,
    nameForms,
    normalizeEntityName,
} from '../public/scripts/extensions/sanguine/entity-table.js';
import { foldTicks } from '../public/scripts/extensions/sanguine/thread-table.js';

/*
 * sanguine-coverage-spelling: one name in two scripts is one name.
 *
 * What this file is defending, and what it measured.
 *
 * Admission is by COVERAGE: a proposal is admitted when the model's own `mentions` report names it
 * ([ROUTER]). That rule is right and nothing here loosens it. What it left open is record linkage
 * between two writings of one name, and RULE 1 forbids closing that with a similarity metric,
 * which could not close it anyway: `Zhāng Lín` and `张林` share not one character.
 *
 * Every case below is replayed from the live campaign, not invented. All 149 traced passes of
 * `data/default-user/extensions/sanguine-traces/Wuxia World RPG - 2026-08-20@19h08m26s160ms.jsonl`
 * were run back through `foldEntities` and `foldTicks` with the window reconstructed from each
 * pass's own prompt. `reject:not-mentioned` fired 13 times:
 *
 *   entity gate   6   turns 74, 76, 112 (x3), 141
 *   thread gate   7   turns 59, 111, 116, 119, 133, 135, 141
 *   inventory     0   `state-table.js` can only fire it on an empty report; it never was
 *
 * Twelve of the thirteen are the model disagreeing with itself inside ONE call: it listed a person
 * or a stake in `mentions` under one writing and named it in the proposal under another. The
 * thirteenth (entity, turn 141) is the gate working, see the last describe block.
 *
 * The fix has two halves and this file holds both to their measured reach:
 *
 *   the ask         `coverage.js` `oneSpelling`, shared with `chronicle.js` where it was already
 *                   working. Reaches all twelve if obeyed; unobservable from here, because
 *                   observing it costs a live model call.
 *   the floor       `entity-table.js` `nameForms`: the bracket split. Reaches 2 of the 13 with no
 *                   model cooperation at all, and those two are exactly the shape fold's OWN
 *                   `bilingual.js` rule 3 instructs the narrator to write.
 */

const SANGUINE = path.join(process.cwd(), '..', 'public', 'scripts', 'extensions', 'sanguine');

/** A cast proposal, with only the fields the coverage gate reads. @returns {object} The proposal. */
const person = (name, aka = '') => ({ kind: PERSON, name, aka, place: 'a room', detail: 'standing' });

/** The report, normalised exactly as `entities.js` normalises it. @returns {Set<string>} Keys. */
const report = (...names) => new Set(names.map(name => normalizeEntityName(name)?.key).filter(Boolean));

/** The thread report, lowercased exactly as `clocks.js` lowercases it. @returns {Set<string>} Names. */
const stakes = (...names) => new Set(names.map(name => String(name).trim().toLowerCase()));

describe('nameForms, the punctuation that separates two writings of one name', () => {
    test('a bracketed second writing is a second form, not a different name', () => {
        expect(nameForms('刘三（Liú Sān）')).toEqual(['刘三（Liú Sān）', '刘三', 'Liú Sān']);
    });

    test('pronunciation AND meaning, because rule 3 asks the narrator for both', () => {
        // `bilingual.js` render(): "follow it once with its pronunciation and meaning in
        // parentheses". So the aside itself splits on the separators, and a sect is three writings.
        expect(nameForms('青云门 (Qīngyún Mén, Azure Cloud Sect)'))
            .toEqual(['青云门 (Qīngyún Mén, Azure Cloud Sect)', '青云门', 'Qīngyún Mén', 'Azure Cloud Sect']);
    });

    test('a name with no brackets has exactly one form', () => {
        expect(nameForms('Adele Ricci')).toEqual(['Adele Ricci']);
        expect(nameForms('  the   widow ')).toEqual(['the widow']);
    });

    test('nothing is a form of nothing', () => {
        expect(nameForms('')).toEqual([]);
        expect(nameForms(null)).toEqual([]);
        expect(nameForms('（）')).toEqual(['（）']);
    });

    test('aliasKeys carries the forms, so a record answers to both writings', () => {
        // This is what stops the split producing two ROWS as well as two refusals: a later pass
        // that reports plain 刘三 resolves onto the row 刘三（Liú Sān） opened.
        expect(aliasKeys({ name: '刘三（Liú Sān）' })).toEqual(['刘三（liú sān）', '刘三', 'liú sān']);
    });

    test('the ideographic comma separates aliases, because it IS the comma', () => {
        // The ASCII-only separator class was fold deciding that only names punctuated in ASCII may
        // be split, the substring-proxy failure in different clothes.
        expect(aliasKeys({ name: '张林', aka: '林兄、Forest Zhang' }))
            .toEqual(['张林', '林兄', 'forest zhang']);
    });
});

describe('the entity gate, the five pairs the live Wuxia campaign refused', () => {
    /** Run one proposal against one report. @returns {object} The outcome. */
    const fold = (proposal, mentioned, windowText = 'unrelated prose about a road') =>
        foldEntities(new Map(), [proposal], { mentioned, windowText, turn: 1 });

    test('turn 74: 刘三（Liú Sān） against mentions ["刘三", "xiao an"]', () => {
        // The window is 169 characters of English narration that names neither form. Admission is
        // by the report alone, and the report has him.
        const out = fold(person('刘三（Liú Sān）'), report('刘三', 'Xiao An'));
        expect(out.rejected).toEqual([]);
        expect(out.accepted).toBe(1);
        expect(out.byForm).toBe(1);
    });

    test('turn 76: the same man, the same disagreement, a different report', () => {
        const out = fold(person('刘三（Liú Sān）'), report('刘三', '老马', '悦来客栈'));
        expect(out.rejected).toEqual([]);
        expect(out.byForm).toBe(1);
    });

    test('turn 112: Zhāng Lín / Lǐ Qī / Ling Xiang against a Han-script report', () => {
        // The three the floor cannot reach, and the honest reason.
        //
        // These share no character with their own report entries, so no structural rule can link
        // them without a transliteration table, which is exactly the language-reading RULE 1
        // forbids. `aka` is the escape hatch the schema already provides and the model left it
        // empty on all three. The next test is the same call with `aka` answered.
        const mentioned = report('Chí Guāngdé', '张林', '李七', '凌香', 'the elder', '长老', '青云门');
        for (const name of ['Zhāng Lín', 'Lǐ Qī', 'Ling Xiang']) {
            const out = fold(person(name), mentioned);
            expect(out.rejected.map(entry => entry.reason)).toEqual(['not-mentioned']);
        }
    });

    test('turn 112, with the aka the probe is asked for: admitted, by the alias set', () => {
        // The gate reads the whole alias set, not the single `name` string, and has since the
        // coverage rule landed. `entities.js` `instruction()` now names this case outright, a
        // second script IS a second writing of the name, because every English example it carried
        // read as being about titles.
        const mentioned = report('Chí Guāngdé', '张林', '李七', '凌香');
        const out = fold(person('Zhāng Lín', '张林'), mentioned);
        expect(out.rejected).toEqual([]);
        expect(out.byForm).toBe(1);
    });

    test('the model writing the report in the compound form works too', () => {
        // The mirror of turn 74. Expanding forms on only one side would be half a rule.
        const out = fold(person('刘三'), report('刘三（Liú Sān）'));
        expect(out.rejected).toEqual([]);
    });
});

describe('the entity gate is not weakened', () => {
    const fold = (proposal, mentioned) =>
        foldEntities(new Map(), [proposal], { mentioned, windowText: 'a road, a cart, rain', turn: 1 });

    test('turn 141: "the elder" is refused, and that refusal is correct', () => {
        // The brief that commissioned this fix listed turn 141 among the correct proposals. It is
        // not one. The pass's window (1,397 characters) contains neither "elder" nor 长老, and the
        // report is ["苏小婉", "Sū Xiǎowǎn", "青云门", "客院", "山脚茶馆"], the model neither named
        // him nor wrote him. The row's `aka` ("eldest, 青云门 elder") shares the sect name with the
        // report, and that is precisely the alias-to-alias match `canonicalKey` refuses for New
        // Eldoria's reasons. He stays refused.
        const out = fold(person('the elder', 'eldest, 青云门 elder'),
            report('苏小婉', 'Sū Xiǎowǎn', '青云门', '客院', '山脚茶馆'));
        expect(out.rejected.map(entry => entry.reason)).toEqual(['not-mentioned']);
    });

    test('a person nothing in the report or the window names is still refused', () => {
        const out = fold(person('Vesk'), report('Gorak', 'the widow'));
        expect(out.rejected.map(entry => entry.reason)).toEqual(['not-mentioned']);
    });

    test('a bracket cannot smuggle in a name the model never wrote', () => {
        // Every form is a substring of a field the model itself filled, so the floor can only ever
        // admit a writing the model produced. A stem that matches nothing still fails.
        const out = fold(person('Grimble (the apothecary)'), report('Armorer', 'the dwarf'));
        expect(out.rejected.map(entry => entry.reason)).toEqual(['not-mentioned']);
    });

    test('byForm stays zero when the name as written is what the report carried', () => {
        const out = fold(person('Adele Ricci'), report('Adele Ricci'));
        expect(out.accepted).toBe(1);
        expect(out.byForm).toBe(0);
    });
});

describe('the thread gate, the seven ticks the live Wuxia campaign refused', () => {
    /** One tick against one report. @returns {object} The outcome. */
    const fold = (tick, mentioned) =>
        foldTicks(new Map(), [tick], { mentioned, windowText: 'prose the dial is not named in', turn: 1 });

    /*
     * Why every one of these is the ask and not the gate.
     *
     * 8 ticks were proposed across the whole campaign, 7 refused here, 1 accepted, and all 7 were
     * for dials the table did NOT already hold. A new dial's name is authored by the model in the
     * same call that writes `mentions`, so there is no stored label for it to disagree with. The
     * two strings differed for exactly one reason: nothing asked it to write them the same way.
     * `clocks.js` now does, through the same `oneSpelling` clause `chronicle.js` has carried since
     * the coverage rule landed.
     */
    const REFUSED = [
        { turn: 59, name: 'Who wrote the note luring Xiǎo Ān north?', about: 'The identity of the orchestrator is revealed.', where: '', mentions: ['Qīng Hé Zhèn', 'Xiao An', 'north cliffs'] },
        { turn: 111, name: 'the entrance trial for Qīngyún Mén', about: 'join the sect and access the spirit spring', where: 'Qīngyún Mén', mentions: ['the spirit spring', 'the entrance trial', 'the sect'] },
        { turn: 116, name: 'Zhào Tiěshān\'s arena bout', about: '', where: 'Summit of Qīngyún Mén, courtyard', mentions: ['Zhào Tiěshān', 'arena'] },
        { turn: 119, name: 'win first place in the Qīngyún Sect entrance trial', about: 'first place reward is three days in the spirit spring', where: 'Summit of Qīngyún Mén, courtyard', mentions: ['Qīngyún Sect entrance trial', 'next bout'] },
        { turn: 133, name: 'cultivate in the spirit spring', about: 'potential to rise one level', where: 'Qīngyún Spirit Spring', mentions: ['灵泉'] },
        { turn: 135, name: 'cultivation progress', about: 'breakthrough achieved', where: '', mentions: ['突破了'] },
        { turn: 141, name: 'the deadline to leave Qīngyún Mén', about: 'guest quarters cleared at the hour of the dragon tomorrow', where: 'Qīngyún Mén', mentions: ['客院', '山脚茶馆'] },
    ];

    test.each(REFUSED)('turn $turn: "$name" is not in its own report', ({ name, about, where, mentions }) => {
        // Reproduced so the defect is falsifiable: no structural change may make these pass, because
        // there is nothing structural in them to read. What closes them is the model listing the
        // dial's name in `mentions`, which the instruction now requires.
        const out = fold({ name, about, where, tick: 1 }, stakes(...mentions));
        expect(out.rejected.map(entry => entry.reason)).toEqual(['not-mentioned']);
        expect(out.accepted).toBe(0);
    });

    test('the same seven, with the dial named in the report, all advance', () => {
        // The one-line difference the instruction now asks for. Each dial is admitted, and none of
        // them by a form, the model wrote one spelling, which is the whole point.
        for (const { name, about, where, mentions } of REFUSED) {
            const out = fold({ name, about, where, tick: 1, kind: 'doom', size: 6 },
                stakes(...mentions, name));
            expect(out.rejected).toEqual([]);
            expect(out.accepted).toBe(1);
            expect(out.byForm).toBe(0);
        }
    });

    test('the report and the dial name are compared in ONE key space', () => {
        // `normalizeThreadName` strips markdown, collapses whitespace and drops a review's `T6`
        // label; the report used to be only lowercased. Two key spaces, one comparison, a report
        // entry the model emphasised could never match the name it was emphasising.
        const out = fold({ name: 'the entrance trial', tick: 1 }, stakes('**the  entrance   trial**'));
        expect(out.rejected).toEqual([]);
    });

    test('a stake in two scripts is one stake', () => {
        const out = fold({ name: '灵泉（the spirit spring）', tick: 1 }, stakes('灵泉'));
        expect(out.rejected).toEqual([]);
        expect(out.byForm).toBe(1);
    });

    test('a dial the report never touches still cannot advance', () => {
        // The refusal this gate exists for: a hallucinated advance on something the excerpt never
        // went near. Nothing above may make this admissible.
        const out = fold({ name: 'the Blight reaches Briarwood', about: 'the village is abandoned', where: 'Briarwood', tick: 2 },
            stakes('the residency window', 'the Smokewood'));
        expect(out.rejected.map(entry => entry.reason)).toEqual(['not-mentioned']);
    });
});

describe('the window behind the report, what restoring the OR recovers', () => {
    /*
     * The gate said "symmetric with the entity probe's" and was an if/else.
     *
     * `foldEntities` reads report OR window; `foldTicks` read report ELSE window, so on the
     * on-screen path the structural test was unreachable. Restoring the OR admits 20 of the 23
     * refusals measured across three campaigns and refuses 3. The three it still refuses are
     * Wuxia turns 116 and 135, where the window is Han and the dial was named in English, so
     * neither the report nor the window carries it, and one in Raccoon City. Those are what the
     * `oneSpelling` clause in `clocks.js` has to close, and it cannot be measured from a trace.
     */
    const fold = (tick, mentioned, windowText) =>
        foldTicks(new Map(), [tick], { mentioned, windowText, turn: 1 });

    // Verbatim from the turn-111 window of `Wuxia World RPG - 2026-08-20@19h08m26s160ms.jsonl`.
    const TURN_111 = '**Chí Guāngdé\'s status: Registering for the sect entrance trial.**\n\n'
        + '「池光德，十六岁，来自雾谷村。」 *(Chí Guāngdé, sixteen years old, from Misty Valley Village.)*\n\n'
        + 'The grey-robed elder writes the name down without looking up.';

    test('turn 111: the report words the stake differently, the window words it the dial\'s way', () => {
        // `mentions: ["the spirit spring", "the entrance trial", "the sect"]` against
        // `name: "the entrance trial for Qīngyún Mén"`. The report is not a match under any rule
        // that is not a substring proxy, and the window says "the sect entrance trial" outright.
        const tick = { name: 'the entrance trial for Qīngyún Mén', tick: 1, kind: 'progress', size: 3, about: 'join the sect and access the spirit spring', where: 'Qīngyún Mén' };
        expect(fold(tick, stakes('the spirit spring', 'the entrance trial', 'the sect'), TURN_111).accepted).toBe(1);
        // The report alone still does not admit it: that is the half the ask has to close.
        expect(fold(tick, stakes('the spirit spring', 'the entrance trial', 'the sect'), 'nothing of the kind here')
            .rejected.map(entry => entry.reason)).toEqual(['not-mentioned']);
    });

    test('turn 135: neither the report nor the window carries it, and it stays refused', () => {
        // `mentions: ["突破了"]`, `name: "cultivation progress"`, and a window written in Han. Two
        // writings of one idea with no character in common, the case no structural rule may reach,
        // and the reason the fix has a half that lives at the ask.
        const out = fold({ name: 'cultivation progress', about: 'breakthrough achieved', where: '', tick: 1 },
            stakes('突破了'), '你盘膝而坐，灵气涌入丹田。水面平静如镜。');
        expect(out.rejected.map(entry => entry.reason)).toEqual(['not-mentioned']);
    });
});

describe('one rule, three callers', () => {
    /*
     * Why this reads source.
     *
     * The property under test is that the cast, thread and chronicle probes ask for the wording
     * discipline through the SAME sentence rather than three hand-written versions of it, and that
     * is a property of the call sites, not of any value they produce. Importing all three would
     * mean shimming `script.js`, `world-info.js` and the whole storage layer to assert a string.
     * `sanguine-observe.test.js` reads source for the same class of build gate.
     */
    const source = (file) => fs.readFileSync(path.join(SANGUINE, file), 'utf8');

    test('every probe that gates on coverage calls oneSpelling', () => {
        for (const file of ['entities.js', 'clocks.js', 'chronicle.js']) {
            expect(source(file)).toContain('oneSpelling({');
            expect(source(file)).toContain('from \'./coverage.js\'');
        }
    });

    test('nobody has re-written the clause by hand beside the shared one', () => {
        // The failure this guards is a probe growing its own "word it the same way" sentence, which
        // then drifts from the other two on the next edit. The literal lives in `coverage.js` and
        // nowhere else.
        const owners = fs.readdirSync(SANGUINE)
            .filter(name => name.endsWith('.js') && name !== 'coverage.js')
            .filter(name => source(name).includes('one spelling for one'));
        expect(owners).toEqual([]);
    });

    test('the counter the gate raises is declared', () => {
        // `observe.js` `KNOWN_RULES` is the build gate: an undeclared counter fails it.
        expect(source('observe.js')).toContain('\'covered:by-form\'');
        for (const file of ['entities.js', 'clocks.js']) {
            expect(source(file)).toContain('observe.note(\'covered:by-form\')');
        }
    });
});
