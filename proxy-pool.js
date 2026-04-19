"use strict";

const net = require("node:net");
const tls = require("node:tls");

const {
    CircularBuffer,
    PROXY_VERSION,
    createLineParser,
    maybeUnref,
    respondToHttpProbe
} = require("./proxy-common");

class UpstreamPoolClient {
    constructor(options) {
        this.config = options.config;
        this.master = options.master;
        this.logger = options.logger;
        this.poolConfig = options.poolConfig;
        this.coinAdapter = options.coinAdapter;

        this.hostname = this.poolConfig.hostname;
        this.port = this.poolConfig.port;
        this.ssl = this.poolConfig.ssl === true;
        this.share = this.poolConfig.share;
        this.username = this.poolConfig.username;
        this.password = this.poolConfig.password;
        this.keepAlive = this.poolConfig.keepAlive !== false;
        this.default = this.poolConfig.default === true;
        this.devPool = this.poolConfig.devPool === true;
        this.coin = this.poolConfig.coin;
        this.blobType = this.poolConfig.blob_type;
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
            // Best effort cleanup.
        }
    }

    connect() {
        if (this.stopping) return;
        this.destroySocket();

        const socket = this.ssl
            ? tls.connect({
                host: this.hostname,
                port: this.port,
                servername: net.isIP(this.hostname) ? undefined : this.hostname,
                minVersion: "TLSv1.2",
                rejectUnauthorized: !this.poolConfig.allowSelfSignedSSL
            })
            : net.connect({
                host: this.hostname,
                port: this.port
            });

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
        if (this.poolId) payload.params.id = this.poolId;
        this.socket.write(`${JSON.stringify(payload)}\n`);
        this.sendLog.set(payload.id, { method, timestamp: Date.now() });
        this.logger.debug("pool", `Sent ${method} to ${this.hostname}`, payload.params);
        if (this.sendLog.size > 1024) {
            const cutoff = Date.now() - (10 * 60_000);
            for (const [id, entry] of this.sendLog) {
                if (entry.timestamp >= cutoff) break;
                this.sendLog.delete(id);
            }
        }
        return true;
    }

    login() {
        this.sendData("login", {
            login: this.username,
            pass: this.password,
            agent: `xmr-node-proxy/${PROXY_VERSION}`,
            algo: Object.keys(this.algos),
            "algo-perf": this.algosPerf
        });
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
        if (!this.lastCommonAlgoNotifyTime || (now - this.lastCommonAlgoNotifyTime) > 300_000 || prevAlgoKey !== nextAlgoKey) {
            this.logger.info("pool.algos", {
                host: this.hostname,
                algos: Object.keys(this.algos).join(","),
                perf: Object.entries(this.algosPerf).map(([algo, value]) => `${algo}:${value}`).join(",")
            });
            this.lastCommonAlgoNotifyTime = now;
        }

        if (this.connected) {
            this.sendData("getjob", {
                algo: Object.keys(this.algos),
                "algo-perf": this.algosPerf
            });
        }
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

        if (message.method === "job") {
            this.master.handlePoolTemplate(this, message.params);
            return;
        }

        const sendLog = message.id !== undefined ? this.sendLog.get(message.id) : null;

        if (message.error) {
            if (sendLog) this.sendLog.delete(message.id);

            if (this.isTemplatePendingError(message.error.message)) {
                this.logger.warn("pool.no_template_yet", {
                    host: this.hostname,
                    method: sendLog?.method || "request",
                    retryMs: 2000
                });
                this.destroySocket();
                this.scheduleConnect(2_000);
                return;
            }

            this.logger.error("pool.reply_error", {
                host: this.hostname,
                method: sendLog?.method,
                code: message.error.code,
                error: message.error.message
            });
            if (typeof message.error.message === "string" && message.error.message.includes("Unauthenticated")) {
                this.markUnavailable("upstream-unauthenticated");
                this.destroySocket();
                this.scheduleConnect();
            }
            return;
        }

        if (!sendLog) {
            this.logger.warn("pool.unknown_reply", {
                host: this.hostname,
                id: message.id
            });
            return;
        }
        this.sendLog.delete(message.id);

        switch (sendLog.method) {
        case "login":
            if (!message.result || !message.result.id || !message.result.job) {
                this.logger.error("pool.login_invalid", {
                    host: this.hostname
                });
                this.markUnavailable("invalid-login-response");
                this.destroySocket();
                this.scheduleConnect();
                return;
            }
            this.poolId = message.result.id;
            this.master.handlePoolTemplate(this, message.result.job);
            return;
        case "getjob":
            if (message.result !== null) {
                this.master.handlePoolTemplate(this, message.result);
            }
            return;
        case "keepalived":
        case "submit":
            return;
        default:
            this.logger.warn("pool.reply_unhandled", {
                host: this.hostname,
                method: sendLog.method
            });
        }
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
        if (shareData.resultHash) params.result = shareData.resultHash;
        if (shareData.pow) params.pow = shareData.pow;
        this.sendData("submit", params);
    }
}

module.exports = {
    UpstreamPoolClient
};
