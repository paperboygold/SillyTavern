/**
 * sanguine-gloss/data/wuxia-lexicon.js — Curated Xianxia & Wuxia Cultivation Lexicon.
 *
 * Each entry provides:
 *   - say: Pinyin pronunciation with diacritics
 *   - mean: Concise English definition for the hover tooltip
 *   - more: (Optional) Rich cultivation lore, realm requirements, or mechanics for the click card
 */

export const WUXIA_LEXICON = {
    // ── 7 Cultivation Realms & Stages ──
    '练气': {
        say: 'liàn qì',
        mean: 'Qi Gathering (Stage 1)',
        more: 'The first stage of cultivation (levels 0–50). Cultivators absorb ambient spiritual energy (Lingqi) into their meridians to cleanse the mortal flesh.',
    },
    '聚气': {
        say: 'jù qì',
        mean: 'Qi Gathering / Qi Condensation',
        more: 'Gathering heaven-and-earth spiritual Qi into the body before opening the Dantian.',
    },
    '筑基': {
        say: 'zhù jī',
        mean: 'Foundation Establishment',
        more: 'Laying the Daoist foundation. Gaseous Qi in the Dantian condenses into liquid spiritual lakes.',
    },
    '结丹': {
        say: 'jié dān',
        mean: 'Core Formation',
        more: 'Forming the spiritual core. Liquid Qi in the Dantian is compressed into a solid, revolving core.',
    },
    '金丹': {
        say: 'jīn dān',
        mean: 'Golden Core (Stage 2)',
        more: 'Levels 51–100. Solidification of condensed spiritual liquid into an indestructible, radiant Golden Core within the lower Dantian.',
    },
    '元婴': {
        say: 'yuán yīng',
        mean: 'Nascent Soul (Stage 3)',
        more: 'Levels 101–150. The Golden Core hatches into an energy infant mirroring the cultivator\'s soul. The Nascent Soul can survive even if the physical body is destroyed.',
    },
    '化神': {
        say: 'huà shén',
        mean: 'Spirit Transformation / Soul Formation',
        more: 'The Nascent Soul fuses with the heavenly domain, allowing manipulation of worldly laws and intent.',
    },
    '斩灵': {
        say: 'zhǎn líng',
        mean: 'Spirit Severing (Stage 4)',
        more: 'Levels 151–200. Severing mortal attachments or heavenly shackles through supreme willpower to forge an untethered Dao.',
    },
    '问道': {
        say: 'wèn dào',
        mean: 'Dao Seeking (Stage 5)',
        more: 'Levels 201–250. Seeking the profound truth of the universe to comprehend the Great Dao and surpass mortal limitations.',
    },
    '炼虚': {
        say: 'liàn xū',
        mean: 'Void Refining',
        more: 'Refining the void; fusing one\'s spiritual domain with space itself.',
    },
    '合体': {
        say: 'hé tǐ',
        mean: 'Body Integration / Unity',
        more: 'Merging the Primordial Spirit completely with the physical body into an immortal vessel.',
    },
    '大乘': {
        say: 'dà chéng',
        mean: 'Great Vehicle / Mahayana',
        more: 'The pinnacle mortal realm before immortal ascension. The body and soul are completely purified.',
    },
    '渡劫': {
        say: 'dù jié',
        mean: 'Tribulation Transcending',
        more: 'Enduring Heavenly Lightning Tribulations sent by the Heavenly Dao to test the cultivator\'s qualifications for immortality.',
    },
    '飞升': {
        say: 'fēi shēng',
        mean: 'Immortal Ascension (Stage 6/7)',
        more: 'Levels 251–999+. Breaking through the boundary of the mortal world to ascend to the Higher Immortal Realm.',
    },
    '登仙': {
        say: 'dēng xiān',
        mean: 'Ascending to Immortality',
        more: 'Transcending the cycle of reincarnation to attain eternal life among true immortals.',
    },

    // ── Spiritual Anatomy & Internal Arts ──
    '丹田': {
        say: 'dān tián',
        mean: 'Dantian (Elixir Field)',
        more: 'The energy centers of the body. Lower Dantian stores Qi/Essence; Middle Dantian stores Heart/Prana; Upper Dantian (between eyebrows) houses the Spirit/Sea of Consciousness.',
    },
    '经脉': {
        say: 'jīng mài',
        mean: 'Meridians',
        more: 'Spiritual pathways throughout the body through which Qi circulates. Blocked or broken meridians hinder or cripple cultivation.',
    },
    '气海': {
        say: 'qì hǎi',
        mean: 'Sea of Qi',
        more: 'The vast internal reservoir located at the lower abdomen where spiritual essence gathers.',
    },
    '识海': {
        say: 'shí hǎi',
        mean: 'Sea of Consciousness',
        more: 'The mental plane located in the upper Dantian where spiritual sense (divine consciousness) is generated.',
    },
    '紫府': {
        say: 'zǐ fǔ',
        mean: 'Purple Palace',
        more: 'The mystical sanctum in the head where the Primordial Spirit resides.',
    },
    '泥丸宫': {
        say: 'ní wán gōng',
        mean: 'Niwan Palace (Upper Dantian)',
        more: 'The supreme cranial chamber controlling spiritual consciousness and divine thoughts.',
    },
    '道心': {
        say: 'dào xīn',
        mean: 'Dao Heart',
        more: 'A cultivator\'s mental resolution and philosophical conviction. An unstable Dao Heart causes cultivation stagnation or Qi deviation.',
    },
    '灵根': {
        say: 'líng gēn',
        mean: 'Spiritual Root',
        more: 'An innate elemental affinity (Fire, Water, Wood, Earth, Metal, Thunder, Wind, etc.) that dictates cultivation speed and technique suitability.',
    },
    '天灵根': {
        say: 'tiān líng gēn',
        mean: 'Heavenly Spiritual Root',
        more: 'A single, pure elemental root of flawless grade that allows cultivation at astronomical speeds without bottlenecks.',
    },
    '元神': {
        say: 'yuán shén',
        mean: 'Primordial Spirit / Soul Essence',
        more: 'The true spiritual essence and consciousness of a cultivator, capable of wandering the astral planes.',
    },
    '神识': {
        say: 'shén shí',
        mean: 'Divine Sense / Spiritual Awareness',
        more: 'Mental radar projected outward to perceive surroundings, inspect enemies, and guide spiritual weapons without physical sight.',
    },

    // ── Cultivation Phenomena & Tropes ──
    '灵气': {
        say: 'líng qì',
        mean: 'Spiritual Energy / Lingqi',
        more: 'The natural supernatural energy permeating Heaven and Earth that cultivators refine into personal spiritual power.',
    },
    '煞气': {
        say: 'shà qì',
        mean: 'Malevolent / Fiendish Qi',
        more: 'Harmful, aggressive energy born from slaughter, death, or dark yin ley lines. Used by demonic practitioners.',
    },
    '走火入魔': {
        say: 'zǒu huǒ rù mó',
        mean: 'Qi Deviation / Demon Possession',
        more: 'A catastrophic internal energy collapse caused by impatience, inner demons, or corrupted cultivation methods. Can cripple meridians or cause madness.',
    },
    '双修': {
        say: 'shuāng xiū',
        mean: 'Dual Cultivation',
        more: 'Esoteric yin-yang harmony practice where two cultivators exchange and refine energies together to accelerate cultivation or heal injuries.',
    },
    '闭关': {
        say: 'bì guān',
        mean: 'Seclusion / Closed-Door Cultivation',
        more: 'Isolating oneself in a meditation chamber for months or centuries to break through bottlenecks or comprehend secret techniques.',
    },
    '顿悟': {
        say: 'dùn wù',
        mean: 'Epiphany / Sudden Enlightenment',
        more: 'A rare flash of profound comprehension regarding the laws of the universe, instantly raising one\'s cultivation level or martial mastery.',
    },
    '夺舍': {
        say: 'duó shè',
        mean: 'Body Snatching / Soul Possession',
        more: 'A desperate act where a dying or disembodied master destroys a weaker cultivator\'s soul to seize their physical vessel.',
    },
    '天劫': {
        say: 'tiān jié',
        mean: 'Heavenly Tribulation',
        more: 'Cataclysmic lightning storms dispatched by the Heavenly Dao to eliminate beings attempting to defy mortality.',
    },
    '心魔': {
        say: 'xīn mó',
        mean: 'Inner Demon',
        more: 'Subconscious doubts, obsessions, traumas, or guilt that manifest during breakthroughs to corrupt the soul.',
    },
    '逆天': {
        say: 'nì tiān',
        mean: 'Defying the Heavens',
        more: 'The core philosophy of Xianxia: defying fate, mortal life expectancy, and natural laws to reach godhood.',
    },
    '斩草除根': {
        say: 'zhǎn cǎo chú gēn',
        mean: 'Eradicate Root and Stem',
        more: 'Ruthless Wuxia doctrine: eliminate every last member of an enemy faction so no vengeful descendants return in the future.',
    },

    // ── Equipment, Alchemy, and Treasures ──
    '储物戒': {
        say: 'chǔ wù jiè',
        mean: 'Storage Ring',
        more: 'A spatial ring enchanted with pocket-dimension spatial formations to store weapons, pills, and treasures.',
    },
    '乾坤袋': {
        say: 'qián kūn dài',
        mean: 'Qiankun Bag / Universe Pouch',
        more: 'A silk spatial pouch holding immense volume inside a palm-sized bag via spatial folding.',
    },
    '玉简': {
        say: 'yù jiǎn',
        mean: 'Jade Slip',
        more: 'A polished jade tablet inscribed with massive libraries of martial arts manuals or sect records, read via Divine Sense.',
    },
    '符箓': {
        say: 'fú lù',
        mean: 'Talisman / Daoist Talisman',
        more: 'Inscribed paper, cloth, or jade charms sealed with spiritual spells (e.g. Divine Speed, Fireball, Teleportation).',
    },
    '阵法': {
        say: 'zhèn fǎ',
        mean: 'Formation / Spell Array',
        more: 'Geomantic arrangements of spirit stones and flags to create defensive barriers, offensive traps, or spirit-gathering vortices.',
    },
    '飞剑': {
        say: 'fēi jiàn',
        mean: 'Flying Sword',
        more: 'A spiritual sword refined with one\'s blood and divine sense, used for telekinetic sword-flight or ranged combat.',
    },
    '剑气': {
        say: 'jiàn qì',
        mean: 'Sword Qi',
        more: 'Concentrated razor-sharp spiritual energy projected from the blade of a sword.',
    },
    '剑意': {
        say: 'jiàn yì',
        mean: 'Sword Intent',
        more: 'A transcendent conceptual mastery where the cultivator\'s will becomes the sharpest blade in the world.',
    },
    '灵石': {
        say: 'líng shí',
        mean: 'Spirit Stone',
        more: 'Crystalline minerals condensed from spiritual veins, serving as universal currency and fuel for cultivation/formations.',
    },
    '丹药': {
        say: 'dān yào',
        mean: 'Medicinal Pill / Elixir',
        more: 'Concoctions refined in alchemical cauldrons from spirit herbs to heal wounds, replenish Qi, or trigger realm breakthroughs.',
    },
    '筑基丹': {
        say: 'zhù jī dān',
        mean: 'Foundation Establishment Pill',
        more: 'A precious tier-2 pill that dramatically increases the success rate of stepping into the Foundation Establishment realm.',
    },
    '洗髓丹': {
        say: 'xǐ suǐ dān',
        mean: 'Marrow Cleansing Pill',
        more: 'An alchemical pill that expels impurities from bones and meridians to elevate one\'s innate talent.',
    },
    '灵草': {
        say: 'líng cǎo',
        mean: 'Spirit Grass / Spirit Herb',
        more: 'Supernatural flora nourished by heaven-and-earth spiritual veins, harvested as ingredients for alchemy.',
    },
    '洞府': {
        say: 'dòng fǔ',
        mean: 'Immortal Cave / Abode',
        more: 'A cultivator\'s fortified private residence, typically carved into spiritual mountain peaks and protected by warding arrays.',
    },

    // ── Titles, Factions, and Honorifics ──
    '道友': {
        say: 'dào yǒu',
        mean: 'Fellow Daoist',
        more: 'Polite, peer-to-peer form of address among cultivators walking the road of cultivation.',
    },
    '前辈': {
        say: 'qián bèi',
        mean: 'Senior',
        more: 'Respectful address toward a higher-realm or older cultivator.',
    },
    '晚辈': {
        say: 'wǎn bèi',
        mean: 'Junior',
        more: 'Self-deprecating or humble term used when speaking to a senior cultivator.',
    },
    '后辈': {
        say: 'hòu bèi',
        mean: 'Junior / Younger Generation',
        more: 'Members of the younger or lower-ranking cultivation generation.',
    },
    '师尊': {
        say: 'shī zūn',
        mean: 'Honored Master',
        more: 'Deeply revered teacher responsible for transmitting the Dao and secret arts.',
    },
    '师父': {
        say: 'shī fu',
        mean: 'Master / Teacher',
        more: 'Respectful form of address for one\'s martial mentor.',
    },
    '师兄': {
        say: 'shī xiōng',
        mean: 'Senior Martial Brother',
        more: 'Male disciple in the same sect/lineage who entered earlier or holds senior rank.',
    },
    '师姐': {
        say: 'shī jiě',
        mean: 'Senior Martial Sister',
        more: 'Female disciple in the same sect/lineage who entered earlier.',
    },
    '师弟': {
        say: 'shī dì',
        mean: 'Junior Martial Brother',
        more: 'Male disciple who entered the sect after you.',
    },
    '师妹': {
        say: 'shī mèi',
        mean: 'Junior Martial Sister',
        more: 'Female disciple who entered the sect after you.',
    },
    '散修': {
        say: 'sǎn xiū',
        mean: 'Rogue / Loose Cultivator',
        more: 'Independent cultivator unaffiliated with any sect, surviving on personal wits and dangerous realm exploration.',
    },
    '掌门': {
        say: 'zhǎng mén',
        mean: 'Sect Master',
        more: 'The supreme administrative and spiritual leader of a cultivation sect.',
    },
    '长老': {
        say: 'zhǎng lǎo',
        mean: 'Sect Elder',
        more: 'High-ranking master managing sect disciples, halls, and territory.',
    },
    '太上长老': {
        say: 'tài shàng zhǎng lǎo',
        mean: 'Grand Elder / Supreme Elder',
        more: 'Reclusive ancestor of a sect whose immense power acts as the sect\'s ultimate deterrent.',
    },
    '本座': {
        say: 'běn zuò',
        mean: 'This Seat (Arrogant Self-Address)',
        more: 'Haughty pronoun used by powerful sect masters and ancient elders to emphasize authority.',
    },
    '老夫': {
        say: 'lǎo fū',
        mean: 'This Old Man',
        more: 'Self-address used by elderly male cultivators and masters.',
    },
    '贫道': {
        say: 'pín dào',
        mean: 'This Humble Daoist',
        more: 'Traditional modest self-referential term used by Daoist practitioners.',
    },
    '宗门': {
        say: 'zōng mén',
        mean: 'Sect / Clan',
        more: 'A martial organization dedicated to cultivating specific ancient lineages and techniques.',
    },
    '妖兽': {
        say: 'yāo shòu',
        mean: 'Demon Beast / Monster Beast',
        more: 'Wild animals that absorbed spiritual Qi to develop intelligence, monstrous physical strength, and elemental spells.',
    },
    '灵兽': {
        say: 'líng shòu',
        mean: 'Spiritual Beast',
        more: 'Benevolent or tamed magical creatures bound to cultivators via blood contracts.',
    },
    '魔道': {
        say: 'mó dào',
        mean: 'Demonic Path / Demon Sect',
        more: 'Cultivators who utilize forbidden blood-refining, soul-harvesting, or ruthless shortcuts to pursue rapid power.',
    },
    '正道': {
        say: 'zhèng dào',
        mean: 'Orthodox Path / Righteous Dao',
        more: 'Mainstream sects bound by traditional honor codes and orderly cultivation methods.',
    },
    '仙人': {
        say: 'xiān rén',
        mean: 'Immortal / Celestial',
        more: 'A transcendent being who has successfully escaped mortal decay and ascended to the heavenly plane.',
    },
    '江湖': {
        say: 'jiāng hú',
        mean: 'Rivers and Lakes (The Martial World)',
        more: 'The roaming world of wandering martial artists, outlaws, sects, and chivalric brotherhood.',
    },
    '武侠': {
        say: 'wǔ xiá',
        mean: 'Martial Heroes / Wuxia',
        more: 'The genre and romantic ideal of martial chivalry, mortal martial arts mastery, and righteous code.',
    },
    '仙侠': {
        say: 'xiān xiá',
        mean: 'Immortal Heroes / Xianxia',
        more: 'High-fantasy cultivation genre featuring Daoist magic, flying swords, monsters, and immortality.',
    },
};
