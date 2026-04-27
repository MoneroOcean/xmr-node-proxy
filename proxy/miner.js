"use strict";

const { CircularBuffer, createLineParser, randomId, respondToHttpProbe, writeJsonLine } = require("./common");
const NONCE_32_HEX = /^[0-9a-f]{8}$/;
const NONCE_64_HEX = /^[0-9a-f]{16}$/;
const METHOD_HANDLERS = new Map([
    ["login", (protocol, socket, request, portData, pushMessage, reply, replyFinal) => protocol.handleLogin(socket, request, portData, pushMessage, reply, replyFinal)],
    ["getjobtemplate", (protocol, socket, _request, _portData, _pushMessage, reply) => protocol.handleGetJobTemplate(socket, reply)],
    ["getjob", (protocol, _socket, request, _portData, _pushMessage, reply, replyFinal) => protocol.handleGetJob(request.params, reply, replyFinal)],
    ["submit", (protocol, socket, request, _portData, _pushMessage, reply, replyFinal) => protocol.handleSubmit(socket, request.params, reply, replyFinal)],
    ["keepalive", (protocol, socket, request, _portData, _pushMessage, reply, replyFinal) => protocol.handleKeepalive(socket, request.params, reply, replyFinal)],
    ["keepalived", (protocol, socket, request, _portData, _pushMessage, reply, replyFinal) => protocol.handleKeepalive(socket, request.params, reply, replyFinal)]
]);
class MinerSession {
    constructor(options) {
        Object.assign(this, createMinerBaseState(options));
        const loginDiffSplit = options.params.login ? options.params.login.split("+") : [""];
        const passAlgoSplit = this.applyLoginParams(options, loginDiffSplit);
        applyPasswordAlgo(options.params, passAlgoSplit);
        this.algos = buildAlgoSet(options.params.algo);
        this.algosPerf = options.params["algo-perf"] || null;
        this.pool = this.runtime.chooseInitialPool();
        if (!this.applyLoginDifficulty(loginDiffSplit)) return;
        this.finalizeLogin();
    }
    applyLoginParams(options, loginDiffSplit) {
        const pass = options.params.pass || "x";
        const passAlgoSplit = pass.split("~");
        const passSplit = passAlgoSplit[0].split(":");

        this.login = loginDiffSplit[0];
        this.user = loginDiffSplit[0];
        this.password = passSplit[0];
        this.agent = options.params.agent || "";
        this.ip = options.ip;
        this.identifier = options.runtime.config.addressWorkerID ? this.user : passSplit[0];
        this.logString = minerLogString(this.identifier, this.ip);
        this.difficulty = Number(options.portData.diff);
        this.error = "";
        this.validMiner = true;
        return passAlgoSplit;
    }
    finalizeLogin() {
        const poolState = this.validateLogin();
        if (!poolState) return;
        if (this.algos) warnUnsupportedAlgo(this, poolState);
        this.heartbeat();
    }
    applyLoginDifficulty(loginDiffSplit) {
        if (loginDiffSplit.length === 2) {
            this.fixedDiff = true;
            this.difficulty = Number(loginDiffSplit[1]);
            return true;
        }
        if (loginDiffSplit.length <= 2) return true;
        this.invalidate("Too many options in the login field");
        return false;
    }
    validateLogin() {
        if (!Number.isFinite(this.difficulty) || this.difficulty <= 0) return this.invalidateAndNull("Invalid difficulty");
        if (!this.pool) return this.invalidateAndNull("No active pool available");
        return this.validateLoginPool();
    }
    validateLoginPool() {
        if (!this.runtime.isAllowedLogin(this.user, this.password)) return this.invalidateAndNull("Unauthorized access");
        const poolState = this.runtime.pools.get(this.pool);
        if (!poolState || !poolState.activeBlockTemplate) return this.invalidateAndNull("No active block template");
        return poolState;
    }
    invalidateAndNull(reason) {
        this.invalidate(reason);
        return null;
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
function createMinerBaseState(options) {
    return {
        runtime: options.runtime,
        id: options.id,
        socket: options.socket,
        pushMessage: options.pushMessage,
        portData: options.portData,
        protocol: "default",
        coins: options.coins,
        difficultySettings: options.difficultySettings,
        connectTime: Date.now(),
        lastShareTime: Date.now() / 1000,
        shares: 0,
        blocks: 0,
        hashes: 0,
        newDiff: null,
        incremented: false,
        fixedDiff: false,
        validJobs: new CircularBuffer(5),
        cachedJob: null
    };
}
function applyPasswordAlgo(params, passAlgoSplit) {
    if (passAlgoSplit.length !== 2) return;
    const algoName = passAlgoSplit[1];
    params.algo = [algoName];
    params["algo-perf"] = { [algoName]: 1 };
}
function minerLogString(identifier, ip) {
    if (!identifier) return ip;
    if (identifier === "x") return ip;
    return `${identifier} (${ip})`;
}
function buildAlgoSet(algos) {
    if (!Array.isArray(algos)) return null;
    const algoSet = {};
    for (const algo of algos) algoSet[algo] = 1;
    return algoSet;
}
function warnUnsupportedAlgo(miner, poolState) {
    const blockTemplate = poolState.activeBlockTemplate;
    const blockVersion = blockTemplate.blob ? parseInt(blockTemplate.blob.slice(0, 2), 16) : 0;
    const poolAlgo = poolState.coins.detectAlgo(poolState.defaultAlgoSet, blockVersion);
    if (!(poolAlgo in miner.algos)) miner.runtime.logger.warn(`Miner ${miner.logString} does not support ${poolAlgo}`);
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
        if (!this.validateRequest(socket, request)) return;
        const reply = (error, result) => this.sendReply(socket, request, error, result, false);
        const replyFinal = (error) => this.sendReply(socket, request, error, null, true);
        this.dispatchMethod(socket, request, portData, pushMessage, reply, replyFinal);
    }
    dispatchMethod(socket, request, portData, pushMessage, reply, replyFinal) {
        const handler = this.getMethodHandler(request.method);
        if (handler) handler(this, socket, request, portData, pushMessage, reply, replyFinal);
        else reply("Unknown method");
    }
    validateRequest(socket, request) {
        if (!("id" in request)) {
            this.runtime.logger.warn("miner.rpc_missing_id", { remote: socket.remoteAddress });
            return false;
        }
        if (typeof request.method === "string") return true;
        this.runtime.logger.warn("miner.rpc_missing_method", { remote: socket.remoteAddress });
        return false;
    }
    getMethodHandler(method) {
        return METHOD_HANDLERS.get(method);
    }
    handleLogin(socket, request, portData, pushMessage, reply, replyFinal) {
        const params = this.getParams(request.params, replyFinal);
        if (!params) return;
        const miner = this.createMinerSession(socket, portData, pushMessage, params);
        if (!this.acceptLogin(miner, socket, replyFinal)) return;
        this.registerMiner(socket, request, miner);
        reply(null, this.loginReply(miner));
    }
    registerMiner(socket, request, miner) {
        socket.minerId = miner.id;
        this.runtime.activeMiners.set(miner.id, miner);
        if (this.runtime.config.keepOfflineMiners) this.removeDuplicateOfflineMiners(miner);
        miner.protocol = request.id === "Stratum" ? "grin" : "default";
        this.runtime.reportMinerStat(miner.id, miner);
    }
    createMinerSession(socket, portData, pushMessage, params) {
        const defaultPool = this.runtime.defaultPool || Array.from(this.runtime.pools.keys())[0];
        return new MinerSession({
            runtime: this.runtime,
            id: randomId(),
            socket,
            pushMessage,
            portData,
            params,
            ip: socket.remoteAddress,
            coins: this.runtime.pools.get(defaultPool)?.coins,
            difficultySettings: this.runtime.config.difficultySettings
        });
    }
    loginReply(miner) {
        if (miner.protocol === "grin") return "ok";
        return {
            id: miner.id,
            job: miner.getNewJob(),
            status: "OK"
        };
    }
    acceptLogin(miner, socket, replyFinal) {
        if (miner.validMiner) return true;
        this.runtime.logger.warn("miner.login_rejected", {
            miner: miner.logString || socket.remoteAddress,
            reason: miner.error
        });
        replyFinal(miner.error);
        return false;
    }
    removeDuplicateOfflineMiners(miner) {
        for (const [minerId, activeMiner] of this.runtime.activeMiners) {
            if (skipOfflineDuplicateCheck(minerId, activeMiner, miner)) continue;
            if (sameMinerIdentity(activeMiner, miner)) this.runtime.activeMiners.delete(minerId);
        }
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
        const submitState = this.getSubmitState(socket, params, reply, replyFinal);
        if (!submitState) return;
        ({ params } = submitState);
        const { miner } = submitState;
        if (typeof params.job_id === "number") params.job_id = String(params.job_id);
        this.processSubmit(miner, params, reply);
    }
    processSubmit(miner, params, reply) {
        const job = this.getSubmitJob(miner, params, reply);
        if (!job) return;
        if (!this.acceptNonce(miner, job, params, reply)) return;
        const blockTemplate = this.findBlockTemplate(miner, job);
        if (!blockTemplate) {
            this.handleExpiredShare(miner, job, reply);
            return;
        }
        this.processAcceptedShare(miner, job, blockTemplate, params, reply);
    }
    getSubmitState(socket, params, reply, replyFinal) {
        params = this.getParams(params, replyFinal);
        if (!params) return null;
        const miner = this.getMiner(params.id || socket.minerId, reply);
        if (!miner) return null;
        miner.heartbeat();
        return { params, miner };
    }
    getSubmitJob(miner, params, reply) {
        const job = miner.validJobs.toarray().find((entry) => entry.id === params.job_id);
        if (job) return job;
        reply("Invalid job id");
        return null;
    }
    acceptNonce(miner, job, params, reply) {
        if (hasBadNonce(miner, job, params)) {
            this.runtime.logger.warn("share.bad_nonce", { miner: miner.logString, job: params.job_id });
            reply("Duplicate share");
            return false;
        }
        const nonceKey = miner.coins.blobTypeGrin(job.blob_type) ? params.pow.join(":") : params.nonce;
        if (job.submissions.includes(nonceKey)) {
            this.runtime.logger.warn("share.duplicate", { miner: miner.logString, job: params.job_id, nonce: nonceKey });
            reply("Duplicate share");
            return false;
        }
        job.submissions.push(nonceKey);
        return true;
    }
    findBlockTemplate(miner, job) {
        const poolState = this.runtime.pools.get(miner.pool);
        if (poolState.activeBlockTemplate && poolState.activeBlockTemplate.id === job.templateID) return poolState.activeBlockTemplate;
        return poolState.pastBlockTemplates.toarray().find((entry) => entry.id === job.templateID);
    }
    handleExpiredShare(miner, job, reply) {
        this.runtime.logger.warn("share.expired", { miner: miner.logString, height: job.height });
        if (miner.incremented === false) {
            miner.newDiff = miner.difficulty + 1;
            miner.incremented = true;
        } else {
            miner.newDiff = Math.max(1, miner.difficulty - 1);
            miner.incremented = false;
        }
        miner.pushNewJob(true);
        reply("Block expired");
    }
    processAcceptedShare(miner, job, blockTemplate, params, reply) {
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
function sameMinerIdentity(left, right) {
    return left.identifier === right.identifier && left.ip === right.ip && left.agent === right.agent;
}
function skipOfflineDuplicateCheck(minerId, activeMiner, miner) {
    if (minerId === miner.id) return true;
    return !activeMiner.socket.destroyed;
}
function hasBadNonce(miner, job, params) {
    const blobTypeNum = job.blob_type;
    if (miner.coins.blobTypeGrin(blobTypeNum)) {
        return hasBadGrinNonce(miner, blobTypeNum, params);
    }
    const pattern = miner.coins.nonceSize(blobTypeNum) === 8 ? NONCE_64_HEX : NONCE_32_HEX;
    return typeof params.nonce !== "string" || !pattern.test(params.nonce);
}
function hasBadGrinNonce(miner, blobTypeNum, params) {
    if (!Number.isInteger(params.nonce)) return true;
    if (!Array.isArray(params.pow)) return true;
    return params.pow.length !== miner.coins.c29ProofSize(blobTypeNum);
}
module.exports = { MinerProtocol, MinerSession };
