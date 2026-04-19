"use strict";

const path = require("node:path");

const {
    humanHashrate,
    maybeUnref
} = require("./proxy-common");
const { ProxyMonitor } = require("./proxy-monitor");
const { UpstreamPoolClient } = require("./proxy-pool");

function loadCoinFactory(coinName, overrides = {}) {
    if (overrides[coinName]) return overrides[coinName];
    return require(path.resolve(__dirname, `${coinName}.js`));
}

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
            this.logger.error(`Pool ${pool.hostname} returned an empty block template`);
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
            this.logger.info(
                `Received template from ${pool.hostname} height=${pool.activeBlockTemplate.height} target=${pool.activeBlockTemplate.targetDiff}`
            );
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
            this.logger.error(`Failed to accept template from ${pool.hostname}: ${error.message}`);
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
        const globalStats = { miners: 0, hashes: 0, hashRate: 0, diff: 0 };
        const poolAlgos = new Map();
        const poolAlgosPerf = new Map();
        const inactivityDeadline = this.config.minerInactivityTime <= 0
            ? 0
            : Math.floor(Date.now() / 1000) - this.config.minerInactivityTime;

        for (const [workerId, workerState] of this.workers) {
            const stats = { miners: 0, hashes: 0, hashRate: 0, diff: 0 };
            for (const [minerId, workerData] of workerState.stats) {
                if (!workerData) {
                    workerState.stats.delete(minerId);
                    continue;
                }
                if (workerData.lastContact < inactivityDeadline) {
                    workerState.stats.delete(minerId);
                    continue;
                }
                stats.miners += 1;
                stats.hashes += workerData.hashes;
                stats.hashRate += workerData.avgSpeed;
                stats.diff += workerData.diff;

                const pool = this.pools.get(workerData.pool);
                if (!pool) continue;
                const minerAlgos = workerData.algos || pool.defaultAlgoSet;
                if (poolAlgos.has(workerData.pool)) {
                    const common = poolAlgos.get(workerData.pool);
                    for (const algo of Object.keys(common)) {
                        if (!(algo in minerAlgos)) delete common[algo];
                    }
                } else {
                    poolAlgos.set(workerData.pool, { ...minerAlgos });
                    poolAlgosPerf.set(workerData.pool, {});
                }

                if (workerData.algos_perf) {
                    const perf = poolAlgosPerf.get(workerData.pool);
                    for (const [algo, value] of Object.entries(workerData.algos_perf)) {
                        perf[algo] = (perf[algo] || 0) + value;
                    }
                }
            }

            globalStats.miners += stats.miners;
            globalStats.hashes += stats.hashes;
            globalStats.hashRate += stats.hashRate;
            globalStats.diff += stats.diff;

            this.logger.debug("workers", `Worker ${workerId}: ${stats.miners} miners at ${stats.hashRate} h/s`);
        }

        this.hashrateAlgo = "h/s";
        for (const [poolName, algos] of poolAlgos) {
            const pool = this.pools.get(poolName);
            if (!pool) continue;
            const perf = poolAlgosPerf.get(poolName);
            const perfToUse = Object.keys(perf).length > 0 ? perf : pool.defaultAlgosPerf;
            pool.updateAlgoPerf(algos, perfToUse);
            const algoKeys = Object.keys(algos);
            if (algoKeys.length === 1) {
                const algo = algoKeys[0];
                if (algo === "c29s" || algo === "c29v") {
                    if (this.hashrateAlgo === "h/s" || this.hashrateAlgo === algo) {
                        this.hashrateAlgo = algo;
                    }
                } else {
                    this.hashrateAlgo = "h/s";
                }
            } else {
                this.hashrateAlgo = "h/s";
            }
        }

        const averageDiff = globalStats.miners > 0 ? Math.floor(globalStats.diff / globalStats.miners) : 0;
        this.logger.info(
            `The proxy currently has ${globalStats.miners} miners connected at ${humanHashrate(globalStats.hashRate, this.hashrateAlgo)}`
            + (globalStats.miners ? ` with an average diff of ${averageDiff}` : "")
        );
    }

    balanceWorkers() {
        const minerStates = {};
        const poolStates = {};

        for (const [poolName, pool] of this.pools) {
            if (!poolStates[pool.coin]) {
                poolStates[pool.coin] = { totalPercentage: 0, activePoolCount: 0, devPool: null };
            }
            poolStates[pool.coin][poolName] = {
                miners: {},
                hashrate: 0,
                percentage: pool.share,
                devPool: pool.devPool,
                idealRate: 0
            };
            if (pool.devPool) {
                poolStates[pool.coin].devPool = poolName;
            } else if (this.isPoolUsable(poolName)) {
                poolStates[pool.coin].totalPercentage += pool.share;
                poolStates[pool.coin].activePoolCount += 1;
            }
            if (!minerStates[pool.coin]) minerStates[pool.coin] = { hashrate: 0 };
        }

        for (const [coin, state] of Object.entries(poolStates)) {
            if (state.totalPercentage !== 100) {
                if (state.totalPercentage > 0) {
                    const modifier = 100 / state.totalPercentage;
                    for (const poolName of Object.keys(state)) {
                        if (!this.pools.has(poolName)) continue;
                        if (state[poolName].devPool || !this.isPoolUsable(poolName)) continue;
                        state[poolName].percentage *= modifier;
                    }
                } else if (state.activePoolCount > 0) {
                    const addModifier = 100 / state.activePoolCount;
                    for (const poolName of Object.keys(state)) {
                        if (!this.pools.has(poolName)) continue;
                        if (state[poolName].devPool || !this.isPoolUsable(poolName)) continue;
                        state[poolName].percentage += addModifier;
                    }
                } else {
                    this.logger.warn(`No active pools for ${coin}, skipping balance cycle`);
                    continue;
                }
            }
            delete state.totalPercentage;
            delete state.activePoolCount;
        }

        for (const [workerId, workerState] of this.workers) {
            for (const [minerId, miner] of workerState.stats) {
                if (!miner || !miner.active) continue;
                if (!poolStates[miner.coin] || !poolStates[miner.coin][miner.pool]) continue;
                minerStates[miner.coin].hashrate += miner.avgSpeed;
                poolStates[miner.coin][miner.pool].hashrate += miner.avgSpeed;
                poolStates[miner.coin][miner.pool].miners[`${workerId}_${minerId}`] = miner.avgSpeed;
            }
        }

        for (const [coin, coinPools] of Object.entries(poolStates)) {
            const coinMiners = minerStates[coin];
            const devPoolName = coinPools.devPool;
            const highPools = {};
            const lowPools = {};
            delete coinPools.devPool;

            if (devPoolName) {
                const devHashrate = Math.floor(coinMiners.hashrate * (this.config.developerShare / 100));
                coinMiners.hashrate -= devHashrate;
                coinPools[devPoolName].idealRate = devHashrate;
                if (this.isPoolUsable(devPoolName) && coinPools[devPoolName].idealRate > coinPools[devPoolName].hashrate) {
                    lowPools[devPoolName] = coinPools[devPoolName].idealRate - coinPools[devPoolName].hashrate;
                } else if (!this.isPoolUsable(devPoolName) || coinPools[devPoolName].idealRate < coinPools[devPoolName].hashrate) {
                    highPools[devPoolName] = coinPools[devPoolName].hashrate - coinPools[devPoolName].idealRate;
                }
            }

            for (const poolName of Object.keys(coinPools)) {
                if (poolName === devPoolName || !this.pools.has(poolName)) continue;
                coinPools[poolName].idealRate = Math.floor(coinMiners.hashrate * (coinPools[poolName].percentage / 100));
                if (this.isPoolUsable(poolName) && coinPools[poolName].idealRate > coinPools[poolName].hashrate) {
                    lowPools[poolName] = coinPools[poolName].idealRate - coinPools[poolName].hashrate;
                } else if (!this.isPoolUsable(poolName) || coinPools[poolName].idealRate < coinPools[poolName].hashrate) {
                    highPools[poolName] = coinPools[poolName].hashrate - coinPools[poolName].idealRate;
                }
            }

            const freedMiners = {};
            for (const [poolName, delta] of Object.entries(highPools)) {
                let remainder = delta;
                for (const [minerKey, rate] of Object.entries(coinPools[poolName].miners)) {
                    if ((rate <= remainder || !this.isPoolUsable(poolName)) && rate !== 0) {
                        remainder -= rate;
                        freedMiners[minerKey] = rate;
                        delete coinPools[poolName].miners[minerKey];
                    }
                }
            }

            const minerChanges = {};
            for (const [poolName, needed] of Object.entries(lowPools)) {
                let remainder = needed;
                minerChanges[poolName] = [];
                for (const [minerKey, rate] of Object.entries(freedMiners)) {
                    if (rate <= remainder) {
                        minerChanges[poolName].push(minerKey);
                        remainder -= rate;
                        delete freedMiners[minerKey];
                    }
                }

                if (remainder > 100) {
                    for (const donorPool of Object.keys(coinPools)) {
                        if (donorPool in lowPools) continue;
                        for (const [minerKey, rate] of Object.entries(coinPools[donorPool].miners)) {
                            if (rate <= remainder && rate !== 0) {
                                minerChanges[poolName].push(minerKey);
                                remainder -= rate;
                                delete coinPools[donorPool].miners[minerKey];
                            }
                            if (remainder < 50) break;
                        }
                        if (remainder < 50) break;
                    }
                }
            }

            for (const poolName of Object.keys(lowPools)) {
                if (poolName === devPoolName) continue;
                if (!minerChanges[poolName]) minerChanges[poolName] = [];
                for (const minerKey of Object.keys(freedMiners)) {
                    minerChanges[poolName].push(minerKey);
                    delete freedMiners[minerKey];
                }
            }

            for (const [poolName, minerKeys] of Object.entries(minerChanges)) {
                for (const minerKey of minerKeys) {
                    const [workerId, minerId] = minerKey.split("_");
                    const workerState = this.workers.get(workerId);
                    if (!workerState) continue;
                    workerState.send({
                        type: "changePool",
                        worker: minerId,
                        pool: poolName
                    });
                }
            }
        }
    }

    getMonitorSnapshot() {
        const miners = [];
        const offlineMiners = [];
        const seenNames = new Set();
        const poolHashrate = new Map();
        let totalMiners = 0;
        let totalHashrate = 0;

        for (const workerState of this.workers.values()) {
            for (const miner of workerState.stats.values()) {
                if (!miner) continue;
                if (miner.active) {
                    miners.push({
                        ...miner,
                        algo: this.pools.get(miner.pool)?.activeBlockTemplate?.algo || this.hashrateAlgo
                    });
                    seenNames.add(miner.logString);
                    totalMiners += 1;
                    totalHashrate += miner.avgSpeed;
                    poolHashrate.set(miner.pool, (poolHashrate.get(miner.pool) || 0) + miner.avgSpeed);
                } else {
                    offlineMiners.push(miner);
                }
            }
        }

        for (const miner of offlineMiners) {
            if (seenNames.has(miner.logString)) continue;
            miners.push({
                ...miner,
                algo: this.pools.get(miner.pool)?.activeBlockTemplate?.algo || this.hashrateAlgo
            });
            seenNames.add(miner.logString);
        }

        miners.sort((left, right) => {
            if (left.active !== right.active) return left.active ? -1 : 1;
            return right.avgSpeed - left.avgSpeed;
        });

        const pools = Array.from(this.pools.values())
            .filter((pool) => !pool.devPool || this.config.developerShare > 0)
            .map((pool) => ({
                hostname: pool.hostname,
                coin: pool.coin,
                devPool: pool.devPool,
                percentage: Number(pool.share || 0).toFixed(2),
                active: this.isPoolUsable(pool.hostname),
                hashrate: poolHashrate.get(pool.hostname) || 0,
                height: pool.activeBlockTemplate?.height || null,
                targetDiff: pool.activeBlockTemplate?.targetDiff || null,
                algo: pool.activeBlockTemplate?.algo || null,
                variant: pool.activeBlockTemplate?.variant || null
            }))
            .sort((left, right) => right.hashrate - left.hashrate);

        return {
            generatedAt: Date.now(),
            generatedAtAgeMs: 0,
            totalMiners,
            totalHashrate,
            hashrateAlgo: this.hashrateAlgo,
            pools,
            miners
        };
    }
}

module.exports = {
    MasterController
};
