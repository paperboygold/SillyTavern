/**
 * fold/slash-commands.js — /steer and its aliases.
 *
 * Deliberately does NOT extend /regenerate: that routes to Generate('regenerate'), which deletes
 * the entire last chat entry (and therefore every swipe on it) before generating. Attaching an
 * instruction there would mean "type a direction, lose your variant history" — the exact opposite
 * of what steering is for.
 */

import { chat, is_send_press } from '../../../script.js';
import { extension_settings } from '../../extensions.js';
import { is_group_generating } from '../../group-chats.js';
import { t } from '../../i18n.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { isTrueBoolean, waitUntilCondition } from '../../utils.js';
import * as chronicle from './chronicle.js';
import * as clocks from './clocks.js';
import * as plot from './plot.js';
import * as verdict from './verdict.js';
import * as entities from './entities.js';
import * as observe from './observe.js';
import * as state from './state.js';
import * as trace from './trace.js';
import * as extract from './extract.js';
import * as store from './store.js';
import { requestSteer } from './steer.js';

async function steerCallback(args, instruction) {
    const shouldAwait = isTrueBoolean(args?.await);
    const text = String(instruction ?? '').trim();

    if (!text) {
        toastr.warning(t`/steer needs an instruction, e.g. /steer make her angrier`);
        return '';
    }

    const requestedMesId = Number(args?.mes);
    const mesId = Number.isInteger(requestedMesId) && requestedMesId >= 0
        ? requestedMesId
        : chat.length - 1;

    const outerPromise = new Promise((outerResolve) => setTimeout(async () => {
        try {
            await waitUntilCondition(() => !is_send_press && !is_group_generating, 10000, 100);
        } catch {
            console.warn('Timeout waiting for generation unlock');
            toastr.warning(t`Cannot run /steer while a reply is being generated.`);
            outerResolve(Promise.resolve(''));
            return '';
        }

        outerResolve(Promise.resolve(requestSteer(mesId, text, { source: 'slash' })));
        return '';
    }, 1));

    if (shouldAwait) {
        const innerPromise = await outerPromise;
        await innerPromise;
    }

    return '';
}

/**
 * Register fold's slash commands. Called once from init().
 */
export function registerFoldSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'steer',
        callback: steerCallback,
        aliases: ['retry', 'redirect'],
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'await',
                t`Whether to await the steered generation before proceeding`,
                [ARGUMENT_TYPE.BOOLEAN],
                false,
                false,
                'false',
            ),
            new SlashCommandNamedArgument(
                'mes',
                t`Message id to steer. Defaults to the last message.`,
                [ARGUMENT_TYPE.NUMBER],
                false,
                false,
            ),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`steering instruction`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: `
        <div>
            ${t`Generates a new swipe for the latest reply under an explicit instruction, keeping every existing swipe. The instruction is saved alongside the swipe it produced and shown in the swipe picker.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li><pre><code class="language-stscript">/steer make her angrier</code></pre></li>
                <li><pre><code class="language-stscript">/steer shorter, and don't mention the sword</code></pre></li>
            </ul>
        </div>
        <div>
            ${t`Unlike <code>/regenerate</code>, this never discards the current reply.`}
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'fold-move',
        callback: moveCallback,
        returns: 'where the item moved from and to',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`<item> to <place>`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: `
        <div>
            ${t`Moves a tracked item between places — your pockets, the apartment, the car boot.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li><pre><code class="language-stscript">/fold-move canned tuna to apartment</code></pre></li>
                <li><pre><code class="language-stscript">/fold-move crowbar to carried</code></pre></li>
            </ul>
        </div>
        <div>
            ${t`A card's status block reports what you have, not where it is, so it will not undo this — a restated total lands wherever the item already is.`}
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'fold-lock',
        callback: lockCallback,
        returns: 'the fields currently pinned',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`scene field to pin or release; omit to list`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: `
        <div>
            ${t`Pins a scene field so the narrator cannot overwrite it. Run it again to release.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li><pre><code class="language-stscript">/fold-lock location</code></pre></li>
                <li><pre><code class="language-stscript">/fold-lock</code></pre></li>
            </ul>
        </div>
        <div>
            ${t`Clicking the time or location in the tracker panel does the same thing.`}
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'try',
        callback: tryCallback,
        aliases: ['fold-try'],
        returns: 'how the attempt goes, and why',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`what you are attempting`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: `
        <div>
            ${t`Adjudicates an attempt against what the world has already established, then tells the narrator the outcome it must write. The model is never asked whether you succeed — that is decided from tracked state, so it cannot simply agree with you.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li><pre><code class="language-stscript">/try talk Lord Everard into lending me his cavalry</code></pre></li>
                <li><pre><code class="language-stscript">/try climb the outer wall in daylight</code></pre></li>
            </ul>
        </div>
        <div>
            ${t`Succeeding at something hard banks standing that protects you later; a setback spends it and advances whatever pressure you are under.`}
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'fold-clock',
        callback: clockCallback,
        returns: 'the clock as it now stands',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'at',
                description: t`fill level to set, e.g. 3`,
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'size',
                description: t`total segments: 4 imminent, 6 ordinary, 8 slow`,
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'about',
                description: t`what happens when it fills`,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'seen',
                description: t`open if the character can perceive it, hidden if not`,
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: ['open', 'hidden'],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`clock name; omit to list every clock`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: `
        <div>
            ${t`Sets a pressure clock by hand, or lists them all. Fold proposes clocks from the narrative; this is how you correct one or start one yourself.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li><pre><code class="language-stscript">/fold-clock size=6 about="the village is abandoned" the Blight reaches Briarwood</code></pre></li>
                <li><pre><code class="language-stscript">/fold-clock at=3 the Blight reaches Briarwood</code></pre></li>
                <li><pre><code class="language-stscript">/fold-clock seen=hidden the traitor moves</code></pre></li>
                <li><pre><code class="language-stscript">/fold-clock</code></pre></li>
            </ul>
        </div>
        <div>
            ${t`A hidden clock is named in the panel but never quantified, so you can feel it closing without your character knowing how near it is.`}
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'fold-calibrate',
        callback: () => calibrationReport(),
        returns: 'a report of which of fold\'s bounds actually bound in this chat',
        helpString: `
        <div>
            ${t`Reports how often each of fold's limits changed an outcome in this chat, and which have never fired at all.`}
        </div>
        <div>
            ${t`fold carries twenty-two numeric constants and every one of them was chosen rather than measured. A rule that never fires is decoration and should be deleted; a rule that fires constantly is set wrong. This is how you tell which is which.`}
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'fold-replay',
        callback: replayCallback,
        returns: 'the number of extraction passes run',
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'dry',
                t`Count the passes without calling the model`,
                [ARGUMENT_TYPE.BOOLEAN],
                false,
                false,
                'false',
            ),
            new SlashCommandNamedArgument(
                'limit',
                t`Stop after this many passes`,
                [ARGUMENT_TYPE.NUMBER],
                false,
                false,
            ),
            new SlashCommandNamedArgument(
                'step',
                t`Messages advanced per pass (default 2, the observed live cadence)`,
                [ARGUMENT_TYPE.NUMBER],
                false,
                false,
                '2',
            ),
        ],
        helpString: `
        <div>
            ${t`Re-runs extraction over this chat from the beginning, recording a trace for every pass. The chat's own tracked state is snapshotted first and restored afterwards, so nothing you are playing is changed — only the trace is kept.`}
        </div>
        <div>
            ${t`This is how a chat played before the trace existed gets its prompt→answer record: the identity questions the review asks are re-asked against a ledger rebuilt the same way, and this time the prompt that produced each answer is written down.`}
        </div>
        <div>
            <strong>${t`Usage:`}</strong>
            <ul>
                <li><pre><code class="language-stscript">/fold-replay dry=true</code></pre> ${t`how many passes, and therefore how many model calls, without spending any`}</li>
                <li><pre><code class="language-stscript">/fold-replay limit=10</code></pre> ${t`prove the driver on ten passes first`}</li>
                <li><pre><code class="language-stscript">/fold-replay</code></pre> ${t`the whole chat`}</li>
            </ul>
        </div>
        <div>
            ${t`Every pass is one extraction call against your configured profile, so a long chat costs real money. Run it dry first.`}
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'fold-trace',
        callback: traceCallback,
        returns: 'the number of traced passes for this chat',
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'raw',
                t`Print the latest pass's full prompt, raw reply and parsed fragment to the console`,
                [ARGUMENT_TYPE.BOOLEAN],
                false,
                false,
                'false',
            ),
            new SlashCommandNamedArgument(
                'download',
                t`Save the whole per-chat trace file as fold-trace.json`,
                [ARGUMENT_TYPE.BOOLEAN],
                false,
                false,
                'false',
            ),
        ],
        helpString: `
        <div>
            ${t`Shows how many extraction passes are traced for this chat and how many succeeded. Every pass — success and failure — is recorded with its exact prompt, the JSON schema, the raw model reply, and the parsed fragment.`}
        </div>
        <div>
            <strong>${t`Usage:`}</strong>
            <ul>
                <li><pre><code class="language-stscript">/fold-trace</code></pre> ${t`count of traced passes`}</li>
                <li><pre><code class="language-stscript">/fold-trace raw</code></pre> ${t`latest pass's prompt + raw reply + parsed fragment, verbatim, to the console`}</li>
                <li><pre><code class="language-stscript">/fold-trace download</code></pre> ${t`save the chat's whole trace as fold-trace.json`}</li>
            </ul>
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'fold-plot',
        callback: plotCallback,
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`the story direction, as a synopsis or outline. Omit to show the current guide.`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: `
        <div>
            ${t`Sets the overall story direction — a plot synopsis, a scene outline, a direction the narrator must follow. Unlike steer, it is NOT forgotten on the next message: it is injected into every narrator prompt until you change it. It is injected as the hidden hand — the characters never know it, only the narrator — so write events, not "X realizes Y": solution language in the outline gets copied into character dialogue and everyone starts acting as if they read the synopsis.`}
        </div>
        <div>
            <strong>${t`Examples:`}</strong>
            <ul>
                <li><pre><code class="language-stscript">/fold-plot We are replaying Solo Leveling. The party is sealed inside Cartenon Temple; the statue god's three commandments have killed and maimed them. The events of the original story unfold around Solomon — arrive at each beat through what the characters see and decide, never through their knowledge of the plot.</code></pre></li>
            </ul>
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'fold-plot-clear',
        callback: () => plotClearCallback(),
        helpString: `
        <div>
            ${t`Clears the story direction. The narrator stops being steered by it.`}
        </div>
    `,
    }));
}

function plotCallback(_args, text) {
    const guide = String(text ?? '').trim();
    if (!guide) {
        const current = plot.text();
        toastr.info(current ? `Plot guide is set: ${current.slice(0, 100)}…` : 'No plot guide set. Use /fold-plot <text> to set one.');
        return current;
    }
    plot.set({ text: guide, source: 'manual' });
    toastr.success('Plot guide set — it now reaches every narrator prompt.');
    return '';
}

function plotClearCallback() {
    plot.set({ text: '' });
    toastr.success('Plot guide cleared.');
}

/**
 * `/fold-move <item> to <place>` — put something down, or pick it back up.
 * @param {object} _args Named args (unused).
 * @param {string} text The unnamed argument.
 * @returns {string} A short report.
 */
function moveCallback(_args, text) {
    const raw = String(text ?? '').trim();
    const match = raw.match(/^(.*?)\s+(?:to|into|in|at)\s+(.+)$/i);
    if (!match) {
        toastr.warning(t`Say where: /fold-move canned tuna to apartment`);
        return '';
    }
    const outcome = state.moveItem(match[1], match[2]);
    if (!outcome.moved) {
        toastr.warning(outcome.reason === 'not-held'
            ? t`Nothing by that name is being tracked.`
            : outcome.reason === 'already-there'
                ? t`It is already there.`
                : t`Could not move that.`);
        return '';
    }
    toastr.success(`${match[1].trim()} → ${outcome.to}`);
    return `${outcome.from} → ${outcome.to}`;
}

/**
 * `/fold-lock [field]` — pin a scene field, or list what is pinned.
 * @param {object} _args Named args (unused).
 * @param {string} text The field label.
 * @returns {string} The locked fields.
 */
/**
 * Adjudicate an attempt, then send it.
 *
 * The directive is written into the message the player is about to send rather than injected
 * separately, so it travels with the attempt it judges and cannot drift onto a later turn. The
 * narrator receives an outcome it must honour; it was never asked for an opinion about it.
 *
 * @param {object} _named Named arguments (unused).
 * @param {string} attempt What the player is trying.
 * @returns {Promise<string>} A readable account of the verdict.
 */
async function tryCallback(_named, attempt) {
    const said = String(attempt ?? '').trim();
    if (!said) {
        toastr.warning(t`Say what you are attempting.`);
        return '';
    }

    // Read by literal key rather than importing MODULE_NAME from index.js: index.js imports this
    // file, so that import would close a cycle. Same reason the rest of this module does it.
    const settings = extension_settings.fold ?? {};
    const outcome = await verdict.judge(said, {
        window: settings?.chronicle?.window ?? 6,
        profileId: settings?.chronicle?.profile ?? '',
        responseLength: settings?.chronicle?.response_length ?? 2400,
    });

    if (!outcome.ok) {
        // Declining is better than guessing: a verdict built on a failed classification would be
        // arithmetic over defaults, dressed up as a ruling.
        toastr.warning(t`Could not adjudicate that attempt.`);
        return '';
    }
    return `${verdict.explain(outcome.verdict)}\n${outcome.directive}`;
}

/**
 * Set or list pressure clocks.
 *
 * The GM override. Every value fold derives has to be correctable in place: a tracker you cannot
 * correct is one you stop trusting the first time it is wrong, and the reference implementation's
 * worst issues were all of that kind — stats silently not updating, settings deleting themselves.
 *
 * @param {object} named Named arguments.
 * @param {string} name The clock name, or empty to list.
 * @returns {string} A description of what stands now.
 */
function clockCallback(named, name) {
    const turn = entities.turn();
    const title = String(name ?? '').trim();

    if (!title) {
        const all = clocks.snapshot(turn);
        if (!all.length) {
            return t`No clocks yet.`;
        }
        return all.map(clock => {
            const dial = clock.seen === 'hidden' ? t`hidden` : `${clock.filled}/${clock.size}`;
            return `${clock.name} — ${dial}${clock.about ? ` — ${clock.about}` : ''}`;
        }).join('\n');
    }

    const changes = { turn };
    if (named?.at !== undefined) changes.filled = Number(named.at);
    if (named?.size !== undefined) changes.size = Number(named.size);
    if (named?.about !== undefined) changes.about = String(named.about);
    if (named?.seen !== undefined) changes.seen = String(named.seen).toLowerCase();

    if (!clocks.set(title, changes)) {
        return t`That clock could not be set.`;
    }
    const written = clocks.snapshot(turn).find(clock => clock.name.toLowerCase() === title.toLowerCase());
    return written
        ? `${written.name} — ${written.filled}/${written.size}${written.about ? ` — ${written.about}` : ''}`
        : t`Set.`;
}

function lockCallback(_args, text) {
    const label = String(text ?? '').trim().toLowerCase();
    if (label) {
        const now = state.setLock(label);
        toastr.info(now ? `${label} ${'pinned'}` : `${label} ${'released'}`);
    }
    const locked = state.lockedFields();
    return locked.length ? locked.join(', ') : '';
}

/**
 * Render the observation table as text.
 *
 * Deliberately a command rather than a panel section: this is a question you ask on purpose, after
 * a long chat, and putting it on screen permanently would be the "throw everything at the wall"
 * the panel exists to avoid.
 *
 * @returns {string} The report.
 */
function calibrationReport() {
    const fired = observe.report();
    const silent = observe.neverFired();

    const lines = [];

    // Extraction first, because when it is off everything else in the report is misleading: no
    // rejections, no caps, no entities — a system that looks calm because nothing is running.
    const src = chronicle.sources();
    // Read straight off the settings bag rather than through index.js: slash-commands is
    // imported BY index.js, and importing back would close a cycle for one number.
    const interval = Math.max(1, Number(extension_settings.fold?.chronicle?.interval ?? 1));
    lines.push(`Ledger: ${src.total} events — ${src.user} from the card's own status block, ${src.llm} from extraction.`);
    if (src.total > 0 && src.llm === 0) {
        lines.push(`  ⚠ Extraction has never contributed an event. With interval ${interval} it fires`);
        lines.push(`    every ${interval} replies; item places, people and leads all come from it.`);
    }
    lines.push('');
    if (fired.length) {
        const width = Math.max(...fired.map(entry => entry.rule.length));
        lines.push('Bounds that bound, in this chat:');
        const KIND = { cap: 'cap   ', pass: 'pass  ', reject: 'reject' };
        for (const entry of fired) {
            lines.push(`  ${KIND[entry.kind] ?? 'reject'}  ${entry.rule.padEnd(width)}  ${entry.count}`);
        }
    } else {
        lines.push('No bound has changed an outcome in this chat yet.');
    }

    if (silent.length) {
        lines.push('', `Never fired (${silent.length}): ${silent.join(', ')}`);
        lines.push('A limit that has never bound in a long chat is a number nobody needed.');
    }

    const text = lines.join('\n');
    toastr.info(t`Calibration report written to the console.`);
    console.log(`[fold] calibration\n${text}`);
    return text;
}

/**
 * `/fold-trace` — dump the current chat's prompt->output trace.
 *
 * The trace is the full record of every extraction pass: the exact prompt sent, the schema, the
 * raw model reply, and the parsed fragment. `raw` prints the latest pass verbatim to the console
 * (a question you ask on purpose, the same discipline as the calibration report); `download`
 * saves the whole per-chat trace file so it can be harvested for the resolver's training data.
 *
 * @param {object} _args Named args.
 * @param {boolean} _args.raw Show the latest pass's full prompt+raw reply verbatim.
 * @param {boolean} _args.download Save the whole trace file for this chat.
 * @returns {string} A short report.
 */
/**
 * How many message indices one replay step advances by.
 *
 * Not a guess: the Wuxia chat's trace holds 140 passes over 277 messages, so the live trigger
 * cadence averaged just under two messages per pass. Stepping by one would produce roughly twice
 * the passes the chat really ran — a different corpus, and twice the cost, for no extra fidelity.
 */
const REPLAY_STEP = 2;

/**
 * Re-run extraction over this chat from turn zero, recording a trace for every pass.
 *
 * ── Why this exists ──
 *
 * The trace (`trace.js`) records the exact prompt and reply of every extraction pass, and it landed
 * after most of these chats were played. So the identity verdicts those chats persisted have labels
 * and no context: `state.answers` keeps `{answer, at}` and nothing about the ledger the model was
 * looking at when it answered. A resolver trained on the label alone cannot work — the two names do
 * not contain their own answer, and no metric over them repairs that
 * (`AdaptRetrievalLever.the_metric_is_not_the_lever`, sanguine). The only lever is more information
 * in the features, and the only place that information exists is the prompt.
 *
 * Replaying regenerates it: the pass reads the same window the live pass read, against a ledger
 * rebuilt the same way, and writes a trace.
 *
 * ── Why it is safe to run on a chat you are playing ──
 *
 * Two hazards, both closed rather than warned about. The pass can only read the chat's TAIL
 * (`extract-table.js` `splitWindow` slices `-size`), so re-running history needs the visible chat
 * restricted — and the obvious way, splicing the live `chat` array, is unsafe because SillyTavern
 * persists that array to the chat file on its own events, so a driver that truncated it could
 * truncate the transcript on disk. `runExtraction({ source })` takes an explicit slice instead and
 * the live array is never touched. Second, the replay rebuilds `chat_metadata.fold` from nothing,
 * which would otherwise destroy the ledger of a live chat; `snapshotFold`/`restoreFold` bracket the
 * whole run in a `finally`, so an abort, a thrown pass or a closed tab restores what was there.
 *
 * The trace is written server-side per chat and is NOT part of the snapshot, so it survives the
 * restore. That asymmetry is the point: the state goes back, the evidence stays.
 *
 * @param {object} args Named arguments.
 * @param {string} [args.limit] Cap the number of passes. Default: no cap.
 * @param {string} [args.step] Message indices per pass. Default `REPLAY_STEP`.
 * @param {string} [args.dry] Count the passes and the cost without calling the model.
 * @returns {Promise<string>} The number of passes run (or planned, under `dry`).
 */
async function replayCallback(args) {
    const step = Math.max(1, Number(args?.step) || REPLAY_STEP);
    const cap = Number(args?.limit) > 0 ? Number(args.limit) : Infinity;
    const dry = isTrueBoolean(args?.dry);

    const live = (chat ?? []).filter(m => m?.mes && !m.is_system).length;
    if (!live) {
        toastr.warning(t`/fold-replay needs a chat with messages in it.`);
        return '0';
    }
    // The stops are the message counts a pass would have seen: every `step`th message, and always
    // the last one, so the tail is never dropped by an uneven division.
    const stops = [];
    for (let n = step; n < chat.length; n += step) {
        stops.push(n);
    }
    stops.push(chat.length);
    const planned = Math.min(stops.length, cap);

    if (dry) {
        toastr.info(t`/fold-replay would run ${planned} passes over ${live} messages (step ${step}). Each is one extraction call.`);
        return `${planned}`;
    }

    const snapshot = store.snapshotFold();
    let ran = 0;
    let ok = 0;
    try {
        store.clearFold();
        for (const stop of stops.slice(0, cap)) {
            // `source` is the chat as it stood at that point. `runExtraction` declines with
            // `nothing-new` when the mark already covers the slice, which costs no model call — so
            // a step that lands inside an already-read window is cheap rather than wasteful.
            const result = await extract.runExtraction({ source: chat.slice(0, stop), why: 'replay' });
            ran += 1;
            if (result?.ok) {
                ok += 1;
            }
            if (ran % 10 === 0) {
                console.debug(`[fold] replay ${ran}/${planned} passes (${ok} ok)`);
            }
        }
    } finally {
        // Unconditional: an aborted or thrown replay must not leave a rebuilt ledger in place of
        // the one the chat was playing with.
        store.restoreFold(snapshot);
    }
    toastr.success(t`Replay complete: ${ran} passes, ${ok} produced a fragment. The trace kept every one; this chat's own state is unchanged.`);
    return `${ran}`;
}

async function traceCallback(_args, _text) {
    const records = await trace.load();
    if (!records.length) {
        toastr.info(t`No fold extraction passes are traced for this chat yet. They are recorded on every pass going forward.`);
        return 'no-trace';
    }
    const ok = records.filter(r => r.ok).length;
    const failed = records.length - ok;
    const newest = records[records.length - 1];
    if (_args?.download) {
        const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'fold-trace.json';
        a.click();
        URL.revokeObjectURL(url);
        toastr.success(t`Fold trace for this chat saved (${records.length} passes, ${ok} ok / ${failed} failed).`);
        return `${records.length}`;
    }
    if (_args?.raw) {
        console.log(`[fold] trace — latest pass @ ${new Date(newest.t ?? Date.now()).toISOString()}`);
        console.log(`[fold] turn ${newest.turn ?? '?'} mid ${newest.mid ?? '?'} ${newest.ok ? 'ok' : `failed: ${newest.reason ?? ''}`}`);
        console.log(`[fold] PROMPT\n${newest.prompt ?? ''}`);
        console.log(`[fold] RAW REPLY\n${newest.raw ?? ''}`);
        console.log(`[fold] PARSED\n${JSON.stringify(newest.parsed ?? null, null, 2)}`);
        return `${newest.ok ? 'ok' : 'failed'}`;
    }
    toastr.info(t`Fold trace: ${records.length} passes for this chat (${ok} ok / ${failed} failed). Use /fold-trace raw for the latest pass verbatim, /fold-trace download to save the file.`);
    return `${records.length}`;
}
