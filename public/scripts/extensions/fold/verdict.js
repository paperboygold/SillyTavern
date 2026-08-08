/**
 * fold/verdict.js — adjudication, wired.
 *
 * The pure decision layer is in verdict-table.js; this file gathers what the decision needs and
 * hands the result to the narrator.
 *
 * ── The one call, and what it is NOT asked ──
 *
 * The model is asked to classify the attempt against facts the world has already established:
 * does anything on record make this possible, is anyone resisting, does it ignore something the
 * character knows. It is never asked whether the attempt succeeds. That question is the one it
 * cannot answer honestly — dramatic logic says yes, sycophancy worsens with context, and models
 * have been caught fudging outcomes deliberately — so it is answered in code, from the ratings.
 *
 * This is the "zero degrees of freedom" shape: the model does what it is genuinely good at, which
 * is reading fiction and judging what it supports, and the arithmetic that decides the player's
 * fate happens somewhere the model cannot reach.
 */

import { chat, generateRaw } from '../../../script.js';
import { ConnectionManagerRequestService } from '../shared.js';
import * as chronicle from './chronicle.js';
import * as clocks from './clocks.js';
import * as entities from './entities.js';
import { PERSON, dispositionRank, resolveEntity } from './entity-table.js';
import { analyzeExtraction } from './json-parse.js';
import { insert_with, merge_b, lookup } from './lib/hash.js';
import * as observe from './observe.js';
import * as state from './state.js';
import { hurtOf } from './state-table.js';
import { commit, loadTable } from './store.js';
import {
    CLEAR,
    COST,
    SETBACK,
    adjudicate,
    clampMomentum,
    matchThread,
    precedentFor,
    renderVerdict,
} from './verdict-table.js';

const MOMENTUM_PATH = 'state.momentum';
const PENDING_COST_PATH = 'state.pending-cost';

/** @returns {number} Banked standing for this chat. */
export function momentum() {
    const table = loadTable(MOMENTUM_PATH);
    return clampMomentum(Number(table.get('n')));
}

/**
 * Set banked standing.
 * @param {number} value New momentum.
 */
export function setMomentum(value) {
    const table = loadTable(MOMENTUM_PATH);
    table.set('n', clampMomentum(value));
    commit(MOMENTUM_PATH, table);
}

/**
 * Record that the last attempt succeeded at a cost, so the NEXT extraction can record the cost.
 *
 * ── Why a note at all — the loop that closed nothing ──
 *
 * Before Phase E, a COST verdict vanished into the narrator's block and the money/item the cost
 * consumed had to happen to be re-extracted from the prose that followed. That is hope wearing the
 * clothes of a pipeline. The write-back closes it the same way verdicts write state everywhere else
 * (§6): COST writes a pending note here, and the next extraction pass reads it into its prompt and
 * is told to record what was spent as a delta. One entry, overwritten by the next COST — a queue
 * would hold stale costs for turns nothing consumed them.
 *
 * @param {string} text The attempt that succeeded at a cost, in the player's words.
 */
export function notePendingCost(text) {
    const table = loadTable(PENDING_COST_PATH);
    insert_with(table, merge_b, 'cost', {
        v: String(text ?? '').trim().slice(0, 240),
        t: Date.now(),
    });
    commit(PENDING_COST_PATH, table);
}

/**
 * Take the pending-cost note for the next extraction, clearing it in the same call.
 *
 * Read-then-delete is the whole point: the note describes a cost from LAST turn, and a note that
 * survives to the turn after would bill a cost the story has moved past. Taken before the extraction
 * prompt is built; cleared even if the pass then declines, so a note can never be read twice.
 *
 * @returns {string} The note, or '' when there is nothing pending.
 */
export function takePendingCost() {
    const table = loadTable(PENDING_COST_PATH);
    const row = lookup(table, 'cost', null);
    table.delete('cost');
    commit(PENDING_COST_PATH, table);
    return row?.v ?? '';
}

const SYSTEM_PROMPT = [
    'You are a rules adjudicator for a roleplay session. You judge only what the established fiction supports.',
    'You never decide whether an attempt succeeds — that is decided elsewhere, and guessing at it corrupts the result.',
    'You answer only in JSON.',
].join(' ');

/** @returns {object} The JSON schema for the classification. */
function schema() {
    return {
        name: 'fold_attempt',
        strict: true,
        returnInvalid: true,
        value: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                contested: {
                    type: 'boolean',
                    description: 'True only if the OUTCOME of this attempt is genuinely in doubt — it could fail, or cost something. False for anything a competent person simply does: picking up an object, walking somewhere safe, speaking, putting on clothing, examining a thing. When false, nothing else here matters.',
                },
                supported: {
                    type: 'boolean',
                    description: 'True if something already established — a possession, an ability, a relationship, a fact from the transcript — makes this attempt possible for this character. False if nothing on record does. Judge the CAPABILITY, not the likelihood.',
                },
                opposed: {
                    type: 'boolean',
                    description: 'True if a person, creature or force in the scene is actively resisting this specific attempt right now.',
                },
                reckless: {
                    type: 'boolean',
                    description: 'True if the attempt ignores something this character has been told, has seen, or plainly knows — walking into a danger they were warned about, trusting someone who already betrayed them.',
                },
                against: {
                    type: 'string',
                    description: 'The name of the person most directly opposing or being asked, exactly as the transcript names them. Empty if the attempt is not aimed at anyone.',
                },
                keywords: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Two to five lowercase keywords describing the attempt, for matching against past events: verbs and nouns, not adjectives.',
                },
            },
            required: ['contested', 'supported', 'opposed', 'reckless', 'against', 'keywords'],
            additionalProperties: false,
        },
    };
}

/**
 * Ask the model to classify an attempt.
 * @param {string} attempt What the player is trying.
 * @param {object} options Options.
 * @param {number} [options.window] Trailing messages for context.
 * @param {string} [options.profileId] Connection profile.
 * @param {number} [options.responseLength] Token budget.
 * @returns {Promise<object|null>} The classification, or null.
 */
async function classify(attempt, { window = 6, profileId = '', responseLength = 800 } = {}) {
    const recent = (chat ?? [])
        .filter(message => message?.mes && !message.is_system)
        .slice(-Math.max(1, window))
        .map(message => `${message.name ?? 'Unknown'}: ${message.mes}`)
        .join('\n\n');

    // ── The judge is fed the record, not just the transcript ──
    //
    // §6: "It judges blind." Before Phase E the classifier saw only the chat excerpt, so `supported`
    // — "does anything on record make this possible?" — was answered WITHOUT the record: the ledger
    // the narrator is shown (marks, threat integers, momentum, feels/wants/knows, live threads) was
    // never in the evidence. `precedentFor` was the only tracked fact that reached the verdict. The
    // pinned ledger closes that: "an E-rank with a wounded calf vaults a rank of charging goblins"
    // is visibly opposed-and-reckless when the block carries the calf wound and the rank.
    const ledger = state.ledgerBlock();

    const prompt = [
        'Transcript:', '---', recent, '---', '',
        ...(ledger.text ? ['Established state:', ledger.text, ''] : []),
        `The player now attempts: ${attempt}`,
        '',
        'Classify this attempt against what the fiction and this established state support. Respond with JSON only.',
    ].join('\n');

    const json = schema();
    const raw = profileId
        ? (await ConnectionManagerRequestService.sendRequest(
            profileId,
            [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }],
            responseLength,
            { extractData: true, includePreset: false, includeInstruct: false },
            { json_schema: json },
        ))?.content
        : await generateRaw({ prompt, systemPrompt: SYSTEM_PROMPT, responseLength, jsonSchema: json });

    return analyzeExtraction(raw).value;
}

/**
 * Adjudicate an attempt and produce the directive the narrator must honour.
 *
 * @param {string} attempt What the player is trying, in their own words.
 * @param {object} [options] Options.
 * @returns {Promise<{ok: boolean, reason?: string, verdict?: object, directive?: string}>} Outcome.
 */
export async function judge(attempt, options = {}) {
    const said = String(attempt ?? '').trim();
    if (!said) {
        return { ok: false, reason: 'no-attempt' };
    }

    let classified = null;
    try {
        classified = await classify(said, options);
    } catch (error) {
        console.error('[fold] adjudication failed', error);
        observe.note('verdict:error');
        return { ok: false, reason: String(error?.message ?? error) };
    }
    if (!classified) {
        // Declining is better than guessing. An unclassified attempt adjudicated from defaults
        // would hand the narrator a verdict built on nothing, which is worse than no verdict.
        observe.note('verdict:unclassified');
        return { ok: false, reason: 'unclassified' };
    }

    // ── The model judges whether the outcome is in doubt; code judges how it goes ──
    //
    // The keyword gate upstream is a cheap pre-filter, not a decision — measured on a real chat it
    // ran about 50% precision, which is fine for deciding whether to spend a call and useless for
    // deciding whether to impose a verdict. Asking "is this contested?" is a reading-comprehension
    // question, which the model is good at; asking "does it succeed?" is the one it cannot answer
    // honestly. Splitting them puts each question where it belongs.
    if (classified.contested === false) {
        observe.note('verdict:uncontested');
        return { ok: false, reason: 'uncontested' };
    }

    // ── Everything below happens in code ──
    const turn = entities.turn();
    const table = entities.load();
    const target = resolveEntity(table, PERSON, classified.against)?.entity;

    const standing = {
        momentum: momentum(),
        // ── The player's own wounds, and nobody else's ──
        //
        // This read `state.snapshot().status.length` — a count of a flat, subjectless flag table, so
        // the ambush that wounded Lee and Park made SOLOMON two steps worse at everything for the
        // rest of the session (`FOLD-RPG-GAP.md` §3, `FOLD-REDESIGN.md` §3). With `who` on every
        // mark the question is answerable properly: the pov's marks, weighted by severity. The
        // weighting and its two-step coarseness are argued in `state-table.js` `hurtOf`.
        hurt: hurtOf(state.derive().marks, state.pov()),
        regard: target?.feels ? dispositionRank(target.feels) : undefined,
        precedent: precedentFor(chronicle.loadEvents(), classified.keywords),
    };

    const verdict = adjudicate(classified, standing);
    setMomentum(verdict.momentum);
    observe.note(`verdict:${verdict.band}`);

    // ── Verdicts write state; they do not vanish into the narrator's block ──
    //
    // §6's third fix. Before this, the only side effect of a verdict was the directive injection.
    // Now each band leaves its own trace in the world fold knows about.
    //
    // SETBACK: the dial the attempt was actually about advances — the residency window, not a random
    // victim. A mis-aimed tick is worse than no tick, so a setback with no matching thread lands as
    // narrative consequence only and no dial moves (§6, `verdict-table.js` `matchThread`).
    if (verdict.band === SETBACK) {
        const aimed = matchThread(clocks.snapshot(turn), {
            keywords: classified.keywords,
            against: classified.against,
        });
        if (aimed) {
            clocks.set(aimed.name, { filled: (aimed.filled ?? 0) + 1, turn });
            observe.note('verdict:setback-aimed');
        }
    }

    // COST: the next extraction is told to record what the cost consumed as a delta — the loop that
    // used to depend on the narrator's prose happening to re-extract (§6, `notePendingCost`).
    if (verdict.band === COST) {
        notePendingCost(said);
        observe.note('verdict:cost-note');
    }

    return {
        ok: true,
        verdict: { ...verdict, standing, classified, target: target?.name ?? '' },
        directive: renderVerdict(verdict, said),
    };
}

/**
 * A one-line account of why it went that way, for the player.
 * @param {object} verdict The verdict from `judge`.
 * @returns {string} A readable explanation.
 */
export function explain(verdict) {
    const band = verdict?.band === CLEAR ? 'It works.'
        : verdict?.band === SETBACK ? 'It does not work.'
            : 'It works, at a cost.';
    const why = (verdict?.why ?? []).join(', ');
    return why ? `${band} (${why})` : band;
}
