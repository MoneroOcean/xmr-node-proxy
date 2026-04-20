"use strict";

const assert = require("node:assert/strict");
const net = require("node:net");
const test = require("node:test");
const tls = require("node:tls");
const { once } = require("node:events");

const { UpstreamPoolClient } = require("../proxy/pool");

const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC5yaWybc3Pu8vW
mPyadiZ0sQGxy1UzXqd7ECZZv9eDLKPX+rHPsjchN0CfNnwrVjsOLm1Zmjk7dt41
y4DeoUVTaADr4hLdC8DRNqB9u6HZZQFwzCoV6aU65KnMRXLsQ+OAVDv/nfnGhFx+
s5u3I4CiyyWAH5rrf3ExzrnnOHvqz8NWiFzZe8pP0nYEqugkF+PiaBIzG8UsRT74
N84fuKA+GPPqw7MrYmeUW6POhwOdUFzQ8M+YD1BYRXzx6dl5C9uLsZL4fA2tIY5e
9CVdy8sOHyxlmTmE0x42mai6S3QCzlavs6XiRm+Vu6WP2fnlqvzGUAJmhFR4sMWx
QUDu9P0RAgMBAAECggEAHm79QRrClY5WSDt8WZMUHpZmSCkeNlGBjuOo3JfT5k14
M2eCHBs986d44vvKYFD6UIrjZ8OfL3H72YUSAaYaVJzbVciNPX9w4PSZWq9TRmjI
0SDonflNkzWk6OzRdAl06W8i+u72XQIOosSqM9hReJlddbz3pC8WrEmIY2t5xQ9n
Bpt8MAEMcXkiIBSpwBy/ed7H4g/2pn24ZVCdcfERRnj4kQ2nKgesVS0nxBe9QhTV
kU0RtltyeYtgI1R3BnqRFMrbA42HFPeRfYbTJuxB/WsYqUJOgQUg5IEF0DZPOFjb
HKLcbsqXbu/Yp1JUNSRkFWPgvCkrMNgumqCJJSsvJwKBgQDnJjTvSvnC5jGDj7d8
zfBjp0k8Ui/bWLDOJCPmKH1e3pBIJ4xOa06T4P7P0GOQVT4HzhqNf/RiZSTzgLWk
tfODuthvRmTNBSfGMxTsNDZ61X0ZUd34GDkhSmKwH6rpIuNeUkQ4VgdLaTXUMwKy
HUHS/vWUFUWuD/QdmnThAo/9MwKBgQDNwvqwhE7eTSeUdlbHNYVba/By343V2z/c
exuN9QybcGMf0i++5WyiF6XSi0uidBPRo7xA8HsnD7XSNzUs4d3GiWUStR5IsUKb
5hc4vT2V6EUGaxGSfkSxR5hW04t868R+1VuoaIlYVizbk6PFp8BNryyYgA6UbciO
miOxVEW0qwKBgQDTiDRzNHLi+JQhaLkrPq+aEvJDgJcJLd4HmC0+KJmq4xS443BU
J4FudT3bYkJrSIcOz3+fNJSqIxOwv337cQOb7ra5Bnui3+/pQsAH9TRSLuNf83ql
200U+STdNu3KksHuhGyn/ZqJWYwIWHJEG+AsPmTxEpKE21a0bLA/Zn/s3wKBgQCo
bAzfJ62W8PiQ4Tyu2vRJnNS4cpyajFh9lJc9X3PuV9QLW/SRASImm8yzxikm1HTU
iH2zeiSUGJvvchkon8j0lcoRwgcD4XRwP6qKWvxqFDFLy6AalRiNM9lSWN44ZpP0
bZgVBVxG3mLhaLwJMgKKk/Sg71D/1czwTOMiZ6SW+QKBgB0GSDP9slwYqALHihmg
CVOVgTHABoZFHhZ2QlP55AvaoXYhH+0G2wj/H6B1OP27gxRupC5G+zPnlVr4rXH2
G9KgP5dPFVhCQSHqpJ2zEHcqESPzjp4odroTufdNrzGpAdKaLGI+losRMGoVyoV4
a50bKkVFlhbYUTqM8bb+evLU
-----END PRIVATE KEY-----`;

const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUUm/V/rlqto0NC0xwUzSeQ94No9wwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDQxOTA1MjA1MFoXDTI2MDQy
MDA1MjA1MFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAucmlsm3Nz7vL1pj8mnYmdLEBsctVM16nexAmWb/Xgyyj
1/qxz7I3ITdAnzZ8K1Y7Di5tWZo5O3beNcuA3qFFU2gA6+IS3QvA0Tagfbuh2WUB
cMwqFemlOuSpzEVy7EPjgFQ7/535xoRcfrObtyOAosslgB+a639xMc655zh76s/D
Vohc2XvKT9J2BKroJBfj4mgSMxvFLEU++DfOH7igPhjz6sOzK2JnlFujzocDnVBc
0PDPmA9QWEV88enZeQvbi7GS+HwNrSGOXvQlXcvLDh8sZZk5hNMeNpmoukt0As5W
r7Ol4kZvlbulj9n55ar8xlACZoRUeLDFsUFA7vT9EQIDAQABo1MwUTAdBgNVHQ4E
FgQUjv4HT8EwGML/55U0QqgtjMwHOF0wHwYDVR0jBBgwFoAUjv4HT8EwGML/55U0
QqgtjMwHOF0wDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAX5Ks
uDKnzJmrs1Y87ooUxkeikZHpifGF0acaIz1W5i4AxM4SPeO95H7+AdYVVbZ6lLA1
rhw5rMtMNzfqJ6tasahnH1OqQM2HHdmsiR3i32Vs24cqyfN94iGvXVnZYandbuMC
ExFTIp7Jr+VHsCHGG+Slvt2K/ewgPUfwey4lJkRK95fZpGLzBP5cD1tWre6ty+YC
3Fz3A0oY1gsEAhNZda5FFgmkoyakmNTdUWgKcnbm9kdXssSNakqkSz72zPydEx1T
90+wifm11o4fIzcJ0ZLqCQL9lSvIl0yVHuUCyijR2KdKs4+Owww0/vq4qtMLQzC/
flTlWlOxUA6QuZ3Tew==
-----END CERTIFICATE-----`;

function createLogger() {
    const entries = {
        info: [],
        warn: [],
        error: [],
        debug: []
    };

    return {
        entries,
        info(message, meta) {
            entries.info.push({ message, meta });
        },
        warn(message, meta) {
            entries.warn.push({ message, meta });
        },
        error(message, meta) {
            entries.error.push({ message, meta });
        },
        debug(namespace, message, meta) {
            entries.debug.push({ namespace, message, meta });
        }
    };
}

function createClient(serverPort, overrides = {}) {
    const logger = createLogger();
    const templates = [];
    const broadcasts = [];

    const client = new UpstreamPoolClient({
        config: {
            socketTimeoutMs: 5_000,
            maxJsonLineBytes: 128 * 1024
        },
        master: {
            broadcast(message) {
                broadcasts.push(message);
            },
            handlePoolTemplate(_pool, template) {
                templates.push(template);
            },
            isPoolUsable() {
                return true;
            }
        },
        logger,
        poolConfig: {
            hostname: "127.0.0.1",
            port: serverPort,
            ssl: false,
            allowSelfSignedSSL: false,
            share: 100,
            username: "wallet",
            password: "worker",
            keepAlive: true,
            algo: ["rx/0"],
            algo_perf: { "rx/0": 1 },
            blob_type: "cryptonote",
            default: true,
            ...overrides
        },
        coins: {}
    });

    return { client, logger, templates, broadcasts };
}

async function waitFor(check, timeoutMs = 7_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Timed out waiting for condition");
}

function attachJsonHandler(socket, onMessage) {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
        buffer += chunk;
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            if (line) onMessage(JSON.parse(line), socket);
            newlineIndex = buffer.indexOf("\n");
        }
    });
}

test("UpstreamPoolClient retries quickly when MO says the template is not ready yet", async () => {
    let loginAttempts = 0;
    const server = net.createServer((socket) => {
        attachJsonHandler(socket, (message) => {
            if (message.method !== "login") return;
            loginAttempts += 1;

            if (loginAttempts === 1) {
                socket.write(`${JSON.stringify({
                    id: message.id,
                    error: { code: -1, message: "No block template yet. Please wait." },
                    result: null
                })}\n`);
                socket.end();
                return;
            }

            socket.write(`${JSON.stringify({
                id: message.id,
                error: null,
                result: {
                    id: "session-ready",
                    job: {
                        job_id: "job-ready",
                        target_diff: 10000
                    }
                }
            })}\n`);
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const { client, logger, templates } = createClient(server.address().port);
    try {
        client.start();

        await waitFor(() => loginAttempts >= 2 && templates.length === 1);
        assert.equal(loginAttempts, 2);
        assert.equal(templates[0].job_id, "job-ready");
        assert.equal(client.sendLog.size, 0);
        assert.equal(client.connected, true);
        assert.equal(logger.entries.warn[0].message, "pool.no_template_yet");
    } finally {
        client.stop();
        await new Promise((resolve) => server.close(resolve));
    }
});

test("UpstreamPoolClient advertises algo and algo-perf during login for MO-style switching", async () => {
    let loginRequest = null;
    const server = net.createServer((socket) => {
        attachJsonHandler(socket, (message) => {
            if (message.method !== "login") return;
            loginRequest = message;
            socket.write(`${JSON.stringify({
                id: message.id,
                error: null,
                result: {
                    id: "session-ready",
                    job: {
                        job_id: "job-ready",
                        target_diff: 10000
                    }
                }
            })}\n`);
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const { client } = createClient(server.address().port);
    try {
        client.start();
        await waitFor(() => loginRequest !== null);
        assert.deepEqual(loginRequest.params.algo, ["rx/0"]);
        assert.deepEqual(loginRequest.params["algo-perf"], { "rx/0": 1 });
    } finally {
        client.stop();
        await new Promise((resolve) => server.close(resolve));
    }
});

test("UpstreamPoolClient accepts self-signed TLS pools and treats keepalived replies as normal acks", async () => {
    let keepaliveRequests = 0;
    const server = tls.createServer({ key: TLS_KEY, cert: TLS_CERT }, (socket) => {
        attachJsonHandler(socket, (message) => {
            if (message.method === "login") {
                socket.write(`${JSON.stringify({
                    id: message.id,
                    error: null,
                    result: {
                        id: "tls-session",
                        job: {
                            job_id: "tls-job",
                            target_diff: 10000
                        }
                    }
                })}\n`);
                return;
            }

            if (message.method === "keepalived") {
                keepaliveRequests += 1;
                socket.write(`${JSON.stringify({
                    id: message.id,
                    error: null,
                    result: { status: "KEEPALIVED" }
                })}\n`);
            }
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const { client, logger, templates } = createClient(server.address().port, {
        ssl: true,
        allowSelfSignedSSL: true
    });

    try {
        client.start();
        await waitFor(() => templates.length === 1);
        assert.equal(templates[0].job_id, "tls-job");
        assert.equal(client.connected, true);

        assert.equal(client.sendData("keepalived"), true);
        await waitFor(() => keepaliveRequests === 1 && client.sendLog.size === 0);

        assert.equal(keepaliveRequests, 1);
        assert.equal(client.connected, true);
        assert.equal(logger.entries.warn.some((entry) => /Unhandled reply type keepalived/.test(entry.message)), false);
    } finally {
        client.stop();
        await new Promise((resolve) => server.close(resolve));
    }
});
