"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { AccessControl, createLogger, normalizeConfig } = require("../proxy/common");

test("createLogger can omit timestamps when requested", () => {
    const lines = [];
    const originalLog = console.log;
    console.log = (line) => lines.push(line);

    try {
        const logger = createLogger({
            component: "test",
            timestamps: false
        });
        logger.info("proxy.start", { mode: "standalone" });
    } finally {
        console.log = originalLog;
    }

    assert.deepEqual(lines, [
        "INF test proxy.start mode=standalone"
    ]);
});

test("AccessControl does not reread an unchanged file on denied login", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xnp-access-"));
    const controlFile = path.join(tempDir, "accessControl.json");
    fs.writeFileSync(controlFile, JSON.stringify({ "wallet-ok": "secret" }, null, 2));

    const accessControl = new AccessControl({
        accessControl: {
            enabled: true,
            controlFile
        }
    });

    let readCount = 0;
    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = (...args) => {
        if (args[0] === controlFile) readCount += 1;
        return originalReadFileSync(...args);
    };

    try {
        assert.equal(accessControl.isAllowed("wallet-ok", "secret"), true);
        const readsAfterInitialLoad = readCount;

        assert.equal(accessControl.isAllowed("wallet-miss", "wrong"), false);
        assert.equal(readCount, readsAfterInitialLoad);
    } finally {
        fs.readFileSync = originalReadFileSync;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("AccessControl still reloads immediately when the file changes", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xnp-access-"));
    const controlFile = path.join(tempDir, "accessControl.json");
    fs.writeFileSync(controlFile, JSON.stringify({ "wallet-ok": "secret" }, null, 2));

    const accessControl = new AccessControl({
        accessControl: {
            enabled: true,
            controlFile
        }
    });

    try {
        assert.equal(accessControl.isAllowed("wallet-denied", "wrong"), false);

        fs.writeFileSync(controlFile, JSON.stringify({ "wallet-denied": "wrong" }, null, 2));
        const bumpedTime = new Date(Date.now() + 2_000);
        fs.utimesSync(controlFile, bumpedTime, bumpedTime);

        assert.equal(accessControl.isAllowed("wallet-denied", "wrong"), true);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("normalizeConfig applies flat difficultySettings", () => {
    const config = normalizeConfig({
        pools: [
            {
                hostname: "pool.example.com",
                port: 3333,
                default: true
            }
        ],
        listeningPorts: [
            {
                port: 4444,
                diff: 100
            }
        ],
        difficultySettings: {
            minDiff: 2,
            maxDiff: 2000,
            shareTargetTime: 45
        }
    }, path.join(os.tmpdir(), "config.json"));

    assert.deepEqual(config.difficultySettings, {
        minDiff: 2,
        maxDiff: 2000,
        shareTargetTime: 45
    });
});

test("normalizeConfig accepts pool algo-min-time and normalizes it to algo_min_time", () => {
    const config = normalizeConfig({
        pools: [
            { hostname: "pool.example.com", port: 3333, default: true, "algo-min-time": 1 }
        ],
        listeningPorts: [
            { port: 4444, diff: 100 }
        ]
    }, path.join(os.tmpdir(), "config.json"));

    assert.equal(config.pools[0].algo_min_time, 1);
    assert.equal("algo-min-time" in config.pools[0], false);
});

test("normalizeConfig rejects legacy coinSettings with an upgrade message", () => {
    assert.throws(() => normalizeConfig({
        pools: [
            {
                hostname: "pool.example.com",
                port: 3333,
                default: true
            }
        ],
        listeningPorts: [
            {
                port: 4444,
                diff: 100
            }
        ],
        coinSettings: {
            xmr: {
                minDiff: 2,
                maxDiff: 2000,
                shareTargetTime: 45
            }
        }
    }, path.join(os.tmpdir(), "config.json")), /rename it to difficultySettings and update your config/);
});
