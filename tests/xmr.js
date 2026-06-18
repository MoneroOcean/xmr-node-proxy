"use strict";

const assert = require("node:assert/strict");
const powHash = require("node-powhash");
const test = require("node:test");

const createCoins = require("../coins/core");
const { createTemplateTools } = require("../coins/template");
const { CircularBuffer } = require("../proxy/common");
const { MinerProtocol } = require("../proxy/miner");
const { createRavenTemplateBlob } = require("./common/harness");

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

    test("processShare verifies KawPoW mixhash before forwarding pool shares", () => {
        const coins = createCoins({
            instanceId: Buffer.from([1, 2, 3])
        });
        const miner = {
            blocks: 0,
            shares: 0,
            hashes: 0,
            logString: "kawpow-miner",
            pool: "rvn-pool"
        };
        const job = {
            blob_type: coins.parseBlobType("raven"),
            extraNonce: 0,
            difficulty: 1
        };
        const blocktemplateBlob = createRavenTemplateBlob();
        const template = new coins.MasterBlockTemplate(createProxyTemplate({
            algo: "kawpow",
            blob_type: "raven",
            blocktemplate_blob: blocktemplateBlob,
            difficulty: 1,
            height: 0,
            id: "kawpow-template",
            job_id: "kawpow-job",
            reserved_offset: 0,
            target_diff: 1
        }));
        const nonce = "000000000000059b";
        const [result, mixhash] = powHash.kawpow_light(coins.convertBlob(template.buffer, template.blob_type), Buffer.from(nonce, "hex"), template.height);
        const goodShare = {
            nonce,
            mixhash: mixhash.toString("hex"),
            result: result.toString("hex")
        };
        const forwarded = [];

        const accepted = coins.processShare(miner, job, template, goodShare, {
            onPoolShare(data) {
                forwarded.push(data);
            }
        });

        assert.equal(accepted, true);
        assert.equal(miner.blocks, 1);
        assert.equal(forwarded.length, 1);
        assert.deepEqual(forwarded[0], {
            btID: undefined,
            mixhash: goodShare.mixhash,
            nonce: goodShare.nonce,
            pow: undefined,
            resultHash: goodShare.result,
            workerNonce: job.extraNonce
        });
        assert.equal(
            powHash.kawpow_light(
                coins.convertBlob(template.buffer, template.blob_type),
                Buffer.from(goodShare.nonce, "hex"),
                template.height
            )[0].toString("hex"),
            goodShare.result
        );

        const rejected = coins.processShare(miner, job, template, {
            ...goodShare,
            mixhash: "11".repeat(32)
        });

        assert.equal(rejected, false);
        assert.equal(forwarded.length, 1);
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

    test("acceptNonce caps the per-job submissions list to bound memory and CPU", () => {
        const warnings = [];
        const protocol = new MinerProtocol({
            logger: { warn: (event, meta) => warnings.push({ event, meta }) }
        });
        const miner = {
            logString: "test-miner",
            coins: { blobTypeGrin: () => false, nonceSize: () => 4 }
        };
        const job = { blob_type: 0, job_id: "job-cap", submissions: [] };

        // Distinct, well-formed nonces are accepted only up to the cap.
        let accepted = 0;
        let rejected = 0;
        for (let i = 0; i < 10050; i += 1) {
            const nonce = i.toString(16).padStart(8, "0");
            const ok = protocol.acceptNonce(miner, job, { job_id: "job-cap", nonce }, () => {});
            if (ok) accepted += 1;
            else rejected += 1;
        }

        assert.equal(job.submissions.length, 10000);
        assert.equal(accepted, 10000);
        assert.equal(rejected, 50);
        assert.ok(warnings.some((entry) => entry.event === "share.submission_cap"));

        // A previously-seen nonce is still reported as a duplicate, not a cap hit.
        const duplicateReplies = [];
        const dupOk = protocol.acceptNonce(miner, job, { job_id: "job-cap", nonce: "00000000" }, (msg) => duplicateReplies.push(msg));
        assert.equal(dupOk, false);
        assert.deepEqual(duplicateReplies, ["Duplicate share"]);
    });
});
