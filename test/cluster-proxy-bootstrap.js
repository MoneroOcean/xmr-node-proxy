"use strict";

const proxy = require("../proxy");
const createFakeCoins = require("./fake-coins");

proxy.main({
    coinsFactory: createFakeCoins
}).catch((error) => {
    console.error(error);
    process.exit(1);
});
