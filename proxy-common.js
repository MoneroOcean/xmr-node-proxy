"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PROXY_VERSION = "0.29.0";
const DEFAULT_ALGO = ["rx/0"];
const DEFAULT_ALGO_PERF = { "rx/0": 1, "rx/loki": 1 };
const HTTP_OK_RESPONSE = " 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 19\r\n\r\nMining Proxy Online";
const MAX_JSON_LINE_BYTES = 128 * 1024;

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

    deq() {
        return this.items.pop();
    }

    get(index) {
        return this.items[index];
    }

    size() {
        return this.items.length;
    }

    clear() {
        this.items.length = 0;
    }

    sum() {
        if (this.items.length === 0) return 0;
        return this.items.reduce((total, item) => total + item, 0);
    }

    average(lastShareTimeSeconds, targetTimeSeconds = 15) {
        if (this.items.length === 0) return targetTimeSeconds * 1.5;
        const secondsSinceLastShare = Math.max(0, Math.round((Date.now() / 1000) - lastShareTimeSeconds));
        return (this.sum() + secondsSinceLastShare) / (this.items.length + 1);
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
    if (value === undefined) return "";
    if (value === null) return "null";
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        return String(value);
    }
    if (typeof value === "string") {
        return /^[a-zA-Z0-9._:/,@%+\-=]+$/.test(value) ? value : JSON.stringify(value);
    }
    return JSON.stringify(value);
}

function formatLogMeta(meta) {
    if (meta === undefined || meta === null) return "";
    if (typeof meta !== "object" || Array.isArray(meta)) {
        return formatLogValue(meta);
    }

    return Object.entries(meta)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${formatLogValue(value)}`)
        .join(" ");
}

function createLogger({ prefix = "", component = "", debug = process.env.DEBUG || "" } = {}) {
    const patterns = compileDebugPatterns(debug);
    const componentValue = component || normalizeLoggerComponent(prefix);
    const levelLabels = {
        info: "INF",
        warn: "WRN",
        error: "ERR",
        debug: "DBG"
    };

    function write(level, sink, message, meta, namespace = "") {
        const parts = [
            formatTimestamp(),
            levelLabels[level],
            componentValue || "-",
            namespace ? `${namespace} ${message}` : message
        ];
        const metaText = formatLogMeta(meta);
        if (metaText) parts.push(metaText);
        sink(parts.join(" "));
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
            return createLogger({ component: normalizeLoggerComponent(childComponent) || componentValue, debug });
        }
    };
}

function parseArgs(argv) {
    const result = {
        config: path.resolve(process.cwd(), "config.json"),
        standalone: false,
        workers: null
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--standalone") {
            result.standalone = true;
            continue;
        }
        if (arg === "--config" && argv[index + 1]) {
            result.config = path.resolve(process.cwd(), argv[index + 1]);
            index += 1;
            continue;
        }
        if (arg.startsWith("--config=")) {
            result.config = path.resolve(process.cwd(), arg.slice("--config=".length));
            continue;
        }
        if (arg === "--workers" && argv[index + 1]) {
            result.workers = Number.parseInt(argv[index + 1], 10);
            index += 1;
            continue;
        }
        if (arg.startsWith("--workers=")) {
            result.workers = Number.parseInt(arg.slice("--workers=".length), 10);
        }
    }

    if (result.workers !== null && (!Number.isInteger(result.workers) || result.workers <= 0)) {
        throw new Error(`Invalid worker count: ${result.workers}`);
    }

    return result;
}

function loadJsonFile(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolvePath(baseDir, value) {
    if (!value) return value;
    return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function normalizePoolConfig(poolConfig, fallbackCoin = "xmr") {
    const algo = poolConfig.algo
        ? (Array.isArray(poolConfig.algo) ? poolConfig.algo : [poolConfig.algo])
        : DEFAULT_ALGO;

    return {
        ...poolConfig,
        coin: poolConfig.coin || fallbackCoin,
        keepAlive: poolConfig.keepAlive !== false,
        allowSelfSignedSSL: poolConfig.allowSelfSignedSSL === true,
        default: poolConfig.default === true,
        devPool: poolConfig.devPool === true,
        algo,
        algo_perf: poolConfig.algo_perf && typeof poolConfig.algo_perf === "object"
            ? poolConfig.algo_perf
            : DEFAULT_ALGO_PERF,
        blob_type: poolConfig.blob_type || "cryptonote"
    };
}

function normalizePortConfig(portConfig, fallbackCoin = "xmr") {
    return {
        ...portConfig,
        coin: portConfig.coin || fallbackCoin,
        ssl: portConfig.ssl === true,
        diff: Number(portConfig.diff || portConfig.difficulty || 1)
    };
}

function normalizeConfig(rawConfig, configPath) {
    const configDir = path.dirname(configPath);
    const pools = Array.isArray(rawConfig.pools) ? rawConfig.pools.map((poolConfig) => normalizePoolConfig(poolConfig)) : [];
    const listeningPorts = Array.isArray(rawConfig.listeningPorts)
        ? rawConfig.listeningPorts.map((portConfig) => normalizePortConfig(portConfig))
        : [];

    const config = {
        ...rawConfig,
        pools,
        listeningPorts,
        accessControl: rawConfig.accessControl && typeof rawConfig.accessControl === "object"
            ? {
                enabled: rawConfig.accessControl.enabled === true,
                controlFile: resolvePath(configDir, rawConfig.accessControl.controlFile || "accessControl.json")
            }
            : { enabled: false, controlFile: resolvePath(configDir, "accessControl.json") },
        bindAddress: rawConfig.bindAddress || "0.0.0.0",
        httpEnable: rawConfig.httpEnable === true,
        httpAddress: rawConfig.httpAddress || "127.0.0.1",
        httpPort: Number(rawConfig.httpPort ?? 8081),
        refreshTime: Number(rawConfig.refreshTime ?? 30),
        theme: rawConfig.theme || "light",
        developerShare: Number(rawConfig.developerShare ?? 0),
        addressWorkerID: rawConfig.addressWorkerID === true,
        minerInactivityTime: Number(rawConfig.minerInactivityTime ?? 120),
        keepOfflineMiners: rawConfig.keepOfflineMiners === true || Number(rawConfig.keepOfflineMiners || 0) > 0,
        socketTimeoutMs: Number(rawConfig.socketTimeoutMs ?? 180000),
        maxJsonLineBytes: Number(rawConfig.maxJsonLineBytes ?? MAX_JSON_LINE_BYTES),
        tls: rawConfig.tls && typeof rawConfig.tls === "object"
            ? {
                keyPath: resolvePath(configDir, rawConfig.tls.keyPath || "cert.key"),
                certPath: resolvePath(configDir, rawConfig.tls.certPath || "cert.pem")
            }
            : {
                keyPath: resolvePath(configDir, "cert.key"),
                certPath: resolvePath(configDir, "cert.pem")
            },
        coinSettings: rawConfig.coinSettings && typeof rawConfig.coinSettings === "object"
            ? rawConfig.coinSettings
            : { xmr: { minDiff: 1, maxDiff: 10000000, shareTargetTime: 30 } }
    };

    validateConfig(config);
    return config;
}

function validateConfig(config) {
    if (!Array.isArray(config.pools) || config.pools.length === 0) {
        throw new Error("config.pools must contain at least one pool");
    }
    if (!Array.isArray(config.listeningPorts) || config.listeningPorts.length === 0) {
        throw new Error("config.listeningPorts must contain at least one listening port");
    }

    const defaultsByCoin = new Map();
    for (const pool of config.pools) {
        if (!pool.hostname || !Number.isInteger(Number(pool.port))) {
            throw new Error(`Invalid pool entry: ${JSON.stringify(pool)}`);
        }
        if (pool.default) defaultsByCoin.set(pool.coin, pool.hostname);
    }

    const coins = new Set(config.pools.filter((pool) => !pool.devPool).map((pool) => pool.coin));
    for (const coin of coins) {
        if (!defaultsByCoin.has(coin)) {
            throw new Error(`Missing default pool for coin ${coin}`);
        }
        if (!config.coinSettings[coin]) {
            throw new Error(`Missing coinSettings entry for coin ${coin}`);
        }
    }

    for (const portConfig of config.listeningPorts) {
        if (!Number.isInteger(Number(portConfig.port)) && portConfig.port !== 0) {
            throw new Error(`Invalid listening port: ${JSON.stringify(portConfig)}`);
        }
        const coinSettings = config.coinSettings[portConfig.coin];
        if (!coinSettings) {
            throw new Error(`Missing coinSettings entry for listening port coin ${portConfig.coin}`);
        }
    }
}

class AccessControl {
    constructor(config) {
        this.config = config;
        this.lastLoadedAt = 0;
        this.entries = Object.create(null);
    }

    reloadIfNeeded(force = false) {
        if (!this.config.accessControl.enabled) return;
        const now = Date.now();
        if (!force && now - this.lastLoadedAt < 60_000) return;
        this.lastLoadedAt = now;
        const rawEntries = loadJsonFile(this.config.accessControl.controlFile);
        if (!rawEntries || typeof rawEntries !== "object" || Array.isArray(rawEntries)) {
            throw new Error("access control file must contain a JSON object");
        }
        this.entries = rawEntries;
    }

    isAllowed(username, password) {
        if (!this.config.accessControl.enabled) return true;
        this.reloadIfNeeded();
        if (Object.prototype.hasOwnProperty.call(this.entries, username) && this.entries[username] === password) {
            return true;
        }
        this.reloadIfNeeded(true);
        return Object.prototype.hasOwnProperty.call(this.entries, username) && this.entries[username] === password;
    }
}

function randomId() {
    const min = 100000000000000n;
    const span = 900000000000000n;
    const randomValue = BigInt(`0x${crypto.randomBytes(8).toString("hex")}`) % span;
    return String(min + randomValue);
}

function humanHashrate(hashes, algo = "h/s") {
    const unit = algo === "c29s" || algo === "c29v" ? "G" : "H";
    let adjusted = hashes || 0;
    if (algo === "c29s") adjusted *= 32;
    if (algo === "c29v") adjusted *= 16;
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

function formatRelativeSeconds(timestampSeconds) {
    if (!timestampSeconds) return "never";
    const seconds = Math.max(0, Math.floor((Date.now() / 1000) - timestampSeconds));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

function formatDurationMs(durationMs) {
    const seconds = Math.max(0, Math.floor(durationMs / 1000));
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
            let index = buffer.indexOf("\n");
            while (index !== -1) {
                const line = buffer.slice(0, index).trim();
                buffer = buffer.slice(index + 1);
                if (line) onLine(line);
                index = buffer.indexOf("\n");
            }
            return true;
        },
        clear() {
            buffer = "";
        }
    };
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

module.exports = {
    AccessControl,
    CircularBuffer,
    DEFAULT_ALGO,
    DEFAULT_ALGO_PERF,
    HTTP_OK_RESPONSE,
    MAX_JSON_LINE_BYTES,
    PROXY_VERSION,
    bigIntToBufferBE,
    bufferToBigIntLE,
    createLineParser,
    createLogger,
    escapeHtml,
    formatDurationMs,
    formatRelativeSeconds,
    humanHashrate,
    loadJsonFile,
    maybeUnref,
    normalizeConfig,
    parseArgs,
    randomId,
    respondToHttpProbe,
    safeEqual,
    writeJsonLine
};
