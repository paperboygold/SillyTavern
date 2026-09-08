/**
 * fold/evaluate.js: the gate the learned resolver has to clear before it is wired.
 *
 * Run from the SillyTavern repo root, after `harvest.js`:
 *
 *     node public/scripts/extensions/sanguine/evaluate.js [corpus.jsonl]
 *
 * Reads the `pair` records out of the corpus and measures, by leave-one-out, what `lib/ml/`'s
 * `AutoUnit` would actually have answered for each identity verdict had it been asked instead of
 * the LLM. Reports one variant per featurizer input:
 *
 *   - `names`: the two names alone, which is all a resolver reading `state.answers` can see.
 *   - `context`: the names plus the text that decided them (`harvest.js` `pair.context`).
 *
 * The gate, and why it is this one.
 *
 * The metric is NOT accuracy. A corpus of identity verdicts is dominated by `same`, because
 * `nearIdentity` (`thread-table.js:957`) only raises the question for names that already look
 * alike: strict token containment, or one substitution. So the question the resolver has to beat
 * is not "is it right often" but "is it right more often than answering `same` every time", and a
 * unit that scores 88% against a 91% majority baseline is a unit that ACTIVELY COSTS accuracy for
 * the LLM calls it saves. `majority` below is that baseline, and a variant that does not clear it
 * has not earned the wire-up however good its raw number looks.
 *
 * Deopt rate is reported beside it because the two trade off: a guard tuned to admit nothing
 * scores perfectly and saves nothing. What matters is accuracy ON THE ADMITTED SET against the
 * baseline, at a deopt rate low enough to be worth the code.
 *
 * Honest refusal.
 *
 * A variant whose examples carry fewer than two classes cannot be evaluated at all, and this tool
 * says so rather than printing a number. That is the live case as this was written: every `pair`
 * with real context is a `same`, because the `different` verdicts are all THREAD identity, thread
 * names are fold's own synthesised labels ("garrison integration", "zareena's request"), and a
 * synthesised label does not appear in the prose, so the pre-trace chats can supply no context
 * for exactly the pairs that would teach the distinction. The trace fixes this going forward; no
 * amount of re-reading the old chats does.
 */

import fs from 'node:fs';
import path from 'node:path';
import { baselineShare, cellAdmits, cellPosterior, countWeight, earnedAccuracyFloor } from './lib/ml/contract.js';
import { AutoUnit, DistillConfig, Witness } from './lib/ml/distill.js';

const corpusPath = path.resolve(process.argv[2] ?? path.join('data', 'fold-corpus.jsonl'));

/** The two answers an identity question may carry, as class ids for the one-vs-rest GBMs. */
const CLASS = { same: 0, different: 1 };
const CLASS_NAME = ['same', 'different'];

/** The BLUP parameter the earned floor is read at, `Contract.earnedBaseline`'s default, and
 * `earnedAccuracyFloor`'s docblock is where the `4` comes from. */
const ALPHA = 4;

/**
 * Read the `pair` records out of a harvested corpus.
 * @param {string} file The corpus JSONL.
 * @returns {object[]} The pair records.
 */
function readPairs(file) {
    if (!fs.existsSync(file)) {
        console.error(`No corpus at ${file}, run harvest.js first.`);
        process.exit(1);
    }
    const pairs = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) {
            continue;
        }
        try {
            const record = JSON.parse(line);
            if (record?.kind === 'pair' && record.answer in CLASS) {
                pairs.push(record);
            }
        } catch {
            // A corrupt corpus line is skipped; the rest still measures.
        }
    }
    return pairs;
}

/**
 * Leave-one-out over a witness set: for each example, distill on the other n-1 and decide it.
 *
 * Leave-one-out rather than a holdout split because n is small enough that a split's variance
 * would swamp the effect being measured, and every example is expensive, each one is an LLM call
 * a human sat through.
 *
 * @param {Witness[]} witnesses The examples.
 * @param {DistillConfig} cfg The config.
 * @returns {{deopt: number, right: number, wrong: number, misses: string[]}} The tally.
 */
function leaveOneOut(witnesses, cfg) {
    let deopt = 0;
    let right = 0;
    let wrong = 0;
    const misses = [];
    for (let i = 0; i < witnesses.length; i++) {
        const train = witnesses.filter((_, j) => j !== i);
        let unit;
        try {
            unit = AutoUnit.distill(train, cfg);
        } catch {
            // Holding one example out can leave a single class behind; that fold is unmeasurable,
            // not a failure of the unit.
            continue;
        }
        const decision = unit.decide(witnesses[i].text);
        if (decision.kind === 'Deopt') {
            deopt += 1;
        } else if (decision.class === witnesses[i].class) {
            right += 1;
        } else {
            wrong += 1;
            misses.push(`${CLASS_NAME[witnesses[i].class]} -> ${CLASS_NAME[decision.class] ?? decision.class}  ${witnesses[i].label}`);
        }
    }
    return { deopt, right, wrong, misses };
}

/**
 * Measure and print one featurizer variant.
 * @param {string} name The variant name.
 * @param {string} what What the witness text carries.
 * @param {object[]} pairs The pair records.
 * @param {(pair: object) => string} textOf The featurizer input.
 * @returns {void}
 */
function report(name, what, pairs, textOf) {
    console.log(`\n${name}, ${what}:`);
    const usable = pairs.filter(pair => textOf(pair).trim().length > 0);
    const skipped = pairs.length - usable.length;
    const counts = usable.reduce((tally, pair) => ({ ...tally, [pair.answer]: (tally[pair.answer] ?? 0) + 1 }), {});

    console.log(`  examples:      ${usable.length}${skipped ? `  (${skipped} skipped, no text to featurize)` : ''}`);
    console.log(`  labels:        ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}`);

    if (Object.keys(counts).length < 2) {
        console.log('  UNMEASURABLE:  fewer than two classes present. A resolver cannot be');
        console.log('                 evaluated, let alone trained, on a set with one answer in it.');
        return;
    }
    const witnesses = usable.map((pair) => {
        const witness = new Witness(textOf(pair), CLASS[pair.answer]);
        witness.label = `${pair.a} ~ ${pair.b}`;
        return witness;
    });
    const majority = baselineShare(witnesses);
    console.log(`  majority baseline (always answer "${Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]}"): ${(majority * 100).toFixed(1)}%`);

    const { deopt, right, wrong, misses } = leaveOneOut(witnesses, new DistillConfig());
    const answered = right + wrong;

    console.log(`  deopt (guard trips, LLM still asked): ${deopt}/${witnesses.length} (${(deopt / witnesses.length * 100).toFixed(0)}%)`);
    console.log(`  fast-pathed:                          ${answered} (${(answered / witnesses.length * 100).toFixed(0)}% of LLM calls saved)`);
    if (answered) {
        const accuracy = right / answered;
        // Every leave-one-out fold that produced a decision is one held-out observation, so `n` is
        // the number of decisions, not the corpus size, the accuracy rests on exactly those.
        const floor = earnedAccuracyFloor(witnesses, answered, ALPHA);
        console.log(`  accuracy on the admitted set:         ${(accuracy * 100).toFixed(1)}%`);
        console.log(`  ${`earned floor (n=${answered}, alpha=${ALPHA}):`.padEnd(37)}${(floor * 100).toFixed(1)}%` +
            `  (weight ${countWeight(ALPHA, answered).toFixed(3)} on the measurement)`);
        const verdict = accuracy >= floor ? 'CLEARS' : 'FAILS';
        console.log(`  GATE: ${verdict} the earned floor${verdict === 'FAILS'
            ? accuracy > majority
                ? ', it beats the constant, but not by the margin this much evidence earns.'
                : ', this unit costs accuracy for the calls it saves.'
            : '.'}`);
    }
    if (misses.length) {
        console.log('  misclassified:');
        misses.forEach(miss => console.log(`    ${miss}`));
    }
}

/**
 * The cell a pair falls in: the detector's own branch, crossed with the table it came from.
 *
 * Both were computed upstream and discarded. `why` is `nearIdentity`'s answer, the reason the
 * question was asked at all, and `of` is whether the row is a person or a stake. Neither appears
 * anywhere in the two names, which is why a featurizer reading only the names cannot recover them.
 *
 * @param {object} pair A `pair` record.
 * @returns {string} The cell key.
 */
const cellOf = (pair) => `${pair.why ?? 'none'}|${pair.of ?? '?'}`;

/**
 * `same` is transitive, so the asked pairs are partial information about a PARTITION rather than a
 * list of independent judgements. Union the `same` edges and report what the closure adds and
 * whether it is consistent.
 *
 * A `different` edge inside a merged component is a contradiction: the model said a=b, b=c and
 * a≠c. Measured over this corpus that count is ZERO across every story, which is what licenses
 * using the closure as free labels rather than as a hypothesis.
 *
 * Keyed per chat, because two stories may name unrelated things alike.
 *
 * @param {object[]} pairs The pair records.
 * @returns {{nodes: number, components: number, implied: number, asked: number,
 *   contradictions: number, sizes: object}} The closure report.
 */
function closure(pairs) {
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
    const union = (a, b) => {
        const [ra, rb] = [find(a), find(b)];
        if (ra !== rb) {
            parent.set(ra, rb);
        }
    };
    const node = (pair, side) => `${pair.chat}${String(pair[side]).toLowerCase()}`;

    let asked = 0;
    for (const pair of pairs) {
        if (pair.answer === 'same') {
            union(node(pair, 'a'), node(pair, 'b'));
            asked += 1;
        } else {
            find(node(pair, 'a'));
            find(node(pair, 'b'));
        }
    }
    const members = new Map();
    for (const key of parent.keys()) {
        const root = find(key);
        members.set(root, (members.get(root) ?? 0) + 1);
    }
    let implied = 0;
    const sizes = {};
    for (const size of members.values()) {
        implied += (size * (size - 1)) / 2;
        sizes[size] = (sizes[size] ?? 0) + 1;
    }
    const contradictions = pairs.filter(pair =>
        pair.answer === 'different' && find(node(pair, 'a')) === find(node(pair, 'b'))).length;

    return { nodes: parent.size, components: members.size, implied, asked, contradictions, sizes };
}

/**
 * Leave-one-out over the cell model: predict each pair from the majority label of its cell, fitted
 * without that pair, abstaining whenever `cellAdmits` says the cell has not earned it.
 * @param {object[]} pairs The pair records.
 * @param {number} baseline The global majority share.
 * @returns {{right: number, wrong: number, abstain: number, misses: string[]}} The tally.
 */
function cellLeaveOneOut(pairs, baseline) {
    let right = 0;
    let wrong = 0;
    let abstain = 0;
    const misses = [];
    for (let i = 0; i < pairs.length; i++) {
        const key = cellOf(pairs[i]);
        const others = pairs.filter((_, j) => j !== i).filter(pair => cellOf(pair) === key);
        const same = others.filter(pair => pair.answer === 'same').length;
        const n = others.length;
        // Both halves are needed, and dropping either was MEASURED to fail. Shrinkage alone
        // (answer every cell, pull thin ones to the prior) reaches 100% coverage at 78.9% against
        // an 83.8% floor: a 67%-pure cell cannot be rescued by reweighting, only by declining it.
        // Abstention alone would answer a thin cell's raw majority. So: admit by earned evidence,
        // then answer the shrunk posterior.
        const purity = n ? Math.max(same, n - same) / n : 0;
        if (!cellAdmits(n, purity, baseline, ALPHA)) {
            abstain += 1;
            continue;
        }
        const predicted = cellPosterior(n, same / n, baseline, ALPHA) >= 0.5 ? 'same' : 'different';
        if (predicted === pairs[i].answer) {
            right += 1;
        } else {
            wrong += 1;
            misses.push(`${pairs[i].answer} -> ${predicted}  [${key}]  ${pairs[i].a} ~ ${pairs[i].b}`);
        }
    }
    return { right, wrong, abstain, misses };
}

function main() {
    const pairs = readPairs(corpusPath);
    console.log(`corpus: ${corpusPath}`);
    console.log(`        ${pairs.length} labelled identity pairs` +
        ` (${pairs.filter(p => p.source === 'trace').length} with prompt context,` +
        ` ${pairs.filter(p => p.source === 'chat').length} reconstructed from chat text)`);

    report('names', 'the two names alone', pairs, pair => `${pair.a} | ${pair.b}`);
    report('context', 'the names plus the text that decided them', pairs, pair => pair.context ?? '');

    // the partition.
    const shut = closure(pairs);
    console.log('\nthe relation is a partition, not a list of judgements:');
    console.log(`  nodes ${shut.nodes} in ${shut.components} components   sizes ${JSON.stringify(shut.sizes)}`);
    console.log(`  contradictions (a "different" edge inside a merged component): ${shut.contradictions}`);
    console.log(`  same-pairs implied by transitivity: ${shut.implied}, asked: ${shut.asked}` +
        `  -> ${Math.max(0, shut.implied - shut.asked)} labels for free`);
    if (shut.contradictions > 0) {
        console.log('  WARNING: the closure is inconsistent. Free labels are NOT safe to take.');
    }

    // the cell model.
    const baseline = baselineShare(pairs.map(pair => ({ class: CLASS[pair.answer] })));
    console.log('\ncells, the detector branch crossed with the table it came from:');
    const cells = {};
    for (const pair of pairs) {
        (cells[cellOf(pair)] ??= []).push(pair.answer);
    }
    for (const [key, answers] of Object.entries(cells).sort((a, b) => b[1].length - a[1].length)) {
        const same = answers.filter(answer => answer === 'same').length;
        const n = answers.length;
        const purity = Math.max(same, n - same) / n;
        const posterior = cellPosterior(n, same / n, baseline, ALPHA);
        const admits = cellAdmits(n, purity, baseline, ALPHA);
        console.log(`  ${key.padEnd(22)} n=${String(n).padStart(3)}  same ${String(same).padStart(3)}` +
            `  diff ${String(n - same).padStart(3)}  purity ${(purity * 100).toFixed(0).padStart(3)}%` +
            `  p̂ ${posterior.toFixed(2)}  ${admits ? `-> ${posterior >= 0.5 ? 'same' : 'different'}` : 'ABSTAINS'}`);
    }

    const { right, wrong, abstain, misses } = cellLeaveOneOut(pairs, baseline);
    const answered = right + wrong;
    console.log('\ncell model, leave-one-out, admit by earned evidence, answer the shrunk posterior:');
    console.log(`  examples:      ${pairs.length}`);
    console.log(`  abstained (LLM still asked):          ${abstain}/${pairs.length} (${(abstain / pairs.length * 100).toFixed(0)}%)`);
    console.log(`  fast-pathed:                          ${answered} (${(answered / pairs.length * 100).toFixed(0)}% of LLM calls saved)`);
    if (answered) {
        const accuracy = right / answered;
        const floor = earnedAccuracyFloor(pairs.map(pair => ({ class: CLASS[pair.answer] })), answered, ALPHA);
        console.log(`  accuracy on the admitted set:         ${(accuracy * 100).toFixed(1)}%`);
        console.log(`  ${`earned floor (n=${answered}, alpha=${ALPHA}):`.padEnd(37)}${(floor * 100).toFixed(1)}%`);
        console.log(`  GATE: ${accuracy >= floor ? 'CLEARS' : 'FAILS'} the earned floor.`);
    }
    if (misses.length) {
        console.log('  misclassified:');
        misses.forEach(miss => console.log(`    ${miss}`));
    }

    // The resolution of the measurement itself, which is the number that decides whether any of
    // the above can carry weight.
    const different = pairs.filter(pair => pair.answer === 'different').length;
    console.log('\nmeasurement resolution:');
    console.log(`  minority-class examples ("different"): ${different}`);
    if (different < 20) {
        console.log(`  One example is worth ${(100 / Math.max(different, 1)).toFixed(0)}% of the minority class. A gate decided at`);
        console.log('  this resolution is decided by noise. More play is the only fix, and it has to be');
        console.log('  play that produces DIFFERENT verdicts, not more of the same ones.');
    }
}

main();
