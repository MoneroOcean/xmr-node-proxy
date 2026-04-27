"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const createCoins = require("../coins/core");
const { createTemplateTools } = require("../coins/template");
const { CircularBuffer } = require("../proxy/common");

function createProxyTemplate(overrides = {}) {
    return {
        blocktemplate_blob: Buffer.alloc(160).toString("hex"),
        blob_type: "cryptonote_arq",
        algo: "rx/arq",
        difficulty: 470000086,
        height: 1925616,
        seed_hash: "00".repeat(32),
        reserved_offset: 16,
        target_diff: 123644.73151102096,
        job_id: "job-live",
        id: "template-live",
        ...overrides
    };
}

test.describe("xmr-node-proxy coin helpers", { concurrency: false }, () => {
    test("MasterBlockTemplate normalizes floating upstream pool target difficulty", () => {
        const coins = createCoins({
            instanceId: Buffer.from([1, 2, 3])
        });

        const template = new coins.MasterBlockTemplate(createProxyTemplate());

        assert.equal(template.difficulty, 470000086);
        assert.equal(template.targetDiff, 123644);
        assert.match(template.targetHex, /^[0-9a-f]{8}$/);
    });

    test("processShare handles floating pool target difficulty without throwing", () => {
        const coins = createCoins({
            instanceId: Buffer.from([1, 2, 3])
        });
        const warnings = [];
        const miner = {
            blocks: 0,
            shares: 0,
            hashes: 0,
            logString: "test-miner",
            pool: "live-mo"
        };
        const job = {
            blob_type: coins.parseBlobType("cryptonote_arq"),
            extraNonce: 1,
            difficulty: 2
        };
        const template = new coins.MasterBlockTemplate(createProxyTemplate());

        const accepted = coins.processShare(miner, job, template, {
            nonce: "00000000",
            result: "ff".repeat(32)
        }, {
            warn(message) {
                warnings.push(message);
            }
        });

        assert.equal(accepted, false);
        assert.equal(warnings.some((message) => message === "share.low_diff"), true);
    });

    test("parseBlobType handles non-string objects without prototype lookups", () => {
        const coins = createCoins({
            instanceId: Buffer.from([1, 2, 3])
        });

        assert.equal(coins.parseBlobType("cryptonote_arq"), 16);
        assert.equal(coins.parseBlobType(104), 104);
        assert.equal(coins.parseBlobType({ toString: () => "cryptonote_arq" }), 0);
        assert.equal(coins.parseBlobType("toString"), 0);
    });

    test("getJob preserves explicit algo for non-grin miners on grin blob types", () => {
        const tools = createTemplateTools({
            blobTypeGrin: () => true,
            c29ProofSize: () => 32,
            convertBlob: (buffer) => Buffer.from(buffer),
            nonceSize: () => 4,
            parseBlobType: () => 8
        });
        const template = new tools.BlockTemplate({
            id: "template-grin",
            blocktemplate_blob: Buffer.alloc(80).toString("hex"),
            blob_type: "cuckaroo",
            algo: "rx/test",
            difficulty: 100,
            height: 12,
            reserved_offset: 0,
            seed_hash: "00".repeat(32),
            target_diff: 100,
            worker_offset: 4
        });
        const miner = {
            cachedJob: null,
            difficulty: 10,
            id: "miner-default",
            newDiff: null,
            protocol: "default",
            validJobs: new CircularBuffer(5)
        };
        const grinMiner = {
            ...miner,
            cachedJob: null,
            id: "miner-grin",
            protocol: "grin",
            validJobs: new CircularBuffer(5)
        };

        assert.equal(tools.getJob(miner, template, true).algo, "rx/test");
        assert.equal(tools.getJob(grinMiner, template, true).algo, "cuckaroo");
    });
});
