import { describe, expect, test } from '@jest/globals';

import {
    CLOSED,
    DOOM,
    HIDDEN,
    MAX_THREADS,
    MAX_TRACK_SIZE,
    THREAD_STALE,
    MOOT,
    PROGRESS,
    aliasKeys,
    dialOf,
    foldThread,
    foldThreads,
    foldTicks,
    identityPairs,
    isFull,
    mergeThreads,
    nameTokens,
    nearIdentity,
    normalizeSize,
    normalizeStatus,
    normalizeThreadName,
    overlayClosures,
    perMinutes,
    renderOpenThreads,
    renderPressure,
    renderProgress,
    renderThreads,
    reviewable,
    threads,
    threadsByKind,
    tickCalendar,
} from '../public/scripts/extensions/fold/thread-table.js';

/*
 * One table for what is at stake. The Solo Leveling campaign carried the residency obligation
 * twice — a lead whose `open` read "1 of 20 logged" and a clock at 1/8 — two tables, two
 * lifecycles, two renderings of one stake, and the thing the fiction actually stated (twenty raids
 * in twelve months) expressible in neither. FOLD-REDESIGN.md §4.
 */
describe('one table, three shapes', () => {
    test('no dial is a thread, a dial is a clock, a big dial is a track', () => {
        const table = new Map();
        foldThreads(table, [{ name: 'the cellar', open: 'nobody has searched it' }], { turn: 1 });
        foldTicks(table, [{ name: 'the guard alert rises', tick: 1, size: 6, kind: DOOM }], { turn: 1 });
        foldTicks(table, [{ name: 'twenty D-rank raids logged', tick: 1, size: 20, kind: PROGRESS }], { turn: 1 });

        const split = threadsByKind(table, 1);
        expect(split.open.map(t => t.name)).toEqual(['the cellar']);
        expect(split.pressure.map(t => t.name)).toEqual(['the guard alert rises']);
        expect(split.progress.map(t => t.name)).toEqual(['twenty D-rank raids logged']);
    });

    test('a dial-less thread has no dial object at all', () => {
        const table = new Map();
        foldThreads(table, [{ name: 'the cellar', open: 'nobody has searched it' }], { turn: 1 });
        expect(dialOf(threads(table, 1)[0])).toBeNull();
    });

    test('a review label echoed into a name resolves to the recorded thread', () => {
        // The review section lists open threads as "T6 [open] Geldfurt funding", and the model
        // echoed that label back as a NEW thread name, opening a duplicate of a thread it was told
        // was already recorded. "T6 Geldfurt funding" must resolve to "Geldfurt funding" so the
        // proposal merges instead of creating a twin row.
        const table = new Map();
        foldThreads(table, [{ name: 'Geldfurt funding', open: 'the true payer is unknown' }], { turn: 1 });
        foldThreads(table, [{ name: 'T6 Geldfurt funding', open: 'the extent of the network is unknown' }], { turn: 2 });
        expect(threads(table, 2)).toHaveLength(1);
        expect(threads(table, 2)[0].name).toBe('Geldfurt funding');
        expect(normalizeThreadName('T9 second ledger').key).toBe('second ledger');
        expect(normalizeThreadName('T1 Karr of the Red Hand gathers strength — the east falls to rai').key)
            .toBe('karr of the red hand gathers strength — the east falls to rai');
    });

    test('a progress track keeps the number the story stated', () => {
        // Rounding "twenty raids" to eight would be fold inventing a different obligation from the
        // one the fiction set out.
        expect(normalizeSize(20, PROGRESS)).toBe(20);
        expect(normalizeSize(12, PROGRESS)).toBe(12);
        expect(normalizeSize(999, PROGRESS)).toBe(MAX_TRACK_SIZE);
        // A doom still rounds to the Blades vocabulary.
        expect(normalizeSize(20, DOOM)).toBe(8);
    });

    test('a later mention that omits the polarity does not demote a clock to a lead', () => {
        const table = new Map();
        foldTicks(table, [{ name: 'x', tick: 1, size: 6, kind: DOOM }], { turn: 1 });
        foldTicks(table, [{ name: 'x', tick: 1 }], { turn: 2 });
        expect(threads(table, 2)[0].dial).toEqual({ filled: 2, size: 6, kind: DOOM });
    });
});

/*
 * Polarity. Two dials coexisted for one stake in the live chat — "The residency window closes"
 * (fills = the sponsorship lapses) and "Residency in Korea" (about: "Solomon completes 20 D-rank
 * raids and gains residency" — fills = you win) — and renderClocks printed BOTH under `Pressure:`.
 * A dial that fills on success narrated as mounting threat is the injection steering the model to
 * treat the player's progress as danger. FOLD-REDESIGN.md §0.1-3.
 */
describe('the §0.1-3 pair — one doom, one progress, never one heading', () => {
    /** @returns {Map<string, object>} The two dials as the live chat carried them. */
    const residency = () => {
        const table = new Map();
        foldTicks(table, [{
            name: 'The residency window closes', tick: 1, size: 8, kind: DOOM,
            about: 'twelve months pass with fewer than twenty raids logged and the sponsorship lapses',
        }], { turn: 9 });
        foldTicks(table, [{
            name: 'Residency in Korea', tick: 1, size: 20, kind: PROGRESS,
            about: 'Solomon completes 20 D-rank raids and gains residency',
        }], { turn: 9 });
        return table;
    };

    test('each renders under its own heading', () => {
        const table = residency();
        expect(renderPressure(table, 9)).toBe(
            'Pressure: The residency window closes 1/8 — twelve months pass with fewer than twenty raids logged and the sponsorship lapses');
        expect(renderProgress(table, 9)).toBe(
            'Progress: Residency in Korea 1/20 — Solomon completes 20 D-rank raids and gains residency');
    });

    test('the progress dial never appears under Pressure:, by any of its words', () => {
        const rendered = renderThreads(residency(), 9);
        const pressure = rendered.split('\n').find(line => line.startsWith('Pressure:'));
        const progress = rendered.split('\n').find(line => line.startsWith('Progress:'));

        expect(pressure).not.toContain('Residency in Korea');
        expect(pressure).not.toContain('gains residency');
        expect(pressure).not.toContain('1/20');
        expect(progress).toContain('gains residency');
        // And the two lines are genuinely separate lines, not one heading with both under it.
        expect(rendered.split('\n').filter(line => line.startsWith('Pressure:'))).toHaveLength(1);
    });

    test('a hidden progress dial says "underway", never "closing in"', () => {
        const table = new Map();
        foldTicks(table, [{ name: 'the smith finishes the blade', tick: 1, size: 6, kind: PROGRESS, seen: 'hidden' }], { turn: 1 });
        expect(renderProgress(table, 1)).toContain('(underway)');
        expect(renderProgress(table, 1)).not.toContain('closing in');
    });

    test('advancing is the filled direction whichever way the stakes point', () => {
        // The tick semantics do not change with polarity; only what the reader is told it means.
        const table = new Map();
        foldTicks(table, [{ name: 'p', tick: 3, size: 10, kind: PROGRESS }], { turn: 1 });
        foldTicks(table, [{ name: 'p', tick: -1 }], { turn: 2 });
        expect(threads(table, 2)[0].filled).toBe(2);
    });

    test('a dial may only advance when the window mentions it', () => {
        // Symmetric with the entity probe's mention gate: a tick for a dial the new excerpt never
        // touches is a hallucinated advance — it was being accepted at non-zero tick before this
        // gate existed, and only a zero tick got caught as `no-change`.
        const table = new Map();
        const { accepted, rejected } = foldTicks(
            table,
            [{ name: 'east falls to raiders', tick: 2, kind: DOOM, size: 6, where: 'the east' }],
            { turn: 1, windowText: 'Sol reads the letter, and looks sidelong at Zareena.' });

        expect(accepted).toBe(0);
        expect(rejected[0].reason).toBe('not-mentioned');
        expect(table.size).toBe(0);
    });

    test('a dial advances when the window names its subject or consequence', () => {
        // "the Blight" in the window is still the "the Blight reaches Briarwood" dial; "the east"
        // names where the doom clock applies. The gate reads name, `about` and `where`.
        const table = new Map();
        const byName = foldTicks(table,
            [{ name: 'the Blight reaches Briarwood', tick: 1, kind: DOOM, size: 6 }],
            { turn: 1, windowText: 'the Blight creeps closer to the village' });
        expect(byName.accepted).toBe(1);

        const byWhere = foldTicks(table,
            [{ name: 'east falls to raiders', tick: 1, kind: DOOM, size: 6, where: 'the east' }],
            { turn: 2, windowText: 'raiders torch a farmhouse in the east' });
        expect(byWhere.accepted).toBe(1);
    });

    test('the mention gate is off without a window, for migrations and absorption', () => {
        const table = new Map();
        const { accepted } = foldTicks(table,
            [{ name: 'the guard alert rises', tick: 1, kind: DOOM, size: 6 }],
            { turn: 1 });
        expect(accepted).toBe(1);
    });
});

/*
 * Status. `moot` beside open/closed, because the Nowon counterattack clock after the nest was
 * routed was not COMPLETED — it stopped being about anything, and conflating the two loses the
 * difference between a consequence and an irrelevance.
 */
describe('a thread can stop mattering without being finished', () => {
    test('the vocabulary has three members and a default', () => {
        expect(normalizeStatus('closed')).toBe(CLOSED);
        expect(normalizeStatus('moot')).toBe(MOOT);
        expect(normalizeStatus('stalled')).toBe('open');
        expect(normalizeStatus(undefined)).toBe('open');
    });

    test('neither a closed nor a moot thread is injected', () => {
        const table = new Map();
        foldThreads(table, [
            { name: 'the cellar', open: 'nobody has searched it', status: 'open' },
            { name: 'the ledger', open: 'nobody has read it', status: 'closed' },
            { name: 'the counterattack', open: 'whether the nest retaliates', status: 'moot' },
        ], { turn: 1 });
        expect(renderOpenThreads(table, 1)).toBe('Threads: the cellar; nobody has searched it');
    });

    test('but both hold their place for one turn so the change is witnessed', () => {
        const table = new Map();
        foldThreads(table, [{ name: 'the ledger', open: 'nobody has read it', status: 'closed' }], { turn: 4 });
        expect(threadsByKind(table, 4).done.map(t => t.name)).toEqual(['the ledger']);
        expect(threadsByKind(table, 5).done).toHaveLength(0);
    });
});

/*
 * Identity. `next raid with Kang's squad` and `next raid with Kang's team` opened as two threads,
 * because leads had no `aka` at all and nothing ever compared two thread names.
 * FOLD-REDESIGN.md §0.1-6.
 */
describe('threads finally have aliases', () => {
    test('an alias lands the write on the record that already exists', () => {
        const table = new Map();
        foldThreads(table, [{ name: 'Next raid with Kang\'s squad', open: 'no slot has opened yet, and nobody has said when' }], { turn: 1 });
        foldThreads(table, [{ name: 'Next raid with Kang\'s team', aka: 'Next raid with Kang\'s squad', open: 'nobody has said when a slot opens' }], { turn: 2 });
        expect(table.size).toBe(1);
        expect(threads(table, 2)[0].aka).toContain('Next raid with Kang\'s squad');
    });

    test('a name a thread was once called never stops having been used', () => {
        const table = new Map();
        foldThreads(table, [{ name: 'the weapon hunt', open: 'nobody has bought one' }], { turn: 1 });
        foldThreads(table, [{ name: 'A weapon that is not a goblin knife', aka: 'the weapon hunt', open: 'nobody has bought one' }], { turn: 2 });
        const [thread] = threads(table, 2);
        expect(thread.name).toBe('A weapon that is not a goblin knife');
        expect(thread.aka).toContain('the weapon hunt');
    });
});

describe('nearIdentity — a trigger for a question, never a decision', () => {
    test('the substitution case, which a subset test cannot catch', () => {
        // Neither token set contains the other: {next,raid,kang\'s,squad} vs {next,raid,kang\'s,team}.
        expect(nearIdentity('next raid with Kang\'s squad', 'next raid with Kang\'s team')).toBe('substitution');
    });

    test('the subset case, at both ends, which is the Kang and broker bug', () => {
        // "scarred broker" heads LAST — it is a kind of broker. "Kang Min-seo" heads FIRST. Both
        // are refinements, and both split a real person into two rows in a live chat.
        expect(nearIdentity('broker', 'scarred broker')).toBe('subset');
        expect(nearIdentity('Kang', 'Kang Min-seo')).toBe('subset');
    });

    test('a shared surname is a family, not a person', () => {
        // Measured on Evil Hero Party: accepting a final-position head for the SUBSTITUTION branch
        // asks whether Lord Everard is Lillian Everard. Only a shared first token licenses that
        // question — the same error "the dining hall" versus "the great hall" would make.
        expect(nearIdentity('Lord Everard', 'Lillian Everard')).toBeNull();
        expect(nearIdentity('the dining hall', 'the great hall')).toBeNull();
    });

    test('an echoed review label is a subset, not a new dial', () => {
        // The Royal Succession duplicate: the model copied a block id into a thread name, so
        // "T1 Karr of the Red Hand gathers strength — the east falls to rai" is a strict superset
        // of "Karr of the Red Hand gathers strength". Neither the first nor the last token agrees
        // (the prefix defeats both ends), yet one name fully contains the other — it is one dial
        // recorded twice, at 1/6 and at 6/6, the second left open after firing.
        expect(nearIdentity('Karr of the Red Hand gathers strength',
            'T1 Karr of the Red Hand gathers strength — the east falls to rai')).toBe('subset');
        expect(nearIdentity('the smith finishes the blade', 'the smith finishes the blade — completed')).toBe('subset');
    });

    test('names sharing nothing raise nothing, which no metric could fix anyway', () => {
        expect(nearIdentity('Solomon', 'the Hero')).toBeNull();
    });

    test('identical token sets raise no question — there is nothing to ask', () => {
        expect(nearIdentity('the cellar', 'cellar')).toBeNull();
        expect(nearIdentity('a weapon', 'the weapon')).toBeNull();
    });

    test('two substitutions is too far', () => {
        expect(nearIdentity('next raid with Kang', 'next trip with Park')).toBeNull();
    });

    test('noise words carry no identity', () => {
        expect(nameTokens('the next raid with Kang\'s squad')).toEqual(['next', 'raid', 'kang\'s', 'squad']);
    });

    test('identityPairs asks about pairs and merges nothing', () => {
        const rows = [
            { key: 'a', name: 'next raid with Kang\'s squad' },
            { key: 'b', name: 'next raid with Kang\'s team' },
            { key: 'c', name: 'the missing hunter in Busan' },
        ];
        expect(identityPairs(rows)).toEqual([{ a: 'a', b: 'b', why: 'substitution' }]);
    });
});

describe('bounds', () => {
    test('the table is bounded, and the bound is reported when nothing can be evicted', () => {
        const table = new Map();
        for (let i = 0; i < MAX_THREADS; i++) {
            foldThreads(table, [{ name: `thread ${i}`, open: 'unresolved' }], { turn: 1 });
        }
        // All dial-less threads are equally fresh; the first (also stalest) is evicted to make
        // room, so a new development is never refused while any stale thread lingers.
        const accepted = foldThreads(table, [{ name: 'one too many', open: 'unresolved' }], { turn: 1 });
        expect(accepted.accepted).toBe(1);
        expect(table.size).toBe(MAX_THREADS);
        expect(table.has('thread 0')).toBe(false);

        // When every row carries a dial, nothing is expendable — a dial's fill is progress the
        // story measured, and evicting it would lose real state. The bound is then reported.
        const dials = new Map();
        for (let i = 0; i < MAX_THREADS; i++) {
            foldThreads(dials, [{ name: `dial ${i}`, kind: DOOM, size: 6, open: '' }], { turn: 1 });
        }
        const { rejected } = foldThreads(dials, [{ name: 'one more dial', kind: DOOM, size: 6, open: '' }], { turn: 1 });
        expect(rejected[0].reason).toBe('threads-full');
        expect(dials.size).toBe(MAX_THREADS);
    });

    test('the exposition gate still gates dial-less proposals only', () => {
        const table = new Map();
        // Lore: nothing in it is unsettled.
        const lore = foldThreads(table, [{ name: 'the brand', open: 'it permits pain and recall' }], { turn: 1 });
        expect(lore.rejected[0].reason).toBe('exposition');
        // A dial IS its own open question and skips the gate.
        const dial = foldThreads(table, [{ name: 'the guard alert rises', kind: DOOM, size: 6, open: '' }], { turn: 1 });
        expect(dial.accepted).toBe(1);
    });

    test('a filled dial is not live pressure — it has already happened', () => {
        const table = new Map();
        foldThread(table, { name: 'x', tick: 4, size: 4, kind: DOOM, turn: 1 });
        expect(isFull(threads(table, 1)[0])).toBe(true);
        expect(renderPressure(table, 1)).toBe('');
    });
});

/*
 * ── Closure as a read-time overlay, and the swipe scenario that chose the shape ──
 *
 * FOLD-REDESIGN.md §2 promises closures land as ledger events, nothing is deleted in place, and
 * swiping away the closing turn un-closes the thread. Threads are a STORED table, so the only shape
 * that keeps all three is: stored status, overridden by the closure events live on this branch.
 * `overlayClosures`' docblock carries the two rejected alternatives.
 */
describe('overlayClosures — nothing is deleted in place', () => {
    /** A thread and a dial, as a real table holds them. */
    function stored() {
        const table = new Map();
        foldThreads(table, [{ name: 'the cellar', open: 'nobody has searched it' }], { turn: 1 });
        foldTicks(table, [{ name: 'the guard alert rises', tick: 2, size: 6, kind: DOOM }], { turn: 1 });
        return table;
    }

    test('with no closures the stored table is returned unchanged, and not copied', () => {
        const table = stored();
        expect(overlayClosures(table, [])).toBe(table);
        expect(overlayClosures(table, null)).toBe(table);
    });

    test('a closure closes a thread without touching the row', () => {
        const table = stored();
        const view = overlayClosures(table, [{ key: 'the cellar', status: CLOSED }]);
        expect(view.get('the cellar').status).toBe(CLOSED);
        expect(table.get('the cellar').status).toBe('open');
        expect(threadsByKind(view, 1).open).toHaveLength(0);
        expect(threadsByKind(view, 1).done.map(row => row.key)).toContain('the cellar');
    });

    test('a dial can be made moot, which is the exit a threat never had', () => {
        // `foldTicks` refuses `tick === 0` as `no-change` and `renderPressure` filters only on full
        // and local, so a danger that stopped existing had no way out of the table at all
        // (FOLD-RPG-GAP.md §1). Two moot clocks squatted in the live chat until a script deleted
        // them by hand.
        const table = stored();
        const view = overlayClosures(table, [{ key: 'the guard alert rises', status: MOOT }]);
        expect(renderPressure(view, 1)).toBe('');
        expect(view.get('the guard alert rises').filled).toBe(2);
    });

    test('the closure vanishes with its evidence — the swipe case, in full', () => {
        const table = stored();
        // The closing turn is live: liveEvents() yields the closure.
        expect(overlayClosures(table, [{ key: 'the cellar', status: CLOSED }]).get('the cellar').status).toBe(CLOSED);
        // The user swipes; the message's content changes; its content key is no longer in
        // liveHashes(); liveEvents() drops the event; this function receives nothing.
        expect(overlayClosures(table, []).get('the cellar').status).toBe('open');
    });

    test('an unknown key changes nothing rather than opening a row', () => {
        const table = stored();
        const view = overlayClosures(table, [{ key: 'a thread nobody wrote', status: CLOSED }, { key: '', status: CLOSED }]);
        expect(view.size).toBe(table.size);
    });
});

describe('mergeThreads — the answer to a thread identity question', () => {
    test('two wordings of one stake become one row with both names', () => {
        const table = new Map();
        foldThreads(table, [
            { name: 'next raid with Kang\'s squad', open: 'when and where it will be' },
            { name: 'next raid with Kang\'s team', open: 'nobody has said when Kang will call' },
        ], { turn: 1 });
        expect(table.size).toBe(2);

        const done = mergeThreads(table, 'next raid with kang\'s squad', 'next raid with kang\'s team');
        expect(table.size).toBe(1);
        const row = table.get(done.key);
        expect(row.aka).toContain('Kang\'s');
        // The alias set is what stops the next mention of either wording opening a third row —
        // leads had no `aka` at all before Phase B, which is how this pair happened.
        expect(aliasKeys(row)).toHaveLength(2);
    });

    test('the dial survives whole, and is never a sum', () => {
        const table = new Map();
        foldThreads(table, [{ name: 'twenty raids logged', open: 'nineteen have not been logged yet' }], { turn: 1 });
        foldTicks(table, [{ name: 'twenty raids done', tick: 3, size: 20, kind: PROGRESS }], { turn: 1 });
        const done = mergeThreads(table, 'twenty raids logged', 'twenty raids done');
        const row = table.get(done.key);
        expect(row.filled).toBe(3);
        expect(row.size).toBe(20);
        expect(row.kind).toBe(PROGRESS);
    });

    test('when both bear dials the more advanced position wins', () => {
        // Two readings of one stake: the fill is the position the story has reached, so a merge
        // must keep the MORE advanced reading — a duplicate's less-progressed dial must not move
        // the stake backwards. The keeper's name is a cosmetic tie break, never the reason.
        const table = new Map();
        foldTicks(table, [
            { name: 'the residency window closes', tick: 1, size: 8, kind: DOOM },
            { name: 'residency in Korea', tick: 2, size: 8, kind: DOOM },
        ], { turn: 1 });
        const done = mergeThreads(table, 'the residency window closes', 'residency in korea');
        expect(table.get(done.key).filled).toBe(2);
        expect(table.size).toBe(1);
    });

    test('a merge keeps the more-advanced Karr dial, not the longer name', () => {
        // The Royal Succession duplicate: "T1 Karr of the Red Hand gathers strength — the east
        // falls to rai" is the LONGER name but its dial read 1/6, while the canonical
        // "Karr of the Red Hand gathers strength" had reached 7/8. Name-length kept the wrong row
        // and the merge moved the Karr clock backwards; the fill must win. The two rows are built
        // in SEPARATE passes, because the alias-resolution in one batch would collapse them before
        // the merge ever sees two rows — exactly how the live duplicate survived until a merge.
        const table = new Map();
        foldTicks(table, [{ name: 'Karr of the Red Hand gathers strength', tick: 3, size: 8, kind: DOOM }], { turn: 1 });
        foldTicks(table, [{ name: 'Karr of the Red Hand gathers strength', tick: 3 }], { turn: 2 });
        foldTicks(table, [{ name: 'Karr of the Red Hand gathers strength', tick: 1 }], { turn: 3 });
        // A separate pass with a differently-worded name opens a second row only when no alias
        // links them yet; force the raw key so the merge has two rows to choose between.
        table.set('t1 karr of the red hand gathers strength — the east falls to rai', {
            name: 'T1 Karr of the Red Hand gathers strength — the east falls to rai',
            first: 1, turn: 2, kind: 'doom', filled: 1, size: 6, status: 'open', seen: 'open', about: 'the east falls to raiders',
        });
        const done = mergeThreads(
            table,
            'karr of the red hand gathers strength',
            't1 karr of the red hand gathers strength — the east falls to rai');
        expect(done).not.toBeNull();
        expect(table.get(done.key).filled).toBe(7);
        expect(table.get(done.key).size).toBe(8);
        expect(table.size).toBe(1);
    });

    test('nothing merges when a key is missing or the two are the same row', () => {
        const table = new Map();
        foldThreads(table, [{ name: 'the cellar', open: 'nobody has searched it' }], { turn: 1 });
        expect(mergeThreads(table, 'the cellar', 'the attic')).toBeNull();
        expect(mergeThreads(table, 'the cellar', 'the cellar')).toBeNull();
        expect(table.size).toBe(1);
    });
});

/*
 * ── What the review must be able to close, and what the prompt should show, are different sets ──
 *
 * Found by the Phase C hand-check against the four live logs, not by reasoning: `threadsByKind` (the
 * prompt's and the panel's view) drops threads that are non-local or stale, and a thread that never
 * reaches the review block can never be asked about. The measured case is the Goblin Market gear
 * trip, which "sat open while the player stood inside it" (FOLD-REDESIGN.md §2) and would have
 * dropped off the moment he walked out of the market.
 */
describe('reviewable — every open line, wherever it is and however quiet', () => {
    /** A table with one local thread, one bound elsewhere, and one nobody has named in ages. */
    function mixed() {
        const table = new Map();
        foldThreads(table, [
            { name: 'the cellar', open: 'nobody has searched it', where: 'the manor' },
            { name: 'the gear trip', open: 'nobody has bought anything yet', where: 'the Goblin Market' },
        ], { turn: 1 });
        foldThreads(table, [{ name: 'the old debt', open: 'nobody has said when it falls due' }], { turn: 1 });
        return table;
    }

    test('a thread bound to a place you have left is still reviewable', () => {
        const table = mixed();
        expect(threadsByKind(table, 1, { at: 'the manor' }).open.map(row => row.key)).not.toContain('the gear trip');
        expect(reviewable(table, 1).map(row => row.key)).toContain('the gear trip');
    });

    test('a thread nobody has named for longer than THREAD_STALE is still reviewable', () => {
        const table = mixed();
        const later = THREAD_STALE + 5;
        expect(threadsByKind(table, later).open).toHaveLength(0);
        expect(reviewable(table, later)).toHaveLength(3);
    });

    test('but a closed or filled thread is not an open line', () => {
        const table = mixed();
        const closed = overlayClosures(table, [{ key: 'the cellar', status: CLOSED }]);
        expect(reviewable(closed, 1).map(row => row.key)).not.toContain('the cellar');

        foldTicks(table, [{ name: 'the alarm', tick: 3, size: 4, kind: DOOM }], { turn: 1 });
        foldTicks(table, [{ name: 'the alarm', tick: 1 }], { turn: 2 });
        expect(reviewable(table, 2).map(row => row.key)).not.toContain('the alarm');
    });
});

/*
 * The residency window is a front whose firing condition is "twelve months pass with fewer than
 * twenty raids logged" — a pure calendar condition that nothing in fold could tick, because ticks
 * arrived only from on-screen extraction (FOLD-REDESIGN.md §7.1). `tickCalendar` is the engine: it
 * advances every `per`-front the narrative clock has run past, in code, with no model involved.
 */
describe('calendar fronts tick in code (Phase W)', () => {
    // month/week/day in minutes — held to `clock.js` UNIT so the front and the clock agree on what a
    // month is (the docblock on `parseSpan` argues why the two share one table).
    const MONTH = 1440 * 30;
    const DAY = 1440;

    test('perMinutes reads a cadence, or null when the front has none', () => {
        expect(perMinutes({ per: '1 month' })).toBe(MONTH);
        expect(perMinutes({ per: '2 weeks' })).toBe(1440 * 14);
        expect(perMinutes({ per: '' })).toBeNull();
        expect(perMinutes({})).toBeNull();
    });

    test('a per-front advances when the clock crosses its boundary — no model call', () => {
        // The residency stake: a progress track at 1/20, ticking once per month. This is Gate 2.
        const table = new Map();
        foldThread(table, { name: 'twenty D-rank raids logged', tick: 1, size: 20, kind: PROGRESS, per: '1 month', ticked: 0 });
        const before = threads(table, 0)[0].dial.filled;
        const out = tickCalendar(table, { now: MONTH, turn: 5 });
        expect(out.ticked).toHaveLength(1);
        expect(threads(table, 0)[0].dial.filled).toBe(before + 1);
    });

    test('the same now does not double-tick on a second pass (a position, not an accumulator)', () => {
        // The pass is async and fire-and-forget, so it can run twice against the same elapse. An
        // accumulator would tick twice; floor((now - ticked) / per) is zero the second time.
        const table = new Map();
        foldThread(table, { name: 'the window closes', tick: 1, size: 8, kind: DOOM, per: '1 month', ticked: 0 });
        tickCalendar(table, { now: MONTH });
        const afterOne = threads(table, 0)[0].dial.filled;
        tickCalendar(table, { now: MONTH });
        expect(threads(table, 0)[0].dial.filled).toBe(afterOne);
    });

    test('a front seen for the first time is anchored to now, not filled from pre-history', () => {
        // A front carrying `per` written by hand into an old chat must not read the whole campaign as
        // elapsed and fill the dial on sight.
        const table = new Map();
        foldThread(table, { name: 'the window closes', tick: 1, size: 8, kind: DOOM, per: '1 month' });
        const out = tickCalendar(table, { now: MONTH * 999, turn: 1 });
        expect(out.ticked).toEqual([]);
        expect(out.anchored).toHaveLength(1);
        // Anchored to that now, so a later month crosses exactly one boundary from there.
        const out2 = tickCalendar(table, { now: MONTH * 999 + MONTH, turn: 2 });
        expect(out2.ticked).toHaveLength(1);
    });

    test('a partial elapse keeps its remainder', () => {
        // Forty days against a monthly front: one tick, ten days held in hand for the next boundary.
        const table = new Map();
        foldThread(table, { name: 'the window closes', tick: 1, size: 8, kind: DOOM, per: '1 month', ticked: 0 });
        tickCalendar(table, { now: MONTH + 10 * DAY, turn: 1 });
        expect(threads(table, 0)[0].dial.filled).toBe(2);
        // The ten-day remainder is held, not lost: a second pass at the SAME now advances nothing.
        expect(tickCalendar(table, { now: MONTH + 10 * DAY, turn: 2 }).ticked).toEqual([]);
    });

    test('a declared year advances a monthly front past MAX_TICK, clamped only by size', () => {
        // MAX_TICK catches a MODEL that skipped the story; arithmetic over a player-declared elapse has
        // no such failure mode. A year against a monthly front is twelve boundaries.
        const table = new Map();
        foldThread(table, { name: 'the window closes', tick: 1, size: 8, kind: DOOM, per: '1 month', ticked: 0 });
        const out = tickCalendar(table, { now: 12 * MONTH, turn: 1 });
        expect(out.ticked).toHaveLength(1);
        expect(out.fired).toHaveLength(1); // 1 + 12 >= size 8 → filled, fires once
        expect(isFull(threads(table, 0)[0])).toBe(true);
    });

    test('a hidden front stays hidden when the calendar moves it', () => {
        // `tickCalendar` restates `seen` so merge_thread's field-wise last-write cannot quietly reopen
        // a hidden front every time the calendar advances it.
        const table = new Map();
        foldThread(table, { name: 'the window closes', tick: 1, size: 8, kind: DOOM, per: '1 month', ticked: 0, seen: HIDDEN });
        tickCalendar(table, { now: MONTH });
        expect(threads(table, 0)[0].seen).toBe(HIDDEN);
    });

    test('closed, full, and dial-less fronts are untouched', () => {
        const table = new Map();
        foldThread(table, { name: 'done', tick: 1, size: 4, kind: DOOM, per: '1 month', ticked: 0, status: CLOSED });
        foldThread(table, { name: 'filled', tick: 4, size: 4, kind: DOOM, per: '1 month', ticked: 0 });
        foldThread(table, { name: 'a lead', open: 'nobody has searched it', per: '1 month' });
        expect(tickCalendar(table, { now: MONTH }).ticked).toEqual([]);
    });
});
