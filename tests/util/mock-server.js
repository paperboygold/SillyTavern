import http from 'node:http';
import { readAllChunks, tryParse } from '../../src/util.js';

export class MockServer {
    /** @type {string} */
    host;
    /** @type {number} */
    port;
    /** @type {import('http').Server} */
    server;
    /**
     * Every chat-completion request body this server has received, oldest first.
     * Lets a test assert what actually reached the model rather than inferring it
     * from the reply — which is the only way to verify prompt-shaping features.
     * @type {object[]}
     */
    requests = [];
    /**
     * Optional override for the assistant's reply text.
     * @type {((jsonBody: object) => string)|null}
     */
    responder = null;

    /**
     * Creates an instance of MockServer.
     * @param {object} [param] Options object.
     * @param {string} [param.host] The hostname or IP address to bind the server to.
     * @param {number} [param.port] The port number to listen on.
     */
    constructor({ host, port } = {}) {
        this.host = host ?? '127.0.0.1';
        this.port = port ?? 3000;
    }

    /**
     * The most recent request body, or null if none have arrived.
     * @returns {object|null} The last request body.
     */
    lastRequest() {
        return this.requests.length ? this.requests[this.requests.length - 1] : null;
    }

    /**
     * Concatenated content of the last request's messages — the flattened prompt.
     * @returns {string} The prompt text, or '' if no request has arrived.
     */
    lastPromptText() {
        const messages = this.lastRequest()?.messages ?? [];
        return messages
            .map(m => (typeof m?.content === 'string'
                ? m.content
                : Array.isArray(m?.content) ? m.content.map(p => p?.text ?? '').join('') : ''))
            .join('\n');
    }

    /**
     * Forget all recorded requests and any scripted responder.
     */
    reset() {
        this.requests = [];
        this.responder = null;
    }

    /**
     * Script the assistant's reply. Pass null to restore the default echo behaviour.
     * @param {((jsonBody: object) => string)|null} responder Reply generator.
     */
    setResponder(responder) {
        this.responder = responder;
    }

    /**
     * The reply text for a request: the scripted responder if set, else an echo of the
     * last prompt message (the default this class has always had).
     * @param {object} jsonBody The parsed JSON body from the request.
     * @returns {string} The assistant reply text.
     */
    replyTextFor(jsonBody) {
        if (typeof this.responder === 'function') {
            return String(this.responder(jsonBody));
        }
        const messages = jsonBody?.messages;
        const lastMessage = messages?.[messages.length - 1];
        return String(lastMessage?.content ?? 'No prompt messages.');
    }

    /**
     * Handles Chat Completions requests.
     * @param {object} jsonBody The parsed JSON body from the request.
     * @returns {object} Mock response object.
     */
    handleChatCompletions(jsonBody) {
        const messages = jsonBody?.messages;
        const mockResponse = {
            choices: [
                {
                    finish_reason: 'stop',
                    index: 0,
                    message: {
                        role: 'assistant',
                        reasoning_content: `${jsonBody?.model}\n${messages?.length}\n${jsonBody?.max_tokens}`,
                        content: this.replyTextFor(jsonBody),
                    },
                },
            ],
            created: 0,
            model: jsonBody?.model,
        };
        return mockResponse;
    }

    /**
     * Streams a Chat Completions response as OpenAI-style SSE, so tests can exercise the
     * streaming code path (which writes swipe data in different places than the blocking one).
     * @param {import('http').ServerResponse} res The response to write to.
     * @param {object} jsonBody The parsed JSON body from the request.
     * @returns {Promise<void>} Resolves when the stream has ended.
     */
    async streamChatCompletions(res, jsonBody) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });

        const text = this.replyTextFor(jsonBody);
        // Chunk on word boundaries so the test sees a genuinely incremental stream.
        const chunks = text.match(/\S+\s*/g) ?? [text];

        for (const chunk of chunks) {
            const payload = {
                choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
                created: 0,
                model: jsonBody?.model,
            };
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }

        const final = {
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            created: 0,
            model: jsonBody?.model,
        };
        res.write(`data: ${JSON.stringify(final)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
    }

    /**
     * Starts the mock server.
     * @returns {Promise<void>}
     */
    async start() {
        return new Promise((resolve, reject) => {
            this.server = http.createServer(async (req, res) => {
                try {
                    const body = await readAllChunks(req);
                    const jsonBody = tryParse(body.toString());
                    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
                        this.requests.push(jsonBody);
                        if (jsonBody?.stream) {
                            await this.streamChatCompletions(res, jsonBody);
                            return;
                        }
                        const mockResponse = this.handleChatCompletions(jsonBody);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(mockResponse));
                    } else if (req.method === 'GET' && req.url === '/v1/models') {
                        // Some code paths probe the model list before generating.
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
                    } else {
                        res.writeHead(404);
                        res.end();
                    }
                } catch (error) {
                    res.writeHead(500);
                    res.end();
                }
            });

            this.server.on('error', (err) => {
                reject(err);
            });

            this.server.listen(this.port, this.host, () => {
                resolve();
            });
        });
    }

    /**
     * Stops the mock server.
     * @returns {Promise<void>}
     */
    async stop() {
        return new Promise((resolve, reject) => {
            if (!this.server) {
                return reject(new Error('Server is not running.'));
            }
            this.server.closeAllConnections();
            this.server.close(( /** @type {NodeJS.ErrnoException|undefined} */ err) => {
                if (err && (err?.code !== 'ERR_SERVER_NOT_RUNNING')) {
                    return reject(err);
                }
                resolve();
            });
        });
    }
}
