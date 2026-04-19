"use strict";

const {
    maybeUnref
} = require("./proxy-common");
const { loadCoinFactory } = require("./coin-loader");
const { planPoolRebalance } = require("./proxy-balance");
const { ProxyMonitor } = require("./proxy-monitor");
const { UpstreamPoolClient } = require("./proxy-pool");
const {
    buildMonitorSnapshot,
    collectWorkerStats,
    createSummaryState
} = require("./proxy-stats");

class MasterController {
    constructor(options) {
        this.config = options.config;
        this.logger = options.logger;
        this.coinFactories = options.coinFactories || {};
        this.instanceId = options.instanceId;
        this.workers = new Map();
        this.pools = new Map();
        this.defaultPools = new Map();
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

    getPool(hostname) {
        return this.pools.get(hostname) || null;
    }

    connectPools() {
        const seenCoins = new Set();
        for (const poolConfig of this.config.pools) {
            this.ensurePool(poolConfig);
            if (poolConfig.default) {
                this.defaultPools.set(poolConfig.coin, poolConfig.hostname);
            }
            seenCoins.add(poolConfig.coin);
        }

        if (this.config.developerShare > 0) {
            for (const coin of seenCoins) {
                const factory = loadCoinFactory(coin, this.coinFactories);
                const coinAdapter = factory({ instanceId: this.instanceId, logger: this.logger });
                const devPoolConfig = coinAdapter.devPool;
                if (!this.pools.has(devPoolConfig.hostname)) {
                    this.ensurePool(devPoolConfig);
                }
            }
        }

        for (const pool of this.pools.values()) {
            pool.start();
        }
    }

    ensurePool(poolConfig) {
        if (this.pools.has(poolConfig.hostname)) return this.pools.get(poolConfig.hostname);
        const factory = loadCoinFactory(poolConfig.coin, this.coinFactories);
        // The master owns upstream pool IO and template fanout, but it uses the same
        // adapter surface as workers so pool-side and miner-side template handling stay in sync.
        const coinAdapter = factory({ instanceId: this.instanceId, logger: this.logger });
        const pool = new UpstreamPoolClient({
            config: this.config,
            master: this,
            logger: this.logger,
            poolConfig,
            coinAdapter
        });
        this.pools.set(pool.hostname, pool);
        return pool;
    }

    isPoolUsable(hostname) {
        const pool = this.pools.get(hostname);
        if (!pool || !pool.enabled || !pool.connected || !pool.activeBlockTemplate) return false;

        let topHeight = 0;
        for (const candidate of this.pools.values()) {
            if (candidate.coin !== pool.coin) continue;
            if (!candidate.enabled || !candidate.connected || !candidate.activeBlockTemplate) continue;
            if (Math.abs(candidate.activeBlockTemplate.height - pool.activeBlockTemplate.height) > 1000) continue;
            if (candidate.activeBlockTemplate.height > topHeight) {
                topHeight = candidate.activeBlockTemplate.height;
            }
        }
        return pool.activeBlockTemplate.height >= topHeight - 5;
    }

    handlePoolTemplate(pool, blockTemplate) {
        if (!blockTemplate) {
            this.logger.error("pool.job_empty", {
                host: pool.hostname
            });
            pool.markUnavailable("empty-template");
            pool.destroySocket();
            pool.scheduleConnect();
            return;
        }

        const templateCopy = { ...blockTemplate };
        if (!templateCopy.algo) {
            const blockVersion = templateCopy.blocktemplate_blob
                ? parseInt(templateCopy.blocktemplate_blob.slice(0, 2), 16)
                : 0;
            templateCopy.algo = pool.coinAdapter.detectAlgo(pool.defaultAlgoSet, blockVersion);
        }
        if (!templateCopy.blob_type) {
            templateCopy.blob_type = pool.blobType;
        }

        if (pool.activeBlockTemplate && pool.activeBlockTemplate.job_id === templateCopy.job_id) {
            this.logger.debug("pool", `Ignoring duplicate job ${templateCopy.job_id} from ${pool.hostname}`);
            return;
        }

        try {
            if (pool.activeBlockTemplate) {
                pool.pastBlockTemplates.enq(pool.activeBlockTemplate);
            }
            pool.activeBlockTemplate = new pool.coinAdapter.MasterBlockTemplate(templateCopy);
            pool.enabled = true;
            this.logger.info("pool.job", {
                host: pool.hostname,
                height: pool.activeBlockTemplate.height,
                algo: pool.activeBlockTemplate.algo,
                target: pool.activeBlockTemplate.targetDiff,
                variant: pool.activeBlockTemplate.variant
            });
            this.broadcast({ type: "enablePool", pool: pool.hostname });
            for (const [workerId, workerState] of this.workers) {
                if (!this.isPoolUsable(pool.hostname)) continue;
                workerState.send({
                    host: pool.hostname,
                    type: "newBlockTemplate",
                    data: pool.coinAdapter.getMasterJob(pool, workerId)
                });
            }
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

    handleWorkerMessage(workerId, message) {
        if (!message || typeof message !== "object") return;
        switch (message.type) {
        case "shareFind":
        case "blockFind": {
            const pool = this.pools.get(message.host);
            if (pool) pool.sendShare(workerId, message.data);
            return;
        }
        case "needPoolState": {
            const workerState = this.workers.get(workerId);
            if (!workerState) return;
            workerState.send({
                type: "poolState",
                data: Array.from(this.pools.keys())
            });
            for (const [hostname, pool] of this.pools) {
                if (!this.isPoolUsable(hostname)) continue;
                workerState.send({
                    host: hostname,
                    type: "newBlockTemplate",
                    data: pool.coinAdapter.getMasterJob(pool, workerId)
                });
            }
            return;
        }
        case "workerStats": {
            const workerState = this.workers.get(workerId);
            if (!workerState) return;
            workerState.stats.set(message.minerID, message.data);
            return;
        }
        case "workerStatsRemove": {
            const workerState = this.workers.get(workerId);
            if (!workerState) return;
            workerState.stats.delete(message.minerID);
            return;
        }
        default:
            this.logger.debug("master", `Ignoring worker message ${message.type}`);
        }
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
                coin: pool.coin,
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
            for (const [minerId, miner] of workerState.stats) {
                if (!miner || !miner.active) continue;
                views.push({
                    active: miner.active,
                    avgSpeed: miner.avgSpeed,
                    coin: miner.coin,
                    minerId,
                    pool: miner.pool,
                    workerId
                });
            }
        }

        return views;
    }
}

module.exports = {
    MasterController
};
