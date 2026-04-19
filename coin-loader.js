"use strict";

const fs = require("node:fs");
const path = require("node:path");

function resolveCoinModulePath(coinName) {
    const searchRoots = [];
    if (process.env.XNP_COIN_FACTORY_DIR) {
        // Test harnesses and custom deployments can point the loader at out-of-tree
        // coin modules without modifying the repo layout.
        searchRoots.push(path.resolve(process.env.XNP_COIN_FACTORY_DIR));
    }
    searchRoots.push(__dirname);

    for (const root of searchRoots) {
        const candidate = path.resolve(root, `${coinName}.js`);
        if (fs.existsSync(candidate)) return candidate;
    }

    return path.resolve(__dirname, `${coinName}.js`);
}

function loadCoinFactory(coinName, overrides = {}) {
    if (overrides[coinName]) return overrides[coinName];
    return require(resolveCoinModulePath(coinName));
}

module.exports = {
    loadCoinFactory,
    resolveCoinModulePath
};
