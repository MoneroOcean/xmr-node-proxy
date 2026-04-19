"use strict";

const cnUtil = require("cryptoforknote-util");
const multiHashing = require("cryptonight-hashing");

const {
    CircularBuffer,
    DEFAULT_ALGO,
    DEFAULT_ALGO_PERF,
    bigIntToBufferBE,
    bufferToBigIntLE,
    randomId
} = require("./proxy-common");

const BASE_DIFF = (1n << 256n) - 1n;
const MAX_VERIFIED_SHARES_PER_SECOND = 10;
const VERIFIED_SHARE_WINDOW_SECONDS = 5;

function createXmrCoin(options = {}) {
    const {
        instanceId = Buffer.from([0, 0, 0]),
        logger = null
    } = options;

    let verifiedWindowStartedAt = 0;
    let verifiedShareCount = 0;
    const poolShareStats = new Map();

    function logDebug(message, meta) {
        if (logger && typeof logger.debug === "function") {
            logger.debug("coin:xmr", message, meta);
        }
    }

    function parseBlobType(blobTypeValue) {
        if (blobTypeValue === undefined || blobTypeValue === null) return 0;
        if (Number.isInteger(blobTypeValue)) return blobTypeValue;
        switch (blobTypeValue) {
        case "cryptonote": return 0;
        case "forknote1": return 1;
        case "forknote2": return 2;
        case "cryptonote2": return 3;
        case "cryptonote_ryo": return 4;
        case "cryptonote_loki": return 5;
        case "cryptonote3": return 6;
        case "aeon": return 7;
        case "cuckaroo": return 8;
        case "cryptonote_xtnc": return 9;
        case "cryptonote_tube": return 10;
        case "cryptonote_xhv": return 11;
        case "cryptonote_xta": return 12;
        case "cryptonote_zeph": return 13;
        case "cryptonote_xla": return 14;
        case "cryptonote_sal": return 15;
        case "cryptonote_arq": return 16;
        case "cryptonote_xeq": return 22;
        case "cryptonote_dero": return 100;
        case "raptoreum": return 104;
        case "raptoreum_kcn": return 105;
        case "xtm-t": return 106;
        default: return 0;
        }
    }

    function blobTypeGrin(blobTypeNum) {
        return blobTypeNum === 8 || blobTypeNum === 9 || blobTypeNum === 10 || blobTypeNum === 12;
    }

    function blobTypeDero(blobTypeNum) {
        return blobTypeNum === 100;
    }

    function blobTypeRtm(blobTypeNum) {
        return blobTypeNum === 104;
    }

    function blobTypeKcn(blobTypeNum) {
        return blobTypeNum === 105;
    }

    function blobTypeXtmT(blobTypeNum) {
        return blobTypeNum === 106;
    }

    function nonceSize(blobTypeNum) {
        return blobTypeNum === 7 ? 8 : 4;
    }

    function c29ProofSize(blobTypeNum) {
        switch (blobTypeNum) {
        case 10: return 40;
        case 12: return 48;
        default: return 32;
        }
    }

    function convertBlob(blobBuffer, blobTypeNum) {
        if (blobTypeDero(blobTypeNum) || blobTypeXtmT(blobTypeNum)) {
            return Buffer.from(blobBuffer);
        }
        if (blobTypeRtm(blobTypeNum)) {
            return cnUtil.convertRtmBlob(blobBuffer);
        }
        if (blobTypeKcn(blobTypeNum)) {
            return cnUtil.convertKcnBlob(blobBuffer);
        }
        return cnUtil.convert_blob(blobBuffer, blobTypeNum);
    }

    function constructNewBlob(blockTemplateBuffer, nonceBuffer, blobTypeNum, ring) {
        if (blobTypeDero(blobTypeNum) || blobTypeXtmT(blobTypeNum)) {
            const newBlob = Buffer.alloc(blockTemplateBuffer.length);
            blockTemplateBuffer.copy(newBlob);
            nonceBuffer.copy(newBlob, 39, 0, 4);
            return newBlob;
        }
        if (blobTypeRtm(blobTypeNum)) {
            return cnUtil.constructNewRtmBlob(blockTemplateBuffer, nonceBuffer);
        }
        if (blobTypeKcn(blobTypeNum)) {
            return cnUtil.constructNewKcnBlob(blockTemplateBuffer, nonceBuffer);
        }
        return cnUtil.construct_block_blob(blockTemplateBuffer, nonceBuffer, blobTypeNum, ring);
    }

    function detectAlgo(defaultAlgoSet, blockVersion) {
        if ("cn/r" in defaultAlgoSet && "rx/0" in defaultAlgoSet) {
            return blockVersion >= 12 ? "rx/0" : "cn/r";
        }
        const algos = Object.keys(defaultAlgoSet);
        if (algos.length === 1) return algos[0];
        if (logger) logger.error(`Cannot unambiguously detect block template algorithm from: ${algos.join(", ")}`);
        return algos[0] || DEFAULT_ALGO[0];
    }

    function hashFunc(convertedBlob, blockTemplate) {
        const blockVersion = blockTemplate.blocktemplate_blob
            ? (16 * Number.parseInt(blockTemplate.blocktemplate_blob[0], 10)) + Number.parseInt(blockTemplate.blocktemplate_blob[1], 10)
            : 0;
        const algo = blockTemplate.algo || detectAlgo({ [DEFAULT_ALGO[0]]: 1 }, blockVersion);

        switch (algo) {
        case "rx/0": return multiHashing.randomx(convertedBlob, Buffer.from(blockTemplate.seed_hash, "hex"), 0);
        case "cn":
        case "cryptonight":
        case "cn/0":
        case "cryptonight/0": return multiHashing.cryptonight(convertedBlob, 0);
        case "cn/1":
        case "cryptonight/1": return multiHashing.cryptonight(convertedBlob, 1);
        case "cn/xtl":
        case "cryptonight/xtl": return multiHashing.cryptonight(convertedBlob, 3);
        case "cn/msr":
        case "cryptonight/msr": return multiHashing.cryptonight(convertedBlob, 4);
        case "cn/xao":
        case "cryptonight/xao": return multiHashing.cryptonight(convertedBlob, 6);
        case "cn/rto":
        case "cryptonight/rto": return multiHashing.cryptonight(convertedBlob, 7);
        case "cn/2":
        case "cryptonight/2": return multiHashing.cryptonight(convertedBlob, 8);
        case "cn/half":
        case "cryptonight/half": return multiHashing.cryptonight(convertedBlob, 9);
        case "cn/gpu":
        case "cryptonight/gpu": return multiHashing.cryptonight(convertedBlob, 11);
        case "cn/wow":
        case "cryptonight/wow": return multiHashing.cryptonight(convertedBlob, 12, blockTemplate.height);
        case "cn/r":
        case "cryptonight/r": return multiHashing.cryptonight(convertedBlob, 13, blockTemplate.height);
        case "cn/rwz":
        case "cryptonight/rwz": return multiHashing.cryptonight(convertedBlob, 14);
        case "cn/zls":
        case "cryptonight/zls": return multiHashing.cryptonight(convertedBlob, 15);
        case "cn/ccx":
        case "cryptonight/ccx": return multiHashing.cryptonight(convertedBlob, 17);
        case "cn/double":
        case "cryptonight/double": return multiHashing.cryptonight(convertedBlob, 16);
        case "ghostrider": return multiHashing.cryptonight(convertedBlob, 18);
        case "flex": return multiHashing.cryptonight(convertedBlob, 19);
        case "cn-lite":
        case "cryptonight-lite":
        case "cn-lite/0":
        case "cryptonight-lite/0": return multiHashing.cryptonight_light(convertedBlob, 0);
        case "cn-lite/1":
        case "cryptonight-lite/1": return multiHashing.cryptonight_light(convertedBlob, 1);
        case "cn-heavy":
        case "cryptonight-heavy":
        case "cn-heavy/0":
        case "cryptonight-heavy/0": return multiHashing.cryptonight_heavy(convertedBlob, 0);
        case "cn-heavy/xhv":
        case "cryptonight-heavy/xhv": return multiHashing.cryptonight_heavy(convertedBlob, 1);
        case "cn-heavy/tube":
        case "cryptonight-heavy/tube": return multiHashing.cryptonight_heavy(convertedBlob, 2);
        case "cn-pico/trtl":
        case "cryptonight-pico/trtl": return multiHashing.cryptonight_pico(convertedBlob, 0);
        case "rx/wow":
        case "randomx/wow": return multiHashing.randomx(convertedBlob, Buffer.from(blockTemplate.seed_hash, "hex"), 17);
        case "rx/loki":
        case "randomx/loki": return multiHashing.randomx(convertedBlob, Buffer.from(blockTemplate.seed_hash, "hex"), 18);
        case "rx/v": return multiHashing.randomx(convertedBlob, Buffer.from(blockTemplate.seed_hash, "hex"), 19);
        case "rx/graft": return multiHashing.randomx(convertedBlob, Buffer.from(blockTemplate.seed_hash, "hex"), 20);
        case "rx/xeq": return multiHashing.randomx(convertedBlob, Buffer.from(blockTemplate.seed_hash, "hex"), 22);
        case "defyx": return multiHashing.randomx(convertedBlob, Buffer.from(blockTemplate.seed_hash, "hex"), 1);
        case "panthera": return multiHashing.randomx(convertedBlob, Buffer.from(blockTemplate.seed_hash, "hex"), 3);
        case "rx/arq": return multiHashing.randomx(convertedBlob, Buffer.from(blockTemplate.seed_hash, "hex"), 2);
        case "argon2/chukwav2":
        case "chukwav2": return multiHashing.argon2(convertedBlob, 2);
        case "argon2/wrkz": return multiHashing.argon2(convertedBlob, 1);
        case "k12": return multiHashing.k12(convertedBlob);
        case "astrobwt": return multiHashing.astrobwt(convertedBlob, 0);
        default: return Buffer.alloc(0);
        }
    }

    function hashFuncC29(algo, header, ring) {
        switch (algo) {
        case "c29s": return multiHashing.c29s(header, ring);
        case "c29v": return multiHashing.c29v(header, ring);
        case "c29b": return multiHashing.c29b(header, ring);
        case "c29i": return multiHashing.c29i(header, ring);
        default: return 1;
        }
    }

    function normalizeDifficulty(value, fallback = 1) {
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
                log(`Submitted ${state.count} share(s) of ${state.lastDiff} hashes to ${poolName} pool`);
            } else if (typeof log === "function") {
                log(`Submitted share of ${targetDiff} hashes to ${poolName} pool`);
            }
            state.startedAt = now;
            state.count = 1;
            state.lastDiff = targetDiff;
        } else {
            state.count += 1;
        }
        poolShareStats.set(poolName, state);
    }

    class WorkerBlockTemplate {
        constructor(template) {
            this.id = template.id;
            this.blob = template.blocktemplate_blob;
            this.blocktemplate_blob = template.blocktemplate_blob;
            this.blob_type = parseBlobType(template.blob_type);
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

    class MasterBlockTemplate {
        constructor(template) {
            this.blob = template.blocktemplate_blob;
            this.blocktemplate_blob = template.blocktemplate_blob;
            this.blob_type = parseBlobType(template.blob_type);
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
        miner.lastBlockHeight = activeBlockTemplate.height;

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

        if (!poolState.workerJobs) {
            poolState.workerJobs = new Map();
        }
        if (!poolState.workerJobs.has(workerId)) {
            poolState.workerJobs.set(workerId, new CircularBuffer(4));
        }
        poolState.workerJobs.get(workerId).enq(localData);
        return workerData;
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
                    warn(`Share verification throttled for ${miner.logString}`);
                }

                if (verifyFailed) {
                    if (typeof warn === "function") warn(`Bad share from miner ${miner.logString}`);
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
                    warn(`Rejected low diff share of ${hashDiff.toString()} from ${miner.logString}`);
                }
                return false;
            }

            miner.shares += 1;
            miner.hashes += normalizeDifficulty(job.difficulty);
            return true;
        } catch (error) {
            if (typeof warn === "function") {
                warn(`Share processing failed for ${miner.logString}: ${error.message}`);
            }
            return false;
        }
    }

    const devPool = {
        hostname: "devshare.moneroocean.stream",
        port: 10032,
        ssl: false,
        share: 0,
        username: "89TxfrUmqJJcb1V124WsUzA78Xa3UYHt7Bg8RGMhXVeZYPN8cE5CZEk58Y1m23ZMLHN7wYeJ9da5n5MXharEjrm41hSnWHL",
        password: "proxy_donations",
        keepAlive: true,
        coin: "xmr",
        default: false,
        devPool: true,
        algo: DEFAULT_ALGO,
        algo_perf: DEFAULT_ALGO_PERF,
        blob_type: "cryptonote"
    };

    return {
        BlockTemplate: WorkerBlockTemplate,
        MasterBlockTemplate,
        blobTypeGrin,
        c29ProofSize,
        convertBlob,
        defaultAlgo: DEFAULT_ALGO,
        defaultAlgoPerf: DEFAULT_ALGO_PERF,
        detectAlgo,
        devPool,
        getJob,
        getMasterJob,
        nonceSize,
        parseBlobType,
        processShare
    };
}

module.exports = createXmrCoin;
