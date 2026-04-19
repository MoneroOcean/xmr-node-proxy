"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { AccessControl, createLogger } = require("../proxy-common");

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
