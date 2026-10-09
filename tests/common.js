"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const { AccessControl, createLogger, humanHashrate, normalizeConfig, parseArgs } = require("../proxy/common");
const { collectWorkerStats } = require("../proxy/stats");

function runInstallerFixture(nodeVersion, npmVersion) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "xnp-install-"));
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.copyFileSync(path.join(__dirname, "../install.sh"), path.join(root, "install.sh"));
    for (const file of ["package.json", "proxy.js", "config.json", "cert.key", "cert.pem"]) fs.writeFileSync(path.join(root, file), "");
    for (const command of ["dirname", "uname"]) fs.symlinkSync(`/usr/bin/${command}`, path.join(bin, command));
    const script = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o700 });
    script("id", "echo 0");
    script("apt-get", 'echo PACKAGES >> "$INSTALLER_MUTATIONS"; for package in "$@"; do case "$package" in nodejs|npm) echo RUNTIME_PACKAGE >> "$INSTALLER_MUTATIONS" ;; esac; done');
    if (nodeVersion) script("node", 'version="$INSTALLER_NODE_VERSION"; case "$2" in *"[0]"*) echo "${version%%.*}" ;; *"[1]"*) rest="${version#*.}"; echo "${rest%%.*}" ;; *) echo "$version" ;; esac');
    if (npmVersion) script("npm", 'if [[ "$1" == --version ]]; then echo "$INSTALLER_NPM_VERSION"; else echo NPM_RUN >> "$INSTALLER_MUTATIONS"; fi');
    for (const command of ["git", "openssl", "python3", "make", "g++"]) script(command, "exit 0");
    try {
        const result = spawnSync("/bin/bash", [path.join(root, "install.sh")], {
            env: { ...process.env, PATH: bin, INSTALLER_NODE_VERSION: nodeVersion || "", INSTALLER_NPM_VERSION: npmVersion || "", INSTALLER_MUTATIONS: path.join(root, "mutations") },
            encoding: "utf8", timeout: 5000
        });
        return { status: result.status, output: result.stdout + result.stderr, mutations: fs.existsSync(path.join(root, "mutations")) ? fs.readFileSync(path.join(root, "mutations"), "utf8") : "" };
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test.describe("install.sh runtime prerequisites", { skip: process.platform !== "linux" }, () => {
    for (const [name, nodeVersion, npmVersion] of [
        ["old Node", "22.8.0", "11.10.0"],
        ["old npm", "22.9.0", "11.9.9"],
        ["missing Node", null, "11.10.0"],
        ["missing npm", "22.9.0", null],
        ["prerelease npm", "22.9.0", "11.10.0-beta.1"],
        ["oversized version", "999999999999999999999.0.0", "11.10.0"]
    ]) {
        test(`rejects ${name} before package-manager mutation`, () => {
            const result = runInstallerFixture(nodeVersion, npmVersion);
            assert.equal(result.status, 1);
            assert.equal(result.mutations, "");
        });
    }
    for (const [nodeVersion, npmVersion] of [["22.9.0", "11.10.0"], ["24.0.0", "12.0.0"]]) {
        test(`accepts supported runtime ${nodeVersion}/${npmVersion} without replacing it`, () => {
            const result = runInstallerFixture(nodeVersion, npmVersion);
            assert.equal(result.status, 0, result.output);
            assert.match(result.mutations, /PACKAGES/);
            assert.match(result.mutations, /NPM_RUN/);
            assert.doesNotMatch(result.mutations, /RUNTIME_PACKAGE/);
        });
    }
});

test.describe("xmr-node-proxy common helpers", { concurrency: false }, () => {
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

    test("normalizeConfig accepts legacy coinSettings.xmr as a compatibility fallback", () => {
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
            coinSettings: {
                xmr: {
                    minDiff: 2,
                    maxDiff: 2000,
                    shareTargetTime: 45
                }
            }
        }, path.join(os.tmpdir(), "config.json"));

        assert.deepEqual(config.difficultySettings, {
            minDiff: 2,
            maxDiff: 2000,
            shareTargetTime: 45
        });
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
