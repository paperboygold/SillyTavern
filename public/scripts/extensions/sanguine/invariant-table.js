/**
 * fold/invariant-table.js: what the ledger can prove wrong about itself, with no ground truth.
 *
 * Pure, like every `-table.js`: a fold over derived state, no storage and no app graph, so it is
 * unit-testable and replayable.
 *
 * Why this exists.
 *
 * Fidelity over a year-long campaign cannot be checked by comparing the ledger against the truth,
 * because nobody has the truth written down. It CAN be checked against itself. A negative quantity
 * of a physical object is impossible. One currency occupying two rows is a keying fault, not a
 * fact about the world. A `different` verdict inside a component the `same` verdicts already
 * merged is a contradiction. None of these need a label, a model call, or a human.
 *
 * Measured over the live chats the day this was written:
 *
 *   Wuxia              suspected  carried `silver wen` 21 against money `silver` 76
 *   Isekai (73 msgs)   suspected  money `copper coins` 14 against money `copper` 2
 *
 * Both are real splits and both are STILL SPLIT in the live chats. `crosswalk.js` folds them to 77
 * and 6, one row each, but only once a `same` verdict for the pair exists in `state.answers`, and
 * across all nine campaigns the persisted verdicts are 21 cast + 48 thread and ZERO item. Those two
 * numbers were produced by seeding the verdict by hand and on a duplicated test chat; no live pass
 * has yet asked the item question and had it answered. The mechanism is verified end to end, its
 * effect on a real campaign is not, and the difference is exactly the kind this file has been wrong
 * about twice before. The Isekai split appeared inside 73 messages, so this is not a long-campaign
 * problem that can be deferred.
 *
 * Two wrong numbers were published from this file, and both are recorded rather than erased.
 *
 * A hand-rolled version of this check reported `marks −8500` for Royal Succession, an artifact of
 * summing `dq` while ignoring `set`: an absolute restatement is not a change. This module applies
 * both and Royal Succession is clean.
 *
 * The same scratch fold also produced a "PROVEN" column here, Time Stop `silver −11`, Solo Leveling
 * `painkillers −1`: which `deriveState` cannot ever produce, because it deletes a row that reaches
 * zero. See `negativeQuantities` below for what was really happening, which was worse. Both errors
 * have the same cause: a convenience reimplementation of the fold, trusted because it agreed with
 * expectations. The measurement instrument has to be the shipped one.
 *
 * The second job: violations are WITNESSES.
 *
 * `lib/ml/` exists to take over identity resolution by test-time training, the `Ratchet`
 * recompiles an `AutoUnit` as witnesses accumulate, and the witnesses have always been LLM answers
 * to `[same?]`, which cost a question slot each and arrive at roughly three per thousand messages.
 * That is why the corpus is 76 pairs after a week of play.
 *
 * A split-currency violation is a witness the SYSTEM produced. Two money rows whose names share a
 * token are either one currency (a `same` label) or a genuine pair the story keeps apart (a
 * `different` label), and the conservation check flags the pair for free, during play, without an
 * LLM call and without a question slot. The invariant checker is therefore both the correctness
 * gate and the label source the learner was always short of.
 *
 * `witnesses` is deliberately separate from `violations` and never decides: a flagged pair is a
 * QUESTION, exactly as `nearIdentity` raises one. Fold does not merge on a token overlap. RULE 1's
 * STRUCTURE clause is what licenses the grouping, token algebra on fold's own keys, no morphology
 * and no word list, and the answer stays the model's.
 */

import { CARRIED, MONEY, splitItemKey } from './state-table.js';

/**
 * Split a key's name into tokens.
 *
 * NOT language-neutral, and the first version of this comment claimed it was. Splitting on
 * non-alphanumerics needs whitespace to separate words, which Han, Hangul and Kana do not use, so
 * `二十银两` is ONE token and shares nothing with `银两`. Inflecting languages fail too:
 * `серебряных` against `серебро` is morphology, which fold does not do. Measured:
 *
 *   english   "silver wen" vs "silver"          DETECTED
 *   chinese   "二十银两"    vs "银两"             MISSED
 *   japanese  "銀貨二十枚"  vs "銀貨"             MISSED
 *   korean    "은화스무닢"  vs "은화"             MISSED
 *   russian   "серебряных монет" vs "серебро"   MISSED
 *
 * The earlier claim was tested with `"玉佩 吊坠"`, a space no real Chinese text contains, which
 * rigged the result. This is kept as a cheap SUPPLEMENT for space-delimited scripts, never as the
 * mechanism; `unbackedDebits` below carries no text at all and is what actually holds in every
 * language.
 */
const tokens = (name) => new Set(String(name ?? '').toLowerCase().split(/[^0-9a-zÀ-￿]+/i).filter(Boolean));

/**
 * Quantities that have gone below zero.
 *
 * A ledger that is a fold over signed deltas can go negative two ways, and both are defects: a debit
 * was double-counted, or a debit was keyed to a row that never held the credit.
 *
 * This check CANNOT fire on live state, and the docblock above used to claim it had.
 *
 * `deriveState` deletes any row the moment it reaches zero or below, and `setQty` clamps at zero, so
 * no derived inventory can contain a negative quantity. Run over `derive().inv` this function returns
 * `[]` for every chat, unconditionally. The "PROVEN" rows this module reported, Time Stop `silver
 * −11`, Solo Leveling `painkillers −1`: came from a scratch fold written to inspect the chats, which
 * omitted the delete rule. They were never what fold showed anyone.
 *
 * What fold actually did was worse, and is why the mistake was worth chasing rather than quietly
 * fixing: an overdraw DELETES the row, so the balance restarts from zero on the next credit and the
 * line silently vanishes from the panel. Time Stop ended a campaign of buying and selling with no
 * silver row at all. `crosswalk.js` is the repair, with the duplicate guard the same events fold to
 * 13: and `tests/fold-crosswalk.test.js` pins both the impossibility of a negative and the recovery.
 *
 * Kept, not deleted: it is the correct check for a table that has not been through `deriveState`,
 * which is what `migrate.js` and the replay harness build, and it costs one pass over a small map.
 *
 * @param {Map<string, {qty?: number}>} inv Derived inventory, keyed by `itemKey`.
 * @returns {Array<{kind: string, key: string, place: string, name: string, qty: number}>} Violations.
 */
export function negativeQuantities(inv) {
    const out = [];
    for (const [key, row] of inv ?? []) {
        const qty = Number(row?.qty);
        if (Number.isFinite(qty) && qty < 0) {
            const { place, name } = splitItemKey(key);
            out.push({ kind: 'negative-quantity', key, place, name, qty });
        }
    }
    return out;
}

/**
 * One THING occupying two rows in the same place, found by strict token containment.
 *
 * The gap this closes, reported from live play.
 *
 * Everything else in this file is money. `splitCurrency` requires a row at `money`,
 * `unbackedDebits` reads overdrawn balances, and `same_currency` (`review-table.js`) reads the
 * pinned Money block. So an ability recorded twice under two spellings had NO detector at all, and
 * a fresh Isekai campaign showed it inside 49 messages:
 *
 *   abilities  "quarterstaff proficiency (e)"   granted at mid 4, with its rank
 *   abilities  "quarterstaff proficiency"       re-reported at mid 46, without it
 *
 * The card grades skills in prose (`(e)`, `(d)` appear in the narrative), so the model sometimes
 * captures the grade and sometimes does not. Both readings are faithful; the ledger keyed them
 * apart and showed the player one skill twice.
 *
 * Why STRICT CONTAINMENT and SAME PLACE, measured.
 *
 * Containment either way (`{quarterstaff, proficiency} ⊂ {quarterstaff, proficiency, e}`) rather
 * than shared-token grouping, which is what `splitCurrency` uses. Shared-token is right for money,
 * a currency name is short and its variants overlap loosely, and far too loose everywhere else: it
 * would pair every carried item sharing any word. Containment says one name is the other plus
 * qualifiers, which is what a re-report under a fuller spelling actually looks like.
 *
 * Same place, because place is part of the identity by design: the ledger's own docblock says a
 * crowbar in the boot and a crowbar in your hand are two entries and moving one must not merge them.
 * The cross-place case is money's alone, and `splitCurrency` already owns it.
 *
 * Swept over all nine campaigns, this raises **three** pairs in total:
 *
 *   abilities  "quarterstaff proficiency (e)" ~ "quarterstaff proficiency"   one skill, two rows
 *   carried    "second ledger" ~ "ledger"                                    two real objects
 *   carried    "fs-4 dataspike" ~ "dataspike"                                genuinely ambiguous
 *
 * One certain merge, one certain refusal, one worth asking, which is the calibration a QUESTION
 * source wants. It decides nothing: the pair goes to the model exactly as a currency split does, and
 * a `different` answer is a minority label the resolver's witness set is starved of.
 *
 * @param {Map<string, {qty?: number}>} inv Derived inventory.
 * @returns {Array<{kind: string, rows: Array<{key: string, place: string, name: string, qty: number}>}>} Suspicions.
 */
export function splitNames(inv) {
    const rows = [];
    for (const [key, row] of inv ?? []) {
        const { who, place, name } = splitItemKey(key);
        rows.push({ key, who, place, name, qty: Number(row?.qty) || 0, t: tokens(name) });
    }
    const out = [];
    for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
            const a = rows[i];
            const b = rows[j];
            // Same OWNER as well as same place. Two people carrying a sword and a shortsword is two
            // people carrying swords, not one row that split, and raising it would spend a review
            // question on a pair whose only relation is that both are armed.
            if (a.who !== b.who || a.place !== b.place || !a.t.size || !b.t.size || a.t.size === b.t.size) {
                continue;
            }
            const [small, big] = a.t.size < b.t.size ? [a.t, b.t] : [b.t, a.t];
            if ([...small].every(token => big.has(token))) {
                out.push({ kind: 'split-name', rows: [{ ...a, t: undefined }, { ...b, t: undefined }] });
            }
        }
    }
    return out;
}

/**
 * One currency occupying more than one row.
 *
 * SUSPECTED, never proven, and the measurement says why. Of the five splits this raises on the live
 * chats, Wuxia's (`carried silver wen` against `money silver`) is a real one currency in two rows,
 * and three of Time Stop's are not, a silver ring and a silver moon locket sharing the token with
 * the balance. `{silver} ⊂ {silver, wen}` and `{silver} ⊂ {silver, moon, locket}` are the same
 * relation, so no language-neutral rule tells a denomination from an object made of the metal, and
 * fold must not guess. It raises the pair; the model answers.
 *
 * The false positives are the point rather than a cost: a suspected split answered `different` is a
 * `different` LABEL, which is the class the corpus has three of in seventy-six, and it was raised
 * without spending a question slot on a pair nobody had thought to ask about.
 *
 * Grouping is by shared token, not by similarity: no threshold, no embedding, no distance. That
 * matters beyond RULE 1, `LeverClassification.defining_metric_is_the_ceiling` (sanguine) says a
 * metric cannot be validated against a label it defines, and iText2KG's published answer to this
 * exact problem (cosine similarity at a hand-set 0.7) inherits that. A token overlap is a
 * structural fact about fold's own keys and decides nothing.
 *
 * @param {Map<string, {qty?: number}>} inv Derived inventory.
 * @returns {Array<{kind: string, token: string, rows: Array<{key: string, place: string, name: string, qty: number}>}>} Violations.
 */
export function splitCurrency(inv) {
    const byToken = new Map();
    for (const [key, row] of inv ?? []) {
        const { who, place, name } = splitItemKey(key);
        // The player's purse only. One currency in two rows is a question about one person's money;
        // a companion holding silver is not evidence that the player's silver is split.
        if (who || (place !== MONEY && place !== CARRIED)) {
            continue;
        }
        for (const token of tokens(name)) {
            if (!byToken.has(token)) {
                byToken.set(token, []);
            }
            byToken.get(token).push({ key, place, name, qty: Number(row?.qty) || 0 });
        }
    }
    const out = [];
    for (const [token, rows] of byToken) {
        // A split needs two DISTINCT rows, and at least one of them at `money`: two carried items
        // sharing a word ("silver ring", "silver moon locket") are two objects, not one balance.
        const distinct = [...new Map(rows.map(r => [r.key, r])).values()];
        if (distinct.length > 1 && distinct.some(r => r.place === MONEY)) {
            out.push({ kind: 'split-currency', token, rows: distinct });
        }
    }
    return out;
}

/**
 * Money the ledger spent from a row that never held it.
 *
 * The language-invariant half, and the one that should be read first: it contains no text. If the
 * model debits a currency row and the fold holds nothing there, the credit landed somewhere else,
 * under a different key for the same money. That is a split, established by arithmetic on fold's
 * own numbers, in any script and any writing system, with no tokenizer and no threshold.
 *
 * The two signals catch different halves and neither subsumes the other. This one fires only after
 * a split has already cost something (Time Stop's `money silver` at −11), so it is precise and
 * late. The token supplement fires before damage but only where words are separated by spaces
 * (Wuxia's `silver wen` against `silver`, both still positive). Reported separately so the
 * difference stays visible.
 *
 * It reads INCIDENTS, not the table, and that is a correction.
 *
 * This used to scan the derived inventory for `qty < 0`, exactly as `negativeQuantities` does. That
 * cannot work and never did: `deriveState` deletes a row the moment it reaches zero or below, so the
 * table it was handed can never contain a negative. Measured over all nine live campaigns, this
 * function returned `[]` every single time, while the event streams contain real overdraws, Isekai
 * `money copper` held 12 and was debited 14; Solo Leveling `carried painkillers` held 1 and was
 * debited 2. The check that was documented as "what actually holds in every language" was dead code,
 * which left the token supplement, script-dependent by its own docblock, as the only live detector.
 *
 * `deriveState` now records each overdraw as it deletes the row, so the evidence survives the line
 * that destroys it, and this function reads that instead. Still pure arithmetic on fold's own
 * numbers: no text, no tokenizer, no threshold.
 *
 * @param {Map<string, {qty?: number}>} inv Derived inventory, for the funded rows a credit could be in.
 * @param {Array<{key: string, had: number, dq: number, short: number, mid: number|null}>} [overdrawn]
 *   Overdraw incidents from `deriveState`. Absent, this reports nothing, an empty result means
 *   "nothing was recorded", never "the ledger is sound".
 * @returns {Array<{kind: string, key: string, name: string, qty: number,
 *   candidates: Array<{key: string, name: string, qty: number}>}>} Violations, with the funded rows
 *   the missing credit could be sitting in.
 */
export function unbackedDebits(inv, overdrawn = []) {
    const money = [];
    for (const [key, row] of inv ?? []) {
        const { place, name } = splitItemKey(key);
        if (place === MONEY) {
            money.push({ key, name, qty: Number(row?.qty) || 0 });
        }
    }
    return (overdrawn ?? [])
        // Money only, and deliberately: with no text there is nothing to narrow carried rows by, so
        // offering them would pair a shortfall against the dagger, the bow and the map, a flood of
        // obviously-different questions spending the review's slots on noise.
        .filter(incident => splitItemKey(incident.key).place === MONEY)
        .map(incident => ({
            kind: 'unbacked-debit',
            key: incident.key,
            name: splitItemKey(incident.key).name,
            qty: -incident.short,
            had: incident.had,
            dq: incident.dq,
            mid: incident.mid,
            // Every funded currency row is a candidate for where the credit went. Fold does not
            // pick one, the pair goes to the model, exactly as a token overlap would.
            candidates: money.filter(other => other.key !== incident.key && other.qty > 0),
        }));
}

/**
 * A `different` verdict inside a component the `same` verdicts merged.
 *
 * Identity is an equivalence relation, so `same` is transitive: union the `same` edges and any
 * `different` edge landing inside one component is a contradiction the model cannot have meant.
 * Measured over PERSISTED answers, `state.answers`, nine campaigns, 69 verdicts, this count is
 * ZERO, which is what licenses treating the transitive closure as fact there.
 *
 * That licence does NOT extend to the harvested training corpus, and the earlier version of this
 * docblock implied it did. `harvest.js` walks the traces rather than the persisted table, and at 174
 * pairs it carries 13 partition contradictions, roughly 7.5% of pairs sitting in a contradicted
 * component, with the same two names answered both ways on different passes. The persisted table
 * looks clean only because `remember` keeps one answer per pair key, so the last write hides the
 * disagreement rather than resolving it. A resolver trained on the harvest is therefore trained on an
 * inconsistent relation, and `evaluate.js` prints that warning itself.
 *
 * The consequence for this module: a wrong `same` that lands last flows straight into
 * `crosswalk.js` with nothing flagging it. Quarantining contradicted components out of `aliasMap`:
 * the way `unsoundComponents` already drops `set` collisions, is the cheap guard, and it is not
 * built.
 *
 * @param {Map<string, {answer?: string}>|Iterable<[string, {answer?: string}]>} answers
 *   Persisted identity answers, keyed by `pairKey`.
 * @param {string} pairSep The separator `pairKey` joins on.
 * @returns {Array<{kind: string, a: string, b: string}>} Violations.
 */
export function partitionContradictions(answers, pairSep = String.fromCharCode(1)) {
    const parent = new Map();
    const find = (x) => {
        if (!parent.has(x)) {
            parent.set(x, x);
        }
        while (parent.get(x) !== x) {
            parent.set(x, parent.get(parent.get(x)));
            x = parent.get(x);
        }
        return x;
    };
    const pairs = [];
    for (const [key, value] of answers ?? []) {
        const [a, b] = String(key).split(pairSep);
        if (!a || !b) {
            continue;
        }
        pairs.push({ a, b, answer: value?.answer });
        if (value?.answer === 'same') {
            const [ra, rb] = [find(a), find(b)];
            if (ra !== rb) {
                parent.set(ra, rb);
            }
        }
    }
    return pairs
        .filter(pair => pair.answer === 'different' && find(pair.a) === find(pair.b))
        .map(pair => ({ kind: 'partition-contradiction', a: pair.a, b: pair.b }));
}

/**
 * Every invariant, and the witnesses the violations imply.
 *
 * @param {object} params Parameters.
 * @param {Map<string, {qty?: number}>} params.inv Derived inventory.
 * @param {Map<string, {answer?: string}>|Iterable} [params.answers] Persisted identity answers.
 * @returns {{violations: object[], suspected: object[],
 *   witnesses: Array<{a: string, b: string, of: string, why: string}>}}
 *   Proven defects, suspected splits, and the identity questions those raise, never answers.
 */
/**
 * The findings that have not already been reported.
 *
 * A rejection is an event; an invariant finding is a state.
 *
 * `observe.noteRejections` is the channel for "the model proposed, fold refused", the Count face,
 * one increment per thing that happened. An invariant finding is not that. It is true OF the ledger
 * until the ledger changes, and `checkInvariants` re-derives it from the whole event history on
 * every pass, so pushing it down that channel counts the same defect once per pass forever.
 *
 * Measured on the live Wuxia World RPG: 118 rejections recorded, of which 94 were
 * `invariant:overdraw` with ONE distinct payload, `copper, held 1, debited 2` at mid 50. The tally
 * read ninety-four defects where there was one. Worse, `log.js` caps at `LOG_LIMIT` 120, so the
 * duplicates took 94 of the 120 diagnostic slots and left 26 for every real rejection in the chat,
 * each duplicate carrying an empty `raw`, an empty `snippet` and a null `mid`, because a state has
 * no proposal behind it to record.
 *
 * Identity is the INCIDENT, not the row. Overdrawing the same purse twice is two defects and a
 * filter that collapsed them would hide the second one forever, so an anchored finding keys on its
 * `mid` and its magnitudes. A standing violation, a contradicted partition, a split name, has no
 * mid, and keys on the pair it is about.
 *
 * @param {object[]} findings Everything the audit proved this pass.
 * @param {Set<string>|Iterable<string>} [seen] Identities already reported.
 * @returns {{fresh: object[], seen: Set<string>}} What is new, and the set carried forward.
 */
export function freshFindings(findings, seen = new Set()) {
    const known = new Set(seen ?? []);
    const fresh = [];
    for (const finding of Array.isArray(findings) ? findings : []) {
        const id = [
            finding?.kind ?? '',
            finding?.key ?? finding?.name ?? '',
            finding?.a ?? '', finding?.b ?? '',
            Number.isFinite(finding?.mid) ? finding.mid : '',
            finding?.dq ?? '', finding?.had ?? '',
        ].join('\u0001');
        if (known.has(id)) {
            continue;
        }
        known.add(id);
        fresh.push(finding);
    }
    return { fresh, seen: known };
}

export function checkInvariants({ inv, answers = [], overdrawn = [] }) {
    // PROVEN against SUSPECTED, and the distinction is load-bearing. A negative quantity and a
    // contradicted partition are defects: no reading of the story makes them right. A token overlap
    // is a QUESTION, `carried/silver moon locket` shares "silver" with `money/silver` and is not
    // the same thing, while `carried/silver wen` shares it and is. Those two are structurally
    // identical (both a strict token subset), so nothing language-neutral separates them and fold
    // must not call either a defect.
    //
    // Measured on the live chats: of five suspected splits, the Wuxia one (`silver wen` / `silver`)
    // is real and the three Time Stop ones (a locket and a ring against the balance) are not. That
    // is not a failure of the check. A suspected split the model answers `different` is a
    // `different` LABEL, the minority class the corpus has three of in seventy-six, and it cost
    // no question slot to raise. Both answers are worth having, which is why they are witnesses.
    const splits = splitCurrency(inv);
    // The non-money half. `splitCurrency` cannot see it (it requires a `money` row) and neither can
    // the arithmetic detector (an ability is never overdrawn), which is why a duplicated skill sat
    // on the panel with nothing in this file able to raise it.
    const names = splitNames(inv);
    const unbacked = unbackedDebits(inv, overdrawn);
    const violations = [
        ...negativeQuantities(inv),
        ...partitionContradictions(answers),
    ];
    // Unbacked debits are SUSPECTED splits too, from the text-free side. The negative balance
    // itself is already a proven violation above; what is suspected is WHICH funded row the credit
    // went to, and that is the model's answer.
    const suspected = [...splits, ...names, ...unbacked];
    // A split raises one question per pair of rows in the group. `of: 'item'` because the review
    // has no item identity source yet, this is the first one, and it arrives free.
    //
    // One pair, one question, however many times the evidence says so.
    //
    // A key can overdraw more than once in a campaign, Time Stop's `money silver` did it three
    // times, and each incident offers the same funded rows, so the naive loop emitted the same pair
    // once per incident. Measured before this dedup: 2 incidents produced 6 witnesses, of which 3
    // were repeats. The review has eight slots; spending two of them re-asking a question already on
    // the list is the cheapest possible waste. Order-independent, because a pair raised as (a,b) by
    // one incident and (b,a) by another is one question.
    const witnesses = [];
    const raised = new Set();
    const raise = (a, b, why) => {
        const id = [a, b].sort().join('');
        if (raised.has(id)) {
            return;
        }
        raised.add(id);
        witnesses.push({ a, b, of: 'item', why });
    };
    for (const debt of unbacked) {
        for (const candidate of debt.candidates) {
            raise(debt.key, candidate.key, 'unbacked-debit');
        }
    }
    for (const split of splits) {
        for (let i = 0; i < split.rows.length; i++) {
            for (let j = i + 1; j < split.rows.length; j++) {
                raise(split.rows[i].key, split.rows[j].key, 'split-currency');
            }
        }
    }
    for (const pair of names) {
        raise(pair.rows[0].key, pair.rows[1].key, 'split-name');
    }
    return { violations, suspected, witnesses };
}
