"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createLogger } = require("../proxy-common");

test("createLogger can omit timestamps when requested", () => {
    const lines = [];
    const originalLog = console.log;
    console.log = (line) => lines.push(line);

    try {
        const logger = createLogger({
            component: "test",
            timestamps: false
        });
        logger.info("proxy.start", { mode: "standalone" });
    } finally {
        console.log = originalLog;
    }

    assert.deepEqual(lines, [
        "INF test proxy.start mode=standalone"
    ]);
});
