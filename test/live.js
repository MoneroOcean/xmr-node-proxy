"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { setTimeout: sleep } = require("node:timers/promises");

const ROOT_DIR = path.join(__dirname, "..");
const DEFAULT_CACHE_DIR = path.join(ROOT_DIR, ".cache", "live-miners");
const DEFAULT_ARTIFACT_ROOT = path.join(ROOT_DIR, "test-artifacts", "live-xnp");
const DEFAULT_WALLET = "89TxfrUmqJJcb1V124WsUzA78Xa3UYHt7Bg8RGMhXVeZYPN8cE5CZEk58Y1m23ZMLHN7wYeJ9da5n5MXharEjrm41hSnWHL";
const XMRIG_RELEASE_API = "https://api.github.com/repos/MoneroOcean/xmrig/releases/latest";
const USER_AGENT = "xmr-node-proxy-live-tests";
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g;
const DEFAULT_TIMEOUT_MS = 8 * 60_000;
const POST_SUBMIT_GRACE_MS = 2_000;
// nodejs-pool applies algo changes on getjob, but omitted or zero
// "algo-min-time" still resolves to its 60 second default because the server
// uses a truthy check when storing that value. The live suite keeps a smaller
// default here so same-session algo-switch coverage completes in reasonable
// time unless the operator explicitly overrides it.
const DEFAULT_UPSTREAM_ALGO_MIN_TIME = 1;
const DEFAULT_FALLBACK_SWITCH_DELAY_MS = 61_000;
const LOCAL_MINER_NAME = "xnp-live";
const LOCAL_MINER_PASSWORD = "x~";
// Keep the live coverage explicit and stable; this mirrors the README algo set
// but does not parse README.md at runtime. Coin labels stay descriptive only;
// forcing xmrig --coin can switch some algos onto a different protocol family.
const SCENARIOS = [
    { algo: "rx/arq", coin: "arqma" },
    { algo: "panthera", coin: "scala" },
    { algo: "ghostrider", coin: "rtm" },
    { algo: "cn/gpu", coin: "ryo" },
    { algo: "rx/0", coin: "monero" }
];
const ALGO_PERF_SEED = Object.freeze(Object.fromEntries([
    "argon2/chukwav2",
    "cn-heavy/xhv",
    "cn/half",
    "cn-lite/1",
    "cn/gpu",
    "cn-pico",
    "cn-pico/trtl",
    "cn/r",
    "cn/ccx",
    "flex",
    "ghostrider",
    "kawpow",
    "panthera",
    "rx/0",
    "rx/arq",
    "rx/graft",
    "rx/wow"
].map((algo) => [algo, 1])));

function sanitizeName(value) {
    return String(value || "")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase();
}

function stripAnsi(value) {
    return typeof value === "string" ? value.replace(ANSI_ESCAPE_PATTERN, "") : "";
}

function fileExistsSync(filePath) {
    try {
        fs.accessSync(filePath, fs.constants.F_OK);
        return true;
    } catch (_error) {
        return false;
    }
}

async function isExecutable(filePath) {
    if (!filePath) return false;
    try {
        await fsp.access(filePath, fs.constants.X_OK);
        return true;
    } catch (_error) {
        return false;
    }
}

async function ensureDir(dirPath) {
    await fsp.mkdir(dirPath, { recursive: true });
}

function buildRunId() {
    return `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
}

function parseInteger(rawValue, fallback) {
    const parsed = Number.parseInt(String(rawValue ?? ""), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(rawValue, fallback) {
    const parsed = Number.parseInt(String(rawValue ?? ""), 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function defaultSwitchDelayMs(upstreamAlgoMinTime) {
    return upstreamAlgoMinTime > 0
        ? (upstreamAlgoMinTime * 1000) + 1_000
        : DEFAULT_FALLBACK_SWITCH_DELAY_MS;
}

function formatReadableTime(date) {
    const value = date instanceof Date ? date : new Date(date);
    return [value.getHours(), value.getMinutes(), value.getSeconds()]
        .map((part) => String(part).padStart(2, "0"))
        .join(":");
}

function emitLiveStatus(status, label, detail = "") {
    process.stdout.write(`[${formatReadableTime(new Date())}] ${status} ${label}${detail ? ` ${detail}` : ""}\n`);
}

function firstLine(value) {
    return String(value || "").split(/\r?\n/, 1)[0] || "";
}

async function runCommand(command, args, options = {}) {
    return await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ["ignore", "pipe", "pipe"]
        });

        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", (code, signal) => {
            if (code !== 0) {
                reject(new Error(`${command} ${args.join(" ")} failed with code ${code} signal ${signal || "none"} stderr=${stderr.trim()}`));
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

async function request(url, headers = {}) {
    const response = await fetch(url, {
        headers: {
            Accept: "application/vnd.github+json, application/json",
            "User-Agent": USER_AGENT,
            ...headers
        },
        redirect: "follow"
    });

    if (!response.ok) {
        throw new Error(`Request failed for ${url}: ${response.status} ${response.statusText}`);
    }

    return response;
}

async function fetchJson(url) {
    return await (await request(url)).json();
}

async function downloadToFile(url, destination) {
    const response = await request(url);
    if (!response.body) throw new Error(`Download body missing for ${url}`);

    await ensureDir(path.dirname(destination));
    const tmpPath = `${destination}.part`;
    const output = fs.createWriteStream(tmpPath, { mode: 0o644 });

    try {
        await pipeline(Readable.fromWeb(response.body), output);
        await fsp.rename(tmpPath, destination);
    } catch (error) {
        await fsp.rm(tmpPath, { force: true });
        throw error;
    }
}

function resolveXmrigAsset(release) {
    const assets = Array.isArray(release.assets) ? release.assets : [];
    if (process.platform === "linux" && process.arch === "x64") {
        return assets.find((asset) => asset.name.includes("lin64-compat"))
            || assets.find((asset) => asset.name.includes("lin64.tar.gz"))
            || null;
    }
    if (process.platform === "darwin" && process.arch === "arm64") {
        return assets.find((asset) => asset.name.includes("mac64")) || null;
    }
    if (process.platform === "darwin" && process.arch === "x64") {
        return assets.find((asset) => asset.name.includes("mac-intel"))
            || assets.find((asset) => asset.name.includes("mac64"))
            || null;
    }
    return null;
}

async function findNamedFile(rootDir, basename) {
    if (!fileExistsSync(rootDir)) return null;

    const queue = [rootDir];
    while (queue.length > 0) {
        const current = queue.pop();
        const entries = await fsp.readdir(current, { withFileTypes: true });
        for (const entry of entries) {
            const candidate = path.join(current, entry.name);
            if (entry.isDirectory()) {
                queue.push(candidate);
                continue;
            }
            if (path.basename(candidate) === basename) return candidate;
        }
    }

    return null;
}

async function ensureXmrigBinary(cacheDir) {
    const explicitPath = process.env.XNP_LIVE_XMRIG || "";
    const homeDir = os.homedir();
    const commonPaths = [
        explicitPath,
        path.join(homeDir, "xmrig", "xmrig-mo", "xmrig"),
        "/home/sap/xmrig/xmrig-mo/xmrig",
        path.join(homeDir, "xmrig", "xmrig", "xmrig")
    ].filter(Boolean);

    for (const candidate of commonPaths) {
        if (await isExecutable(candidate)) return candidate;
    }

    if (process.platform === "win32") {
        throw new Error("test:live currently supports automatic xmrig download only on Linux/macOS; set XNP_LIVE_XMRIG explicitly");
    }

    const release = await fetchJson(XMRIG_RELEASE_API);
    const asset = resolveXmrigAsset(release);
    if (!asset || typeof asset.browser_download_url !== "string") {
        throw new Error(`No MoneroOcean xmrig asset is available for ${process.platform}/${process.arch}`);
    }

    const versionDir = path.join(cacheDir, "xmrig-mo", release.tag_name);
    const archivePath = path.join(versionDir, asset.name);
    const extractDir = path.join(versionDir, sanitizeName(asset.name.replace(/(\.tar\.gz|\.zip)$/i, "")));
    const binaryPath = await findNamedFile(extractDir, "xmrig");
    if (binaryPath && await isExecutable(binaryPath)) {
        return binaryPath;
    }

    await ensureDir(versionDir);
    if (!fileExistsSync(archivePath)) {
        await downloadToFile(asset.browser_download_url, archivePath);
    }

    await fsp.rm(extractDir, { recursive: true, force: true });
    await ensureDir(extractDir);
    await runCommand("tar", ["-xzf", archivePath, "-C", extractDir]);

    const extractedBinary = await findNamedFile(extractDir, "xmrig");
    if (!extractedBinary) {
        throw new Error(`Could not find xmrig after extracting ${asset.name}`);
    }

    await fsp.chmod(extractedBinary, 0o755);
    return extractedBinary;
}

async function writeJson(filePath, value) {
    await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function findFreePort() {
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
}

class LineJournal {
    constructor(filePath) {
        this.filePath = filePath;
        this.lines = [];
        this.stream = fs.createWriteStream(filePath, { flags: "a" });
    }

    push(line) {
        this.lines.push(line);
        this.stream.write(`${line}\n`);
    }

    size() {
        return this.lines.length;
    }

    slice(fromIndex = 0) {
        return this.lines.slice(fromIndex);
    }

    tail(maxLines = 80) {
        return this.lines.slice(-maxLines).join("\n");
    }

    async close() {
        await new Promise((resolve) => this.stream.end(resolve));
    }
}

function attachLineReader(stream, journals) {
    stream.setEncoding("utf8");
    let buffer = "";

    stream.on("data", (chunk) => {
        buffer += chunk;
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
            const rawLine = buffer.slice(0, newlineIndex).replace(/\r$/, "");
            buffer = buffer.slice(newlineIndex + 1);
            const line = stripAnsi(rawLine);
            if (line) {
                for (const journal of journals) journal.push(line);
            }
            newlineIndex = buffer.indexOf("\n");
        }
    });

    stream.on("close", () => {
        const line = stripAnsi(buffer.replace(/\r$/, "").trim());
        if (!line) return;
        for (const journal of journals) journal.push(line);
        buffer = "";
    });
}

function spawnLoggedProcess({ name, command, args, cwd, env, artifactDir }) {
    const stdout = new LineJournal(path.join(artifactDir, `${name}.stdout.log`));
    const stderr = new LineJournal(path.join(artifactDir, `${name}.stderr.log`));
    const combined = new LineJournal(path.join(artifactDir, `${name}.combined.log`));

    const child = spawn(command, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"]
    });

    attachLineReader(child.stdout, [stdout, combined]);
    attachLineReader(child.stderr, [stderr, combined]);

    let exit = null;
    let spawnError = null;
    const exitPromise = new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, signal) => {
            exit = { code, signal };
            resolve(exit);
        });
    }).catch((error) => {
        spawnError = error;
        exit = { code: null, signal: "spawn-error" };
        combined.push(`${name}.spawn_error ${error.message}`);
        return exit;
    });

    return {
        name,
        child,
        stdout,
        stderr,
        combined,
        get exit() {
            return exit;
        },
        get spawnError() {
            return spawnError;
        },
        async close() {
            await Promise.all([stdout.close(), stderr.close(), combined.close()]);
        },
        exitPromise
    };
}

async function stopProcess(handle) {
    if (!handle || handle.exit) return;

    const child = handle.child;
    child.kill("SIGINT");
    const interrupted = await Promise.race([
        handle.exitPromise.then(() => true),
        sleep(1_000).then(() => false)
    ]);
    if (interrupted) return;

    child.kill("SIGTERM");
    const terminated = await Promise.race([
        handle.exitPromise.then(() => true),
        sleep(1_500).then(() => false)
    ]);
    if (terminated) return;

    child.kill("SIGKILL");
    await handle.exitPromise.catch(() => {});
}

async function pollUntil(check, timeoutMs, label, options = {}) {
    const deadline = Date.now() + timeoutMs;
    const progressIntervalMs = options.progressIntervalMs ?? 30_000;
    let nextProgressAt = Date.now() + progressIntervalMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        if (typeof options.onProgress === "function" && progressIntervalMs > 0 && Date.now() >= nextProgressAt) {
            await options.onProgress();
            nextProgressAt = Date.now() + progressIntervalMs;
        }
        await sleep(250);
    }
    throw new Error(`Timed out waiting for ${label}`);
}

function formatFailure(label, scenario, proxyHandle, proxyIndex, minerHandle) {
    const logs = collectFailureLogs(proxyHandle, proxyIndex, minerHandle);
    return [
        `${label} for ${scenario.algo}/${scenario.coin}`,
        "",
        `Proxy log: ${logs.proxyLogPath}`,
        `Miner log: ${logs.minerLogPath || "<none>"}`,
        "",
        "Proxy log tail:",
        logs.proxyTail,
        "",
        "Miner log tail:",
        logs.minerTail
    ].join("\n");
}

function buildFailureDetails(label, scenario, proxyHandle, proxyIndex, minerHandle) {
    return {
        scenario,
        label,
        summary: firstLine(label),
        ...collectFailureLogs(proxyHandle, proxyIndex, minerHandle)
    };
}

function formatFailureDetails(entries) {
    return entries.map((entry) => [
        `[${entry.scenario.algo}/${entry.scenario.coin}] ${entry.summary}`,
        "",
        `Proxy log: ${entry.proxyLogPath}`,
        `Miner log: ${entry.minerLogPath || "<none>"}`,
        "",
        "Proxy log tail:",
        entry.proxyTail,
        "",
        "Miner log tail:",
        entry.minerTail
    ].join("\n")).join("\n\n");
}

function collectFailureLogs(proxyHandle, proxyIndex, minerHandle) {
    const proxyTail = proxyHandle.combined.slice(proxyIndex).join("\n") || proxyHandle.combined.tail() || "<empty>";
    return {
        proxyLogPath: proxyHandle.combined.filePath,
        minerLogPath: minerHandle?.combined.filePath || "",
        proxyTail,
        minerTail: minerHandle?.combined.tail() || "<empty>"
    };
}

function withArtifactPaths(message, context, details = null) {
    if (!context) return message;

    return `${message}\n\nArtifacts: ${context.artifactDir}`
        + `\nProxy log: ${context.proxyHandle.combined.filePath}`
        + (details?.minerLogPath ? `\nMiner log: ${details.minerLogPath}` : "");
}

async function waitForProxyReady(proxyHandle, proxyPort, upstreamHost) {
    await pollUntil(() => {
        if (proxyHandle.exit) {
            throw new Error(`proxy exited before bind\n\n${proxyHandle.combined.tail()}`);
        }
        const lines = proxyHandle.combined.slice();
        return lines.some((line) => line.includes("listen.ready") && line.includes(`port=${proxyPort}`));
    }, 15_000, `proxy listen on ${proxyPort}`);

    await pollUntil(() => {
        if (proxyHandle.exit) {
            throw new Error(`proxy exited before upstream connect\n\n${proxyHandle.combined.tail()}`);
        }
        const lines = proxyHandle.combined.slice();
        return lines.some((line) => line.includes("pool.connect") && line.includes(`host=${upstreamHost}`));
    }, 30_000, `proxy upstream connect to ${upstreamHost}`);
}

async function waitForInitialPoolJob(proxyHandle, upstreamHost, algo) {
    await pollUntil(() => {
        if (proxyHandle.exit) {
            throw new Error(`proxy exited before initial pool job\n\n${proxyHandle.combined.tail()}`);
        }
        const lines = proxyHandle.combined.slice();
        return lines.some((line) => line.includes("pool.job")
            && line.includes(`host=${upstreamHost}`)
            && (!algo || line.includes(`algo=${algo}`)));
    }, 30_000, `initial pool job for ${algo || upstreamHost}`);
}

async function buildLiveContext() {
    const runId = buildRunId();
    const artifactDir = path.join(DEFAULT_ARTIFACT_ROOT, runId);
    const cacheDir = DEFAULT_CACHE_DIR;
    const proxyPort = await findFreePort();
    const configPath = path.join(artifactDir, "config.json");
    const xmrigConfigPath = path.join(artifactDir, "xmrig-config.json");
    const poolHost = process.env.XNP_LIVE_POOL_HOST || "gulf.moneroocean.stream";
    const poolPort = parseInteger(process.env.XNP_LIVE_POOL_PORT, 20001);
    const upstreamLogin = String(process.env.XNP_LIVE_WALLET || DEFAULT_WALLET).trim();
    const upstreamAlgoMinTime = parseNonNegativeInteger(process.env.XNP_LIVE_UPSTREAM_ALGO_MIN_TIME, DEFAULT_UPSTREAM_ALGO_MIN_TIME);
    const minerDiff = parseInteger(process.env.XNP_LIVE_MINER_DIFF, 1000);
    const switchDelayMs = parseNonNegativeInteger(process.env.XNP_LIVE_SWITCH_DELAY_MS, defaultSwitchDelayMs(upstreamAlgoMinTime));
    const timeoutMs = parseInteger(process.env.XNP_LIVE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const threads = parseInteger(process.env.XNP_LIVE_THREADS, Math.max(1, os.availableParallelism()));
    const requestedAlgos = String(process.env.XNP_LIVE_ALGOS || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    const scenarios = requestedAlgos.length > 0 ? SCENARIOS.filter((scenario) => requestedAlgos.includes(scenario.algo)) : SCENARIOS;
    const initialAlgoSet = scenarios[0] ? [scenarios[0].algo] : [];
    const initialAlgoPerf = Object.fromEntries(initialAlgoSet.map((algo) => [algo, 1]));
    const selectedAlgoPerf = Object.fromEntries(scenarios.map(({ algo }) => [algo, 1]));

    if (requestedAlgos.length > 0) {
        const missing = requestedAlgos.filter((algo) => !scenarios.some((scenario) => scenario.algo === algo));
        if (missing.length > 0) {
            throw new Error(`Unknown XNP_LIVE_ALGOS entries: ${missing.join(", ")}`);
        }
    }
    if (scenarios.length === 0) {
        throw new Error("No live scenarios selected");
    }
    await ensureDir(cacheDir);
    await ensureDir(artifactDir);

    const xmrigBinary = await ensureXmrigBinary(cacheDir);

    // Keep the local miner eager to switch; the upstream pacing is controlled
    // by the proxy pool config below.
    await writeJson(xmrigConfigPath, {
        autosave: false,
        "algo-min-time": 0,
        "algo-perf": requestedAlgos.length > 0 ? selectedAlgoPerf : ALGO_PERF_SEED
    });

    await writeJson(configPath, {
        pools: [
            {
                hostname: poolHost,
                port: poolPort,
                ssl: true,
                allowSelfSignedSSL: true,
                share: 100,
                username: upstreamLogin,
                password: "proxy-live",
                keepAlive: true,
                algo: initialAlgoSet,
                algo_perf: initialAlgoPerf,
                "algo-min-time": upstreamAlgoMinTime,
                blob_type: "cryptonote",
                default: true
            }
        ],
        listeningPorts: [
            {
                port: proxyPort,
                ssl: false,
                diff: 1
            }
        ],
        bindAddress: "127.0.0.1",
        developerShare: 0,
        httpEnable: false,
        difficultySettings: {
            minDiff: 1,
            maxDiff: 1024,
            shareTargetTime: 30
        }
    });

    const proxyHandle = spawnLoggedProcess({
        name: "proxy",
        command: process.execPath,
        args: ["proxy.js", "--standalone", "--config", configPath],
        cwd: ROOT_DIR,
        env: {
            ...process.env,
            DEBUG: process.env.DEBUG ? `${process.env.DEBUG},pool` : "pool",
            XNP_LOG_TIME: "0"
        },
        artifactDir
    });

    await waitForProxyReady(proxyHandle, proxyPort, poolHost);
    await waitForInitialPoolJob(proxyHandle, poolHost, initialAlgoSet[0]);

    return {
        artifactDir,
        configPath,
        lastAlgo: null,
        lastAlgoFinishedAt: 0,
        minerDiff,
        poolHost,
        poolPort,
        proxyHandle,
        proxyPort,
        scenarios,
        switchDelayMs,
        threads,
        timeoutMs,
        upstreamAlgoMinTime,
        xmrigBinary,
        xmrigConfigPath
    };
}

function buildXmrigArgs(context, scenario) {
    return [
        "-c", context.xmrigConfigPath,
        "-o", `127.0.0.1:${context.proxyPort}`,
        "-u", `${LOCAL_MINER_NAME}+${context.minerDiff}`,
        "-p", `${LOCAL_MINER_PASSWORD}${scenario.algo}`,
        // Match nodejs-pool's xmrig live launch style. Forcing -a/--coin can
        // move some algos, notably ghostrider/RTM, off the XMR login/getjob
        // path this proxy is meant to exercise.
        "--rig-id", `xnp-live-${sanitizeName(scenario.algo)}`,
        "-t", String(context.threads),
        "--cpu-priority", "0",
        "--donate-level", "0",
        "--bench-algo-time", "0",
        "--algo-min-time", "0",
        "--print-time", "1",
        "--no-color",
        "--keepalive"
    ];
}

async function runScenario(context, scenario) {
    const proxyIndex = context.proxyHandle.combined.size();
    const shouldRequireAlgoSwitch = context.lastAlgo !== null && context.lastAlgo !== scenario.algo;
    const shouldRequireFreshJob = context.lastAlgo !== null;
    const startedAt = Date.now();
    emitLiveStatus("start", `algo ${scenario.algo}`, `coin=${scenario.coin}`);
    // When the upstream pool keeps the previous coin sticky for algo-min-time
    // seconds, wait out that configured window before asking the same session
    // to switch families with the next getjob request.
    if (shouldRequireAlgoSwitch && context.switchDelayMs > 0) {
        const elapsedMs = context.lastAlgoFinishedAt ? Date.now() - context.lastAlgoFinishedAt : 0;
        const waitMs = Math.max(0, context.switchDelayMs - elapsedMs);
        if (waitMs > 0) {
            emitLiveStatus("wait", `algo ${scenario.algo}`, `switch=${context.lastAlgo}->${scenario.algo} ${Math.ceil(waitMs / 1000)}s`);
            await sleep(waitMs);
        }
    }

    const minerHandle = spawnLoggedProcess({
        name: `xmrig-${sanitizeName(scenario.algo)}`,
        command: context.xmrigBinary,
        args: buildXmrigArgs(context, scenario),
        cwd: ROOT_DIR,
        env: process.env,
        artifactDir: context.artifactDir
    });

    try {
        await pollUntil(() => {
            const minerExit = minerHandle.exit;
            if (minerExit) {
                throw new Error(formatFailure(`xmrig exited early (${minerExit.code ?? "null"}/${minerExit.signal || "none"})`, scenario, context.proxyHandle, proxyIndex, minerHandle));
            }

            const proxyLines = context.proxyHandle.combined.slice(proxyIndex);
            const minerLines = minerHandle.combined.slice();
            const replyError = proxyLines.find((line) => line.includes("pool.reply_error"));
            if (replyError) {
                throw new Error(formatFailure(`proxy received upstream error: ${replyError}`, scenario, context.proxyHandle, proxyIndex, minerHandle));
            }

            const jobRejected = proxyLines.find((line) => line.includes("pool.job_rejected"));
            if (jobRejected) {
                throw new Error(formatFailure(`proxy rejected upstream template: ${jobRejected}`, scenario, context.proxyHandle, proxyIndex, minerHandle));
            }

            const minerError = minerLines.find((line) => /\b(no active pools|connect error|connection refused|net error|read error|job timeout|failed to resolve|invalid\b.*\bshare\b|\brejected\b.*\bshare\b)\b/i.test(line));
            if (minerError) {
                throw new Error(formatFailure(`xmrig reported miner error: ${minerError}`, scenario, context.proxyHandle, proxyIndex, minerHandle));
            }

            const sawAlgoSwitch = proxyLines.some((line) => line.includes("pool.algos") && line.includes(`algos=${scenario.algo}`));
            const sawJob = proxyLines.some((line) => line.includes("pool.job") && line.includes(`algo=${scenario.algo}`));
            const sawSubmit = proxyLines.some((line) => line.includes(`Sent submit to ${context.poolHost}`));

            return (shouldRequireAlgoSwitch ? sawAlgoSwitch : true) && (shouldRequireFreshJob ? sawJob : true) && sawSubmit;
        }, context.timeoutMs, `${scenario.algo} upstream share submit`, {
            onProgress: async () => {
                const proxyLines = context.proxyHandle.combined.slice(proxyIndex);
                const minerLines = minerHandle.combined.slice();
                const localAccepted = minerLines.filter((line) => /\baccepted\b/i.test(line)).length;
                const sawJob = proxyLines.some((line) => line.includes("pool.job") && line.includes(`algo=${scenario.algo}`));
                const sawSubmit = proxyLines.some((line) => line.includes(`Sent submit to ${context.poolHost}`));
                emitLiveStatus("progress", `algo ${scenario.algo}`, `localAccepted=${localAccepted} job=${sawJob ? "yes" : "no"} upstreamSubmit=${sawSubmit ? "yes" : "no"}`);
            }
        });

        await sleep(POST_SUBMIT_GRACE_MS);
        const submitErrors = context.proxyHandle.combined
            .slice(proxyIndex)
            .filter((line) => line.includes("pool.reply_error") && line.includes("method=submit"));
        assert.equal(
            submitErrors.length,
            0,
            formatFailure(`upstream submit reply failed: ${submitErrors.join("\n")}`, scenario, context.proxyHandle, proxyIndex, minerHandle)
        );
        context.lastAlgo = scenario.algo;
        context.lastAlgoFinishedAt = Date.now();
        emitLiveStatus("pass", `algo ${scenario.algo}`, `coin=${scenario.coin} elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`);
    } catch (error) {
        const details = buildFailureDetails(error.message, scenario, context.proxyHandle, proxyIndex, minerHandle);
        emitLiveStatus("fail", `algo ${scenario.algo}`, details.summary || "failed");
        const wrapped = new Error(details.summary || firstLine(error.message) || "failed");
        Object.defineProperty(wrapped, "liveFailureDetails", {
            value: details,
            enumerable: false,
            configurable: true
        });
        throw wrapped;
    } finally {
        await stopProcess(minerHandle);
        await minerHandle.close();
    }
}

async function cleanupContext(context, keepArtifacts) {
    if (!context) return;

    await stopProcess(context.proxyHandle).catch(() => {});
    await context.proxyHandle.close().catch(() => {});

    if (!keepArtifacts) {
        await fsp.rm(context.artifactDir, { recursive: true, force: true });
    }
}

const liveFailureState = {
    details: [],
    printed: false
};

test.after(() => {
    if (!liveFailureState.details.length || liveFailureState.printed) return;
    process.stdout.write(`\nLive failure logs\n${formatFailureDetails(liveFailureState.details)}\n`);
    liveFailureState.printed = true;
});

test("Live gulf.moneroocean.stream proxy testing", { timeout: 60 * 60 * 1000 }, async (t) => {
    let context = null;
    let keepArtifacts = process.env.XNP_LIVE_KEEP_ARTIFACTS === "1";

    try {
        context = await buildLiveContext();
        for (const scenario of context.scenarios) {
            let scenarioFailed = false;
            await t.test(`${scenario.algo} via ${scenario.coin}`, { timeout: context.timeoutMs + context.switchDelayMs + 60_000 }, async () => {
                try {
                    await runScenario(context, scenario);
                } catch (error) {
                    scenarioFailed = true;
                    keepArtifacts = true;
                    if (error.liveFailureDetails) {
                        liveFailureState.details.push(error.liveFailureDetails);
                    }
                    error.message = withArtifactPaths(error.message, context, error.liveFailureDetails);
                    throw error;
                }
            }).catch(() => {});
            if (scenarioFailed) break;
        }
    } catch (error) {
        keepArtifacts = true;
        error.message = withArtifactPaths(error.message, context);
        throw error;
    } finally {
        await cleanupContext(context, keepArtifacts);
    }
});
