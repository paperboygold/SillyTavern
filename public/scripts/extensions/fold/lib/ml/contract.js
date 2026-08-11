// CONTRACT — the verification gate a distilled AutoUnit must clear before it's trusted to run in
// place of the reference LLM, ported from `modelfold/src/auto/contract.rs` (auto's
// `spec/contract.md`, restood). The three-valued verdict IS the trinity `{B, NB, B/U}` rather
// than a bespoke enum: **Pass = B** (proven — every declared check held), **Fail = NB** (refuted
// — a check failed outright), **Inconclusive = B/U** (the superposition — not enough evidence
// either way). auto's own rule, reproduced exactly: **Fail beats Inconclusive, and BOTH block
// emit** — there is no force flag.

/**
 * The verdict — Pass (B), Fail (NB), or Inconclusive (B/U).
 */
export class Verdict {
    /**
     * @param {string} kind 'Pass' | 'Fail' | 'Inconclusive'.
     * @param {object} [detail] `{reasons: string[]}` for Fail, `{reason: string}` for Inconclusive.
     */
    constructor(kind, detail = {}) {
        this.kind = kind;
        this.reasons = detail.reasons ?? [];
        this.reason = detail.reason ?? null;
    }

    /** Neither `Fail` nor `Inconclusive` may emit — only `Pass` does. No force flag. */
    blocksEmit() {
        return this.kind !== 'Pass';
    }

    /**
     * Combine several verdicts under auto's own rule: Fail beats Inconclusive beats Pass — the
     * weakest evidence wins, never the strongest.
     * @param {Verdict[]} verdicts The per-check verdicts.
     * @returns {Verdict} The combined verdict.
     */
    static combine(verdicts) {
        // `anyFail` is tracked explicitly, NOT inferred from `reasons.length` — a `Fail` can
        // legitimately carry an empty reasons list (a >100% threshold check: every witness
        // matches, yet the check still fails on the raw arithmetic). Inferring "was there a
        // Fail?" from "are there any reasons?" silently drops exactly that Fail.
        let anyFail = false;
        const allReasons = [];
        let inconclusiveReason = null;
        for (const v of verdicts) {
            if (v.kind === 'Fail') {
                anyFail = true;
                for (const r of v.reasons) {
                    allReasons.push(r);
                }
            } else if (v.kind === 'Inconclusive') {
                if (inconclusiveReason === null) {
                    inconclusiveReason = v.reason;
                }
            }
        }
        if (anyFail) {
            return new Verdict('Fail', { reasons: allReasons });
        }
        if (inconclusiveReason !== null) {
            return new Verdict('Inconclusive', { reason: inconclusiveReason });
        }
        return new Verdict('Pass');
    }
}

/**
 * Exact differential replay (auto's own default): does the compiled unit reproduce EVERY
 * witnessed input's recorded class exactly? A unit's own witnesses should always pass this — a
 * failure here means the unit and its own training data have drifted apart.
 * @param {AutoUnit} unit The distilled unit.
 * @param {Witness[]} witnesses The recorded witnesses.
 * @returns {Verdict} Pass, Fail, or Inconclusive (empty witness set).
 */
export const differentialReplay = (unit, witnesses) => {
    if (witnesses.length === 0) {
        return new Verdict('Inconclusive', { reason: 'no witnessed inputs to replay' });
    }
    const reasons = [];
    for (const w of witnesses) {
        const d = unit.decide(w.text);
        if (d.kind === 'FastPath' && d.class === w.class) {
            continue;
        }
        if (d.kind === 'FastPath') {
            reasons.push(`${w.text}: replayed class ${d.class}, recorded class ${w.class}`);
        } else {
            reasons.push(`${w.text}: guard tripped replaying its own witness`);
        }
    }
    return reasons.length === 0 ? new Verdict('Pass') : new Verdict('Fail', { reasons });
};

/**
 * Differential replay with a declared minimum agreement threshold instead of exact 100% — auto's
 * ADR-0018 escape hatch, reproduced with its exact pure-integer-math rule
 * (`matched*1000 >= milli*eligible`, no float division to drift).
 * @param {AutoUnit} unit The distilled unit.
 * @param {Witness[]} witnesses The recorded witnesses.
 * @param {number} minAgreementMilli The minimum agreement, in thousandths.
 * @returns {Verdict} Pass, Fail, or Inconclusive (empty witness set).
 */
export const differentialReplayThresholded = (unit, witnesses, minAgreementMilli) => {
    if (witnesses.length === 0) {
        return new Verdict('Inconclusive', { reason: 'no witnessed inputs to replay' });
    }
    let matched = 0;
    const mismatches = [];
    for (const w of witnesses) {
        const d = unit.decide(w.text);
        if (d.kind === 'FastPath' && d.class === w.class) {
            matched += 1;
        } else if (d.kind === 'FastPath') {
            mismatches.push(`${w.text}: got ${d.class} want ${w.class}`);
        } else {
            mismatches.push(`${w.text}: guard tripped replaying its own witness`);
        }
    }
    const eligible = witnesses.length;
    if (matched * 1000 >= minAgreementMilli * eligible) {
        return new Verdict('Pass');
    }
    // Every witness can match (mismatches empty) and this still fails, if `minAgreementMilli`
    // itself demands more than 100% — an honest Fail always names why.
    if (mismatches.length === 0) {
        mismatches.push(`${matched}/${eligible} witnesses matched (100%), but the declared threshold ` +
            `${minAgreementMilli} milli (${minAgreementMilli / 10.0}%) is mathematically unreachable`);
    }
    return new Verdict('Fail', { reasons: mismatches });
};

/**
 * A regex-based SCOPE check — auto's own closed-set contract property: every witness recorded
 * under `class` must match `pattern`, catching a witness that doesn't actually belong to the
 * domain it was recorded under. JS `RegExp`, the browser's native engine, standing in for the
 * Rust side's `tregex`. This checks the SHAPE of recorded witnesses against a caller-declared
 * pattern — protocol, never narrative prose.
 * @param {Witness[]} witnesses The recorded witnesses.
 * @param {number} klass The class to scope-check.
 * @param {string} pattern The regex every class-`klass` witness must match.
 * @returns {Verdict} Pass, Fail, or Inconclusive.
 */
export const regexScopeCheck = (witnesses, klass, pattern) => {
    let re;
    try {
        re = new RegExp(pattern);
    } catch (e) {
        return new Verdict('Inconclusive', { reason: `invalid regex pattern ${pattern}: ${e.message}` });
    }
    const reasons = [];
    let checked = 0;
    for (const w of witnesses) {
        if (w.class !== klass) {
            continue;
        }
        checked += 1;
        if (!re.test(w.text)) {
            reasons.push(`${w.text}: class ${klass} witness doesn't match scope pattern ${pattern}`);
        }
    }
    if (checked === 0) {
        return new Verdict('Inconclusive', { reason: `no witnesses recorded for class ${klass} to check` });
    }
    return reasons.length === 0 ? new Verdict('Pass') : new Verdict('Fail', { reasons });
};

/**
 * The declared checks an emitted AutoUnit must clear — auto's own TOML contract, narrowed to what
 * this port can actually verify: differential agreement, holdout generalization, and a per-class
 * regex scope check.
 */
export class Contract {
    /**
     * @param {object} [o] Overrides.
     * @param {number} [o.minDifferentialAgreementMilli=0] Minimum differential agreement on the
     *   witness set, in thousandths. `1000` = exact replay (auto's default). `0` disables.
     * @param {number} [o.minHoldoutAccuracy=0.0] Minimum acceptable holdout-generalization
     *   accuracy. `0.0` disables.
     * @param {Array<[number, string]>} [o.scopePatterns=[]] Per-class scope patterns every
     *   witness of that class must match. Empty disables.
     */
    constructor(o = {}) {
        this.minDifferentialAgreementMilli = o.minDifferentialAgreementMilli ?? 0;
        this.minHoldoutAccuracy = o.minHoldoutAccuracy ?? 0.0;
        this.scopePatterns = o.scopePatterns ?? [];
    }

    /** The auto-default contract: require exact differential replay, no holdout floor, no scope. */
    static exactReplay() {
        return new Contract({ minDifferentialAgreementMilli: 1000 });
    }

    /**
     * Run every declared check and combine the verdicts under auto's rule (Fail beats
     * Inconclusive beats Pass).
     * @param {AutoUnit} unit The distilled unit.
     * @param {Witness[]} witnesses The recorded witnesses.
     * @returns {Verdict} The combined verdict.
     */
    verify(unit, witnesses) {
        const verdicts = [];
        if (this.minDifferentialAgreementMilli > 0) {
            verdicts.push(differentialReplayThresholded(unit, witnesses, this.minDifferentialAgreementMilli));
        }
        if (this.minHoldoutAccuracy > 0.0) {
            const acc = unit.holdout_accuracy();
            if (acc === null) {
                verdicts.push(new Verdict('Inconclusive', { reason: 'no holdout check ran during distillation' }));
            } else if (acc >= this.minHoldoutAccuracy) {
                verdicts.push(new Verdict('Pass'));
            } else {
                verdicts.push(new Verdict('Fail', {
                    reasons: [`holdout accuracy ${acc.toFixed(3)} < declared floor ${this.minHoldoutAccuracy.toFixed(3)}`],
                }));
            }
        }
        for (const [klass, pattern] of this.scopePatterns) {
            verdicts.push(regexScopeCheck(witnesses, klass, pattern));
        }
        return Verdict.combine(verdicts);
    }
}

// ───────── the self-test (mirrors auto/contract.rs §tests, runnable: import { self_test }) ─────────

/**
 * The contract's own verification, mirroring the Rust suite's trinity-combine assertions.
 * @returns {string} An acknowledgement that every assertion held.
 */
export const self_test = () => {
    const failBeatsInconclusive = Verdict.combine([
        new Verdict('Inconclusive', { reason: 'no data' }),
        new Verdict('Fail', { reasons: ['mismatch'] }),
        new Verdict('Pass'),
    ]);
    if (failBeatsInconclusive.kind !== 'Fail') {
        throw new Error('contract.js: fail_beats_inconclusive_when_combined');
    }
    // A Fail with an empty reasons list still blocks emit — the regression the Rust side pinned.
    const emptyReasons = Verdict.combine([new Verdict('Pass'), new Verdict('Fail', { reasons: [] })]);
    if (emptyReasons.kind !== 'Fail' || !emptyReasons.blocksEmit()) {
        throw new Error('contract.js: a_fail_with_empty_reasons_still_blocks_emit');
    }
    if (new Verdict('Pass').blocksEmit()) {
        throw new Error('contract.js: pass_never_blocks_emit');
    }
    if (!new Verdict('Inconclusive', { reason: 'x' }).blocksEmit()) {
        throw new Error('contract.js: inconclusive_blocks_emit');
    }
    return 'contract.js: the trinity verdicts hold';
};
