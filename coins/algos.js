"use strict";

const powHash = require("node-powhash");

const { DEFAULT_ALGO } = require("../proxy/common");

function randomxHasher(variant) {
    return (convertedBlob, blockTemplate) => powHash.randomx(convertedBlob, Buffer.from(blockTemplate.seed_hash, "hex"), variant);
}

function cryptonightHasher(variant, useHeight = false) {
    return (convertedBlob, blockTemplate) => useHeight
        ? powHash.cryptonight(convertedBlob, variant, blockTemplate.height)
        : powHash.cryptonight(convertedBlob, variant);
}

function fixedHasher(handler) {
    return handler;
}

const HASH_DISPATCH = new Map();

function registerHash(names, handler) {
    for (const name of names) {
        HASH_DISPATCH.set(name, handler);
    }
}

registerHash(["rx/0"], randomxHasher(0));
registerHash(["cn", "cryptonight", "cn/0", "cryptonight/0"], cryptonightHasher(0));
registerHash(["cn/1", "cryptonight/1"], cryptonightHasher(1));
registerHash(["cn/xtl", "cryptonight/xtl"], cryptonightHasher(3));
registerHash(["cn/msr", "cryptonight/msr"], cryptonightHasher(4));
registerHash(["cn/xao", "cryptonight/xao"], cryptonightHasher(6));
registerHash(["cn/rto", "cryptonight/rto"], cryptonightHasher(7));
registerHash(["cn/2", "cryptonight/2"], cryptonightHasher(8));
registerHash(["cn/half", "cryptonight/half"], cryptonightHasher(9));
registerHash(["cn/gpu", "cryptonight/gpu"], cryptonightHasher(11));
registerHash(["cn/wow", "cryptonight/wow"], cryptonightHasher(12, true));
registerHash(["cn/r", "cryptonight/r"], cryptonightHasher(13, true));
registerHash(["cn/rwz", "cryptonight/rwz"], cryptonightHasher(14));
registerHash(["cn/zls", "cryptonight/zls"], cryptonightHasher(15));
registerHash(["cn/ccx", "cryptonight/ccx"], cryptonightHasher(17));
registerHash(["cn/double", "cryptonight/double"], cryptonightHasher(16));
registerHash(["ghostrider"], cryptonightHasher(18));
registerHash(["flex"], cryptonightHasher(19));
registerHash(["cn-lite", "cryptonight-lite", "cn-lite/0", "cryptonight-lite/0"], fixedHasher((convertedBlob) => powHash.cryptonight_light(convertedBlob, 0)));
registerHash(["cn-lite/1", "cryptonight-lite/1"], fixedHasher((convertedBlob) => powHash.cryptonight_light(convertedBlob, 1)));
registerHash(["cn-heavy", "cryptonight-heavy", "cn-heavy/0", "cryptonight-heavy/0"], fixedHasher((convertedBlob) => powHash.cryptonight_heavy(convertedBlob, 0)));
registerHash(["cn-heavy/xhv", "cryptonight-heavy/xhv"], fixedHasher((convertedBlob) => powHash.cryptonight_heavy(convertedBlob, 1)));
registerHash(["cn-heavy/tube", "cryptonight-heavy/tube"], fixedHasher((convertedBlob) => powHash.cryptonight_heavy(convertedBlob, 2)));
registerHash(["cn-pico/trtl", "cryptonight-pico/trtl"], fixedHasher((convertedBlob) => powHash.cryptonight_pico(convertedBlob, 0)));
registerHash(["rx/wow", "randomx/wow"], randomxHasher(17));
registerHash(["rx/loki", "randomx/loki"], randomxHasher(18));
registerHash(["rx/v"], randomxHasher(19));
registerHash(["rx/graft"], randomxHasher(20));
registerHash(["rx/xeq"], randomxHasher(22));
registerHash(["defyx"], randomxHasher(1));
registerHash(["panthera"], randomxHasher(3));
registerHash(["rx/arq"], randomxHasher(2));
registerHash(["argon2/chukwav2", "chukwav2"], fixedHasher((convertedBlob) => powHash.argon2(convertedBlob, 2)));
registerHash(["argon2/wrkz"], fixedHasher((convertedBlob) => powHash.argon2(convertedBlob, 1)));
registerHash(["k12"], fixedHasher((convertedBlob) => powHash.k12(convertedBlob)));
registerHash(["astrobwt"], fixedHasher((convertedBlob) => powHash.astrobwt(convertedBlob, 0)));

const C29_HASHERS = {
    c29s: (header, ring) => powHash.c29s(header, ring),
    c29v: (header, ring) => powHash.c29v(header, ring),
    c29b: (header, ring) => powHash.c29b(header, ring),
    c29i: (header, ring) => powHash.c29i(header, ring)
};

function createAlgoTools({ logger = null } = {}) {
    function detectAlgo(defaultAlgoSet, blockVersion) {
        if ("cn/r" in defaultAlgoSet && "rx/0" in defaultAlgoSet) {
            return blockVersion >= 12 ? "rx/0" : "cn/r";
        }

        const algos = Object.keys(defaultAlgoSet);
        if (algos.length === 1) return algos[0];

        if (logger) logger.error("algo.detect_ambiguous", { algos: algos.join(",") });
        return algos[0] || DEFAULT_ALGO[0];
    }

    function hashFunc(convertedBlob, blockTemplate) {
        const blockVersion = blockTemplate.blocktemplate_blob
            ? parseInt(blockTemplate.blocktemplate_blob.slice(0, 2), 16)
            : 0;
        const algo = blockTemplate.algo || detectAlgo({ [DEFAULT_ALGO[0]]: 1 }, blockVersion);
        const hasher = HASH_DISPATCH.get(algo);
        return hasher ? hasher(convertedBlob, blockTemplate) : Buffer.alloc(0);
    }

    function hashFuncC29(algo, header, ring) {
        const hasher = C29_HASHERS[algo];
        return hasher ? hasher(header, ring) : 1;
    }

    return {
        detectAlgo,
        hashFunc,
        hashFuncC29
    };
}

module.exports = {
    createAlgoTools
};
