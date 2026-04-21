"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const test = require("node:test");

const {
    JsonLineClient,
    createTemplate,
    startHarness
} = require("./common/harness");

function encodeDiff(value) {
    return value.toString(16);
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
