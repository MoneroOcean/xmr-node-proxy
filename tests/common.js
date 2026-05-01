"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { AccessControl, PROXY_VERSION, createLogger, humanHashrate, normalizeConfig, parseArgs } = require("../proxy/common");
const packageJson = require("../package.json");
const { collectWorkerStats } = require("../proxy/stats");

test.describe("xmr-node-proxy common helpers", { concurrency: false }, () => {
    test("runtime proxy version matches package metadata", () => {
        assert.equal(PROXY_VERSION, packageJson.version);
    });

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

    test("AccessControl does not reread an unchanged file on denied login", () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xnp-access-"));
        const controlFile = path.join(tempDir, "accessControl.json");
        fs.writeFileSync(controlFile, JSON.stringify({ "wallet-ok": "secret" }, null, 2));

        const accessControl = new AccessControl({
            accessControl: {
                enabled: true,
                controlFile
            }
        });

        let readCount = 0;
        const originalReadFileSync = fs.readFileSync;
        fs.readFileSync = (...args) => {
            if (args[0] === controlFile) readCount += 1;
            return originalReadFileSync(...args);
        };

        try {
            assert.equal(accessControl.isAllowed("wallet-ok", "secret"), true);
            const readsAfterInitialLoad = readCount;

            assert.equal(accessControl.isAllowed("wallet-miss", "wrong"), false);
            assert.equal(readCount, readsAfterInitialLoad);
        } finally {
            fs.readFileSync = originalReadFileSync;
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test("AccessControl still reloads immediately when the file changes", () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xnp-access-"));
        const controlFile = path.join(tempDir, "accessControl.json");
        fs.writeFileSync(controlFile, JSON.stringify({ "wallet-ok": "secret" }, null, 2));

        const accessControl = new AccessControl({
            accessControl: {
                enabled: true,
                controlFile
            }
        });

        try {
            assert.equal(accessControl.isAllowed("wallet-denied", "wrong"), false);

            fs.writeFileSync(controlFile, JSON.stringify({ "wallet-denied": "wrong" }, null, 2));
            const bumpedTime = new Date(Date.now() + 2_000);
            fs.utimesSync(controlFile, bumpedTime, bumpedTime);

            assert.equal(accessControl.isAllowed("wallet-denied", "wrong"), true);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test("normalizeConfig applies flat difficultySettings", () => {
        const config = normalizeConfig({
            pools: [
                {
                    hostname: "pool.example.com",
                    port: 3333,
                    default: true
                }
            ],
            listeningPorts: [
                {
                    port: 4444,
                    diff: 100
                }
            ],
            difficultySettings: {
                minDiff: 2,
                maxDiff: 2000,
                shareTargetTime: 45
            }
        }, path.join(os.tmpdir(), "config.json"));

        assert.deepEqual(config.difficultySettings, {
            minDiff: 2,
            maxDiff: 2000,
            shareTargetTime: 45
        });
    });

    test("normalizeConfig accepts pool algo-min-time and normalizes it to algo_min_time", () => {
        const config = normalizeConfig({
            pools: [
                { hostname: "pool.example.com", port: 3333, default: true, "algo-min-time": 1 }
            ],
            listeningPorts: [
                { port: 4444, diff: 100 }
            ]
        }, path.join(os.tmpdir(), "config.json"));

        assert.equal(config.pools[0].algo_min_time, 1);
        assert.equal("algo-min-time" in config.pools[0], false);
    });

    test("normalizeConfig rejects legacy coinSettings with an upgrade message", () => {
        assert.throws(() => normalizeConfig({
            pools: [
                {
                    hostname: "pool.example.com",
                    port: 3333,
                    default: true
                }
            ],
            listeningPorts: [
                {
                    port: 4444,
                    diff: 100
                }
            ],
            coinSettings: {
                xmr: {
                    minDiff: 2,
                    maxDiff: 2000,
                    shareTargetTime: 45
                }
            }
        }, path.join(os.tmpdir(), "config.json")), /rename it to difficultySettings and update your config/);
    });

    test("parseArgs preserves inline values and ignores invalid flag forms like the legacy parser", () => {
        const configPath = "configs/pool=a.json";
        const parsed = parseArgs([
            "--config",
            "",
            "--workers",
            "",
            "--standalone=true",
            `--config=${configPath}`,
            "--standalone"
        ]);

        assert.equal(parsed.config, path.resolve(process.cwd(), configPath));
        assert.equal(parsed.workers, null);
        assert.equal(parsed.standalone, true);
        assert.throws(() => parseArgs(["--workers="]), /Invalid worker count: NaN/);
    });

    test("normalizeConfig keeps legacy falsy algo defaults and object-like algo_perf", () => {
        const algoPerf = ["rx/0"];
        const config = normalizeConfig({
            pools: [
                {
                    hostname: "pool.example.com",
                    port: 3333,
                    default: true,
                    algo: 0,
                    algo_perf: algoPerf
                }
            ],
            listeningPorts: [
                { port: 4444, diff: 100 }
            ]
        }, path.join(os.tmpdir(), "config.json"));

        assert.deepEqual(config.pools[0].algo, ["rx/0"]);
        assert.equal(config.pools[0].algo_perf, algoPerf);
    });

    test("humanHashrate treats prototype property names as normal algorithm labels", () => {
        assert.equal(humanHashrate(1, "constructor"), "1.00 H/s");
    });

    test("collectWorkerStats only drops missing or stale miners", () => {
        const workerState = {
            stats: new Map([
                ["missing", undefined],
                ["missing-time", {
                    active: true,
                    avgSpeed: 5,
                    diff: 10,
                    hashes: 20,
                    pool: "alpha"
                }],
                ["stale", {
                    active: true,
                    avgSpeed: 7,
                    diff: 11,
                    hashes: 22,
                    lastContact: 50,
                    pool: "alpha"
                }],
                ["fresh", {
                    active: true,
                    avgSpeed: 13,
                    diff: 17,
                    hashes: 26,
                    lastContact: 150,
                    pool: "alpha"
                }]
            ])
        };
        const pool = {
            defaultAlgoSet: { "rx/0": 1 },
            defaultAlgosPerf: { "rx/0": 1 },
            updateAlgoPerf(algos, perf) {
                this.algos = algos;
                this.perf = perf;
            }
        };

        const result = collectWorkerStats({
            inactivityDeadline: 100,
            logger: { debug() {} },
            pools: new Map([["alpha", pool]]),
            workers: new Map([["worker-1", workerState]])
        });

        assert.equal(workerState.stats.has("missing"), false);
        assert.equal(workerState.stats.has("missing-time"), true);
        assert.equal(workerState.stats.has("stale"), false);
        assert.equal(workerState.stats.has("fresh"), true);
        assert.equal(result.globalStats.miners, 2);
        assert.equal(result.globalStats.hashRate, 18);
    });
});
