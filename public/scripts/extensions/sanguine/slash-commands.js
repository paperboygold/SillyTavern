/**
 * fold/slash-commands.js — /steer and its aliases.
 *
 * Deliberately does NOT extend /regenerate: that routes to Generate('regenerate'), which deletes
 * the entire last chat entry (and therefore every swipe on it) before generating. Attaching an
 * instruction there would mean "type a direction, lose your variant history" — the exact opposite
 * of what steering is for.
 */

import { chat, is_send_press } from '../../../script.js';
import { is_group_generating } from '../../group-chats.js';
import { t } from '../../i18n.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { isTrueBoolean, waitUntilCondition } from '../../utils.js';
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
 * Register sanguine's slash commands. Called once from init().
 */
export function registerSanguineSlashCommands() {
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
}

export const registerFoldSlashCommands = registerSanguineSlashCommands;
