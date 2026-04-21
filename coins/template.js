"use strict";

const {
    CircularBuffer,
    bigIntToBufferBE,
    randomId
} = require("../proxy/common");
const BASE_DIFF = (1n << 256n) - 1n;

function normalizeDifficulty(value, fallback = 1) {
    // Some upstreams expose difficulty-like fields as floats or numeric strings
    // such as target_diff. Normalize once here so the rest of the coins logic can
    // safely use integer math and BigInt conversions.
    const numericValue = Number(value);
    if (Number.isFinite(numericValue) && numericValue > 0) {
        return Math.max(1, Math.floor(numericValue));
    }

    const fallbackValue = Number(fallback);
    if (Number.isFinite(fallbackValue) && fallbackValue > 0) {
        return Math.max(1, Math.floor(fallbackValue));
    }

    return 1;
}

function getTargetHex(difficulty, size) {
    const diff = BigInt(normalizeDifficulty(difficulty));
    const diffBuffer = bigIntToBufferBE(BASE_DIFF / diff, 32);
    return Buffer.from(diffBuffer.subarray(0, size)).reverse().toString("hex");
}

function createTemplateTools(options = {}) {
    const {
        blobTypeGrin,
        c29ProofSize,
        instanceId = Buffer.from([0, 0, 0]),
        convertBlob,
        nonceSize,
        parseBlobType
    } = options;

    // Worker templates are miner-facing snapshots. They track the worker nonce lane
    // and cache enough data to rebuild a submitted share locally.
    class WorkerBlockTemplate {
        constructor(template) {
            this.id = template.id;
            this.blob = template.blocktemplate_blob;
            this.blocktemplate_blob = template.blocktemplate_blob;
            this.blob_type = parseBlobType(template.blob_type);
            this.coin = template.coin;
            this.variant = template.variant;
            this.algo = template.algo;
            this.difficulty = normalizeDifficulty(template.difficulty);
            this.height = template.height;
            this.seed_hash = template.seed_hash;
            this.reservedOffset = template.reserved_offset;
            this.workerOffset = template.worker_offset;
            this.targetDiff = normalizeDifficulty(template.target_diff, this.difficulty);
            this.targetHex = template.target_diff_hex || getTargetHex(this.targetDiff, nonceSize(this.blob_type));
            this.buffer = Buffer.from(this.blob, "hex");
            this.previousHash = Buffer.alloc(32);
            this.workerNonce = 0;
            this.solo = false;

            if (this.workerOffset === undefined) {
                this.solo = true;
                instanceId.copy(this.buffer, this.reservedOffset + 4, 0, 3);
                this.buffer.copy(this.previousHash, 0, 7, 39);
            }
        }

        nextBlob() {
            if (this.solo) {
                this.buffer.writeUInt32BE(++this.workerNonce, this.reservedOffset);
            } else {
                this.buffer.writeUInt32BE(++this.workerNonce, this.workerOffset);
            }
            return convertBlob(this.buffer, this.blob_type).toString("hex");
        }
    }

    // Master templates are upstream-facing snapshots. They own the pool nonce lane
    // so each worker gets a distinct upstream job while still mapping shares back to
    // the original pool job id.
    class MasterBlockTemplate {
        constructor(template) {
            this.blob = template.blocktemplate_blob;
            this.blocktemplate_blob = template.blocktemplate_blob;
            this.blob_type = parseBlobType(template.blob_type);
            this.coin = template.coin;
            this.variant = template.variant;
            this.algo = template.algo;
            this.difficulty = normalizeDifficulty(template.difficulty);
            this.height = template.height;
            this.seed_hash = template.seed_hash;
            this.reservedOffset = template.reserved_offset;
            this.workerOffset = template.client_nonce_offset;
            this.poolOffset = template.client_pool_offset;
            this.targetDiff = normalizeDifficulty(template.target_diff, this.difficulty);
            this.targetHex = template.target_diff_hex || getTargetHex(this.targetDiff, nonceSize(this.blob_type));
            this.buffer = Buffer.from(this.blob, "hex");
            this.previousHash = Buffer.alloc(32);
            this.job_id = template.job_id;
            this.workerNonce = 0;
            this.poolNonce = 0;
            this.solo = false;

            if (this.workerOffset === undefined) {
                this.solo = true;
                instanceId.copy(this.buffer, this.reservedOffset + 4, 0, 3);
                this.buffer.copy(this.previousHash, 0, 7, 39);
            } else if (this.poolOffset === undefined) {
                throw new Error("Upstream pool is missing client_pool_offset and is not compatible with proxy mining");
            }
        }

        blobForWorker() {
            if (!this.solo) {
                this.buffer.writeUInt32BE(++this.poolNonce, this.poolOffset);
            }
            return this.buffer.toString("hex");
        }
    }

    function adjustMinerDiff(miner, maxDiff) {
        const normalizedMaxDiff = normalizeDifficulty(maxDiff);
        if (miner.newDiff) {
            miner.difficulty = normalizeDifficulty(miner.newDiff, miner.difficulty);
            miner.newDiff = null;
        }
        if (miner.difficulty > normalizedMaxDiff) {
            miner.difficulty = normalizedMaxDiff;
        }
    }

    function getJob(miner, activeBlockTemplate, bypassCache) {
        if (
            miner.validJobs.size() > 0
            && miner.validJobs.get(0).templateID === activeBlockTemplate.id
            && !miner.newDiff
            && miner.cachedJob !== null
            && bypassCache !== true
        ) {
            return miner.cachedJob;
        }

        const blob = activeBlockTemplate.nextBlob();
        adjustMinerDiff(miner, activeBlockTemplate.targetDiff);

        const newJob = {
            id: randomId(),
            blob_type: activeBlockTemplate.blob_type,
            extraNonce: activeBlockTemplate.workerNonce,
            height: activeBlockTemplate.height,
            seed_hash: activeBlockTemplate.seed_hash,
            difficulty: miner.difficulty,
            diffHex: getTargetHex(miner.difficulty, nonceSize(activeBlockTemplate.blob_type)),
            submissions: [],
            templateID: activeBlockTemplate.id
        };

        miner.validJobs.enq(newJob);

        if (blobTypeGrin(activeBlockTemplate.blob_type)) {
            miner.cachedJob = {
                pre_pow: blob,
                algo: "cuckaroo",
                edgebits: 29,
                proofsize: c29ProofSize(activeBlockTemplate.blob_type),
                noncebytes: 4,
                height: activeBlockTemplate.height,
                job_id: newJob.id,
                difficulty: miner.difficulty,
                id: miner.id
            };
        } else {
            miner.cachedJob = {
                blob,
                job_id: newJob.id,
                height: activeBlockTemplate.height,
                seed_hash: activeBlockTemplate.seed_hash,
                target: newJob.diffHex,
                id: miner.id
            };
        }

        if (activeBlockTemplate.variant !== undefined) {
            miner.cachedJob.variant = activeBlockTemplate.variant;
        }
        if (activeBlockTemplate.algo !== undefined && miner.protocol !== "grin") {
            miner.cachedJob.algo = activeBlockTemplate.algo;
        }

        return miner.cachedJob;
    }

    function getMasterJob(poolState, workerId) {
        const activeBlockTemplate = poolState.activeBlockTemplate;
        const workerBlob = activeBlockTemplate.blobForWorker();

        const workerData = {
            id: randomId(),
            blocktemplate_blob: workerBlob,
            blob_type: activeBlockTemplate.blob_type,
            coin: activeBlockTemplate.coin,
            variant: activeBlockTemplate.variant,
            algo: activeBlockTemplate.algo,
            difficulty: activeBlockTemplate.difficulty,
            height: activeBlockTemplate.height,
            seed_hash: activeBlockTemplate.seed_hash,
            reserved_offset: activeBlockTemplate.reservedOffset,
            worker_offset: activeBlockTemplate.workerOffset,
            target_diff: activeBlockTemplate.targetDiff,
            target_diff_hex: activeBlockTemplate.targetHex
        };

        const localData = {
            id: workerData.id,
            masterJobID: activeBlockTemplate.job_id,
            poolNonce: activeBlockTemplate.poolNonce
        };

        // Keep a short worker-local mapping from proxy job id back to the upstream
        // job id and pool nonce so submit handling can reconstruct the exact pool share.
        if (!poolState.workerJobs) {
            poolState.workerJobs = new Map();
        }
        if (!poolState.workerJobs.has(workerId)) {
            poolState.workerJobs.set(workerId, new CircularBuffer(4));
        }
        poolState.workerJobs.get(workerId).enq(localData);
        return workerData;
    }

    return {
        BlockTemplate: WorkerBlockTemplate,
        MasterBlockTemplate,
        getJob,
        getMasterJob
    };
}

module.exports = {
    createTemplateTools,
    getTargetHex,
    normalizeDifficulty
};
