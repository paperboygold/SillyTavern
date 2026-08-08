#!/usr/bin/env node
/**
 * Seed API keys from the repo-root .env into a SillyTavern data root's secret store.
 *
 * Uses SillyTavern's own SecretManager so the on-disk shape stays correct as that format
 * evolves. Defaults to the isolated Playwright data root, never a real user's.
 *
 * Usage:
 *   node tests/util/seed-secrets.mjs                       # seeds tests/.st-data/default-user
 *   node tests/util/seed-secrets.mjs --root path/to/user   # seeds a specific user directory
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { setConfigFilePath } from '../../src/util.js';

const repoRoot = path.resolve(import.meta.dirname, '../..');

// secrets.js reads config at import time, so the path must be set before it loads.
setConfigFilePath(path.join(repoRoot, 'config.yaml'));
const { SecretManager } = await import('../../src/endpoints/secrets.js');

/**
 * Minimal .env reader — enough for KEY=value lines, no interpolation.
 * @param {string} file Path to the .env file.
 * @returns {Record<string, string>} Parsed values.
 */
function readEnvFile(file) {
    if (!fs.existsSync(file)) {
        return {};
    }
    const out = {};
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return out;
}

const argv = process.argv.slice(2);
const rootIndex = argv.indexOf('--root');
const userRoot = rootIndex !== -1
    ? path.resolve(argv[rootIndex + 1])
    : path.join(repoRoot, 'tests/.st-data/default-user');

if (!fs.existsSync(userRoot)) {
    console.error(`Data root does not exist: ${userRoot}\nRun the test suite once so SillyTavern creates it, or pass --root.`);
    process.exit(1);
}

const env = { ...readEnvFile(path.join(repoRoot, '.env')), ...process.env };

/** Map of env var -> SillyTavern secret key (SECRET_KEYS in src/endpoints/secrets.js). */
const MAPPING = {
    OPENAI_API_KEY: 'api_key_openai',
    GEMINI_API_KEY: 'api_key_makersuite',
};

const manager = new SecretManager({ root: userRoot });

// Guard against the trap that cost an hour: SECRET_KEYS lives in src/endpoints/secrets.js and is
// prefixed (api_key_openai), while src/constants.js has a similarly-named CHAT_COMPLETION_SOURCES
// enum with bare values (openai). Seeding the bare name writes a file the server silently ignores.
const { SECRET_KEYS } = await import('../../src/endpoints/secrets.js');
for (const secretKey of Object.values(MAPPING)) {
    if (!Object.values(SECRET_KEYS).includes(secretKey)) {
        console.error(`Refusing to seed unknown secret key "${secretKey}". Valid keys come from SECRET_KEYS in src/endpoints/secrets.js.`);
        process.exit(1);
    }
}
const seeded = [];

for (const [envVar, secretKey] of Object.entries(MAPPING)) {
    const value = env[envVar];
    if (!value) continue;
    manager.writeSecret(secretKey, value, `seeded from ${envVar}`);
    seeded.push(secretKey);
}

if (!seeded.length) {
    console.error(`No keys found. Expected one of ${Object.keys(MAPPING).join(', ')} in .env or the environment.`);
    process.exit(1);
}

// Deliberately prints key names only, never values — this output ends up in test logs.
console.log(`Seeded ${seeded.length} secret(s) into ${userRoot}: ${seeded.join(', ')}`);
