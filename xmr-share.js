"use strict";

const multiHashing = require("cryptonight-hashing");

const { bufferToBigIntLE } = require("./proxy-common");

const BASE_DIFF = (1n << 256n) - 1n;
const MAX_VERIFIED_SHARES_PER_SECOND = 10;
const VERIFIED_SHARE_WINDOW_SECONDS = 5;

function createXmrShareProcessor(options) {
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
        if (!state.startedAt || (now - state.startedAt) > 30_000 || state.lastDiff !== targetDiff) {
            if (state.count > 0 && typeof log === "function") {
                log("share.upstream", { pool: poolName, diff: state.lastDiff, count: state.count });
            } else if (typeof log === "function") {
                log("share.upstream", { pool: poolName, diff: targetDiff, count: 1 });
            }
            state.startedAt = now;
            state.count = 1;
            state.lastDiff = targetDiff;
        } else {
            state.count += 1;
        }
        poolShareStats.set(poolName, state);
    }

    function processShare(miner, job, blockTemplate, params, hooks = {}) {
        const { onPoolShare = null, warn = null, info = null } = hooks;
        const blobTypeNum = job.blob_type;
        const nonce = params.nonce;
        const poolTargetDiff = BigInt(normalizeDifficulty(blockTemplate.targetDiff, blockTemplate.difficulty));
        const minerTargetDiff = BigInt(normalizeDifficulty(job.difficulty));

        try {
            const template = Buffer.alloc(blockTemplate.buffer.length);
            blockTemplate.buffer.copy(template);
            if (blockTemplate.solo) {
                template.writeUInt32BE(job.extraNonce, blockTemplate.reservedOffset);
            } else {
                template.writeUInt32BE(job.extraNonce, blockTemplate.workerOffset);
            }

            // This proxy is designed for operator-controlled miner fleets. Normal
            // miner-diff accounting intentionally trusts the miner-reported result
            // so per-share CPU cost stays low; this layer is not a zero-trust public
            // pool edge that fully recomputes every share hash before acceptance.
            const resultBuffer = blobTypeGrin(blobTypeNum)
                ? multiHashing.c29_cycle_hash(params.pow)
                : Buffer.from(params.result, "hex");
            const hashDiff = hashBufferDiff(resultBuffer);

            if (hashDiff >= poolTargetDiff) {
                let verifyFailed = false;

                if (blobTypeGrin(blobTypeNum)) {
                    const shareBuffer = constructNewBlob(
                        template,
                        Buffer.from(Number(nonce).toString(16).padStart(8, "0"), "hex").reverse(),
                        blobTypeNum,
                        params.pow
                    );
                    const header = Buffer.concat([
                        convertBlob(shareBuffer, blobTypeNum),
                        Buffer.from(Number(nonce).toString(16).padStart(8, "0"), "hex")
                    ]);
                    if (hashFuncC29(blockTemplate.algo, header, params.pow)) {
                        verifyFailed = true;
                    }
                } else if (shouldVerifyShare()) {
                    const shareBuffer = constructNewBlob(template, Buffer.from(nonce, "hex"), blobTypeNum);
                    const convertedBlob = convertBlob(shareBuffer, blobTypeNum);
                    const hash = hashFunc(convertedBlob, blockTemplate);
                    if (hash.toString("hex") !== params.result) {
                        verifyFailed = true;
                    }
                } else if (typeof warn === "function") {
                    // Cap expensive local verification work so bursty block candidates
                    // cannot turn the proxy into a hashing bottleneck.
                    warn("share.verify_throttled", { miner: miner.logString });
                }

                if (verifyFailed) {
                    if (typeof warn === "function") warn("share.invalid_hash", { miner: miner.logString });
                    return false;
                }

                miner.blocks += 1;
                if (typeof onPoolShare === "function") {
                    onPoolShare({
                        btID: blockTemplate.id,
                        nonce,
                        pow: params.pow,
                        resultHash: params.result,
                        workerNonce: job.extraNonce
                    });
                }
                recordPoolShare(miner.pool, Number(poolTargetDiff), info);
            } else if (hashDiff < minerTargetDiff) {
                if (typeof warn === "function") {
                    warn("share.low_diff", {
                        miner: miner.logString,
                        diff: hashDiff.toString()
                    });
                }
                return false;
            }

            miner.shares += 1;
            miner.hashes += normalizeDifficulty(job.difficulty);
            return true;
        } catch (error) {
            if (typeof warn === "function") {
                warn("share.process_failed", {
                    miner: miner.logString,
                    error: error.message
                });
            }
            return false;
        }
    }

    return { processShare };
}

module.exports = {
    createXmrShareProcessor
};
