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
