"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { planPoolRebalance } = require("../proxy/balance");

test.describe("xmr-node-proxy balance helpers", { concurrency: false }, () => {
    test("planPoolRebalance moves miners off an overloaded pool", () => {
        const result = planPoolRebalance({
            developerShare: 0,
            isPoolUsable(poolName) {
                return poolName === "alpha" || poolName === "beta";
            },
            miners: [
                { active: true, avgSpeed: 60, minerId: "m1", pool: "alpha", workerId: "w1" },
                { active: true, avgSpeed: 40, minerId: "m2", pool: "alpha", workerId: "w1" }
            ],
            pools: [
                { devPool: false, name: "alpha", share: 50 },
                { devPool: false, name: "beta", share: 50 }
            ]
        });

        assert.deepEqual(result.warnings, []);
        assert.deepEqual(result.changes, [
            { workerId: "w1", minerId: "m2", pool: "beta" }
        ]);
    });

    test("planPoolRebalance reports when no active pools are available", () => {
        const result = planPoolRebalance({
            developerShare: 1,
            isPoolUsable() {
                return false;
            },
            miners: [
                { active: true, avgSpeed: 50, minerId: "m1", pool: "alpha", workerId: "w1" }
            ],
            pools: [
                { devPool: false, name: "alpha", share: 100 },
                { devPool: true, name: "devshare", share: 0 }
            ]
        });

        assert.deepEqual(result.changes, []);
        assert.deepEqual(result.warnings, [
            { reason: "no-active-pools" }
        ]);
    });
});
