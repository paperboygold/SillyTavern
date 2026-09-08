/**
 * fold/slash-commands.js: /steer and its aliases.
 *
 * Deliberately does NOT extend /regenerate: that routes to Generate('regenerate'), which deletes
 * the entire last chat entry (and therefore every swipe on it) before generating. Attaching an
 * instruction there would mean "type a direction, lose your variant history", the exact opposite
 * of what steering is for.
 */

import { chat, eventSource, is_send_press } from '../../../script.js';
import { extension_settings } from '../../extensions.js';
import { is_group_generating } from '../../group-chats.js';
import { t } from '../../i18n.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { isTrueBoolean, waitUntilCondition } from '../../utils.js';
import * as chronicle from './chronicle.js';
import * as clocks from './clocks.js';
import * as flows from './flows.js';
import { flowFace, flowRuler, BY_CLOCK } from './flow-table.js';
import { WASTE, ackSpans, countsOf, newRejects, perTurn } from './reject-table.js';
import * as plot from './plot.js';
import * as lore from './lore.js';
import * as verdict from './verdict.js';
import * as entities from './entities.js';
import * as observe from './observe.js';
import * as audit from './audit.js';
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
            ${t`Moves a tracked item between places, your pockets, the apartment, the car boot.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li><pre><code class="language-stscript">/fold-move canned tuna to apartment</code></pre></li>
                <li><pre><code class="language-stscript">/fold-move crowbar to carried</code></pre></li>
            </ul>
        </div>
        <div>
            ${t`A card's status block reports what you have, not where it is, so it will not undo this, a restated total lands wherever the item already is.`}
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'fold-lore',
        callback: loreCallback,
        returns: 'the lorebook the entry was written to',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`the name of someone fold is tracking`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: `
        <div>
            ${t`Writes a tracked character into the chat's lorebook, so the narrator keeps them straight after they leave the scene.`}
        </div>
        <div>
            ${t`The entry is keyed on every name the story has called them, and its body is what fold already holds, appearance and standing facts, what they want, what they know about you, how to reach them. Run it again to update.`}
        </div>
        <div>
            ${t`The person and the entry stay linked by the entry's id, so renaming either one keeps them together. An entry you wrote yourself is never overwritten, link it from the Entities tab instead, and its text becomes the record.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li><pre><code class="language-stscript">/fold-lore Takeda</code></pre></li>
                <li><pre><code class="language-stscript">/fold-lore the shaved-head boy</code></pre> ${t`any name they answer to works`}</li>
            </ul>
        </div>
        <div>
            ${t`fold's cast table holds who is HERE and ages people out as they leave; a lorebook entry holds who EXISTS and costs nothing until somebody says their name.`}
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
            ${t`Adjudicates an attempt against what the world has already established, then tells the narrator the outcome it must write. The model is never asked whether you succeed, that is decided from tracked state, so it cannot simply agree with you.`}
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
        name: 'fold-flow',
        callback: flowCallback,
        returns: 'the rate as it now stands',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'dq',
                description: t`how much it changes by in one period; negative to drain`,
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'per',
                description: t`how long one period is on the story clock: "6 hours", "1 week"`,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'every',
                description: t`or how many exchanges one period is. Use this OR per, never both`,
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'item',
                description: t`what it moves, the name as the ledger holds it`,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'at',
                description: t`money for a balance, carried for a pack, or a place`,
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: ['money', 'carried', 'assets'],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'on',
                description: t`false to suspend it without forgetting the number`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: ['true', 'false'],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`what to call it; omit to list every rate`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: `
        <div>
            ${t`Sets something that changes on its own as time passes, rent, wages, rations, a shop's takings, a cultivator's daily gain. Fold applies it with no model call at all, so your money moves even when the story never mentions it.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li><pre><code class="language-stscript">/fold-flow dq=1000 per="1 week" item=gold at=money the tea house</code></pre></li>
                <li><pre><code class="language-stscript">/fold-flow dq=-400 per="1 week" item=gold at=money rent</code></pre></li>
                <li><pre><code class="language-stscript">/fold-flow dq=-2 every=8 item=rations at=carried eating</code></pre></li>
                <li><pre><code class="language-stscript">/fold-flow on=false the tea house</code></pre></li>
                <li><pre><code class="language-stscript">/fold-flow</code></pre></li>
            </ul>
        </div>
        <div>
            ${t`A rate is denominated EITHER in story time (per) or in exchanges (every), never both. Which one fits depends on the campaign: four days of a zombie outbreak across three hundred messages wants hours, and a cultivation montage that skips thirty years wants exchanges.`}
        </div>
        <div>
            ${t`Suspending keeps the number and freezes what it has earned; resuming picks up where it left off rather than billing for the gap. Deleting a rate undoes everything it ever contributed, because nothing was ever written down, the effect is recomputed from the clock each time.`}
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
            SlashCommandNamedArgument.fromProps({
                name: 'per',
                description: t`a span it advances on by itself: "6 hours", "1 week", "1 month"`,
                typeList: [ARGUMENT_TYPE.STRING],
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
                <li><pre><code class="language-stscript">/fold-clock per="6 hours" size=8 about="the district is overrun" the infection spreads</code></pre></li>
                <li><pre><code class="language-stscript">/fold-clock</code></pre></li>
            </ul>
        </div>
        <div>
            ${t`A hidden clock is named in the panel but never quantified, so you can feel it closing without your character knowing how near it is.`}
        </div>
    `,
    }));


    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sanguine-audit',
        callback: auditCallback,
        returns: 'the number of disagreements reported',
        namedArgumentList: [
            new SlashCommandNamedArgument('dry', 'price the run without spending it', [ARGUMENT_TYPE.BOOLEAN], false),
        ],
        helpString: `
        <div>
            ${t`Reads the whole chat through in order, as you read it, then puts that beside the tracked record and reports where they disagree.`}
        </div>
        <div>
            ${t`It changes nothing. Every finding cites the message it came from, so you can go and check it, and you act on it with the panel's own controls. This is the one pass allowed to talk about quantities, and it is safe only because nothing it says is applied.`}
        </div>
        <div>
            ${t`Costs one model call per sixteen messages plus one. Use dry=true to see the number first.`}
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sanguine-reconcile',
        callback: reconcileCallback,
        returns: 'the deep-audit outcome: resolved, posed, refused, and what needs the player',
        helpString: `
        <div>
            ${t`Runs the same reconcile the background agent runs on its own: exact detectors shortlist the record, identity and conservation resolve in one model call against the full history, and staleness and capacity become questions in the Audit tab. Same pass as the panel's reconcile button.`}
        </div>
        <div>
            ${t`The detectors are exact arithmetic, never "is anything wrong?" (which measured 0.14% closure). Conserving fixes apply on sight into a visible ledger; the questions keep until answered or superseded, and nothing is ever forced on the fiction.`}
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sanguine-backfill',
        callback: backfillCallback,
        returns: 'the number of chunks read, or the number a run would cost',
        namedArgumentList: [
            new SlashCommandNamedArgument('run', t`Actually spend the calls. Without it this only prices the run.`, [ARGUMENT_TYPE.BOOLEAN], false, false, 'false'),
            new SlashCommandNamedArgument('to', t`The oldest message the record already covers. Everything BELOW it is read.`, [ARGUMENT_TYPE.NUMBER], false),
            new SlashCommandNamedArgument('chunk', t`Messages read per call (default 12)`, [ARGUMENT_TYPE.NUMBER], false),
            new SlashCommandNamedArgument('limit', t`Stop after this many calls; the rest resumes next time`, [ARGUMENT_TYPE.NUMBER], false),
            new SlashCommandNamedArgument('stop', t`Ask a run in progress to stop after the chunk it is on`, [ARGUMENT_TYPE.BOOLEAN], false, false, 'false'),
            new SlashCommandNamedArgument('reset', t`Forget what has been backfilled, so the span can be read again`, [ARGUMENT_TYPE.BOOLEAN], false, false, 'false'),
        ],
        helpString: `
        <div>
            ${t`Reads a stretch of the story that extraction never saw, the messages before fold was switched on, and records what happened in them. Switching fold on at message 200 leaves the first 176 messages invisible to the record: the premise, the starting kit, and everyone established in them. This is how they get read.`}
        </div>
        <div>
            ${t`It records EVENTS only. It never adds or removes an item, never moves the character, never opens or closes a thread: the current record already accounts for everything those messages led to, and crediting the origin again would count it twice. What you get back is memory, the opening becomes findable again.`}
        </div>
        <div>
            <strong>${t`Usage:`}</strong>
            <ul>
                <li><pre><code class="language-stscript">/sanguine-backfill</code></pre> ${t`what it would read and what it would cost. Spends nothing.`}</li>
                <li><pre><code class="language-stscript">/sanguine-backfill to=121</code></pre> ${t`price it against a ceiling you name, everything below message 121`}</li>
                <li><pre><code class="language-stscript">/sanguine-backfill run=true limit=2</code></pre> ${t`prove it on two calls first; the rest resumes next time`}</li>
                <li><pre><code class="language-stscript">/sanguine-backfill run=true</code></pre> ${t`the whole span`}</li>
            </ul>
        </div>
        <div>
            ${t`Every chunk is one model call against your configured profile, so this costs real money. It is resumable, the frontier is saved after every chunk, and stoppable with stop=true.`}
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
        name: 'fold-audit',
        callback: async () => {
            const outcome = await audit.run({ now: entities.turn() });
            if (!outcome.posed) {
                return 'nothing to audit, the record is quiet';
            }
            const applied = outcome.applied ? `${outcome.applied} resolved automatically` : 'nothing auto-resolved';
            const player = outcome.player ? `; ${outcome.player} question${outcome.player === 1 ? '' : 's'} need your answer, open the Audit tab (magnifying-glass icon)` : '';
            return `${applied} of ${outcome.posed} posed (${outcome.rejected} refused)${player}`;
        },
        returns: 'the deep audit outcome: model-answerable questions resolved, player questions in the Audit tab',
        helpString: `
        <div>
            ${t`Runs the deep audit. Identity and conservation questions are answered automatically in one model call; staleness and capacity are PLAYER questions, only you know whether you are still carrying something, and they land in the Audit tab to answer by hand. Findings never enter the fiction.`}
        </div>
        <div>
            ${t`The detectors are exact arithmetic, never "is anything wrong?" (which measured 0.14% closure). A carried row silent for 12 turns is a question in the Audit tab, not a hidden item.`}
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
                'label',
                t`Name this arm in the trace, so two runs of the SAME prompt can be compared`,
                [ARGUMENT_TYPE.STRING],
                false,
                false,
            ),
            new SlashCommandNamedArgument(
                'staticfirst',
                t`Put the instructions ahead of the transcript, so a prefix cache can reach them`,
                [ARGUMENT_TYPE.BOOLEAN],
                false,
                false,
                'false',
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
            ${t`Re-runs extraction over this chat from the beginning, recording a trace for every pass. The chat's own tracked state is snapshotted first and restored afterwards, so nothing you are playing is changed, only the trace is kept.`}
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
        name: 'sanguine-trace',
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
                t`Save the whole per-chat trace file as sanguine-trace.json`,
                [ARGUMENT_TYPE.BOOLEAN],
                false,
                false,
                'false',
            ),
        ],
        helpString: `
        <div>
            ${t`Shows how many extraction passes are traced for this chat and how many succeeded. Every pass, success and failure, is recorded with its exact prompt, the JSON schema, the raw model reply, and the parsed fragment.`}
        </div>
        <div>
            <strong>${t`Usage:`}</strong>
            <ul>
                <li><pre><code class="language-stscript">/sanguine-trace</code></pre> ${t`count of traced passes`}</li>
                <li><pre><code class="language-stscript">/sanguine-trace raw</code></pre> ${t`latest pass's prompt + raw reply + parsed fragment, verbatim, to the console`}</li>
                <li><pre><code class="language-stscript">/sanguine-trace download</code></pre> ${t`save the chat's whole trace as sanguine-trace.json`}</li>
            </ul>
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sanguine-ack',
        callback: ackCallback,
        returns: 'the number of refusals that were outstanding',
        namedArgumentList: [
            new SlashCommandNamedArgument('rates', t`Print the refusals-per-turn table between marks to the console instead of marking`, [ARGUMENT_TYPE.BOOLEAN], false, false, 'false'),
        ],
        helpString: `
        <div>
            ${t`Marks the refusals fold has counted as seen, so the panel's "N rejected" chip clears and starts again from the next one. It DELETES NOTHING: the counts stay exactly as they are and the Diagnostics tab still shows all of them. All this writes down is where you had got to.`}
        </div>
        <div>
            ${t`Each mark is also a measuring point. Refusals between two marks, divided by the turns between them, is the number that says whether a change helped, and it is the only comparable form, because a raw count over sixty turns and one over twelve are not the same measurement. Five marks are kept.`}
        </div>
        <div>
            <strong>${t`Usage:`}</strong>
            <ul>
                <li><pre><code class="language-stscript">/sanguine-ack</code></pre> ${t`mark what is on the counters now as seen`}</li>
                <li><pre><code class="language-stscript">/sanguine-ack rates=true</code></pre> ${t`print the per-turn rate between every mark, and mark nothing`}</li>
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
            ${t`Sets the overall story direction, a plot synopsis, a scene outline, a direction the narrator must follow. Unlike steer, it is NOT forgotten on the next message: it is injected into every narrator prompt until you change it. It is injected as the hidden hand, the characters never know it, only the narrator, so write events, not "X realizes Y": solution language in the outline gets copied into character dialogue and everyone starts acting as if they read the synopsis.`}
        </div>
        <div>
            <strong>${t`Examples:`}</strong>
            <ul>
                <li><pre><code class="language-stscript">/fold-plot We are replaying Solo Leveling. The party is sealed inside Cartenon Temple; the statue god's three commandments have killed and maimed them. The events of the original story unfold around Solomon, arrive at each beat through what the characters see and decide, never through their knowledge of the plot.</code></pre></li>
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

/**
 * Promote a cast member into a World Info entry.
 *
 * Why a lorebook entry and not another fold field.
 *
 * fold's cast table answers "who is in this scene, and what do they want from you right now". It is
 * deliberately bounded and it ages: people who leave are demoted to the cold store so the injected
 * block stays a glance rather than a directory. That is the right behaviour for a scene tracker and
 * the wrong behaviour for a character who walks out and comes back two hundred messages later, by
 * then the narrator has nothing, and re-invents them.
 *
 * A World Info entry is exactly the missing half: keyed on their names, it costs nothing until
 * somebody says one, and it outlives the chat. So the two surfaces split by lifetime, fold holds
 * who is HERE, the lorebook holds who EXISTS.
 *
 * Written on request rather than automatically. These are the player's own world files, and an
 * extension that silently edits them is an extension nobody can trust with them.
 *
 * What changed when the link became real.
 *
 * This used to re-find its own entry by matching `comment === "fold: <name>"`. Two failures came out
 * of that: renaming the person orphaned the entry and the next run opened a duplicate, and there was
 * no way at all to tell an entry sanguine wrote from one the player did. `lore.writeOut` stores the
 * entry's uid instead and refuses any entry that is not stamped as sanguine's, so this command can
 * no longer damage a hand-written card, and a rename on either side is now a non-event.
 *
 * @param {object} _args Named arguments.
 * @param {string} value The character's name.
 * @returns {Promise<string>} What happened.
 */
async function loreCallback(_args, value) {
    const said = String(value ?? '').trim();
    if (!said) {
        toastr.warning(t`/fold-lore needs a name, /fold-lore Takeda`);
        return '';
    }

    const found = lore.findPerson(said);
    if (!found) {
        toastr.warning(t`fold has no cast row for "${said}".`);
        return '';
    }
    const row = found.entity ?? {};

    const done = await lore.writeOut(found.key, row);
    if (done.ok) {
        toastr.success(done.created
            ? t`Added "${row.name}" to ${done.book}.`
            : t`Updated "${row.name}" in ${done.book}.`);
        return done.book;
    }
    if (done.reason === 'read-only') {
        // The safety property, said out loud rather than by silence. The entry is the player's own
        // writing; the link stays, so the Entities tab keeps showing that text as this person's
        // canon, it is simply never written over.
        toastr.info(t`"${row.name}" is linked to an entry you wrote in ${done.book}. Sanguine reads it and never overwrites it.`);
        return done.book;
    }
    toastr.error(t`Could not write "${row.name}" to a lorebook.`);
    return '';
}

function plotCallback(_args, text) {
    const guide = String(text ?? '').trim();
    if (!guide) {
        const current = plot.text();
        toastr.info(current ? `Plot guide is set: ${current.slice(0, 100)}…` : 'No plot guide set. Use /fold-plot <text> to set one.');
        return current;
    }
    plot.set({ text: guide, source: 'manual' });
    toastr.success('Plot guide set, it now reaches every narrator prompt.');
    return '';
}

function plotClearCallback() {
    plot.set({ text: '' });
    toastr.success('Plot guide cleared.');
}

/**
 * `/fold-move <item> to <place>`: put something down, or pick it back up.
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
 * `/fold-lock [field]`: pin a scene field, or list what is pinned.
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
 * worst issues were all of that kind, stats silently not updating, settings deleting themselves.
 *
 * @param {object} named Named arguments.
 * @param {string} name The clock name, or empty to list.
 * @returns {string} A description of what stands now.
 */
/**
 * `/fold-flow`: set, list or suspend something that changes on its own.
 *
 * The player's own path to a rate, and for now the only one: a rate is a level multiplied by time,
 * so a wrong one costs more the longer it runs, and the model does not get to author one until the
 * reconcile pass can put it behind a diff the player ticks.
 *
 * @param {object} named Named arguments.
 * @param {string} name What to call it, or empty to list.
 * @returns {string} What stands now.
 */
function flowCallback(named, name) {
    const clock = state.loadClock();
    const label = String(name ?? '').trim();

    if (!label) {
        const all = flows.list(clock);
        if (!all.length) {
            return t`Nothing is running on its own yet.`;
        }
        return all.map(flow => {
            const face = flowFace(flow);
            const unit = flow.coord === BY_CLOCK ? t`min` : t`exchanges`;
            const next = Number.isFinite(flow.nextIn) ? `, next in ${Math.round(flow.nextIn)} ${unit}` : '';
            return `${flow.label}, ${flow.display || flow.item} ${face}${flow.on ? '' : t` (paused)`}${next}`;
        }).join('\n');
    }

    // Suspend/resume is addressed by the same name the rate was created under, so `on=false` alone
    // is a complete command and nothing has to be retyped to switch a shop off for the winter.
    if (named?.on !== undefined && named?.dq === undefined) {
        const key = String(label).toLowerCase().trim();
        if (!flows.suspend(key, isTrueBoolean(String(named.on)), clock)) {
            return t`That rate is already in that state, or there is no such rate.`;
        }
        return isTrueBoolean(String(named.on)) ? t`Resumed.` : t`Paused, it keeps what it has earned.`;
    }

    const changes = { label };
    if (named?.dq !== undefined) changes.dq = Number(named.dq);
    if (named?.per !== undefined) changes.per = String(named.per);
    if (named?.every !== undefined) changes.every = Number(named.every);
    if (named?.item !== undefined) changes.item = String(named.item);
    if (named?.at !== undefined) changes.at = String(named.at);
    if (named?.on !== undefined) changes.on = isTrueBoolean(String(named.on));

    if (!flows.set(label, changes, clock)) {
        return t`That rate could not be set. It needs an item, an amount, and exactly one of per= or every=.`;
    }
    const written = flows.list(clock).find(flow => flow.key === String(label).toLowerCase().trim());
    if (!written) {
        return t`Set.`;
    }
    const ruler = flowRuler(written);
    const unit = ruler?.coord === BY_CLOCK ? t`of story time` : t`exchanges`;
    return `${written.label}, ${written.display || written.item} ${flowFace(written)} (${ruler?.size ?? 0} ${unit} per period)`;
}

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
            return `${clock.name}, ${dial}${clock.about ? `, ${clock.about}` : ''}`;
        }).join('\n');
    }

    const changes = { turn };
    if (named?.at !== undefined) changes.filled = Number(named.at);
    if (named?.size !== undefined) changes.size = Number(named.size);
    if (named?.about !== undefined) changes.about = String(named.about);
    if (named?.seen !== undefined) changes.seen = String(named.seen).toLowerCase();
    // The cadence. A front carrying one advances on the calendar with no model call at all, which
    // is the only thing in fold that moves the world while nobody is looking.
    if (named?.per !== undefined) changes.per = String(named.per);

    if (!clocks.set(title, changes)) {
        return t`That clock could not be set.`;
    }
    const written = clocks.snapshot(turn).find(clock => clock.name.toLowerCase() === title.toLowerCase());
    return written
        ? `${written.name}, ${written.filled}/${written.size}${written.about ? `, ${written.about}` : ''}`
        : t`Set.`;
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
    // rejections, no caps, no entities, a system that looks calm because nothing is running.
    const src = chronicle.sources();
    // Read straight off the settings bag rather than through index.js: slash-commands is
    // imported BY index.js, and importing back would close a cycle for one number.
    const interval = Math.max(1, Number(extension_settings.fold?.chronicle?.interval ?? 1));
    lines.push(`Ledger: ${src.total} events, ${src.user} from the card's own status block, ${src.llm} from extraction.`);
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
    console.log(`[sanguine] calibration\n${text}`);
    return text;
}

/**
 * `/sanguine-trace`: dump the current chat's prompt->output trace.
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
 * the passes the chat really ran, a different corpus, and twice the cost, for no extra fidelity.
 */
const REPLAY_STEP = 2;

/**
 * Re-run extraction over this chat from turn zero, recording a trace for every pass.
 *
 * Why this exists.
 *
 * The trace (`trace.js`) records the exact prompt and reply of every extraction pass, and it landed
 * after most of these chats were played. So the identity verdicts those chats persisted have labels
 * and no context: `state.answers` keeps `{answer, at}` and nothing about the ledger the model was
 * looking at when it answered. A resolver trained on the label alone cannot work, the two names do
 * not contain their own answer, and no metric over them repairs that
 * (`AdaptRetrievalLever.the_metric_is_not_the_lever`, sanguine). The only lever is more information
 * in the features, and the only place that information exists is the prompt.
 *
 * Replaying regenerates it: the pass reads the same window the live pass read, against a ledger
 * rebuilt the same way, and writes a trace.
 *
 * Why it is safe to run on a chat you are playing.
 *
 * Two hazards, both closed rather than warned about. The pass can only read the chat's TAIL
 * (`extract-table.js` `splitWindow` slices `-size`), so re-running history needs the visible chat
 * restricted: and the obvious way, splicing the live `chat` array, is unsafe because SillyTavern
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
/**
 * Check the record against a long stretch of story and propose retractions.
 *
 * Guarded against running while a generation is in flight for `/fold-replay`'s reason: the pass
 * spends a model call, and two in the air at once is how a provider connection wedges.
 *
 * @param {object} args Named arguments.
 * @param {string} [args.size] How many messages to read. Default `RECONCILE_WINDOW`.
 * @returns {Promise<string>} The number of rows retracted.
 */
/**
 * Read the chat through and report where the record disagrees with it.
 *
 * @param {object} args Named arguments.
 * @returns {Promise<string>} The number of findings.
 */
async function auditCallback(args) {
    if (is_send_press || is_group_generating) {
        toastr.warning(t`Wait for the current generation to finish.`);
        return '0';
    }
    const cost = audit.estimate();
    if (isTrueBoolean(args?.dry)) {
        toastr.info(t`The audit would read ${cost.messages} messages in ${cost.chunks} chunks: ${cost.calls} model calls.`);
        return String(cost.calls);
    }
    toastr.info(t`Reading ${cost.messages} messages in ${cost.chunks} chunks (${cost.calls} calls)...`);
    try {
        const found = await audit.run();
        return String(found);
    } catch (error) {
        console.error('[sanguine] audit failed', error);
        toastr.error(t`Audit failed, see the console.`);
        return '0';
    }
}

async function reconcileCallback(args) {
    if (is_send_press || is_group_generating) {
        toastr.warning(t`Wait for the current generation to finish.`);
        return '0';
    }
    try {
        // The one reconcile: the same deep audit the background agent runs on its own and the
        // panel's reconcile button triggers on demand. Reports what it posed and resolved, and
        // what needs the player's call.
        const done = await audit.run({ now: entities.turn() });
        return done.posed
            ? `${done.applied} resolved of ${done.posed} posed (${done.rejected} refused)${done.player ? `; ${done.player} question${done.player === 1 ? '' : 's'} in the Audit tab` : ''}`
            : 'nothing to reconcile, the record is quiet';
    } catch (error) {
        console.error('[sanguine] reconcile failed', error);
        toastr.error(t`Reconcile failed, see the console.`);
        return '0';
    }
}

/**
 * Read a span extraction never reached, or price the reading.
 *
 * The default is the estimate, and that is the whole safety argument.
 *
 * A backfill over the 97-message span in the brief is nine model calls on the owner's own API
 * credit, against a chat he is playing. `/fold-replay` and `/sanguine-audit` both take `dry=true` to
 * ask first, which puts the cheap answer behind an opt-in and the expensive one on the bare command.
 * This inverts it: the bare command spends nothing and reports what a run would cost, and only
 * `run=true` spends. The cost is stated in calls and messages before a single one is made, and the
 * frontier is saved after every chunk, so a run stopped anywhere resumes where it stopped.
 *
 * @param {object} args Named arguments.
 * @returns {Promise<string>} Chunks read, or chunks a run would cost.
 */
async function backfillCallback(args) {
    if (isTrueBoolean(args?.stop)) {
        extract.stopBackfill();
        toastr.info(t`The backfill will stop after the chunk it is on. Whatever it has read is kept.`);
        return '0';
    }
    if (isTrueBoolean(args?.reset)) {
        extract.resetBackfill();
        toastr.info(t`Backfill frontier cleared. The span will be read from its start again.`);
        return '0';
    }

    const to = Number(args?.to);
    const chunk = Number(args?.chunk) > 0 ? Number(args.chunk) : undefined;
    const limit = Number(args?.limit) > 0 ? Number(args.limit) : undefined;
    const plan = extract.backfillPlan({ ...(Number.isFinite(to) ? { to } : {}), ...(chunk ? { chunk } : {}) });

    if (plan.reason === 'no-ceiling') {
        // Naming the hint rather than acting on it. See `backfillPlan`: a ceiling taken from
        // `cap:opening-unread` would have sent a backfill over 145 already-read messages in the one
        // live chat that carries the counter, so the owner supplies the number or nothing happens.
        const hint = Number.isFinite(plan.hint)
            ? t`The oldest message the record is anchored on is ${plan.hint}. If fold was switched on partway through this chat, that is roughly where the gap ends, check it, then pass to=<message>.`
            : t`This chat's record is anchored on nothing, so there is no way to tell where the gap ends. Pass to=<message>.`;
        toastr.info(`${t`Nothing has recorded a gap in this chat.`} ${hint}`);
        return '0';
    }
    if (plan.reason) {
        toastr.info(plan.reason === 'nothing-to-backfill'
            ? t`Nothing to backfill: every message below ${plan.to} has already been read.`
            : t`Nothing to backfill (${plan.reason}).`);
        return '0';
    }

    if (!isTrueBoolean(args?.run)) {
        const where = plan.source === 'stated' ? t`ceiling as stated` : t`ceiling as recorded when the gap was measured`;
        toastr.info(t`/sanguine-backfill would read messages ${plan.from}-${plan.to - 1} (${plan.messages} messages) in ${plan.calls} model calls, ${where}. Run it with run=true.`);
        return String(plan.calls);
    }

    if (is_send_press || is_group_generating) {
        toastr.warning(t`Wait for the current generation to finish.`);
        return '0';
    }

    // Read by literal key for the reason `tryCallback` documents: index.js imports this file.
    const settings = extension_settings.fold ?? {};
    toastr.info(t`Reading ${plan.messages} messages in ${plan.calls} calls. Stop it with /sanguine-backfill stop=true.`);
    try {
        const done = await extract.runBackfill({
            ...(Number.isFinite(to) ? { to } : {}),
            ...(chunk ? { chunk } : {}),
            ...(limit ? { limit } : {}),
            profileId: settings?.chronicle?.profile ?? '',
            responseLength: settings?.chronicle?.response_length ?? 800,
            reasoning: settings?.chronicle?.reasoning ?? false,
            onProgress: (at, total) => console.debug(`[sanguine] backfill ${at}/${total}`),
        });
        const left = done.aborted
            ? t` Stopped early (${done.aborted}); ${done.remaining} calls remain, run it again to continue.`
            : done.remaining
                ? t` ${done.remaining} calls remain, run it again to continue.`
                : '';
        toastr.success(`${t`Backfill: ${done.ran} calls, ${done.ok} produced a fragment, ${done.added} events recovered.`}${left}`);
        return String(done.ran);
    } catch (error) {
        console.error('[sanguine] backfill failed', error);
        toastr.error(t`Backfill failed, see the console. Whatever it read is kept; run it again to continue.`);
        return '0';
    }
}

async function replayCallback(args) {
    const step = Math.max(1, Number(args?.step) || REPLAY_STEP);
    const cap = Number(args?.limit) > 0 ? Number(args.limit) : Infinity;
    const dry = isTrueBoolean(args?.dry);
    // The live default is now static-first; `staticfirst=false` replays the ORIGINAL ordering, which
    // is what an A/B against the pre-change traces needs.
    const staticFirst = args?.staticfirst === undefined ? true : isTrueBoolean(args.staticfirst);

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
            // `nothing-new` when the mark already covers the slice, which costs no model call, so
            // a step that lands inside an already-read window is cheap rather than wasteful.
            const result = await extract.runExtraction({
                source: chat.slice(0, stop),
                why: String(args?.label ?? '').trim() || (staticFirst ? 'replay-staticfirst' : 'replay-original'),
                staticFirst,
            });
            ran += 1;
            if (result?.ok) {
                ok += 1;
            }
            if (ran % 10 === 0) {
                console.debug(`[sanguine] replay ${ran}/${planned} passes (${ok} ok)`);
            }
        }
    } finally {
        // Unconditional AND awaited. `restoreFold` performs an undebounced write and returns a
        // promise; dropping it is the bug that cost two live chats their identity verdicts, because
        // the caller changed chat before a debounced save could fire. See `store.restoreFold`.
        await store.restoreFold(snapshot);
    }
    toastr.success(t`Replay complete: ${ran} passes, ${ok} produced a fragment. The trace kept every one; this chat's own state is unchanged.`);
    return `${ran}`;
}

/**
 * `/sanguine-ack`: record that the refusals on the counters have been seen.
 *
 * Symmetry with the button, not a second implementation of it.
 *
 * Everything here goes through `state.acknowledge()` and `reject-table.js`'s arithmetic, for the
 * reason every other command in this family does: two ways to acknowledge that compute the
 * outstanding count differently would eventually disagree, and the one place that would show is a
 * panel chip that will not clear.
 *
 * `rates=true` marks NOTHING. A read is not an acknowledgement, asking "is this getting better"
 * and having the question silently reset the measurement is the shape that makes an instrument
 * untrustworthy: so the console print is a pure read and the mark needs the bare command.
 *
 * @param {object} args Named arguments.
 * @returns {Promise<string>} The number of refusals that were outstanding.
 */
async function ackCallback(args, _text) {
    const snapshot = state.snapshot();
    const marks = Array.isArray(snapshot.acks) ? snapshot.acks : [];
    const capped = observe.capTotal();

    if (isTrueBoolean(args?.rates)) {
        const live = { ts: Date.now(), at: entities.turn(), r: countsOf(snapshot.rejects), c: capped };
        const spans = ackSpans(marks, live);
        console.log('[sanguine] refusals per turn, newest first');
        for (const span of spans) {
            const from = Number(span.from?.at) || 0;
            const to = Number(span.to?.at) || 0;
            const per = perTurn(span.split.total, span.turns);
            const waste = perTurn(span.split[WASTE], span.turns);
            console.log(
                `[sanguine] turn ${from}→${to}${span.open ? ' (open)' : ''}, ${span.turns} turns, ` +
                `${span.split.total} refusals, ${per === null ? 'no rate' : `${per.toFixed(2)}/turn`}, ` +
                `${waste === null ? 'no rate' : `${waste.toFixed(2)}/turn`} wasted, ${span.dropped} capped`);
        }
        toastr.info(t`${spans.length} span(s) printed to the console. Nothing was marked.`);
        return `${spans.length}`;
    }

    const acked = marks.length ? marks[marks.length - 1] : null;
    const outstanding = newRejects(snapshot.rejects, acked?.r).reduce((sum, row) => sum + row.count, 0);
    const lifetime = snapshot.rejects.reduce((sum, row) => sum + (Number(row.count) || 0), 0);
    const mark = state.acknowledge();
    // The panel's chip reads the same watermark and redraws on this event; without it the number
    // stays on screen until the next message, which reads as a command that did nothing.
    await eventSource.emit('sanguine_chronicle_updated', { src: 'ack' });
    toastr.success(t`Marked ${outstanding} refusal(s) as seen at turn ${mark.at}. Nothing was deleted, all ${lifetime} are still in Diagnostics, and the chip counts again from the next one.`);
    return `${outstanding}`;
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
        a.download = 'sanguine-trace.json';
        a.click();
        URL.revokeObjectURL(url);
        toastr.success(t`Fold trace for this chat saved (${records.length} passes, ${ok} ok / ${failed} failed).`);
        return `${records.length}`;
    }
    if (_args?.raw) {
        console.log(`[sanguine] trace, latest pass @ ${new Date(newest.t ?? Date.now()).toISOString()}`);
        console.log(`[sanguine] turn ${newest.turn ?? '?'} mid ${newest.mid ?? '?'} ${newest.ok ? 'ok' : `failed: ${newest.reason ?? ''}`}`);
        console.log(`[sanguine] PROMPT\n${newest.prompt ?? ''}`);
        console.log(`[sanguine] RAW REPLY\n${newest.raw ?? ''}`);
        console.log(`[sanguine] PARSED\n${JSON.stringify(newest.parsed ?? null, null, 2)}`);
        return `${newest.ok ? 'ok' : 'failed'}`;
    }
    toastr.info(t`Fold trace: ${records.length} passes for this chat (${ok} ok / ${failed} failed). Use /sanguine-trace raw for the latest pass verbatim, /sanguine-trace download to save the file.`);
    return `${records.length}`;
}
