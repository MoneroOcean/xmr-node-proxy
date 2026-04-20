"use strict";

const {
    CircularBuffer,
    createLineParser,
    randomId,
    respondToHttpProbe,
    writeJsonLine
} = require("./common");

const NONCE_32_HEX = /^[0-9a-f]{8}$/;
const NONCE_64_HEX = /^[0-9a-f]{16}$/;

class MinerSession {
    constructor(options) {
        this.runtime = options.runtime;
        this.id = options.id;
        this.socket = options.socket;
        this.pushMessage = options.pushMessage;
        this.portData = options.portData;
        this.protocol = "default";
        this.coins = options.coins;
        this.difficultySettings = options.difficultySettings;
        this.connectTime = Date.now();
        this.lastShareTime = Date.now() / 1000;
        this.shares = 0;
        this.blocks = 0;
        this.hashes = 0;
        this.newDiff = null;
        this.incremented = false;
        this.fixedDiff = false;
        this.validJobs = new CircularBuffer(5);
        this.cachedJob = null;

        const loginDiffSplit = options.params.login ? options.params.login.split("+") : [""];
        const pass = options.params.pass || "x";
        const passAlgoSplit = pass.split("~");
        const passSplit = passAlgoSplit[0].split(":");

        this.login = loginDiffSplit[0];
        this.user = loginDiffSplit[0];
        this.password = passSplit[0];
        this.agent = options.params.agent || "";
        this.ip = options.ip;
        this.identifier = options.runtime.config.addressWorkerID ? this.user : passSplit[0];
        this.logString = this.identifier && this.identifier !== "x" ? `${this.identifier} (${this.ip})` : this.ip;
        this.difficulty = Number(options.portData.diff);
        this.error = "";
        this.validMiner = true;

        if (passAlgoSplit.length === 2) {
            const algoName = passAlgoSplit[1];
            options.params.algo = [algoName];
            options.params["algo-perf"] = { [algoName]: 1 };
        }

        if (Array.isArray(options.params.algo)) {
            this.algos = {};
            for (const algo of options.params.algo) {
                this.algos[algo] = 1;
            }
        } else {
            this.algos = null;
        }
        this.algosPerf = options.params["algo-perf"] || null;

        this.pool = this.runtime.chooseInitialPool();
        if (loginDiffSplit.length === 2) {
            this.fixedDiff = true;
            this.difficulty = Number(loginDiffSplit[1]);
        } else if (loginDiffSplit.length > 2) {
            this.invalidate("Too many options in the login field");
            return;
        }

        if (!Number.isFinite(this.difficulty) || this.difficulty <= 0) {
            this.invalidate("Invalid difficulty");
            return;
        }

        if (!this.pool) {
            this.invalidate("No active pool available");
            return;
        }

        if (!this.runtime.isAllowedLogin(this.user, this.password)) {
            this.invalidate("Unauthorized access");
            return;
        }

        const poolState = this.runtime.pools.get(this.pool);
        if (!poolState || !poolState.activeBlockTemplate) {
            this.invalidate("No active block template");
            return;
        }

        if (this.algos) {
            const blockTemplate = poolState.activeBlockTemplate;
            const blockVersion = blockTemplate.blob ? parseInt(blockTemplate.blob.slice(0, 2), 16) : 0;
            const poolAlgo = poolState.coins.detectAlgo(poolState.defaultAlgoSet, blockVersion);
            if (!(poolAlgo in this.algos)) {
                this.runtime.logger.warn(`Miner ${this.logString} does not support ${poolAlgo}`);
            }
        }

        this.heartbeat();
    }

    invalidate(reason) {
        this.validMiner = false;
        this.error = reason;
    }

    heartbeat() {
        this.lastContact = Date.now();
    }

    getNewJob(bypassCache = false) {
        const poolState = this.runtime.pools.get(this.pool);
        return this.coins.getJob(this, poolState.activeBlockTemplate, bypassCache);
    }

    pushNewJob(bypassCache = false) {
        const job = this.getNewJob(bypassCache);
        if (this.protocol === "grin") {
            this.pushMessage({ method: "getjobtemplate", result: job });
        } else {
            this.pushMessage({ method: "job", params: job });
        }
    }

    setNewDiff(difficulty) {
        this.newDiff = Math.round(difficulty);
        if (this.newDiff > this.difficultySettings.maxDiff) this.newDiff = this.difficultySettings.maxDiff;
        if (this.newDiff < this.difficultySettings.minDiff) this.newDiff = this.difficultySettings.minDiff;
        if (this.difficulty === this.newDiff) return false;
        this.runtime.logger.debug("diff", `Difficulty change for ${this.logString}`, { newDiff: this.newDiff });
        return true;
    }

    updateDifficulty() {
        if (this.hashes <= 0 || this.fixedDiff) return;
        const elapsedSeconds = Math.max(1, Math.floor((Date.now() - this.connectTime) / 1000));
        const newDiff = Math.floor(this.hashes / elapsedSeconds) * this.difficultySettings.shareTargetTime;
        if (this.setNewDiff(newDiff)) this.pushNewJob();
    }

    stats() {
        const elapsedSeconds = Math.max(1, Math.floor((Date.now() - this.connectTime) / 1000));
        return {
            active: !this.socket.destroyed,
            shares: this.shares,
            blocks: this.blocks,
            hashes: this.hashes,
            avgSpeed: this.hashes / elapsedSeconds,
            diff: this.difficulty,
            connectTime: this.connectTime,
            lastContact: Math.floor(this.lastContact / 1000),
            lastShare: this.lastShareTime,
            pool: this.pool,
            id: this.id,
            identifier: this.identifier,
            ip: this.ip,
            agent: this.agent,
            algos: this.algos,
            algos_perf: this.algosPerf,
            logString: this.logString
        };
    }
}

class MinerProtocol {
    constructor(runtime) {
        this.runtime = runtime;
    }

    attachSocket(socket, portData) {
        socket.setKeepAlive(true);
        socket.setEncoding("utf8");
        socket.setTimeout(this.runtime.config.socketTimeoutMs, () => {
            socket.destroy(new Error("Miner socket timeout"));
        });

        const pushMessage = (payload) => {
            if (socket.destroyed) return;
            writeJsonLine(socket, { jsonrpc: "2.0", ...payload });
        };

        const parser = createLineParser({
            maxBufferBytes: this.runtime.config.maxJsonLineBytes,
            onOverflow: () => {
                this.runtime.logger.warn("miner.line_too_large", {
                    remote: socket.remoteAddress,
                    limit: this.runtime.config.maxJsonLineBytes
                });
                socket.destroy(new Error("Packet exceeded max line length"));
            },
            onLine: (line) => {
                if (respondToHttpProbe(socket, line)) return;
                let jsonData;
                try {
                    jsonData = JSON.parse(line);
                } catch (_error) {
                    this.runtime.logger.warn("miner.bad_json", {
                        remote: socket.remoteAddress
                    });
                    socket.destroy(new Error("Malformed miner JSON"));
                    return;
                }
                this.handleMessage(socket, jsonData, portData, pushMessage);
            }
        });

        socket.on("data", (chunk) => parser.push(chunk));
        socket.on("error", (error) => {
            if (error.code !== "ECONNRESET") {
                this.runtime.logger.warn("miner.socket_error", {
                    remote: socket.remoteAddress,
                    error: error.message
                });
            }
        });
        socket.on("close", () => {
            const minerId = socket.minerId;
            if (!minerId) return;
            const miner = this.runtime.activeMiners.get(minerId);
            if (!miner) return;
            if (!this.runtime.config.keepOfflineMiners) {
                this.runtime.activeMiners.delete(minerId);
                this.runtime.removeMinerStat(minerId);
            }
        });
    }

    sendReply(socket, request, error, result, final = false) {
        const payload = {
            jsonrpc: "2.0",
            id: request.id,
            error: error ? { code: -1, message: error } : null,
            result
        };
        if (request.id === "Stratum") payload.method = request.method;
        writeJsonLine(socket, payload, final);
    }

    getParams(params, reject) {
        if (params && typeof params === "object") return params;
        reject("No params specified");
        return null;
    }

    getMiner(minerId, reject) {
        const miner = this.runtime.activeMiners.get(minerId || "");
        if (!miner) reject("Unauthenticated");
        return miner;
    }

    handleMessage(socket, request, portData, pushMessage) {
        if (!request || typeof request !== "object") return;
        if (!("id" in request)) {
            this.runtime.logger.warn("miner.rpc_missing_id", {
                remote: socket.remoteAddress
            });
            return;
        }
        if (typeof request.method !== "string") {
            this.runtime.logger.warn("miner.rpc_missing_method", {
                remote: socket.remoteAddress
            });
            return;
        }

        const reply = (error, result) => this.sendReply(socket, request, error, result, false);
        const replyFinal = (error) => this.sendReply(socket, request, error, null, true);

        switch (request.method) {
        case "login":
            this.handleLogin(socket, request, portData, pushMessage, reply, replyFinal);
            return;
        case "getjobtemplate":
            this.handleGetJobTemplate(socket, reply);
            return;
        case "getjob":
            this.handleGetJob(request.params, reply, replyFinal);
            return;
        case "submit":
            this.handleSubmit(socket, request.params, reply, replyFinal);
            return;
        case "keepalive":
        case "keepalived":
            this.handleKeepalive(socket, request.params, reply, replyFinal);
            return;
        default:
            reply("Unknown method");
        }
    }

    handleLogin(socket, request, portData, pushMessage, reply, replyFinal) {
        const params = this.getParams(request.params, replyFinal);
        if (!params) return;
        const defaultPool = this.runtime.defaultPool || Array.from(this.runtime.pools.keys())[0];
        const coins = this.runtime.pools.get(defaultPool)?.coins;
        const difficultySettings = this.runtime.config.difficultySettings;
        const miner = new MinerSession({
            runtime: this.runtime,
            id: randomId(),
            socket,
            pushMessage,
            portData,
            params,
            ip: socket.remoteAddress,
            coins,
            difficultySettings
        });

        if (!miner.validMiner) {
            this.runtime.logger.warn("miner.login_rejected", {
                miner: miner.logString || socket.remoteAddress,
                reason: miner.error
            });
            replyFinal(miner.error);
            return;
        }

        socket.minerId = miner.id;
        this.runtime.activeMiners.set(miner.id, miner);
        if (this.runtime.config.keepOfflineMiners) {
            for (const [minerId, activeMiner] of this.runtime.activeMiners) {
                if (minerId === miner.id) continue;
                if (!activeMiner.socket.destroyed) continue;
                if (activeMiner.identifier === miner.identifier && activeMiner.ip === miner.ip && activeMiner.agent === miner.agent) {
                    this.runtime.activeMiners.delete(minerId);
                }
            }
        }

        miner.protocol = request.id === "Stratum" ? "grin" : "default";
        this.runtime.reportMinerStat(miner.id, miner);
        reply(null, miner.protocol === "grin" ? "ok" : {
            id: miner.id,
            job: miner.getNewJob(),
            status: "OK"
        });
    }

    handleGetJobTemplate(socket, reply) {
        const miner = this.getMiner(socket.minerId, reply);
        if (!miner) return;
        miner.protocol = "grin";
        miner.heartbeat();
        reply(null, miner.getNewJob());
    }

    handleGetJob(params, reply, replyFinal) {
        const requestParams = this.getParams(params, replyFinal);
        if (!requestParams) return;
        const miner = this.getMiner(requestParams.id, reply);
        if (!miner) return;
        miner.heartbeat();
        reply(null, miner.getNewJob());
    }

    handleSubmit(socket, params, reply, replyFinal) {
        params = this.getParams(params, replyFinal);
        if (!params) return;

        const miner = this.getMiner(params.id || socket.minerId, reply);
        if (!miner) return;
        miner.heartbeat();

        if (typeof params.job_id === "number") {
            params.job_id = String(params.job_id);
        }

        const job = miner.validJobs.toarray().find((entry) => entry.id === params.job_id);
        if (!job) {
            reply("Invalid job id");
            return;
        }

        const blobTypeNum = job.blob_type;
        const isGrin = miner.coins.blobTypeGrin(blobTypeNum);
        const badNonce = isGrin
            ? (!Number.isInteger(params.nonce) || !Array.isArray(params.pow) || params.pow.length !== miner.coins.c29ProofSize(blobTypeNum))
            : (typeof params.nonce !== "string" || !(miner.coins.nonceSize(blobTypeNum) === 8 ? NONCE_64_HEX.test(params.nonce) : NONCE_32_HEX.test(params.nonce)));

        if (badNonce) {
            this.runtime.logger.warn("share.bad_nonce", {
                miner: miner.logString,
                job: params.job_id
            });
            reply("Duplicate share");
            return;
        }

        const nonceKey = isGrin ? params.pow.join(":") : params.nonce;
        if (job.submissions.includes(nonceKey)) {
            this.runtime.logger.warn("share.duplicate", {
                miner: miner.logString,
                job: params.job_id,
                nonce: nonceKey
            });
            reply("Duplicate share");
            return;
        }
        job.submissions.push(nonceKey);

        const poolState = this.runtime.pools.get(miner.pool);
        const blockTemplate = poolState.activeBlockTemplate && poolState.activeBlockTemplate.id === job.templateID
            ? poolState.activeBlockTemplate
            : poolState.pastBlockTemplates.toarray().find((entry) => entry.id === job.templateID);

        if (!blockTemplate) {
            this.runtime.logger.warn("share.expired", {
                miner: miner.logString,
                height: job.height
            });
            if (miner.incremented === false) {
                miner.newDiff = miner.difficulty + 1;
                miner.incremented = true;
            } else {
                miner.newDiff = Math.max(1, miner.difficulty - 1);
                miner.incremented = false;
            }
            miner.pushNewJob(true);
            reply("Block expired");
            return;
        }

        const accepted = miner.coins.processShare(miner, job, blockTemplate, params, {
            onPoolShare: (data) => {
                this.runtime.sendToMaster({
                    type: "shareFind",
                    host: miner.pool,
                    data
                });
            },
            warn: (message, meta) => this.runtime.logger.warn(message, meta),
            info: (message, meta) => this.runtime.logger.info(message, meta)
        });

        if (accepted === null) {
            reply("Throttled down share submission (please increase difficulty)");
            return;
        }
        if (!accepted) {
            reply("Low difficulty share");
            return;
        }

        miner.lastShareTime = Date.now() / 1000;
        this.runtime.reportMinerStat(miner.id, miner);
        if (miner.protocol === "grin") reply(null, "ok");
        else reply(null, { status: "OK" });
    }

    handleKeepalive(socket, params, reply, replyFinal) {
        params = this.getParams(params, replyFinal);
        if (!params) return;
        const miner = this.getMiner(socket.minerId || params.id, replyFinal);
        if (!miner) return;
        miner.heartbeat();
        this.runtime.reportMinerStat(miner.id, miner);
        reply(null, { status: "KEEPALIVED" });
    }
}

module.exports = {
    MinerProtocol,
    MinerSession
};
