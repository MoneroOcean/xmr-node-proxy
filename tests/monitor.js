"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { ProxyMonitor } = require("../proxy/monitor");

test.describe("xmr-node-proxy monitor", { concurrency: false }, () => {
    test("ProxyMonitor renders theme toggle, sortable headers, tooltip polish, and MoneroOcean links", () => {
        const monitor = new ProxyMonitor({
            config: { theme: "light", refreshTime: 30, httpEnable: true },
            logger: { info() {} },
            runtime: {}
        });

        const now = Date.now();
        const html = monitor.renderHtml({
            generatedAtAgeMs: 0,
            totalMiners: 1,
            totalHashrate: 1200,
            hashrateAlgo: "h/s",
            pools: [
                {
                    hostname: "gulf.moneroocean.stream",
                    username: "wallet-demo",
                    devPool: false,
                    percentage: "100.00",
                    active: true,
                    hashrate: 1200,
                    height: 100,
                    targetDiff: 5000,
                    algo: "rx/0",
                    variant: null
                }
            ],
            miners: [
                {
                    active: true,
                    avgSpeed: 1200,
                    diff: 100,
                    shares: 10,
                    hashes: 1000,
                    lastShare: Math.floor(now / 1000) - 30,
                    lastContact: Math.floor(now / 1000) - 5,
                    connectTime: now - 60_000,
                    pool: "gulf.moneroocean.stream",
                    agent: "xmrig/6.22 linux",
                    logString: "worker-a (127.0.0.1)",
                    algo: "rx/0"
                }
            ]
        });

        assert.match(html, /id="theme-toggle"/);
        assert.match(html, /xnp-monitor-theme/);
        assert.match(html, /data-sort-type="number"/);
        assert.match(html, /tooltiptext/);
        assert.match(html, /xmrig\/6\.22 linux/);
        assert.match(html, /https:\/\/moneroocean\.stream\/#\/dashboard\?addr=wallet-demo/);
    });
});
