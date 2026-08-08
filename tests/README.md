# Tests

Two suites, one npm workspace. Install once with `npm ci --prefix tests` (and `npm ci` at the
repo root, which the unit tests need for backend imports).

```bash
npm run test:unit --prefix tests   # jest, fast, no browser, no server
npm run test:e2e  --prefix tests   # playwright, drives a real SillyTavern in a browser
npm test          --prefix tests   # both
```

## Unit tests (`tests/*.test.js`)

Plain jest, `testEnvironment: node`, native ESM via `--experimental-vm-modules`. No jsdom.

Most import backend modules from `../src/`. A few import **pure** frontend modules from
`../public/scripts/` — that works only for modules with no `$`, no `document`, and no import of
`script.js`, since none of those exist in a bare Node context. `fold/steer-table.js` is written
that way on purpose: the data layer is testable, and everything needing the app graph lives in a
sibling file that these tests do not touch.

## End-to-end tests (`tests/frontend/*.e2e.js`)

Playwright against a real running SillyTavern.

**The server starts itself, on its own port, always.** `playwright.config.js` declares a
`webServer` that boots `node server.js` on **port 8100** against an isolated data root at
`tests/.st-data` (gitignored). Override with `ST_TEST_PORT`.

> **Never point the suite or the driver at port 8000.** They rewrite API settings — completion
> source, context size, max tokens — and SillyTavern persists those. An earlier version of this
> config had `reuseExistingServer: true` on the default port, so a test run silently adopted the
> developer's own running instance and reset a 1M-context DeepSeek setup to a 4k mock. The config
> now uses `reuseExistingServer: false` and a non-default port, and `st-driver.mjs` refuses any
> target that is not the test port unless `--force-url` is passed.

**Memory.** The config defaults to 4 workers, i.e. 4 concurrent browsers plus the server. On a
loaded machine that is enough to get the run OOM-killed (exit 137). If that happens, use
`--workers=1`, or run one suite at a time:

```bash
npx playwright test fold-chronicle.e2e.js --workers=1
```

First run needs the browser binaries:

```bash
npx playwright install chromium chromium-headless-shell --prefix tests
```

Do **not** pass `--with-deps`: it tries to `sudo` install system packages and aborts the whole
download if it cannot.

### Testing features that shape the prompt

`tests/util/mock-server.js` is an OpenAI-compatible endpoint that, by default, echoes the last
prompt message back as the assistant reply. It also:

- **records every request** (`mockServer.requests`, `lastRequest()`, `lastPromptText()`), which is
  what makes prompt-shaping features verifiable — you assert on what actually reached the model
  rather than trying to infer it from the reply;
- **streams** when the request sets `stream: true`, so the streaming code path can be exercised
  (SillyTavern writes swipe data in different places when streaming than when blocking);
- accepts a **scripted responder** via `setResponder(fn)` when a specific reply is needed.

`tests/frontend/fold-test-utils.js` wires a page to a mock: it selects the OpenAI-compatible
`custom` source (which is keyless), points it at the mock's port, and opens a chat with
SillyTavern's built-in assistant character — which the app creates on demand, so no fixture
files are needed and nothing is left behind but the disposable data root.

```js
const mockServer = new MockServer({ port: 3100 });
await mockServer.start();
await testSetup.awaitST({ page });
await useMockBackend(page, { mockPort: 3100 });
await sendMessage(page, 'Hello there.');

await steerLastMessage(page, 'make her angrier');
expect(mockServer.lastPromptText()).toContain('make her angrier');
```

Give each worker its own mock port (`3100 + testInfo.parallelIndex`) so a parallel run cannot
collide, and mark suites that share one chat `test.describe.configure({ mode: 'serial' })`.

Three traps the chronicle tests hit, all worth knowing before writing new ones:

- **The default echo responder poisons retrieval tests.** Echoing the prompt puts every earlier
  keyword into the assistant's reply, and the retrieval query is built from recent messages — so
  no query can ever be genuinely unrelated. Script a bland reply instead.
- **A bland reply must still be unique per turn.** Chronicle events are keyed by the content hash
  of the swipe they came from, so two byte-identical swipes share one identity and branch-
  awareness tests silently pass for the wrong reason. Use a counter that is scoped to the file,
  not to the responder.
- **Extraction is a second request.** With a low `interval`, `lastRequest()` after a chat turn is
  the extraction call, not the chat prompt. Set `interval: 999` and drive extraction explicitly
  unless the automatic trigger is what you are testing.

## Live model tests (opt-in)

`fold-steer-live.e2e.js` runs against real providers. It is **skipped by default** — it costs money
and needs network — so the standard suite stays free and offline.

```bash
node tests/util/seed-secrets.mjs                  # once: .env keys -> the test instance's secret store
FOLD_LIVE=1 npm run test:e2e --prefix tests
```

`seed-secrets.mjs` reads `OPENAI_API_KEY` / `GEMINI_API_KEY` from the repo-root `.env` (gitignored)
and writes them into `tests/.st-data/default-user` using SillyTavern's own `SecretManager`, so the
on-disk shape stays correct as that format changes. It prints key *names* only, never values.

> **Secret key names are a trap.** `SECRET_KEYS` lives in `src/endpoints/secrets.js` and its values
> are prefixed — `api_key_openai`. `src/constants.js` has a similarly-shaped
> `CHAT_COMPLETION_SOURCES` enum whose values are bare — `openai`. Seeding the bare name produces a
> perfectly valid secrets file that the server silently ignores, and the only symptom is
> `OpenAI API key is missing` in the server log. `seed-secrets.mjs` now validates against
> `SECRET_KEYS` and refuses unknown names.

What the live suite adds over the mock suite: the mock proves the instruction reaches the prompt and
is persisted on the right swipe, but it cannot prove a real model *obeys* it. The live tests steer
with a directive whose compliance is unambiguous ("reply with exactly the single word BANANA"), so
the assertion stays deterministic even though the model is not, and a second steer confirms a stale
instruction does not leak into the next generation.
