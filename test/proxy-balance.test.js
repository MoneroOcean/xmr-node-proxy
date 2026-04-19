"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { planPoolRebalance } = require("../proxy-balance");

test("planPoolRebalance moves miners off an overloaded pool", () => {
    const result = planPoolRebalance({
        developerShare: 0,
        isPoolUsable(poolName) {
            return poolName === "alpha" || poolName === "beta";
        },
        miners: [
            { active: true, avgSpeed: 60, coin: "xmr", minerId: "m1", pool: "alpha", workerId: "w1" },
            { active: true, avgSpeed: 40, coin: "xmr", minerId: "m2", pool: "alpha", workerId: "w1" }
        ],
        pools: [
            { coin: "xmr", devPool: false, name: "alpha", share: 50 },
            { coin: "xmr", devPool: false, name: "beta", share: 50 }
        ]
    });

    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.changes, [
        { workerId: "w1", minerId: "m2", pool: "beta" }
    ]);
});

test("planPoolRebalance reports coins with no active pools", () => {
    const result = planPoolRebalance({
        developerShare: 1,
        isPoolUsable() {
            return false;
        },
        miners: [
            { active: true, avgSpeed: 50, coin: "xmr", minerId: "m1", pool: "alpha", workerId: "w1" }
        ],
        pools: [
            { coin: "xmr", devPool: false, name: "alpha", share: 100 },
            { coin: "xmr", devPool: true, name: "devshare", share: 0 }
        ]
    });

    assert.deepEqual(result.changes, []);
    assert.deepEqual(result.warnings, [
        { coin: "xmr", reason: "no-active-pools" }
    ]);
});
