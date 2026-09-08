/**
 * fold/compare.js: did a prompt change alter what the model extracts, and what did it cost?
 *
 * Run from the SillyTavern repo root, after replaying a chat both ways:
 *
 *     node public/scripts/extensions/sanguine/compare.js <chat-id> [a-why] [b-why]
 *
 * A prompt change is cheap to argue about and expensive to be wrong about. `extract.js`'s prompt
 * carries a lot of measured reasoning in its current shape, so "the reordered one is 77% cheaper"
 * is only half a claim, the other half is whether it extracts the same things. This pairs the two
 * arms of a `/fold-replay` A/B by the window they read (the `mid` they ended on) and reports:
 *
 *   - TOKENS: what the reorder actually moved, split into the cacheable prefix and the per-pass
 *     remainder, because the saving is only real if a prefix cache can reach it;
 *   - PREFIX STABILITY: how often consecutive passes share a byte-identical cacheable prefix. This
 *     is the number that decides whether the reorder is worth anything at all, a cache is
 *     all-or-nothing up to its breakpoint, so a prefix that moves every pass caches nothing;
 *   - AGREEMENT: per probe, whether the two arms produced the same parsed fragment.
 *
 * Agreement is reported per probe rather than as one number because the probes fail differently: a
 * scene disagreeing on `elapsed_minutes` and a threads probe inventing a stake are not the same
 * severity, and one aggregate would hide which moved.
 *
 * Both arms are read from the trace, so this never calls a model. `why` distinguishes them,
 * `/fold-replay` stamps `replay` and `/fold-replay staticfirst=true` stamps `replay-staticfirst`.
 */

import fs from 'node:fs';
import path from 'node:path';

const TRACES = path.join('data', 'default-user', 'extensions', 'sanguine-traces');

const chatId = process.argv[2];
const whyA = process.argv[3] ?? 'replay';
const whyB = process.argv[4] ?? 'replay-staticfirst';

if (!chatId) {
    console.error('usage: node public/scripts/extensions/sanguine/compare.js <chat-id> [a-why] [b-why]');
    process.exit(1);
}

/** The marker that begins the static half of the prompt. */
const INSTRUCTIONS = 'Extract the following:';

/** A crude token proxy. Ratios are what this file reports, and chars/4 is stable enough for them. */
const tok = (text) => Math.round(String(text ?? '').length / 4);

/**
 * Split a prompt into the half a prefix cache could hold and the half it could not.
 *
 * Which half leads depends on the ordering under test, so this keys on where the instruction block
 * sits rather than assuming: instructions at the front means the static half leads and is
 * cacheable; instructions at the back means the transcript leads and nothing is.
 *
 * @param {string} prompt The prompt as sent.
 * @returns {{cacheable: string, perPass: string, staticFirst: boolean}} The split.
 */
function split(prompt) {
    const text = String(prompt ?? '');
    const at = text.indexOf(INSTRUCTIONS);
    if (at < 0) {
        return { cacheable: '', perPass: text, staticFirst: false };
    }
    // Instructions within the first fifth of the prompt is the reordered arm. The threshold is
    // structural, not tuned: in the original ordering the transcript and ledger always precede
    // them, and the smallest observed transcript is far more than a fifth of a pass.
    const staticFirst = at < text.length / 5;
    if (!staticFirst) {
        return { cacheable: '', perPass: text, staticFirst: false };
    }
    // The cacheable prefix runs from the start to wherever the per-pass content begins, the
    // transcript. Everything before that is byte-identical across passes of the same chat, which
    // `prefixStability` is what actually verifies.
    const dynamicAt = text.indexOf('Transcript excerpt:');
    const cut = dynamicAt > 0 ? dynamicAt : text.length;
    return { cacheable: text.slice(0, cut), perPass: text.slice(cut), staticFirst: true };
}

/** Load one arm's passes, oldest first. */
function arm(records, why) {
    return records.filter(record => record.why === why);
}

/**
 * How often consecutive passes share a byte-identical leading prefix.
 * @param {object[]} passes The arm's passes.
 * @returns {{hits: number, pairs: number, prefixTokens: number}} The stability report.
 */
function prefixStability(passes) {
    let hits = 0;
    let pairs = 0;
    let prefixTokens = 0;
    for (let i = 0; i < passes.length; i++) {
        const here = split(passes[i].prompt);
        prefixTokens += tok(here.cacheable);
        if (i === 0) {
            continue;
        }
        const previous = split(passes[i - 1].prompt);
        pairs += 1;
        if (here.cacheable && here.cacheable === previous.cacheable) {
            hits += 1;
        }
    }
    return { hits, pairs, prefixTokens: passes.length ? Math.round(prefixTokens / passes.length) : 0 };
}

/** Stable stringify so key order cannot masquerade as disagreement. */
function canonical(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonical).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(k => `${k}:${canonical(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

function main() {
    const file = path.join(TRACES, `${chatId}.jsonl`);
    if (!fs.existsSync(file)) {
        console.error(`No trace at ${file}`);
        process.exit(1);
    }
    const records = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) {
            continue;
        }
        try {
            records.push(JSON.parse(line));
        } catch {
            // a corrupt line is skipped; the rest still compares
        }
    }

    const a = arm(records, whyA);
    const b = arm(records, whyB);
    console.log(`${chatId}`);
    console.log(`  arm A "${whyA}": ${a.length} passes    arm B "${whyB}": ${b.length} passes`);
    if (!a.length || !b.length) {
        console.error('\nBoth arms need passes. Run /fold-replay and /fold-replay staticfirst=true on this chat.');
        process.exit(1);
    }

    // tokens.
    const mean = (passes, f) => Math.round(passes.reduce((sum, p) => sum + f(p), 0) / passes.length);
    const aPrompt = mean(a, p => tok(p.prompt));
    const bPrompt = mean(b, p => tok(p.prompt));
    const aSchema = mean(a, p => tok(JSON.stringify(p.schema)));
    const bSchema = mean(b, p => tok(JSON.stringify(p.schema)));
    const aStab = prefixStability(a);
    const bStab = prefixStability(b);

    console.log('\ntokens per pass (chars/4):');
    console.log(`  ${''.padEnd(22)}${whyA.padStart(12)}${whyB.padStart(16)}`);
    console.log(`  ${'prompt'.padEnd(22)}${String(aPrompt).padStart(12)}${String(bPrompt).padStart(16)}`);
    console.log(`  ${'schema'.padEnd(22)}${String(aSchema).padStart(12)}${String(bSchema).padStart(16)}`);
    console.log(`  ${'cacheable prefix'.padEnd(22)}${String(aStab.prefixTokens).padStart(12)}${String(bStab.prefixTokens).padStart(16)}`);

    console.log('\nprefix stability (consecutive passes sharing a byte-identical prefix):');
    for (const [name, stab] of [[whyA, aStab], [whyB, bStab]]) {
        const rate = stab.pairs ? stab.hits / stab.pairs : 0;
        console.log(`  ${name.padEnd(22)} ${stab.hits}/${stab.pairs} = ${(rate * 100).toFixed(0)}%`);
    }
    // What a cache is worth here: the stable prefix, billed at a read rate, on the hit fraction.
    const hitRate = bStab.pairs ? bStab.hits / bStab.pairs : 0;
    const cached = bStab.prefixTokens + bSchema;
    const effective = (bPrompt + bSchema) - cached * hitRate * 0.9;
    console.log(`\n  arm B billable per pass at a 0.1x cache read: ${Math.round(effective)} vs ${aPrompt + aSchema} for arm A` +
        `  (${((1 - effective / (aPrompt + aSchema)) * 100).toFixed(0)}% cheaper)`);

    // agreement, paired by the window each pass ended on.
    const byMid = new Map();
    for (const p of a) {
        byMid.set(p.mid, { a: p });
    }
    for (const p of b) {
        if (byMid.has(p.mid)) {
            byMid.get(p.mid).b = p;
        }
    }
    const paired = [...byMid.values()].filter(pair => pair.b);
    console.log(`\nagreement over ${paired.length} passes paired by window:`);
    const probes = new Set();
    for (const pair of paired) {
        Object.keys(pair.a.parsed ?? {}).forEach(k => probes.add(k));
        Object.keys(pair.b.parsed ?? {}).forEach(k => probes.add(k));
    }
    for (const probe of [...probes].sort()) {
        let same = 0;
        let seen = 0;
        for (const pair of paired) {
            const x = pair.a.parsed?.[probe];
            const y = pair.b.parsed?.[probe];
            if (x === undefined && y === undefined) {
                continue;
            }
            seen += 1;
            if (canonical(x) === canonical(y)) {
                same += 1;
            }
        }
        const rate = seen ? same / seen : 0;
        console.log(`  ${probe.padEnd(12)} ${same}/${seen} identical  ${(rate * 100).toFixed(0)}%`);
    }
    const okA = a.filter(p => p.ok).length;
    const okB = b.filter(p => p.ok).length;
    console.log(`\n  passes that produced a fragment:  ${whyA} ${okA}/${a.length}   ${whyB} ${okB}/${b.length}`);
    console.log('\n  Identical fragments are not the bar, the model is sampled, so two runs of the SAME');
    console.log('  prompt disagree too. Run this on two same-ordering replays first to learn what');
    console.log('  agreement looks like at zero change, then read the reorder against that floor.');
}

main();
