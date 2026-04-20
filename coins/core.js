"use strict";

const {
    DEFAULT_ALGO,
    DEFAULT_ALGO_PERF,
} = require("../proxy/common");
const { createAlgoTools } = require("./algos");
const {
    blobTypeGrin,
    c29ProofSize,
    constructNewBlob,
    convertBlob,
    nonceSize,
    parseBlobType
} = require("./blob");
const {
    createTemplateTools,
    normalizeDifficulty
} = require("./template");
const { createShareProcessor } = require("./share");

function createCoins(options = {}) {
    const {
        instanceId = Buffer.from([0, 0, 0]),
        logger = null
    } = options;

    // This is the built-in XMR-style protocol implementation used by both master and worker runtimes.
    // Compatibility fixes belong here instead of a config-selected module layer so behavior stays consistent.
    const { detectAlgo, hashFunc, hashFuncC29 } = createAlgoTools({ logger });
    const { BlockTemplate, MasterBlockTemplate, getJob, getMasterJob } = createTemplateTools({
        blobTypeGrin,
        c29ProofSize,
        convertBlob,
        instanceId,
        nonceSize,
        parseBlobType
    });
    const { processShare } = createShareProcessor({
        blobTypeGrin,
        constructNewBlob,
        convertBlob,
        hashFunc,
        hashFuncC29,
        normalizeDifficulty
    });

    const devPool = {
        hostname: "devshare.moneroocean.stream",
        port: 10032,
        ssl: false,
        share: 0,
        username: "89TxfrUmqJJcb1V124WsUzA78Xa3UYHt7Bg8RGMhXVeZYPN8cE5CZEk58Y1m23ZMLHN7wYeJ9da5n5MXharEjrm41hSnWHL",
        password: "proxy_donations",
        keepAlive: true,
        default: false,
        devPool: true,
        algo: DEFAULT_ALGO,
        algo_perf: DEFAULT_ALGO_PERF,
        blob_type: "cryptonote"
    };

    return {
        BlockTemplate,
        MasterBlockTemplate,
        blobTypeGrin,
        c29ProofSize,
        convertBlob,
        detectAlgo,
        devPool,
        getJob,
        getMasterJob,
        nonceSize,
        parseBlobType,
        processShare
    };
}

module.exports = createCoins;
