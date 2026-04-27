"use strict";

const { isPoolUsable: resolvePoolUsability, maybeUnref } = require("./common");
const { planPoolRebalance } = require("./balance");
const { ProxyMonitor } = require("./monitor");
const { UpstreamPoolClient } = require("./pool");
const { buildMonitorSnapshot, collectWorkerStats, createSummaryState } = require("./stats");

class MasterController {
    constructor(options) {
        this.config = options.config;
        this.logger = options.logger;
        this.instanceId = options.instanceId;
        this.coins = options.coinsFactory({ instanceId: this.instanceId, logger: this.logger });
        this.workers = new Map();
        this.pools = new Map();
        this.hashrateAlgo = "h/s";
        this.enumerateTimer = null;
        this.balanceTimer = null;
        this.lastSummaryLogAt = 0;
        this.lastSummaryKey = "";
        this.monitor = new ProxyMonitor({
            config: this.config,
            logger: this.logger,
            runtime: this
        });
    }

    start() {
        this.connectPools();
        this.enumerateTimer = maybeUnref(setInterval(() => this.enumerateWorkerStats(), 15_000));
        this.balanceTimer = maybeUnref(setInterval(() => this.balanceWorkers(), 90_000));
        this.monitor.start();
    }

    async stop() {
        if (this.enumerateTimer) clearInterval(this.enumerateTimer);
        if (this.balanceTimer) clearInterval(this.balanceTimer);
        this.enumerateTimer = null;
        this.balanceTimer = null;
        for (const pool of this.pools.values()) pool.stop();
        await this.monitor.stop();
    }

    attachWorker(workerId, sender) {
        if (!this.workers.has(workerId)) {
            this.workers.set(workerId, { send: sender, stats: new Map() });
        } else {
            this.workers.get(workerId).send = sender;
        }
    }

    detachWorker(workerId) {
        this.workers.delete(workerId);
    }

    broadcast(message) {
        for (const { send } of this.workers.values()) {
            send(message);
        }
    }
    connectPools() {
        for (const poolConfig of this.config.pools) this.ensurePool(poolConfig);
        if (this.shouldUseDevPool()) this.ensurePool(this.coins.devPool);
        for (const pool of this.pools.values()) pool.start();
    }
    shouldUseDevPool() {
        return this.config.developerShare > 0 && !this.pools.has(this.coins.devPool.hostname);
    }
    ensurePool(poolConfig) {
        if (this.pools.has(poolConfig.hostname)) return this.pools.get(poolConfig.hostname);
        // The master owns upstream pool IO and template fanout, but it uses the same
        // coins surface as workers so pool-side and miner-side handling stay in sync.
        const pool = new UpstreamPoolClient({
            config: this.config,
            master: this,
            logger: this.logger,
            poolConfig,
            coins: this.coins
        });
        this.pools.set(pool.hostname, pool);
        return pool;
    }

    isPoolUsable(hostname) {
        return resolvePoolUsability(
            this.pools,
            hostname,
            (pool) => pool.enabled && pool.connected && pool.activeBlockTemplate
        );
    }
    handlePoolTemplate(pool, blockTemplate) {
        if (!blockTemplate) {
            this.rejectPoolTemplate(pool, "pool.job_empty", "empty-template");
            return;
        }
        const templateCopy = this.normalizePoolTemplate(pool, blockTemplate);
        if (this.isDuplicateTemplate(pool, templateCopy)) {
            this.logger.debug("pool", `Ignoring duplicate job ${templateCopy.job_id} from ${pool.hostname}`);
            return;
        }
        try {
            this.activatePoolTemplate(pool, templateCopy);
            this.broadcast({ type: "enablePool", pool: pool.hostname });
            this.sendPoolTemplateToWorkers(pool);
        } catch (error) {
            this.logger.error("pool.job_rejected", {
                host: pool.hostname,
                error: error.message
            });
            pool.markUnavailable("invalid-template");
            pool.destroySocket();
            pool.scheduleConnect();
        }
    }
    isDuplicateTemplate(pool, templateCopy) {
        return Boolean(pool.activeBlockTemplate) && pool.activeBlockTemplate.job_id === templateCopy.job_id;
    }
    rejectPoolTemplate(pool, event, reason) {
        this.logger.error(event, { host: pool.hostname });
        pool.markUnavailable(reason);
        pool.destroySocket();
        pool.scheduleConnect();
    }
    normalizePoolTemplate(pool, blockTemplate) {
        const templateCopy = { ...blockTemplate };
        if (!templateCopy.algo) templateCopy.algo = this.detectTemplateAlgo(pool, templateCopy);
        if (!templateCopy.blob_type) templateCopy.blob_type = pool.blobType;
        return templateCopy;
    }
    detectTemplateAlgo(pool, templateCopy) {
        const blockVersion = templateCopy.blocktemplate_blob ? parseInt(templateCopy.blocktemplate_blob.slice(0, 2), 16) : 0;
        return pool.coins.detectAlgo(pool.defaultAlgoSet, blockVersion);
    }
    activatePoolTemplate(pool, templateCopy) {
        if (pool.activeBlockTemplate) pool.pastBlockTemplates.enq(pool.activeBlockTemplate);
        pool.activeBlockTemplate = new pool.coins.MasterBlockTemplate(templateCopy);
        pool.enabled = true;
        this.logger.info("pool.job", {
            host: pool.hostname,
            coin: pool.activeBlockTemplate.coin,
            height: pool.activeBlockTemplate.height,
            algo: pool.activeBlockTemplate.algo,
            target: pool.activeBlockTemplate.targetDiff,
            variant: pool.activeBlockTemplate.variant
        });
    }
    sendPoolTemplateToWorkers(pool) {
        for (const [workerId, workerState] of this.workers) {
            if (this.isPoolUsable(pool.hostname)) this.sendPoolTemplate(workerState, pool, workerId);
        }
    }
    sendPoolTemplate(workerState, pool, workerId) {
        workerState.send({
            host: pool.hostname,
            type: "newBlockTemplate",
            data: pool.coins.getMasterJob(pool, workerId)
        });
    }
    handleWorkerMessage(workerId, message) {
        if (!message || typeof message !== "object") return;
        const handled = [
            () => this.handleShareMessage(workerId, message),
            () => this.handlePoolStateRequest(workerId, message),
            () => this.handleStatsMessage(workerId, message)
        ].some((handler) => handler());
        if (!handled) this.logger.debug("master", `Ignoring worker message ${message.type}`);
    }
    handleShareMessage(workerId, message) {
        if (message.type !== "shareFind" && message.type !== "blockFind") return false;
        const pool = this.pools.get(message.host);
        if (pool) pool.sendShare(workerId, message.data);
        return true;
    }
    handlePoolStateRequest(workerId, message) {
        if (message.type !== "needPoolState") return false;
        const workerState = this.workers.get(workerId);
        if (!workerState) return true;
        workerState.send({ type: "poolState", data: Array.from(this.pools.keys()) });
        for (const [hostname, pool] of this.pools) this.sendUsablePoolTemplate(hostname, pool, workerState, workerId);
        return true;
    }
    sendUsablePoolTemplate(hostname, pool, workerState, workerId) {
        if (this.isPoolUsable(hostname)) this.sendPoolTemplate(workerState, pool, workerId);
    }
    handleStatsMessage(workerId, message) {
        const workerState = this.workers.get(workerId);
        if (!workerState) return ["workerStats", "workerStatsRemove"].includes(message.type);
        if (message.type === "workerStats") workerState.stats.set(message.minerID, message.data);
        else if (message.type === "workerStatsRemove") workerState.stats.delete(message.minerID);
        else return false;
        return true;
    }
    enumerateWorkerStats() {
        const inactivityDeadline = this.config.minerInactivityTime <= 0
            ? 0
            : Math.floor(Date.now() / 1000) - this.config.minerInactivityTime;

        const { globalStats, hashrateAlgo } = collectWorkerStats({
            inactivityDeadline,
            logger: this.logger,
            pools: this.pools,
            workers: this.workers
        });

        this.hashrateAlgo = hashrateAlgo;

        const summary = createSummaryState({
            globalStats,
            hashrateAlgo: this.hashrateAlgo,
            isPoolUsable: (hostname) => this.isPoolUsable(hostname),
            lastSummaryKey: this.lastSummaryKey,
            lastSummaryLogAt: this.lastSummaryLogAt,
            pools: this.pools
        });

        // Keep a heartbeat in logs without reprinting the same fleet summary every 15s.
        if (summary.shouldLog) {
            this.logger.info("proxy.summary", summary.meta);
            this.lastSummaryKey = summary.summaryKey;
            this.lastSummaryLogAt = summary.loggedAt;
        }
    }

    balanceWorkers() {
        const { changes, warnings } = planPoolRebalance({
            developerShare: this.config.developerShare,
            isPoolUsable: (hostname) => this.isPoolUsable(hostname),
            miners: this.getActiveMinerViews(),
            pools: Array.from(this.pools.values()).map((pool) => ({
                devPool: pool.devPool,
                name: pool.hostname,
                share: pool.share
            }))
        });

        for (const warning of warnings) {
            this.logger.warn("pool.balance_skipped", warning);
        }

        for (const change of changes) {
            const workerState = this.workers.get(change.workerId);
            if (!workerState) continue;
            workerState.send({
                type: "changePool",
                worker: change.minerId,
                pool: change.pool
            });
        }
    }

    getMonitorSnapshot() {
        return buildMonitorSnapshot({
            developerShare: this.config.developerShare,
            hashrateAlgo: this.hashrateAlgo,
            isPoolUsable: (hostname) => this.isPoolUsable(hostname),
            pools: this.pools,
            workers: this.workers
        });
    }

    getMonitorRawState() {
        const state = {};

        for (const [workerId, workerState] of this.workers) {
            state[workerId] = {};
            for (const [minerId, miner] of workerState.stats) {
                if (!miner) continue;
                state[workerId][minerId] = miner;
            }
        }
        return state;
    }
    getActiveMinerViews() {
        const views = [];
        for (const [workerId, workerState] of this.workers) {
            for (const [minerId, miner] of workerState.stats) addActiveMinerView(views, workerId, minerId, miner);
        }
        return views;
    }
}
function addActiveMinerView(views, workerId, minerId, miner) {
    if (!miner || !miner.active) return;
    views.push({ active: miner.active, avgSpeed: miner.avgSpeed, minerId, pool: miner.pool, workerId });
}
module.exports = { MasterController };
