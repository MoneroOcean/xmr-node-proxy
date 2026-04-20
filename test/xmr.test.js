"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const createCoins = require("../coins/core");

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
