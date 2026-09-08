/**
 * sanguine/metadata-key.js: the name of the property everything persists under.
 *
 * A leaf. No imports, deliberately: `store.js` runs in the browser and pulls in `script.js`,
 * `harvest.js` runs under node and cannot, and both need this constant. A shared constant that only
 * one side can reach is a constant the other side copies, which is how this file came to exist.
 *
 * Why a whole module for one string.
 *
 * The rename from `fold` to `sanguine` moved the definition in `store.js` and missed two modules
 * that had spelled the key themselves. Nothing threw: `campaignId()` read a property nothing writes,
 * returned `''`, and the durable server-side ledger stopped hydrating and stopped appending for
 * every chat created after the rename, silently. The failure surfaced as a `chat_metadata` blob at
 * 127.7 KB against a 128 KB cap, on a campaign whose events were supposed to be living on disk.
 *
 * One spelling, imported everywhere, and `tests/sanguine-metadata-key.test.js` refuses a second.
 * A missed import fails loudly at load; a missed literal fails silently for a month.
 */

/** The property on `chat_metadata` that holds everything sanguine persists for a chat. */
export const SANGUINE_METADATA_KEY = 'sanguine';

/**
 * Keys this project has persisted under before, newest first.
 *
 * Only for reading chat files written earlier: `harvest.js` walks historical JSONL and
 * finds both spellings on disk. The live store never writes these and never migrates them: a
 * retired chat is data to be read, not state to be carried forward.
 */
export const LEGACY_METADATA_KEYS = Object.freeze(['fold']);

/**
 * The blob a chat carries, under whichever key it was written with.
 *
 * @param {object} metadata A chat's `chat_metadata`, live or parsed from disk.
 * @returns {object|null} The blob, or null when the chat has none.
 */
export function readBlob(metadata) {
    for (const key of [SANGUINE_METADATA_KEY, ...LEGACY_METADATA_KEYS]) {
        const blob = metadata?.[key];
        if (blob && typeof blob === 'object') {
            return blob;
        }
    }
    return null;
}
