"use strict";

const { CircularBuffer, randomId } = require("../../proxy/common");

function createFakeCoins() {
    class WorkerBlockTemplate {
        constructor(template) {
            this.id = template.id;
            this.blob = template.blocktemplate_blob;
            this.blocktemplate_blob = template.blocktemplate_blob;
            this.blob_type = template.blob_type ?? 0;
            this.coin = template.coin;
            this.variant = template.variant;
            this.algo = template.algo || "test/algo";
            this.difficulty = template.difficulty;
            this.height = template.height;
            this.seed_hash = template.seed_hash || "";
            this.reservedOffset = template.reserved_offset ?? 0;
            this.workerOffset = template.worker_offset ?? 4;
            this.targetDiff = template.target_diff;
            this.targetHex = template.target_diff_hex || String(template.target_diff);
            this.workerNonce = 0;
            this.solo = false;
        }

        nextBlob() {
            this.workerNonce += 1;
            return `${this.blob}:${this.workerNonce}`;
        }
    }

    class MasterBlockTemplate {
        constructor(template) {
            this.blob = template.blocktemplate_blob;
            this.blocktemplate_blob = template.blocktemplate_blob;
            this.blob_type = template.blob_type ?? 0;
            this.coin = template.coin;
            this.variant = template.variant;
            this.algo = template.algo || "test/algo";
            this.difficulty = template.difficulty;
            this.height = template.height;
            this.seed_hash = template.seed_hash || "";
            this.reservedOffset = template.reserved_offset ?? 0;
            this.workerOffset = template.client_nonce_offset;
            this.poolOffset = template.client_pool_offset;
            this.targetDiff = template.target_diff;
            this.targetHex = template.target_diff_hex || String(template.target_diff);
            this.job_id = template.job_id;
            this.poolNonce = 0;
            this.solo = false;
            if (this.poolOffset === undefined) {
                throw new Error("Fake pool template missing client_pool_offset");
            }
        }

        blobForWorker() {
            this.poolNonce += 1;
            return `${this.blob}:pool:${this.poolNonce}`;
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
        const newJob = {
            id: randomId(),
            blob_type: activeBlockTemplate.blob_type,
            extraNonce: activeBlockTemplate.workerNonce,
            height: activeBlockTemplate.height,
            seed_hash: activeBlockTemplate.seed_hash,
            difficulty: miner.difficulty,
            submissions: [],
            templateID: activeBlockTemplate.id
        };
        miner.validJobs.enq(newJob);
        miner.cachedJob = {
            blob,
            job_id: newJob.id,
            height: activeBlockTemplate.height,
            seed_hash: activeBlockTemplate.seed_hash,
            target: String(miner.difficulty),
            algo: activeBlockTemplate.algo,
            id: miner.id
        };
        return miner.cachedJob;
    }

    function getMasterJob(poolState, workerId) {
        const activeBlockTemplate = poolState.activeBlockTemplate;
        const workerData = {
            id: randomId(),
            blocktemplate_blob: activeBlockTemplate.blobForWorker(),
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
        if (!poolState.workerJobs) poolState.workerJobs = new Map();
        if (!poolState.workerJobs.has(workerId)) {
            poolState.workerJobs.set(workerId, new CircularBuffer(4));
        }
        poolState.workerJobs.get(workerId).enq(localData);
        return workerData;
    }

    function processShare(miner, job, blockTemplate, params, hooks = {}) {
        const shareDiff = Number.parseInt(String(params.result || ""), 16);
        if (!Number.isFinite(shareDiff)) return false;
        if (shareDiff >= blockTemplate.targetDiff && typeof hooks.onPoolShare === "function") {
            hooks.onPoolShare({
                btID: blockTemplate.id,
                nonce: params.nonce,
                resultHash: params.result,
                workerNonce: job.extraNonce
            });
            miner.blocks += 1;
        } else if (shareDiff < job.difficulty) {
            return false;
        }

        miner.shares += 1;
        miner.hashes += job.difficulty;
        return true;
    }

    return {
        BlockTemplate: WorkerBlockTemplate,
        MasterBlockTemplate,
        blobTypeGrin() {
            return false;
        },
        c29ProofSize() {
            return 32;
        },
        detectAlgo(defaultAlgoSet) {
            return Object.keys(defaultAlgoSet)[0] || "test/algo";
        },
        devPool: {
            hostname: "fake-dev-pool.invalid",
            port: 0,
            ssl: false,
            share: 0,
            username: "dev",
            password: "dev",
            keepAlive: true,
            default: false,
            devPool: true,
            algo: ["test/algo"],
            algo_perf: { "test/algo": 1 },
            blob_type: 0
        },
        getJob,
        getMasterJob,
        nonceSize() {
            return 4;
        },
        processShare
    };
}

module.exports = createFakeCoins;
