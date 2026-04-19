"use strict";

const {
    DEFAULT_ALGO,
    DEFAULT_ALGO_PERF,
} = require("./proxy-common");
const { createXmrAlgoTools } = require("./xmr-algos");
const {
    blobTypeGrin,
    c29ProofSize,
    constructNewBlob,
    convertBlob,
    nonceSize,
    parseBlobType
} = require("./xmr-blob");
const {
    createXmrTemplateTools,
    normalizeDifficulty
} = require("./xmr-template");
const { createXmrShareProcessor } = require("./xmr-share");

function createXmrCoin(options = {}) {
    const {
        instanceId = Buffer.from([0, 0, 0]),
        logger = null
    } = options;

    const { detectAlgo, hashFunc, hashFuncC29 } = createXmrAlgoTools({ logger });
    const { BlockTemplate, MasterBlockTemplate, getJob, getMasterJob } = createXmrTemplateTools({
        blobTypeGrin,
        c29ProofSize,
        convertBlob,
        instanceId,
        nonceSize,
        parseBlobType
    });
    const { processShare } = createXmrShareProcessor({
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
        coin: "xmr",
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
