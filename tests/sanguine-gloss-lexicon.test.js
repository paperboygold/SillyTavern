import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    clearContextTerms,
    getGlossEntry,
    rebuildActiveTrie,
    registerBatchContext,
    registerContextTerm,
    segmentAndGloss,
} from '../public/scripts/extensions/sanguine-gloss/lexicon.js';

describe('sanguine-gloss lexicon — three-tier resolution', () => {
    test('resolves tier-2 Wuxia domain terms with pronunciation and lore', () => {
        const entry = getGlossEntry('金丹');
        assert.ok(entry);
        assert.equal(entry.say, 'jīn dān');
        assert.match(entry.mean, /Golden Core/i);
        assert.ok(entry.more);
        assert.match(entry.more, /51–100/);
    });

    test('resolves tier-3 common lexicon words', () => {
        const entry = getGlossEntry('森林');
        assert.ok(entry);
        assert.equal(entry.say, 'sēn lín');
        assert.match(entry.mean, /forest/i);
    });

    test('tier-1 context terms override tier-2 and tier-3 definitions', () => {
        registerContextTerm('九界天升诀', {
            say: 'jiǔ jiè tiān shēng jué',
            mean: 'Nine Realms Heavenly Ascension Technique',
            more: 'Ancient cultivation art inherited from mysterious jade pendant.',
        });

        const entry = getGlossEntry('九界天升诀');
        assert.ok(entry);
        assert.equal(entry.mean, 'Nine Realms Heavenly Ascension Technique');

        // Override a common word for this specific scene/card
        registerContextTerm('龙', {
            say: 'lóng',
            mean: 'Ancient Azure Dragon Sovereign',
        });
        const dragonEntry = getGlossEntry('龙');
        assert.ok(dragonEntry);
        assert.equal(dragonEntry.mean, 'Ancient Azure Dragon Sovereign');

        // Clear context and verify fallback returns
        clearContextTerms();
        const revertedDragon = getGlossEntry('龙');
        assert.ok(revertedDragon);
        assert.equal(revertedDragon.mean, 'dragon');
    });

    test('segmentAndGloss segments Chinese text with active Wuxia vocabulary', () => {
        const text = '凌香在洞府中运转九界天升诀，凝聚金丹突破境界。';
        registerBatchContext({
            '凌香': { say: 'líng xiāng', mean: 'Ling Xiang (Master Spirit in Jade Pendant)' },
            '九界天升诀': { say: 'jiǔ jiè tiān shēng jué', mean: 'Nine Realms Technique' },
        });

        const tokens = segmentAndGloss(text);
        const glossTerms = tokens.filter(t => t.type === 'gloss').map(t => t.text);

        assert.ok(glossTerms.includes('凌香'));
        assert.ok(glossTerms.includes('洞府'));
        assert.ok(glossTerms.includes('九界天升诀'));
        assert.ok(glossTerms.includes('金丹'));

        clearContextTerms();
    });
});
