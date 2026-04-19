"use strict";

const { humanHashrate } = require("./proxy-common");

function collectWorkerStats({ workers, pools, inactivityDeadline, logger }) {
    const globalStats = { miners: 0, hashes: 0, hashRate: 0, diff: 0 };
    const poolAlgos = new Map();
    const poolAlgosPerf = new Map();

    for (const [workerId, workerState] of workers) {
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

            const pool = pools.get(workerData.pool);
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

        logger.debug("workers", `Worker ${workerId}: ${stats.miners} miners at ${stats.hashRate} h/s`);
    }

    let hashrateAlgo = "h/s";
    for (const [poolName, algos] of poolAlgos) {
        const pool = pools.get(poolName);
        if (!pool) continue;

        const perf = poolAlgosPerf.get(poolName);
        const perfToUse = Object.keys(perf).length > 0 ? perf : pool.defaultAlgosPerf;
        pool.updateAlgoPerf(algos, perfToUse);

        const algoKeys = Object.keys(algos);
        if (algoKeys.length !== 1) {
            hashrateAlgo = "h/s";
            continue;
        }

        const algo = algoKeys[0];
        if (algo === "c29s" || algo === "c29v") {
            if (hashrateAlgo === "h/s" || hashrateAlgo === algo) {
                hashrateAlgo = algo;
            }
            continue;
        }

        hashrateAlgo = "h/s";
    }

    return { globalStats, hashrateAlgo };
}

function createSummaryState({ globalStats, pools, isPoolUsable, hashrateAlgo, lastSummaryKey, lastSummaryLogAt, now = Date.now() }) {
    const averageDiff = globalStats.miners > 0 ? Math.floor(globalStats.diff / globalStats.miners) : 0;
    const activePools = Array.from(pools.keys()).filter((hostname) => isPoolUsable(hostname)).length;
    const hashrateBucket = globalStats.hashRate >= 1000
        ? Math.round(globalStats.hashRate / 100) * 100
        : Math.round(globalStats.hashRate / 10) * 10;

    const summaryKey = JSON.stringify({
        miners: globalStats.miners,
        hashrateBucket,
        averageDiff,
        activePools,
        algo: hashrateAlgo
    });

    return {
        shouldLog: summaryKey !== lastSummaryKey || (now - lastSummaryLogAt) >= 60_000,
        summaryKey,
        loggedAt: now,
        meta: {
            miners: globalStats.miners,
            hashrate: humanHashrate(globalStats.hashRate, hashrateAlgo),
            avgDiff: globalStats.miners > 0 ? averageDiff : undefined,
            activePools,
            algo: hashrateAlgo !== "h/s" ? hashrateAlgo : undefined
        }
    };
}

function buildMonitorSnapshot({ workers, pools, developerShare, hashrateAlgo, isPoolUsable }) {
    const miners = [];
    const offlineMiners = [];
    const seenNames = new Set();
    const poolHashrate = new Map();
    let totalMiners = 0;
    let totalHashrate = 0;

    for (const workerState of workers.values()) {
        for (const miner of workerState.stats.values()) {
            if (!miner) continue;

            const view = {
                ...miner,
                algo: pools.get(miner.pool)?.activeBlockTemplate?.algo || hashrateAlgo
            };

            if (miner.active) {
                miners.push(view);
                seenNames.add(miner.logString);
                totalMiners += 1;
                totalHashrate += miner.avgSpeed;
                poolHashrate.set(miner.pool, (poolHashrate.get(miner.pool) || 0) + miner.avgSpeed);
            } else {
                offlineMiners.push(view);
            }
        }
    }

    for (const miner of offlineMiners) {
        if (seenNames.has(miner.logString)) continue;
        miners.push(miner);
        seenNames.add(miner.logString);
    }

    miners.sort((left, right) => {
        if (left.active !== right.active) return left.active ? -1 : 1;
        return right.avgSpeed - left.avgSpeed;
    });

    const poolList = Array.from(pools.values())
        .filter((pool) => !pool.devPool || developerShare > 0)
        .map((pool) => ({
            hostname: pool.hostname,
            username: pool.username || null,
            coin: pool.coin,
            devPool: pool.devPool,
            percentage: Number(pool.share || 0).toFixed(2),
            active: isPoolUsable(pool.hostname),
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
        hashrateAlgo,
        pools: poolList,
        miners
    };
}

module.exports = {
    buildMonitorSnapshot,
    collectWorkerStats,
    createSummaryState
};
