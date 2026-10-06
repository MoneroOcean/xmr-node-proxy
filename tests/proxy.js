"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const net = require("node:net");
const powHash = require("node-powhash");
const test = require("node:test");
const { once } = require("node:events");

const { bufferToBigIntLE } = require("../proxy/common");
const {
    JsonLineClient,
    createRavenTemplateBlob,
    createTemplate,
    startHarness
} = require("./common/harness");
const createCoins = require("../coins/core");

function encodeDiff(value) {
    return value.toString(16);
}

function hashDiff(hashBuffer) {
    const value = bufferToBigIntLE(hashBuffer);
    return value === 0n ? (1n << 256n) - 1n : ((1n << 256n) - 1n) / value;
}

function findKawpowShare(job, minimumDiff) {
    const header = Buffer.from(job.blob, "hex");
    for (let nonceValue = 0n; nonceValue < 100000n; nonceValue += 1n) {
        const nonce = Buffer.alloc(8);
        nonce.writeBigUInt64BE(nonceValue);
        const [result, mixhash] = powHash.kawpow_light(header, nonce, job.height);
        if (hashDiff(result) >= BigInt(minimumDiff)) {
            return {
                mixhash: mixhash.toString("hex"),
                nonce: nonce.toString("hex"),
                result: result.toString("hex")
            };
        }
    }
    throw new Error("Unable to find KawPoW test share");
}

const runtimeFailureState = {
    details: [],
    printed: false
};

function firstLine(value) {
    return String(value || "").split(/\r?\n/, 1)[0] || "";
}

function formatRuntimeFailureDetails(entries) {
    return entries.map((entry) => [
        `[${entry.name}] ${entry.summary}`,
        "",
        "Proxy log:",
        entry.logOutput || "<empty>"
    ].join("\n")).join("\n\n");
}

async function withHarness(name, options, run) {
    const harness = await startHarness(options);
    try {
        return await run(harness);
    } catch (error) {
        runtimeFailureState.details.push({
            name,
            summary: firstLine(error.message) || "failed",
            logOutput: harness.getLogOutput ? harness.getLogOutput() : ""
        });
        throw error;
    } finally {
        await harness.stop();
    }
}

async function clearWorkerTemplates(harness) {
    const worker = harness.app.getState().worker;
    await harness.waitFor(() => [...worker.pools.values()].every((pool) => pool.activeBlockTemplate));
    for (const pool of worker.pools.values()) {
        pool.active = false;
        pool.activeBlockTemplate = null;
    }
    return worker;
}

test.describe("xmr-node-proxy standalone runtime", { concurrency: false }, () => {
    test.after(() => {
        if (!runtimeFailureState.details.length || runtimeFailureState.printed) return;
        process.stdout.write(`\nStandalone runtime failure logs\n${formatRuntimeFailureDetails(runtimeFailureState.details)}\n`);
        runtimeFailureState.printed = true;
    });

    test("miner can login, use keepalive aliases, and submit a valid share through the proxy", async () => {
        await withHarness("miner can login, use keepalive aliases, and submit a valid share through the proxy", {}, async (harness) => {
            const client = new JsonLineClient(harness.minerPort);
            await client.connect();
            try {
                const loginReply = await client.request({
                    id: 1,
                    method: "login",
                    params: {
                        login: "wallet-a",
                        pass: "worker-a",
                        agent: "test-miner/1.0"
                    }
                });

                assert.equal(loginReply.error, null);
                assert.equal(loginReply.result.status, "OK");

                const keepaliveReply = await client.request({
                    id: 2,
                    method: "keepalive",
                    params: { id: loginReply.result.id }
                });

                const keepalivedReply = await client.request({
                    id: 3,
                    method: "keepalived",
                    params: { id: loginReply.result.id }
                });

                assert.deepEqual(keepaliveReply.result, { status: "KEEPALIVED" });
                assert.deepEqual(keepalivedReply.result, { status: "KEEPALIVED" });

                const submitReply = await client.request({
                    id: 4,
                    method: "submit",
                    params: {
                        id: loginReply.result.id,
                        job_id: loginReply.result.job.job_id,
                        nonce: "00000001",
                        result: encodeDiff(6000)
                    }
                });

                await harness.waitFor(() => harness.primaryPool.submitRequests.length === 1);
                assert.equal(submitReply.error, null);
                assert.deepEqual(submitReply.result, { status: "OK" });

                const forwarded = harness.primaryPool.submitRequests[0].params;
                assert.equal(forwarded.job_id, harness.primaryPool.template.job_id);
                assert.equal(forwarded.nonce, "00000001");
                assert.equal(typeof forwarded.poolNonce, "number");
                assert.equal(typeof forwarded.workerNonce, "number");
            } finally {
                await client.close();
            }
        });
    });

    test("miner logins wait for a template and receive one initial job each", async () => {
        await withHarness("miner logins wait for a template and receive one initial job each", {}, async (harness) => {
            const worker = await clearWorkerTemplates(harness);
            const clients = [new JsonLineClient(harness.minerPort), new JsonLineClient(harness.minerPort)];
            try {
                await Promise.all(clients.map((client) => client.connect()));
                let replyCount = 0;
                const replies = clients.map((client, index) => client.request({
                    id: 100 + index,
                    method: "login",
                    params: { login: `wallet-wait-${index}`, pass: "worker-wait" }
                }).then((reply) => {
                    replyCount += 1;
                    return reply;
                }));
                await harness.waitFor(() => worker.protocol.pendingLogins.size === 2);
                assert.equal(replyCount, 0);
                assert.equal(worker.activeMiners.size, 0);
                assert.ok(clients.every((client) => !client.socket.destroyed));

                worker.handleMasterMessage({
                    type: "newBlockTemplate", host: "127.0.0.1", data: harness.primaryPool.template
                });
                for (const reply of await Promise.all(replies)) {
                    assert.equal(reply.error, null);
                    assert.equal(reply.result.status, "OK");
                    assert.ok(reply.result.job.job_id);
                }
                assert.equal(worker.activeMiners.size, 2);
                assert.equal(worker.protocol.pendingLogins.size, 0);
                assert.ok(clients.every((client) => client.pushes.length === 0));
                assert.doesNotMatch(harness.getLogOutput(), /miner\.login_rejected/);
            } finally {
                await Promise.all(clients.map((client) => client.close()));
            }
        });
    });

    test("a repeated pending login keeps the original request and session", async () => {
        await withHarness("a repeated pending login keeps the original request and session", {}, async (harness) => {
            const worker = await clearWorkerTemplates(harness);
            const client = new JsonLineClient(harness.minerPort);
            await client.connect();
            try {
                const originalReply = client.request({
                    id: 110, method: "login", params: { login: "wallet-original", pass: "worker-original" }
                });
                await harness.waitFor(() => worker.protocol.pendingLogins.size === 1);
                const duplicateReply = await client.request({
                    id: 111, method: "login", params: { login: "wallet-duplicate", pass: "worker-duplicate" }
                });
                assert.equal(duplicateReply.error.message, "Login already pending");
                assert.equal(worker.protocol.pendingLogins.size, 1);
                assert.equal(client.socket.destroyed, false);
                worker.handleMasterMessage({
                    type: "newBlockTemplate", host: "127.0.0.1", data: harness.primaryPool.template
                });
                const reply = await originalReply;
                assert.equal(reply.error, null);
                assert.equal(worker.activeMiners.size, 1);
                assert.equal(worker.activeMiners.get(reply.result.id).user, "wallet-original");
            } finally {
                await client.close();
            }
        });
    });

    test("a backup template completes a login waiting for the primary", async () => {
        await withHarness("a backup template completes a login waiting for the primary", {
            backupTemplate: createTemplate({ jobId: "job-wait-backup", templateId: "tpl-wait-backup" })
        }, async (harness) => {
            const worker = await clearWorkerTemplates(harness);
            const client = new JsonLineClient(harness.minerPort);
            await client.connect();
            try {
                const login = client.request({
                    id: 120, method: "login", params: { login: "wallet-backup-wait", pass: "worker-backup-wait" }
                });
                await harness.waitFor(() => worker.protocol.pendingLogins.size === 1);
                worker.handleMasterMessage({
                    type: "newBlockTemplate", host: "localhost", data: harness.backupPool.template
                });
                const reply = await login;
                assert.equal(reply.error, null);
                assert.equal(worker.activeMiners.get(reply.result.id).pool, "localhost");
                assert.equal(worker.pools.get("127.0.0.1").activeBlockTemplate, null);
            } finally {
                await client.close();
            }
        });
    });

    test("invalid and unauthorized logins fail immediately without a template", async () => {
        await withHarness("invalid and unauthorized logins fail immediately without a template", {
            accessControlEnabled: true, accessEntries: { "wallet-ok": "secret" }
        }, async (harness) => {
            const worker = await clearWorkerTemplates(harness);
            for (const [id, params, reason] of [
                [130, { login: "wallet-ok+0", pass: "secret" }, "Invalid difficulty"],
                [131, { login: "wallet-denied", pass: "wrong" }, "Unauthorized access"]
            ]) {
                const client = new JsonLineClient(harness.minerPort);
                await client.connect();
                try {
                    const reply = await client.request({ id, method: "login", params });
                    assert.equal(reply.error.message, reason);
                    assert.equal(worker.protocol.pendingLogins.size, 0);
                    assert.equal(worker.activeMiners.size, 0);
                } finally {
                    await client.close();
                }
            }
        });
    });

    test("disconnect removes a pending login before a later template", async () => {
        await withHarness("disconnect removes a pending login before a later template", {}, async (harness) => {
            const worker = await clearWorkerTemplates(harness);
            const client = new JsonLineClient(harness.minerPort);
            await client.connect();
            try {
                client.socket.write(`${JSON.stringify({
                    id: 140, method: "login", params: { login: "wallet-wait-close", pass: "worker-wait-close" }
                })}\n`);
                await harness.waitFor(() => worker.protocol.pendingLogins.size === 1);
                await client.close();
                await harness.waitFor(() => worker.protocol.pendingLogins.size === 0);
                worker.handleMasterMessage({
                    type: "newBlockTemplate", host: "127.0.0.1", data: harness.primaryPool.template
                });
                assert.equal(worker.activeMiners.size, 0);
            } finally {
                await client.close();
            }
        });
    });

    test("worker shutdown closes sockets with pending logins", { timeout: 5_000 }, async () => {
        await withHarness("worker shutdown closes sockets with pending logins", {}, async (harness) => {
            const worker = await clearWorkerTemplates(harness);
            const client = new JsonLineClient(harness.minerPort);
            await client.connect();
            try {
                client.socket.write(`${JSON.stringify({
                    id: 150, method: "login", params: { login: "wallet-wait-stop", pass: "worker-wait-stop" }
                })}\n`);
                await harness.waitFor(() => worker.protocol.pendingLogins.size === 1);
                const closed = once(client.socket, "close");
                await worker.stop();
                await closed;
                assert.equal(worker.protocol.pendingLogins.size, 0);
                assert.equal(worker.activeMiners.size, 0);
            } finally {
                await client.close();
            }
        });
    });

    test("pending login times out after 5 seconds without registering a miner", async (context) => {
        await withHarness("pending login times out after 5 seconds without registering a miner", {}, async (harness) => {
            const worker = await clearWorkerTemplates(harness);
            const client = new JsonLineClient(harness.minerPort);
            const connected = once(worker.servers[0].server, "connection");
            await client.connect();
            const [serverSocket] = await connected;
            try {
                context.mock.timers.enable({ apis: ["setTimeout"] });
                const received = once(serverSocket, "data");
                client.socket.write(`${JSON.stringify({
                    id: 160, method: "login", params: { login: "wallet-wait-timeout", pass: "worker-wait-timeout" }
                })}\n`);
                await received;
                assert.equal(worker.protocol.pendingLogins.size, 1);
                context.mock.timers.tick(4_999);
                assert.equal(worker.protocol.pendingLogins.size, 1);
                assert.equal(client.pushes.length, 0);
                context.mock.timers.tick(1);
                context.mock.timers.reset();
                const reply = await client.waitFor((message) => message.id === 160);
                assert.equal(reply.error.message, "No active block template");
                assert.equal(worker.protocol.pendingLogins.size, 0);
                assert.equal(worker.activeMiners.size, 0);
                await harness.waitFor(() => client.socket.destroyed);
            } finally {
                context.mock.timers.reset();
                await client.close();
            }
        });
    });

    test("duplicate shares are rejected before they reach the upstream pool", async () => {
        await withHarness("duplicate shares are rejected before they reach the upstream pool", {}, async (harness) => {
            const client = new JsonLineClient(harness.minerPort);
            await client.connect();
            try {
                const loginReply = await client.request({
                    id: 10,
                    method: "login",
                    params: {
                        login: "wallet-b",
                        pass: "worker-b"
                    }
                });

                const payload = {
                    id: loginReply.result.id,
                    job_id: loginReply.result.job.job_id,
                    nonce: "00000002",
                    result: encodeDiff(6000)
                };

                const firstReply = await client.request({ id: 11, method: "submit", params: payload });
                const secondReply = await client.request({ id: 12, method: "submit", params: payload });

                await harness.waitFor(() => harness.primaryPool.submitRequests.length === 1);
                assert.equal(firstReply.error, null);
                assert.equal(secondReply.error.message, "Duplicate share");
                assert.equal(harness.primaryPool.submitRequests.length, 1);
            } finally {
                await client.close();
            }
        });
    });

    test("KawPoW pool-difficulty shares are verified and submitted upstream", async () => {
        await withHarness("KawPoW pool-difficulty shares are verified and submitted upstream", {
            coinsFactory: createCoins,
            listeningDiff: 1,
            poolAlgo: "kawpow",
            poolAlgoPerf: { kawpow: 1 },
            poolBlobType: "raven",
            primaryTemplate: createTemplate({
                algo: "kawpow",
                blob: createRavenTemplateBlob(),
                blobType: "raven",
                height: 0,
                targetDiff: 500
            })
        }, async (harness) => {
            const client = new JsonLineClient(harness.minerPort);
            await client.connect();
            try {
                const loginReply = await client.request({
                    id: 13,
                    method: "login",
                    params: {
                        login: "wallet-kawpow",
                        pass: "worker-kawpow"
                    }
                });
                const kawpowShare = findKawpowShare(loginReply.result.job, 500);
                const share = {
                    id: loginReply.result.id,
                    job_id: loginReply.result.job.job_id,
                    ...kawpowShare
                };

                const submitReply = await client.request({ id: 14, method: "submit", params: share });

                await harness.waitFor(() => harness.primaryPool.submitRequests.length === 1);
                assert.equal(submitReply.error, null);
                assert.deepEqual(submitReply.result, { status: "OK" });
                assert.equal(harness.primaryPool.submitRequests[0].params.job_id, harness.primaryPool.template.job_id);
                assert.equal(harness.primaryPool.submitRequests[0].params.mixhash, share.mixhash);
                assert.equal(harness.primaryPool.submitRequests[0].params.nonce, share.nonce);
                assert.equal(harness.primaryPool.submitRequests[0].params.result, share.result);
                assert.match(harness.getLogOutput(), /share\.upstream/);
                assert.doesNotMatch(harness.getLogOutput(), /share\.block_found/);

                const badMixReply = await client.request({
                    id: 15,
                    method: "submit",
                    params: {
                        ...share,
                        job_id: loginReply.result.job.job_id,
                        mixhash: "11".repeat(32),
                        nonce: "000000000000059c"
                    }
                });

                assert.equal(badMixReply.error.message, "Low difficulty share");
                assert.equal(harness.primaryPool.submitRequests.length, 1);
            } finally {
                await client.close();
            }
        });
    });

    test("shares for the immediately previous template are still accepted from the past-template cache", async () => {
        await withHarness("shares for the immediately previous template are still accepted from the past-template cache", {}, async (harness) => {
            const client = new JsonLineClient(harness.minerPort);
            await client.connect();
            try {
                const loginReply = await client.request({
                    id: 20,
                    method: "login",
                    params: {
                        login: "wallet-c",
                        pass: "worker-c"
                    }
                });

                harness.primaryPool.pushTemplate(createTemplate({ height: 101, jobId: "job-101", templateId: "tpl-101" }));
                await client.waitFor((message) => message.method === "job");

                const staleShareReply = await client.request({
                    id: 21,
                    method: "submit",
                    params: {
                        id: loginReply.result.id,
                        job_id: loginReply.result.job.job_id,
                        nonce: "00000003",
                        result: encodeDiff(6000)
                    }
                });

                assert.equal(staleShareReply.error, null);
                await harness.waitFor(() => harness.primaryPool.submitRequests.length === 1);
                assert.equal(harness.primaryPool.submitRequests[0].params.job_id, "job-100");
            } finally {
                await client.close();
            }
        });
    });

    test("miners are failed over to the backup pool when the primary pool disconnects", async () => {
        await withHarness("miners are failed over to the backup pool when the primary pool disconnects", {
            backupTemplate: createTemplate({ height: 150, jobId: "job-backup", templateId: "tpl-backup", targetDiff: 7000 })
        }, async (harness) => {
            const client = new JsonLineClient(harness.minerPort);
            await client.connect();
            try {
                const loginReply = await client.request({
                    id: 30,
                    method: "login",
                    params: {
                        login: "wallet-d",
                        pass: "worker-d"
                    }
                });

                harness.primaryPool.destroyConnections();
                await harness.waitFor(() => {
                    const miner = harness.app.getState().worker.activeMiners.get(loginReply.result.id);
                    return miner && miner.pool === "localhost";
                });

                const newJobReply = await client.request({
                    id: 31,
                    method: "getjob",
                    params: { id: loginReply.result.id }
                });
                const submitReply = await client.request({
                    id: 32,
                    method: "submit",
                    params: {
                        id: loginReply.result.id,
                        job_id: newJobReply.result.job_id,
                        nonce: "00000004",
                        result: encodeDiff(8000)
                    }
                });

                assert.equal(submitReply.error, null);
                await harness.waitFor(() => harness.backupPool.submitRequests.length === 1);
                assert.equal(harness.backupPool.submitRequests[0].params.job_id, "job-backup");
            } finally {
                await client.close();
            }
        });
    });

    test("worker ignores disablePool for unknown pools without running failover", async () => {
        await withHarness("worker ignores disablePool for unknown pools without running failover", {}, async (harness) => {
            const worker = harness.app.getState().worker;
            let failoverChecks = 0;
            const originalCheckActivePools = worker.checkActivePools;
            worker.checkActivePools = () => {
                failoverChecks += 1;
            };

            try {
                worker.handleMasterMessage({ type: "disablePool", pool: "missing-pool.invalid" });
                worker.handleMasterMessage({ type: "enablePool", pool: "missing-pool.invalid" });
                assert.equal(failoverChecks, 0);
            } finally {
                worker.checkActivePools = originalCheckActivePools;
            }
        });
    });

    test("prototype-named miner methods are treated as unknown RPC methods", async () => {
        await withHarness("prototype-named miner methods are treated as unknown RPC methods", {}, async (harness) => {
            const client = new JsonLineClient(harness.minerPort);
            await client.connect();
            try {
                const reply = await client.request({
                    id: 35,
                    method: "constructor",
                    params: {}
                });

                assert.equal(reply.error.message, "Unknown method");
            } finally {
                await client.close();
            }
        });
    });

    test("malformed public traffic is logged once without a duplicate socket warning", async () => {
        await withHarness("malformed public traffic is logged once without a duplicate socket warning", {}, async (harness) => {
            for (let index = 0; index < 2; index += 1) {
                const socket = net.connect({ host: "127.0.0.1", port: harness.minerPort });
                await once(socket, "connect");
                socket.write("not-json\nalso-not-json\n");
                await once(socket, "close");
            }

            const badJsonLogs = harness.loggerLines.filter((line) => line.includes("WRN worker miner.bad_json"));
            assert.equal(badJsonLogs.length, 1);
            assert.doesNotMatch(harness.getLogOutput(), /miner\.socket_error.*Malformed miner JSON/);
        });
    });

    test("access control reloads from disk and rejects unauthorized miners", async () => {
        await withHarness("access control reloads from disk and rejects unauthorized miners", {
            accessControlEnabled: true,
            accessEntries: { "wallet-ok": "secret" }
        }, async (harness) => {
            const deniedClient = new JsonLineClient(harness.minerPort);
            await deniedClient.connect();
            try {
                const deniedReply = await deniedClient.request({
                    id: 40,
                    method: "login",
                    params: {
                        login: "wallet-denied",
                        pass: "wrong"
                    }
                });

                assert.equal(deniedReply.error.message, "Unauthorized access");

                await fs.writeFile(harness.accessControlPath, JSON.stringify({ "wallet-denied": "wrong" }, null, 2));
                const acceptedClient = new JsonLineClient(harness.minerPort);
                await acceptedClient.connect();
                try {
                    const acceptedReply = await acceptedClient.request({
                        id: 41,
                        method: "login",
                        params: {
                            login: "wallet-denied",
                            pass: "wrong"
                        }
                    });

                    assert.equal(acceptedReply.error, null);
                    assert.equal(acceptedReply.result.status, "OK");
                } finally {
                    await acceptedClient.close();
                }
            } finally {
                await deniedClient.close();
            }
        });
    });

    test("disconnected miners are removed from master stats immediately", async () => {
        await withHarness("disconnected miners are removed from master stats immediately", {}, async (harness) => {
            const client = new JsonLineClient(harness.minerPort);
            await client.connect();
            try {
                const loginReply = await client.request({
                    id: 45,
                    method: "login",
                    params: {
                        login: "wallet-drop",
                        pass: "worker-drop"
                    }
                });

                assert.equal(loginReply.error, null);
                await harness.waitFor(() => harness.app.getState().master.workers.get("standalone")?.stats.size === 1);

                await client.close();
                await harness.waitFor(() => harness.app.getState().master.workers.get("standalone")?.stats.size === 0);
            } finally {
                await client.close();
            }
        });
    });

    test("http monitor enforces basic auth and exposes live json state", async () => {
        await withHarness("http monitor enforces basic auth and exposes live json state", {
            httpEnable: true,
            httpUser: "admin",
            httpPass: "secret"
        }, async (harness) => {
            const client = new JsonLineClient(harness.minerPort);
            await client.connect();
            try {
                const loginReply = await client.request({
                    id: 50,
                    method: "login",
                    params: {
                        login: "wallet-monitor",
                        pass: "worker-monitor"
                    }
                });

                assert.equal(loginReply.error, null);
                await harness.waitFor(() => harness.monitorPort !== null);

                const denied = await harness.httpRequest({ port: harness.monitorPort, pathName: "/json" });
                assert.equal(denied.statusCode, 401);

                const authHeader = `Basic ${Buffer.from("admin:secret").toString("base64")}`;
                const rawJsonResponse = await harness.httpRequest({
                    port: harness.monitorPort,
                    pathName: "/json",
                    headers: { Authorization: authHeader }
                });
                const snapshotResponse = await harness.httpRequest({
                    port: harness.monitorPort,
                    pathName: "/snapshot",
                    headers: { Authorization: authHeader }
                });
                const htmlResponse = await harness.httpRequest({
                    port: harness.monitorPort,
                    pathName: "/",
                    headers: { Authorization: authHeader }
                });

                assert.equal(rawJsonResponse.statusCode, 200);
                assert.equal(snapshotResponse.statusCode, 200);
                assert.equal(htmlResponse.statusCode, 200);

                const rawState = JSON.parse(rawJsonResponse.body);
                const snapshot = JSON.parse(snapshotResponse.body);
                assert.ok(rawState.standalone);
                assert.equal(rawState.standalone[loginReply.result.id].id, loginReply.result.id);
                assert.equal(snapshot.totalMiners, 1);
                assert.equal(snapshot.miners[0].id, loginReply.result.id);
                assert.match(htmlResponse.body, /worker-monitor/);
                assert.match(htmlResponse.body, /theme-toggle/);
                assert.match(htmlResponse.body, /data-sort-type="number"/);
            } finally {
                await client.close();
            }
        });
    });
});
