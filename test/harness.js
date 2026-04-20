"use strict";

const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");

const { createStandaloneApp } = require("../proxy");
const createFakeCoins = require("./fake-coins");

function createTemplate(options = {}) {
    const height = options.height ?? 100;
    const targetDiff = options.targetDiff ?? 5000;
    const jobId = options.jobId || `job-${height}`;
    const templateId = options.templateId || `tpl-${height}`;

    return {
        id: templateId,
        job_id: jobId,
        blocktemplate_blob: `${(height % 255).toString(16).padStart(2, "0")}${"11".repeat(20)}`,
        blob_type: 0,
        difficulty: targetDiff,
        height,
        seed_hash: "00".repeat(32),
        reserved_offset: 0,
        client_nonce_offset: 4,
        client_pool_offset: 8,
        target_diff: targetDiff,
        target_diff_hex: targetDiff.toString(16),
        algo: "test/algo"
    };
}

class FakePool {
    constructor(template, options = {}) {
        this.template = template;
        this.hostname = options.hostname || "127.0.0.1";
        this.server = null;
        this.sockets = new Set();
        this.loginRequests = [];
        this.getjobRequests = [];
        this.submitRequests = [];
        this.keepaliveRequests = [];
    }

    async start() {
        this.server = net.createServer((socket) => this.handleSocket(socket));
        this.server.listen(0, this.hostname);
        await once(this.server, "listening");
    }

    get port() {
        return this.server.address().port;
    }

    async stop() {
        for (const socket of this.sockets) socket.destroy();
        if (!this.server) return;
        await new Promise((resolve) => this.server.close(resolve));
        this.server = null;
    }

    destroyConnections() {
        for (const socket of this.sockets) {
            socket.destroy();
        }
    }

    pushTemplate(template) {
        this.template = template;
        const payload = JSON.stringify({ method: "job", params: template }) + "\n";
        for (const socket of this.sockets) {
            if (socket.writable) socket.write(payload);
        }
    }

    handleSocket(socket) {
        this.sockets.add(socket);
        socket.setEncoding("utf8");
        let buffer = "";

        socket.on("data", (chunk) => {
            buffer += chunk;
            let newlineIndex = buffer.indexOf("\n");
            while (newlineIndex !== -1) {
                const line = buffer.slice(0, newlineIndex).trim();
                buffer = buffer.slice(newlineIndex + 1);
                if (line) this.handleLine(socket, JSON.parse(line));
                newlineIndex = buffer.indexOf("\n");
            }
        });

        socket.on("close", () => {
            this.sockets.delete(socket);
        });
    }

    handleLine(socket, message) {
        switch (message.method) {
        case "login":
            this.loginRequests.push(message);
            socket.write(`${JSON.stringify({
                id: message.id,
                error: null,
                result: {
                    id: "fake-session",
                    job: this.template
                }
            })}\n`);
            return;
        case "getjob":
            this.getjobRequests.push(message);
            socket.write(`${JSON.stringify({ id: message.id, error: null, result: null })}\n`);
            return;
        case "submit":
            this.submitRequests.push(message);
            socket.write(`${JSON.stringify({ id: message.id, error: null, result: { status: "OK" } })}\n`);
            return;
        case "keepalived":
            this.keepaliveRequests.push(message);
            return;
        default:
            socket.write(`${JSON.stringify({ id: message.id, error: { code: -1, message: "Unknown method" }, result: null })}\n`);
        }
    }
}

class JsonLineClient {
    constructor(port, host = "127.0.0.1") {
        this.port = port;
        this.host = host;
        this.socket = null;
        this.pending = new Map();
        this.pushes = [];
        this.waiters = [];
    }

    async connect() {
        this.socket = net.connect({ port: this.port, host: this.host });
        this.socket.setEncoding("utf8");
        await once(this.socket, "connect");

        let buffer = "";
        this.socket.on("data", (chunk) => {
            buffer += chunk;
            let newlineIndex = buffer.indexOf("\n");
            while (newlineIndex !== -1) {
                const line = buffer.slice(0, newlineIndex).trim();
                buffer = buffer.slice(newlineIndex + 1);
                if (line) this.handleMessage(JSON.parse(line));
                newlineIndex = buffer.indexOf("\n");
            }
        });
    }

    async close() {
        if (!this.socket) return;
        this.socket.destroy();
        this.socket = null;
    }

    request(payload) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(payload.id);
                reject(new Error(`Timed out waiting for reply to id ${payload.id}`));
            }, 2_000);
            this.pending.set(payload.id, { resolve, reject, timeout });
            this.socket.write(`${JSON.stringify(payload)}\n`);
        });
    }

    waitFor(predicate, timeoutMs = 2_000) {
        for (const push of this.pushes) {
            if (predicate(push)) return Promise.resolve(push);
        }
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.waiters = this.waiters.filter((waiter) => waiter.reject !== reject);
                reject(new Error("Timed out waiting for pushed message"));
            }, timeoutMs);
            this.waiters.push({
                predicate,
                resolve: (value) => {
                    clearTimeout(timeout);
                    resolve(value);
                },
                reject
            });
        });
    }

    handleMessage(message) {
        if (this.pending.has(message.id)) {
            const pending = this.pending.get(message.id);
            this.pending.delete(message.id);
            clearTimeout(pending.timeout);
            pending.resolve(message);
            return;
        }

        this.pushes.push(message);
        for (const waiter of [...this.waiters]) {
            if (!waiter.predicate(message)) continue;
            this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
            waiter.resolve(message);
        }
    }
}

async function waitFor(check, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Timed out waiting for condition");
}

function httpRequest({ port, pathName = "/", headers = {} }) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: "127.0.0.1",
            port,
            path: pathName,
            headers
        }, (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
                body += chunk;
            });
            response.on("end", () => {
                resolve({ statusCode: response.statusCode, body });
            });
        });
        request.on("error", reject);
        request.end();
    });
}

async function startHarness(options = {}) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xnp-test-"));
    const accessControlPath = path.join(tempDir, "access-control.json");
    const accessEntries = options.accessEntries || {};
    const primaryHost = "127.0.0.1";
    const backupHost = "localhost";
    await fs.writeFile(accessControlPath, JSON.stringify(accessEntries, null, 2));

    const primaryPool = new FakePool(options.primaryTemplate || createTemplate(), { hostname: primaryHost });
    await primaryPool.start();

    let backupPool = null;
    if (options.backupTemplate) {
        backupPool = new FakePool(options.backupTemplate, { hostname: backupHost });
        await backupPool.start();
    }

    const config = {
        pools: [
            {
                hostname: primaryHost,
                port: primaryPool.port,
                ssl: false,
                allowSelfSignedSSL: false,
                share: 100,
                username: "wallet-primary",
                password: "proxy",
                keepAlive: true,
                algo: "test/algo",
                algo_perf: { "test/algo": 1 },
                blob_type: 0,
                default: true
            }
        ],
        listeningPorts: [
            {
                port: 0,
                ssl: false,
                diff: options.listeningDiff || 100
            }
        ],
        bindAddress: primaryHost,
        developerShare: 0,
        accessControl: {
            enabled: options.accessControlEnabled === true,
            controlFile: accessControlPath
        },
        httpEnable: options.httpEnable === true,
        httpAddress: primaryHost,
        httpPort: options.httpEnable ? 0 : 8081,
        httpUser: options.httpUser || "",
        httpPass: options.httpPass || "",
        difficultySettings: {
            minDiff: 1,
            maxDiff: 100000,
            shareTargetTime: 30
        }
    };

    if (backupPool) {
        config.pools.push({
            hostname: backupHost,
            port: backupPool.port,
            ssl: false,
            allowSelfSignedSSL: false,
            share: 0,
            username: "wallet-backup",
            password: "proxy",
            keepAlive: true,
            algo: "test/algo",
            algo_perf: { "test/algo": 1 },
            blob_type: 0,
            default: false
        });
    }

    const app = createStandaloneApp(config, {
        configPath: path.join(tempDir, "config.json"),
        coinsFactory: createFakeCoins
    });
    app.start();

    await waitFor(() => primaryPool.loginRequests.length > 0);
    if (backupPool) {
        await waitFor(() => backupPool.loginRequests.length > 0);
    }

    const minerPort = app.getBoundPorts()[0].actualPort;
    let monitorPort = null;
    if (options.httpEnable) {
        await waitFor(() => app.getState().master.monitor.server?.address()?.port);
        monitorPort = app.getState().master.monitor.server.address().port;
    }

    return {
        accessControlPath,
        app,
        backupPool,
        httpRequest,
        minerPort,
        monitorPort,
        primaryPool,
        tempDir,
        waitFor,
        async stop() {
            await app.stop();
            if (backupPool) await backupPool.stop();
            await primaryPool.stop();
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    };
}

module.exports = {
    FakePool,
    JsonLineClient,
    createTemplate,
    httpRequest,
    startHarness,
    waitFor
};
