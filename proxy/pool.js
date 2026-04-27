"use strict";

const net = require("node:net");
const tls = require("node:tls");

const {
    CircularBuffer,
    PROXY_VERSION,
    createLineParser,
    maybeUnref,
    respondToHttpProbe
} = require("./common");

class UpstreamPoolClient {
    constructor(options) {
        this.config = options.config;
        this.master = options.master;
        this.logger = options.logger;
        this.poolConfig = options.poolConfig;
        this.coins = options.coins;

        this.hostname = this.poolConfig.hostname;
        this.port = this.poolConfig.port;
        this.ssl = this.poolConfig.ssl === true;
        this.share = this.poolConfig.share;
        this.username = this.poolConfig.username;
        this.password = this.poolConfig.password;
        this.keepAlive = this.poolConfig.keepAlive !== false;
        this.devPool = this.poolConfig.devPool === true;
        this.blobType = this.poolConfig.blob_type;
        this.algoMinTime = this.poolConfig.algo_min_time;
        this.defaultAlgoSet = Object.fromEntries(this.poolConfig.algo.map((algo) => [algo, 1]));
        this.defaultAlgosPerf = { ...this.poolConfig.algo_perf };
        this.algos = { ...this.defaultAlgoSet };
        this.algosPerf = { ...this.defaultAlgosPerf };
        this.workerJobs = new Map();
        this.pastBlockTemplates = new CircularBuffer(4);
        this.sendLog = new Map();
        this.sendId = 1;
        this.poolId = null;
        this.socket = null;
        this.lineParser = null;
        this.activeBlockTemplate = null;
        this.enabled = true;
        this.connected = false;
        this.stopping = false;
        this.reconnectTimer = null;
        this.keepAliveTimer = null;
        this.lastCommonAlgoNotifyTime = 0;
    }

    isTemplatePendingError(errorMessage) {
        return typeof errorMessage === "string"
            && errorMessage.includes("No block template yet. Please wait.");
    }

    start() {
        this.scheduleConnect(0);
        this.keepAliveTimer = maybeUnref(setInterval(() => {
            if (this.keepAlive && this.connected && this.master.isPoolUsable(this.hostname)) {
                this.sendData("keepalived");
            }
        }, 30_000));
    }

    stop() {
        this.stopping = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
        this.reconnectTimer = null;
        this.keepAliveTimer = null;
        this.destroySocket();
    }

    scheduleConnect(delayMs = 30_000) {
        if (this.stopping || this.reconnectTimer) return;
        this.reconnectTimer = maybeUnref(setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delayMs));
    }

    destroySocket() {
        if (!this.socket) return;
        const socket = this.socket;
        this.socket = null;
        this.connected = false;
        socket.removeAllListeners();
        try {
            socket.end();
            socket.destroy();
        } catch (_error) {
            // Ignore close failures after dropping the pool socket reference.
        }
    }

    connect() {
        if (this.stopping) return;
        this.destroySocket();
        const socket = this.createSocket();
        this.socket = socket;
        socket.setKeepAlive(true);
        socket.setEncoding("utf8");
        socket.setTimeout(this.config.socketTimeoutMs, () => {
            socket.destroy(new Error("Pool socket timeout"));
        });

        this.lineParser = createLineParser({
            maxBufferBytes: this.config.maxJsonLineBytes,
            onOverflow: () => {
                this.logger.warn("pool.line_too_large", {
                    host: this.hostname,
                    limit: this.config.maxJsonLineBytes
                });
                socket.destroy(new Error("Pool response exceeded max buffer"));
            },
            onLine: (line) => this.handleLine(line)
        });

        socket.on(this.ssl ? "secureConnect" : "connect", () => {
            this.connected = true;
            this.enabled = true;
            this.poolId = null;
            this.logger.info("pool.connect", {
                host: this.hostname,
                port: this.port,
                tls: this.ssl
            });
            this.master.broadcast({ type: "enablePool", pool: this.hostname });
            this.login();
        });
        socket.on("data", (chunk) => this.lineParser.push(chunk));
        socket.on("error", (error) => {
            if (this.stopping) return;
            this.logger.warn("pool.socket_error", {
                host: this.hostname,
                error: error.message
            });
        });
        socket.on("close", () => {
            if (this.stopping) return;
            this.markUnavailable("socket-closed");
            this.scheduleConnect();
        });
    }
    createSocket() {
        if (!this.ssl) return net.connect({ host: this.hostname, port: this.port });
        return tls.connect({
            host: this.hostname,
            port: this.port,
            servername: net.isIP(this.hostname) ? undefined : this.hostname,
            minVersion: "TLSv1.2",
            rejectUnauthorized: !this.poolConfig.allowSelfSignedSSL
        });
    }
    markUnavailable(reason) {
        this.connected = false;
        this.enabled = false;
        this.logger.warn("pool.down", {
            host: this.hostname,
            reason
        });
        this.master.broadcast({ type: "disablePool", pool: this.hostname });
    }

    sendData(method, params = {}) {
        if (!this.socket || !this.socket.writable) return false;
        const payload = {
            method,
            id: this.sendId++,
            params: { ...params }
        };
        this.applyPoolId(payload);
        this.socket.write(`${JSON.stringify(payload)}\n`);
        this.sendLog.set(payload.id, { method, timestamp: Date.now() });
        this.logger.debug("pool", `Sent ${method} to ${this.hostname}`, payload.params);
        if (this.sendLog.size > 1024) this.pruneSendLog();
        return true;
    }
    applyPoolId(payload) {
        if (this.poolId) payload.params.id = this.poolId;
    }
    pruneSendLog() {
        const cutoff = Date.now() - (10 * 60_000);
        for (const [id, entry] of this.sendLog) {
            if (entry.timestamp >= cutoff) break;
            this.sendLog.delete(id);
        }
    }
    login() {
        this.sendData("login", {
            login: this.username,
            pass: this.password,
            agent: `xmr-node-proxy/${PROXY_VERSION}`,
            ...this.currentAlgoParams()
        });
    }

    currentAlgoParams() {
        const params = {
            algo: Object.keys(this.algos),
            "algo-perf": this.algosPerf
        };
        if (this.algoMinTime !== undefined) params["algo-min-time"] = this.algoMinTime;
        return params;
    }

    updateAlgoPerf(algos, algosPerf) {
        const prevAlgoKey = JSON.stringify(Object.keys(this.algos));
        const prevPerfKey = JSON.stringify(this.algosPerf);
        const nextAlgoKey = JSON.stringify(Object.keys(algos));
        const nextPerfKey = JSON.stringify(algosPerf);
        if (prevAlgoKey === nextAlgoKey && prevPerfKey === nextPerfKey) return;
        this.algos = { ...algos };
        this.algosPerf = { ...algosPerf };
        const now = Date.now();
        this.logAlgoChangeIfNeeded(now, prevAlgoKey, nextAlgoKey);
        if (this.connected) this.sendData("getjob", this.currentAlgoParams());
    }
    logAlgoChangeIfNeeded(now, prevAlgoKey, nextAlgoKey) {
        if (this.shouldLogAlgoChange(now, prevAlgoKey, nextAlgoKey)) this.logAlgoChange(now);
    }
    shouldLogAlgoChange(now, prevAlgoKey, nextAlgoKey) {
        return !this.lastCommonAlgoNotifyTime || (now - this.lastCommonAlgoNotifyTime) > 300_000 || prevAlgoKey !== nextAlgoKey;
    }
    logAlgoChange(now) {
        this.logger.info("pool.algos", {
            host: this.hostname,
            algos: Object.keys(this.algos).join(","),
            perf: Object.entries(this.algosPerf).map(([algo, value]) => `${algo}:${value}`).join(","),
            algoMinTime: this.algoMinTime
        });
        this.lastCommonAlgoNotifyTime = now;
    }
    handleLine(line) {
        if (respondToHttpProbe(this.socket, line)) return;
        let message;
        try {
            message = JSON.parse(line);
        } catch (_error) {
            this.logger.warn("pool.bad_json", {
                host: this.hostname
            });
            this.socket.destroy(new Error("Invalid pool JSON"));
            return;
        }
        this.handleMessage(message);
    }
    handleMessage(message) {
        this.logger.debug("pool", `Received message from ${this.hostname}`, message);
        if (this.handleJobNotify(message)) return;
        const sendLog = this.getSendLog(message);
        if (message.error) return this.handleErrorReply(message, sendLog);
        if (!sendLog) return this.logger.warn("pool.unknown_reply", { host: this.hostname, id: message.id });
        this.sendLog.delete(message.id);
        this.handleSuccessReply(message, sendLog);
    }
    getSendLog(message) {
        if (message.id === undefined) return null;
        return this.sendLog.get(message.id);
    }
    handleJobNotify(message) {
        if (!this.isJobNotify(message)) return false;
        this.master.handlePoolTemplate(this, message.params);
        return true;
    }
    isJobNotify(message) {
        return message.method === "job";
    }
    handleErrorReply(message, sendLog) {
        if (sendLog) this.sendLog.delete(message.id);
        if (this.handlePendingTemplateError(message, sendLog)) return;
        this.logger.error("pool.reply_error", {
            host: this.hostname,
            method: sendLog?.method,
            code: message.error.code,
            error: message.error.message
        });
        if (isUnauthenticatedError(message.error.message)) this.reconnectUnavailable("upstream-unauthenticated");
    }
    handlePendingTemplateError(message, sendLog) {
        if (!this.isTemplatePendingError(message.error.message)) return false;
        this.logger.warn("pool.no_template_yet", { host: this.hostname, method: sendLog?.method || "request", retryMs: 2000 });
        this.destroySocket();
        this.scheduleConnect(2_000);
        return true;
    }
    reconnectUnavailable(reason) {
        this.markUnavailable(reason);
        this.destroySocket();
        this.scheduleConnect();
    }
    handleSuccessReply(message, sendLog) {
        if (sendLog.method === "login") {
            this.handleLoginReply(message);
            return;
        }
        if (sendLog.method === "getjob") {
            this.handleGetJobReply(message);
            return;
        }
        if (["keepalived", "submit"].includes(sendLog.method)) {
            return;
        }
        this.logger.warn("pool.reply_unhandled", { host: this.hostname, method: sendLog.method });
    }
    handleGetJobReply(message) {
        if (message.result !== null) this.master.handlePoolTemplate(this, message.result);
    }
    handleLoginReply(message) {
        if (!message.result || !message.result.id || !message.result.job) {
            this.logger.error("pool.login_invalid", { host: this.hostname });
            this.reconnectUnavailable("invalid-login-response");
            return;
        }
        this.poolId = message.result.id;
        this.master.handlePoolTemplate(this, message.result.job);
    }
    sendShare(workerId, shareData) {
        const jobs = this.workerJobs.get(workerId);
        if (!jobs) return;
        const job = jobs.toarray().find((entry) => entry.id === shareData.btID);
        if (!job) return;

        const params = {
            job_id: job.masterJobID,
            nonce: shareData.nonce,
            workerNonce: shareData.workerNonce,
            poolNonce: job.poolNonce
        };
        copyOptionalShareParams(params, shareData);
        this.sendData("submit", params);
    }
}
function copyOptionalShareParams(params, shareData) {
    if (shareData.resultHash) params.result = shareData.resultHash;
    if (shareData.pow) params.pow = shareData.pow;
}
function isUnauthenticatedError(message) {
    return typeof message === "string" && message.includes("Unauthenticated");
}
module.exports = { UpstreamPoolClient };
