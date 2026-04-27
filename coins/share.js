"use strict";

const powHash = require("node-powhash");

const { bufferToBigIntLE } = require("../proxy/common");

const BASE_DIFF = (1n << 256n) - 1n;
const MAX_VERIFIED_SHARES_PER_SECOND = 10;
const VERIFIED_SHARE_WINDOW_SECONDS = 5;

function createShareProcessor(options) {
    const {
        blobTypeGrin,
        constructNewBlob,
        convertBlob,
        hashFunc,
        hashFuncC29,
        normalizeDifficulty
    } = options;

    let verifiedWindowStartedAt = 0;
    let verifiedShareCount = 0;
    const poolShareStats = new Map();
    const logIfAvailable = (log, message, meta) => {
        if (typeof log === "function") log(message, meta);
    };
    function hashBufferDiff(hashBuffer) {
        const value = bufferToBigIntLE(hashBuffer);
        if (value === 0n) return BASE_DIFF;
        return BASE_DIFF / value;
    }

    function shouldVerifyShare() {
        const now = Date.now();
        const windowDurationMs = VERIFIED_SHARE_WINDOW_SECONDS * 1000;
        if (!verifiedWindowStartedAt || (now - verifiedWindowStartedAt) > windowDurationMs) {
            verifiedWindowStartedAt = now;
            verifiedShareCount = 0;
        }
        verifiedShareCount += 1;
        return verifiedShareCount <= MAX_VERIFIED_SHARES_PER_SECOND * VERIFIED_SHARE_WINDOW_SECONDS;
    }

    function recordPoolShare(poolName, targetDiff, log) {
        const state = poolShareStats.get(poolName) || {
            count: 0,
            lastDiff: targetDiff,
            startedAt: 0
        };
        const now = Date.now();
        const shouldReset = shouldResetPoolShareWindow(state, now, targetDiff);
        if (shouldReset) {
            logIfAvailable(log, "share.upstream", poolShareLogMeta(poolName, state, targetDiff));
            state.startedAt = now;
            state.count = 1;
            state.lastDiff = targetDiff;
        } else {
            state.count += 1;
        }
        poolShareStats.set(poolName, state);
    }
    function poolShareLogMeta(poolName, state, targetDiff) {
        if (state.count > 0) return { pool: poolName, diff: state.lastDiff, count: state.count };
        return { pool: poolName, diff: targetDiff, count: 1 };
    }
    function shouldResetPoolShareWindow(state, now, targetDiff) {
        if (!state.startedAt) return true;
        if ((now - state.startedAt) > 30_000) return true;
        return state.lastDiff !== targetDiff;
    }
    function prepareTemplate(blockTemplate, job) {
        const template = Buffer.alloc(blockTemplate.buffer.length);
        blockTemplate.buffer.copy(template);
        template.writeUInt32BE(job.extraNonce, blockTemplate.solo ? blockTemplate.reservedOffset : blockTemplate.workerOffset);
        return template;
    }
    function grinHeader(template, nonce, blobTypeNum, pow) {
        const nonceBuffer = Buffer.from(Number(nonce).toString(16).padStart(8, "0"), "hex");
        const shareBuffer = constructNewBlob(template, Buffer.from(nonceBuffer).reverse(), blobTypeNum, pow);
        return Buffer.concat([convertBlob(shareBuffer, blobTypeNum), nonceBuffer]);
    }
    function verifyPoolShare({ template, blockTemplate, blobTypeNum, nonce, params, miner, warn }) {
        if (blobTypeGrin(blobTypeNum)) {
            return !hashFuncC29(blockTemplate.algo, grinHeader(template, nonce, blobTypeNum, params.pow), params.pow);
        }
        if (shouldVerifyShare()) {
            const shareBuffer = constructNewBlob(template, Buffer.from(nonce, "hex"), blobTypeNum);
            const hash = hashFunc(convertBlob(shareBuffer, blobTypeNum), blockTemplate);
            return hash.toString("hex") === params.result;
        }
        // Cap expensive local verification work so bursty block candidates
        // cannot turn the proxy into a hashing bottleneck.
        logIfAvailable(warn, "share.verify_throttled", { miner: miner.logString });
        return true;
    }
    function submitPoolShare(miner, job, blockTemplate, params, onPoolShare) {
        miner.blocks += 1;
        if (typeof onPoolShare !== "function") return;
        onPoolShare({
            btID: blockTemplate.id,
            nonce: params.nonce,
            pow: params.pow,
            resultHash: params.result,
            workerNonce: job.extraNonce
        });
    }
    function processShare(miner, job, blockTemplate, params, hooks = {}) {
        const { onPoolShare = null, warn = null, info = null } = hooks;
        const blobTypeNum = job.blob_type;
        const nonce = params.nonce;
        const poolTargetDiff = BigInt(normalizeDifficulty(blockTemplate.targetDiff, blockTemplate.difficulty));
        const minerTargetDiff = BigInt(normalizeDifficulty(job.difficulty));
        try {
            return processShareBody({ miner, job, blockTemplate, params, blobTypeNum, nonce, poolTargetDiff, minerTargetDiff, onPoolShare, warn, info });
        } catch (error) {
            logIfAvailable(warn, "share.process_failed", { miner: miner.logString, error: error.message });
            return false;
        }
    }
    function processShareBody(context) {
        const template = prepareTemplate(context.blockTemplate, context.job);
        // This proxy is designed for operator-controlled miner fleets. Normal
        // miner-diff accounting intentionally trusts the miner-reported result
        // so per-share CPU cost stays low; this layer is not a zero-trust public
        // pool edge that fully recomputes every share hash before acceptance.
        const resultBuffer = shareResultBuffer(context.blobTypeNum, context.params);
        const hashDiff = hashBufferDiff(resultBuffer);
        if (hashDiff >= context.poolTargetDiff) return acceptPoolDifficultyShare({ ...context, template });
        if (hashDiff < context.minerTargetDiff) return rejectLowDiffShare(context.miner, hashDiff, context.warn);
        context.miner.shares += 1;
        context.miner.hashes += normalizeDifficulty(context.job.difficulty);
        return true;
    }
    function shareResultBuffer(blobTypeNum, params) {
        if (blobTypeGrin(blobTypeNum)) return powHash.c29_cycle_hash(params.pow);
        return Buffer.from(params.result, "hex");
    }
    function acceptPoolDifficultyShare(context) {
        const verified = verifyPoolShare(context);
        if (!verified) {
            logIfAvailable(context.warn, "share.invalid_hash", { miner: context.miner.logString });
            return false;
        }
        submitPoolShare(context.miner, context.job, context.blockTemplate, context.params, context.onPoolShare);
        recordPoolShare(context.miner.pool, Number(context.poolTargetDiff), context.info);
        context.miner.shares += 1;
        context.miner.hashes += normalizeDifficulty(context.job.difficulty);
        return true;
    }
    function rejectLowDiffShare(miner, hashDiff, warn) {
        logIfAvailable(warn, "share.low_diff", { miner: miner.logString, diff: hashDiff.toString() });
        return false;
    }
    return { processShare };
}
module.exports = {
    createShareProcessor
};
