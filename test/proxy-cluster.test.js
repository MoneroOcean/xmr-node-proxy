"use strict";

const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { once } = require("node:events");

const {
    FakePool,
    JsonLineClient,
    createTemplate,
    waitFor
} = require("./harness");

async function getFreePort() {
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
}

async function listChildPids(parentPid) {
    return new Promise((resolve, reject) => {
        cp.execFile("ps", ["-o", "pid=", "--ppid", String(parentPid)], (error, stdout) => {
            if (error) {
                reject(error);
                return;
            }

            const pids = stdout
                .split("\n")
                .map((line) => Number.parseInt(line.trim(), 10))
                .filter((value) => Number.isInteger(value));
            resolve(pids);
        });
    });
}

async function writeTestCoinModule(tempDir) {
    const fakeCoinPath = path.resolve(__dirname, "fake-coin.js");
    await fs.writeFile(
        path.join(tempDir, "test.js"),
        `module.exports = require(${JSON.stringify(fakeCoinPath)}).createFakeCoin;\n`
    );
}

function collectLines(stream, lines) {
    stream.setEncoding("utf8");
    let buffer = "";
    stream.on("data", (chunk) => {
        buffer += chunk;
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            if (line) lines.push(line);
            newlineIndex = buffer.indexOf("\n");
        }
    });
}

function createClusterConfig({ minerPort, primaryPoolPort, listeningDiff }) {
    return {
        pools: [
            {
                hostname: "127.0.0.1",
                port: primaryPoolPort,
                ssl: false,
                allowSelfSignedSSL: false,
                share: 100,
                username: "wallet-primary",
                password: "proxy",
                keepAlive: true,
                coin: "test",
                algo: "test/algo",
                algo_perf: { "test/algo": 1 },
                blob_type: 0,
                default: true
            }
        ],
        listeningPorts: [
            {
                port: minerPort,
                ssl: false,
                diff: listeningDiff,
                coin: "test"
            }
        ],
        bindAddress: "127.0.0.1",
        developerShare: 0,
        httpEnable: false,
        coinSettings: {
            test: {
                minDiff: 1,
                maxDiff: 100000,
                shareTargetTime: 30
            }
        }
    };
}

function spawnClusterProxy({ configPath, coinDir }) {
    const lines = [];
    const child = cp.spawn(process.execPath, ["proxy.js", "--workers", "1", "--config", configPath], {
        cwd: path.resolve(__dirname, ".."),
        env: {
            ...process.env,
            XNP_COIN_FACTORY_DIR: coinDir,
            XNP_LOG_TIME: "0"
        },
        stdio: ["ignore", "pipe", "pipe"]
    });

    collectLines(child.stdout, lines);
    collectLines(child.stderr, lines);

    async function waitForLine(pattern, timeoutMs = 7_000) {
        await waitFor(() => lines.some((line) => pattern.test(line)), timeoutMs);
    }

    async function stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        await once(child, "exit");
    }

    return { child, lines, stop, waitForLine };
}

test.describe("xmr-node-proxy clustered runtime", { concurrency: false }, () => {
    test("cluster mode respawns crashed workers and keeps serving miners", async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xnp-cluster-"));
        const minerPort = await getFreePort();
        const primaryPool = new FakePool(createTemplate(), { hostname: "127.0.0.1" });
        await primaryPool.start();
        await writeTestCoinModule(tempDir);

        const configPath = path.join(tempDir, "config.json");
        await fs.writeFile(configPath, JSON.stringify(createClusterConfig({
            minerPort,
            primaryPoolPort: primaryPool.port,
            listeningDiff: 100
        }), null, 2));

        const proxy = spawnClusterProxy({ configPath, coinDir: tempDir });

        try {
            await waitFor(() => primaryPool.loginRequests.length > 0);
            await proxy.waitForLine(new RegExp(`listen.ready .*port=${minerPort} .*coin=test`));

            const firstClient = new JsonLineClient(minerPort);
            await firstClient.connect();
            const firstReply = await firstClient.request({
                id: 1,
                method: "login",
                params: {
                    login: "wallet-a",
                    pass: "worker-a"
                }
            });
            assert.equal(firstReply.error, null);
            await firstClient.close();

            const [workerPid] = await listChildPids(proxy.child.pid);
            assert.ok(workerPid > 0);
            process.kill(workerPid, "SIGKILL");

            await proxy.waitForLine(/cluster\.worker_exit/);
            await waitFor(async () => {
                const childPids = await listChildPids(proxy.child.pid);
                return childPids.length === 1 && childPids[0] !== workerPid;
            }, 7_000);
            await waitFor(() => proxy.lines.filter((line) => new RegExp(`listen.ready .*port=${minerPort} .*coin=test`).test(line)).length >= 2, 7_000);

            const secondClient = new JsonLineClient(minerPort);
            await secondClient.connect();
            const secondReply = await secondClient.request({
                id: 2,
                method: "login",
                params: {
                    login: "wallet-b",
                    pass: "worker-b"
                }
            });
            assert.equal(secondReply.error, null);
            await secondClient.close();
        } finally {
            await proxy.stop();
            await primaryPool.stop();
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    test("cluster mode reloads config on SIGHUP", async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xnp-reload-"));
        const minerPort = await getFreePort();
        const primaryPool = new FakePool(createTemplate({ jobId: "job-a", templateId: "tpl-a" }), { hostname: "127.0.0.1" });
        const backupPool = new FakePool(createTemplate({ jobId: "job-b", templateId: "tpl-b" }), { hostname: "127.0.0.1" });
        await primaryPool.start();
        await backupPool.start();
        await writeTestCoinModule(tempDir);

        const configPath = path.join(tempDir, "config.json");
        await fs.writeFile(configPath, JSON.stringify(createClusterConfig({
            minerPort,
            primaryPoolPort: primaryPool.port,
            listeningDiff: 100
        }), null, 2));

        const proxy = spawnClusterProxy({ configPath, coinDir: tempDir });

        try {
            await waitFor(() => primaryPool.loginRequests.length > 0);
            await proxy.waitForLine(new RegExp(`listen.ready .*port=${minerPort} .*coin=test`));

            const firstClient = new JsonLineClient(minerPort);
            await firstClient.connect();
            const firstReply = await firstClient.request({
                id: 10,
                method: "login",
                params: {
                    login: "wallet-before",
                    pass: "worker-before"
                }
            });
            assert.equal(firstReply.result.job.target, "100");
            await firstClient.close();

            await fs.writeFile(configPath, JSON.stringify(createClusterConfig({
                minerPort,
                primaryPoolPort: backupPool.port,
                listeningDiff: 250
            }), null, 2));

            proxy.child.kill("SIGHUP");
            await proxy.waitForLine(/config\.reload_complete/);
            await waitFor(() => backupPool.loginRequests.length > 0, 7_000);
            await waitFor(() => proxy.lines.filter((line) => new RegExp(`listen.ready .*port=${minerPort} .*coin=test`).test(line)).length >= 2, 7_000);

            const secondClient = new JsonLineClient(minerPort);
            await secondClient.connect();
            const secondReply = await secondClient.request({
                id: 11,
                method: "login",
                params: {
                    login: "wallet-after",
                    pass: "worker-after"
                }
            });
            assert.equal(secondReply.result.job.target, "250");
            await secondClient.close();
        } finally {
            await proxy.stop();
            await backupPool.stop();
            await primaryPool.stop();
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });
});
