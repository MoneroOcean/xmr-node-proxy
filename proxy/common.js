"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PROXY_VERSION = "0.29.3";
const DEFAULT_ALGO = ["rx/0"];
const DEFAULT_ALGO_PERF = { "rx/0": 1, "rx/loki": 1 };
const HTTP_OK_RESPONSE = " 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 19\r\n\r\nMining Proxy Online";
const MAX_JSON_LINE_BYTES = 128 * 1024;
const ACCESS_CONTROL_REFRESH_MS = 60_000;
const FALSE_FLAGS = new Set(["0", "false", "no", "off"]);
const TRUE_FLAGS = new Set(["1", "true", "yes", "on"]);
const C29_HASHRATE_MULTIPLIERS = new Map([["c29s", 32], ["c29v", 16]]);
const LOG_FORMATTERS = {
    undefined: () => "",
    number: String,
    boolean: String,
    bigint: String,
    string: formatLogString,
    object: formatObjectLogValue
};
const ARG_HANDLERS = {
    "--standalone": (result) => {
        result.standalone = true;
        return false;
    },
    "--config": (result, value) => {
        if (value === undefined) return false;
        result.config = path.resolve(process.cwd(), value);
        return true;
    },
    "--workers": (result, value) => {
        if (value === undefined) return false;
        result.workers = Number.parseInt(value, 10);
        return true;
    }
};
function maybeUnref(timer) {
    if (timer && typeof timer.unref === "function") timer.unref();
    return timer;
}

class CircularBuffer {
    constructor(limit) {
        if (!Number.isInteger(limit) || limit <= 0) {
            throw new Error(`Invalid circular buffer limit: ${limit}`);
        }
        this.limit = limit;
        this.items = [];
    }

    enq(value) {
        this.items.unshift(value);
        if (this.items.length > this.limit) {
            return this.items.pop();
        }
        return undefined;
    }

    get(index) {
        return this.items[index];
    }

    size() {
        return this.items.length;
    }

    toarray() {
        return Array.from(this.items);
    }
}

function compileDebugPatterns(rawValue = "") {
    return rawValue
        .split(",")
        .map((pattern) => pattern.trim())
        .filter(Boolean)
        .map((pattern) => new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}$`));
}

function normalizeLoggerComponent(value) {
    return String(value ?? "")
        .trim()
        .replace(/^\[([^\]]+)\]\s*$/, "$1")
        .replace(/\s+/g, "-")
        .replace(/[^a-zA-Z0-9._:-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase();
}

function formatTimestamp(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    const second = String(date.getSeconds()).padStart(2, "0");
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}
function formatLogValue(value) {
    const formatter = LOG_FORMATTERS[typeof value] || JSON.stringify;
    return formatter(value);
}
function formatLogString(value) {
    if (/^[a-zA-Z0-9._:/,@%+\-=]+$/.test(value)) return value;
    return JSON.stringify(value);
}
function formatObjectLogValue(value) {
    if (value === null) return "null";
    return JSON.stringify(value);
}
function formatLogMeta(meta) {
    if (meta === undefined || meta === null) return "";
    if (!isPlainObject(meta)) return formatLogValue(meta);
    return Object.entries(meta)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${formatLogValue(value)}`)
        .join(" ");
}
function envFlagEnabled(rawValue, defaultValue = true) {
    if (rawValue == null || rawValue === "") return defaultValue;
    const normalized = String(rawValue).trim().toLowerCase();
    if (FALSE_FLAGS.has(normalized)) return false;
    if (TRUE_FLAGS.has(normalized)) return true;
    return defaultValue;
}
function createLogger({
    prefix = "",
    component = "",
    debug = process.env.DEBUG || "",
    timestamps = envFlagEnabled(process.env.XNP_LOG_TIME, true)
} = {}) {
    const patterns = compileDebugPatterns(debug);
    const componentValue = component || normalizeLoggerComponent(prefix);
    const levelLabels = {
        info: "INF",
        warn: "WRN",
        error: "ERR",
        debug: "DBG"
    };
    function write(level, sink, message, meta, namespace = "") {
        sink(logParts(levelLabels[level], componentValue, timestamps, namespace, message, meta).join(" "));
    }
    function isDebugEnabled(namespace) {
        if (patterns.length === 0) return false;
        return patterns.some((pattern) => pattern.test(namespace));
    }

    return {
        info(message, meta) {
            write("info", console.log, message, meta);
        },
        warn(message, meta) {
            write("warn", console.warn, message, meta);
        },
        error(message, meta) {
            write("error", console.error, message, meta);
        },
        debug(namespace, message, meta) {
            if (!isDebugEnabled(namespace)) return;
            write("debug", console.log, message, meta, namespace);
        },
        child(childComponent) {
            return createLogger({
                component: normalizeLoggerComponent(childComponent) || componentValue,
                debug,
                timestamps
            });
        }
    };
}
function logParts(levelLabel, componentValue, timestamps, namespace, message, meta) {
    const parts = [];
    if (timestamps) parts.push(formatTimestamp());
    parts.push(levelLabel, componentValue || "-", formatLogMessage(namespace, message));
    const metaText = formatLogMeta(meta);
    if (metaText) parts.push(metaText);
    return parts;
}
function formatLogMessage(namespace, message) {
    return namespace ? `${namespace} ${message}` : message;
}
function parseArgs(argv) {
    const result = {
        config: path.resolve(process.cwd(), "config.json"),
        standalone: false,
        workers: null
    };
    for (let index = 0; index < argv.length; index += 1) {
        index += parseArg(argv, index, result);
    }
    validateWorkerCount(result.workers);
    return result;
}
function validateWorkerCount(workers) {
    if (workers === null) return;
    if (!Number.isInteger(workers)) throw new Error(`Invalid worker count: ${workers}`);
    if (workers <= 0) throw new Error(`Invalid worker count: ${workers}`);
}
function parseArg(argv, index, result) {
    const arg = argv[index];
    const equalsIndex = arg.indexOf("=");
    if (equalsIndex >= 0) return parseInlineArg(arg, equalsIndex, result);
    const handler = ARG_HANDLERS[arg];
    if (!handler) return 0;
    if (arg === "--standalone") {
        handler(result);
        return 0;
    }
    return parseNextArg(handler, argv[index + 1], result);
}
function parseInlineArg(arg, equalsIndex, result) {
    const name = arg.slice(0, equalsIndex);
    if (name === "--standalone") return 0;
    const handler = ARG_HANDLERS[name];
    if (!handler) return 0;
    handler(result, arg.slice(equalsIndex + 1));
    return 0;
}
function parseNextArg(handler, value, result) {
    if (!value) return 0;
    return handler(result, value) ? 1 : 0;
}
function loadJsonFile(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolvePath(baseDir, value) {
    if (!value) return value;
    return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}
function normalizePoolConfig(poolConfig) {
    const { ["algo-min-time"]: _ignored, ...remainingPoolConfig } = poolConfig;
    const rawAlgoMinTime = poolConfig.algo_min_time ?? poolConfig["algo-min-time"];
    return {
        ...remainingPoolConfig,
        keepAlive: poolConfig.keepAlive !== false,
        allowSelfSignedSSL: poolConfig.allowSelfSignedSSL === true,
        default: poolConfig.default === true,
        devPool: poolConfig.devPool === true,
        algo: normalizeAlgoList(poolConfig.algo),
        algo_perf: objectOrDefault(poolConfig.algo_perf, DEFAULT_ALGO_PERF),
        blob_type: poolConfig.blob_type || "cryptonote",
        algo_min_time: rawAlgoMinTime === undefined ? undefined : Number(rawAlgoMinTime)
    };
}
function normalizeAlgoList(algo) {
    if (Array.isArray(algo)) return algo;
    if (!algo) return DEFAULT_ALGO;
    return [algo];
}
function objectOrDefault(value, defaultValue) {
    return value && typeof value === "object" ? value : defaultValue;
}
function normalizeAccessControl(rawAccessControl, configDir) {
    if (!rawAccessControl || typeof rawAccessControl !== "object") {
        return { enabled: false, controlFile: resolvePath(configDir, "accessControl.json") };
    }
    return {
        enabled: rawAccessControl.enabled === true,
        controlFile: resolvePath(configDir, rawAccessControl.controlFile || "accessControl.json")
    };
}
function normalizeTls(rawTls, configDir) {
    const tls = isPlainObject(rawTls) ? rawTls : {};
    return {
        keyPath: resolvePath(configDir, tls.keyPath || "cert.key"),
        certPath: resolvePath(configDir, tls.certPath || "cert.pem")
    };
}
function normalizeList(rawList, mapper) {
    return Array.isArray(rawList) ? rawList.map(mapper) : [];
}
function normalizePortConfig(portConfig) {
    return {
        ...portConfig,
        ssl: portConfig.ssl === true,
        diff: Number(portConfig.diff || portConfig.difficulty || 1)
    };
}

function normalizeDifficultySettings(rawDifficultySettings) {
    return {
        minDiff: Number(rawDifficultySettings?.minDiff ?? 1),
        maxDiff: Number(rawDifficultySettings?.maxDiff ?? 10000000),
        shareTargetTime: Number(rawDifficultySettings?.shareTargetTime ?? 30)
    };
}

function normalizeConfig(rawConfig, configPath) {
    const {
        coinSettings: legacyCoinSettings,
        difficultySettings: rawDifficultySettings,
        pools: _rawPools,
        listeningPorts: _rawListeningPorts,
        ...remainingConfig
    } = rawConfig;

    if (rawDifficultySettings === undefined && legacyCoinSettings !== undefined) {
        throw new Error("config.coinSettings is no longer supported; rename it to difficultySettings and update your config");
    }
    const configDir = path.dirname(configPath);
    const pools = normalizeList(rawConfig.pools, normalizePoolConfig);
    const listeningPorts = normalizeList(rawConfig.listeningPorts, normalizePortConfig);
    const config = {
        ...remainingConfig,
        pools,
        listeningPorts,
        accessControl: normalizeAccessControl(rawConfig.accessControl, configDir),
        ...normalizeGeneralConfig(rawConfig),
        tls: normalizeTls(rawConfig.tls, configDir),
        difficultySettings: normalizeDifficultySettings(rawDifficultySettings)
    };
    validateConfig(config);
    return config;
}
function normalizeGeneralConfig(rawConfig) {
    return {
        ...normalizeHttpConfig(rawConfig),
        ...normalizeRuntimeConfig(rawConfig),
        developerShare: Number(rawConfig.developerShare ?? 0),
        addressWorkerID: rawConfig.addressWorkerID === true,
        keepOfflineMiners: rawConfig.keepOfflineMiners === true || Number(rawConfig.keepOfflineMiners || 0) > 0
    };
}
function normalizeHttpConfig(rawConfig) {
    return {
        httpEnable: rawConfig.httpEnable === true,
        httpAddress: rawConfig.httpAddress || "127.0.0.1",
        httpPort: Number(rawConfig.httpPort ?? 8081),
        refreshTime: Number(rawConfig.refreshTime ?? 30),
        theme: rawConfig.theme || "light"
    };
}
function normalizeRuntimeConfig(rawConfig) {
    return {
        bindAddress: rawConfig.bindAddress || "0.0.0.0",
        minerInactivityTime: Number(rawConfig.minerInactivityTime ?? 120),
        socketTimeoutMs: Number(rawConfig.socketTimeoutMs ?? 180000),
        maxJsonLineBytes: Number(rawConfig.maxJsonLineBytes ?? MAX_JSON_LINE_BYTES)
    };
}
function validateConfig(config) {
    validateRequiredList(config.pools, "config.pools must contain at least one pool");
    validateRequiredList(config.listeningPorts, "config.listeningPorts must contain at least one listening port");
    validatePools(config.pools);
    validateDifficultySettings(config.difficultySettings);
    validateListeningPorts(config.listeningPorts);
}
function validateRequiredList(value, message) {
    if (!Array.isArray(value) || value.length === 0) throw new Error(message);
}
function validatePools(pools) {
    let hasDefaultPool = false;
    for (const pool of pools) {
        validatePool(pool);
        if (isDefaultUserPool(pool)) hasDefaultPool = true;
    }
    if (!hasDefaultPool) {
        throw new Error("config.pools must contain at least one default non-dev pool");
    }
}
function isDefaultUserPool(pool) {
    return pool.default && !pool.devPool;
}
function validatePool(pool) {
    if (!pool.hostname || !Number.isInteger(Number(pool.port))) throw new Error(`Invalid pool entry: ${JSON.stringify(pool)}`);
    if (invalidAlgoMinTime(pool)) throw new Error(`Invalid pool algo-min-time: ${JSON.stringify(pool)}`);
}
function invalidAlgoMinTime(pool) {
    if (pool.algo_min_time === undefined) return false;
    return !Number.isFinite(pool.algo_min_time) || pool.algo_min_time < 0;
}
function validateDifficultySettings(settings) {
    if (!validDifficultySettings(settings)) {
        throw new Error(`Invalid difficultySettings: ${JSON.stringify(settings)}`);
    }
}
function validDifficultySettings(settings) {
    return [settings.minDiff, settings.maxDiff, settings.shareTargetTime].every((value) => Number.isFinite(value) && value > 0)
        && settings.minDiff <= settings.maxDiff;
}
function validateListeningPorts(listeningPorts) {
    for (const portConfig of listeningPorts) {
        if (!Number.isInteger(Number(portConfig.port)) && portConfig.port !== 0) {
            throw new Error(`Invalid listening port: ${JSON.stringify(portConfig)}`);
        }
    }
}

class AccessControl {
    constructor(config) {
        this.config = config;
        this.lastLoadedAt = 0;
        this.entries = Object.create(null);
        this.fileSignature = null;
    }

    getControlFileSignature() {
        const stats = fs.statSync(this.config.accessControl.controlFile);
        return `${stats.mtimeMs}:${stats.size}`;
    }
    loadEntries(signature, loadedAt = Date.now()) {
        const rawEntries = loadJsonFile(this.config.accessControl.controlFile);
        if (!isPlainObject(rawEntries)) throw new Error("access control file must contain a JSON object");
        this.entries = rawEntries;
        this.fileSignature = signature ?? this.getControlFileSignature();
        this.lastLoadedAt = loadedAt;
    }

    hasMatch(username, password) {
        return Object.prototype.hasOwnProperty.call(this.entries, username) && this.entries[username] === password;
    }

    reloadIfNeeded(force = false) {
        if (!this.config.accessControl.enabled) return;
        const now = Date.now();
        if (this.skipAccessReload(force, now)) return;
        this.lastLoadedAt = now;
        const signature = this.getControlFileSignature();
        if (this.skipUnchangedAccessReload(force, signature)) return;
        this.loadEntries(signature, now);
    }
    skipAccessReload(force, now) {
        return !force && now - this.lastLoadedAt < ACCESS_CONTROL_REFRESH_MS;
    }
    skipUnchangedAccessReload(force, signature) {
        return !force && signature === this.fileSignature;
    }
    reloadIfChangedAfterMiss() {
        if (!this.config.accessControl.enabled) return;
        const signature = this.getControlFileSignature();
        if (signature === this.fileSignature) return;
        this.loadEntries(signature);
    }

    isAllowed(username, password) {
        if (!this.config.accessControl.enabled) return true;
        this.reloadIfNeeded();
        if (this.hasMatch(username, password)) return true;
        this.reloadIfChangedAfterMiss();
        return this.hasMatch(username, password);
    }
}

function randomId() {
    const min = 100000000000000n;
    const span = 900000000000000n;
    const randomValue = BigInt(`0x${crypto.randomBytes(8).toString("hex")}`) % span;
    return String(min + randomValue);
}
function humanHashrate(hashes, algo = "h/s") {
    const c29Multiplier = C29_HASHRATE_MULTIPLIERS.get(algo);
    const adjusted = (hashes || 0) * (c29Multiplier || 1);
    return formatHashrateValue(adjusted, c29Multiplier ? "G" : "H");
}
function formatHashrateValue(adjusted, unit) {
    const thresholds = [
        [1_000_000_000_000, "T"],
        [1_000_000_000, "G"],
        [1_000_000, "M"],
        [1_000, "K"]
    ];
    for (const [threshold, suffix] of thresholds) {
        if (adjusted > threshold) {
            return `${Math.round((adjusted / threshold) * 100) / 100} ${suffix}${unit}/s`;
        }
    }
    return `${adjusted.toFixed(2)} ${unit}/s`;
}

function isPoolUsable(pools, hostname, isReady) {
    const pool = pools.get(hostname);
    if (!pool || !isReady(pool)) return false;
    const topHeight = getComparableTopHeight(pools, pool, isReady);
    return pool.activeBlockTemplate.height >= topHeight - 5;
}
function getComparableTopHeight(pools, pool, isReady) {
    let topHeight = 0;
    for (const candidate of pools.values()) {
        if (isComparablePool(candidate, pool, isReady)) topHeight = Math.max(topHeight, candidate.activeBlockTemplate.height);
    }
    return topHeight;
}
function isComparablePool(candidate, pool, isReady) {
    return isReady(candidate) && Math.abs(candidate.activeBlockTemplate.height - pool.activeBlockTemplate.height) <= 1000;
}
function formatRelativeSeconds(timestampSeconds) {
    if (!timestampSeconds) return "never";
    const seconds = Math.max(0, Math.floor((Date.now() / 1000) - timestampSeconds));
    return `${formatSeconds(seconds)} ago`;
}
function formatDurationMs(durationMs) {
    return formatSeconds(Math.max(0, Math.floor(durationMs / 1000)));
}
function formatSeconds(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;")
        .replaceAll("'", "&#39;");
}

function safeEqual(left, right) {
    const leftBuffer = Buffer.from(String(left ?? ""), "utf8");
    const rightBuffer = Buffer.from(String(right ?? ""), "utf8");
    if (leftBuffer.length !== rightBuffer.length) return false;
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function createLineParser({ maxBufferBytes = MAX_JSON_LINE_BYTES, onLine, onOverflow }) {
    let buffer = "";

    return {
        push(chunk) {
            buffer += chunk;
            if (Buffer.byteLength(buffer, "utf8") > maxBufferBytes) {
                buffer = "";
                if (typeof onOverflow === "function") onOverflow();
                return false;
            }
            buffer = flushJsonLines(buffer, onLine);
            return true;
        },
        clear() {
            buffer = "";
        }
    };
}
function flushJsonLines(buffer, onLine) {
    let index = buffer.indexOf("\n");
    while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) onLine(line);
        index = buffer.indexOf("\n");
    }
    return buffer;
}
function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function respondToHttpProbe(socket, line) {
    if (!line.startsWith("GET /")) return false;
    if (line.includes("HTTP/1.1")) {
        socket.end(`HTTP/1.1${HTTP_OK_RESPONSE}`);
        return true;
    }
    if (line.includes("HTTP/1.0")) {
        socket.end(`HTTP/1.0${HTTP_OK_RESPONSE}`);
        return true;
    }
    return false;
}

function writeJsonLine(socket, payload, final = false) {
    if (!socket || !socket.writable) return;
    const body = `${JSON.stringify(payload)}\n`;
    if (final) socket.end(body);
    else socket.write(body);
}

function bufferToBigIntLE(buffer) {
    const hex = Buffer.from(buffer).reverse().toString("hex") || "0";
    return BigInt(`0x${hex}`);
}

function bigIntToBufferBE(value, size) {
    const hex = value.toString(16).padStart(size * 2, "0");
    return Buffer.from(hex, "hex");
}

module.exports = { AccessControl, CircularBuffer, DEFAULT_ALGO, DEFAULT_ALGO_PERF, HTTP_OK_RESPONSE, MAX_JSON_LINE_BYTES, PROXY_VERSION, bigIntToBufferBE, bufferToBigIntLE, createLineParser, createLogger, escapeHtml, formatDurationMs, formatRelativeSeconds, humanHashrate, isPoolUsable, loadJsonFile, maybeUnref, normalizeConfig, parseArgs, randomId, respondToHttpProbe, safeEqual, writeJsonLine };
