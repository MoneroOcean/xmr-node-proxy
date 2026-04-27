"use strict";

const { humanHashrate } = require("./common");

function collectWorkerStats({ workers, pools, inactivityDeadline, logger }) {
    const globalStats = { miners: 0, hashes: 0, hashRate: 0, diff: 0 };
    const poolAlgos = new Map();
    const poolAlgosPerf = new Map();
    for (const [workerId, workerState] of workers) {
        const stats = { miners: 0, hashes: 0, hashRate: 0, diff: 0 };
        for (const [minerId, workerData] of workerState.stats) {
            if (dropStaleMiner(workerState, minerId, workerData, inactivityDeadline)) continue;
            addMinerStats(stats, workerData);
            collectPoolAlgoStats(pools, poolAlgos, poolAlgosPerf, workerData);
        }
        addStats(globalStats, stats);
        logger.debug("workers", `Worker ${workerId}: ${stats.miners} miners at ${stats.hashRate} h/s`);
    }
    const hashrateAlgo = updatePoolAlgos(pools, poolAlgos, poolAlgosPerf);
    return { globalStats, hashrateAlgo };
}
function dropStaleMiner(workerState, minerId, workerData, inactivityDeadline) {
    if (!workerData || workerData.lastContact < inactivityDeadline) {
        workerState.stats.delete(minerId);
        return true;
    }
    return false;
}
function addMinerStats(stats, workerData) {
    stats.miners += 1;
    stats.hashes += workerData.hashes;
    stats.hashRate += workerData.avgSpeed;
    stats.diff += workerData.diff;
}
function addStats(total, stats) {
    total.miners += stats.miners;
    total.hashes += stats.hashes;
    total.hashRate += stats.hashRate;
    total.diff += stats.diff;
}
function collectPoolAlgoStats(pools, poolAlgos, poolAlgosPerf, workerData) {
    const pool = pools.get(workerData.pool);
    if (!pool) return;
    mergePoolAlgos(poolAlgos, poolAlgosPerf, workerData.pool, workerData.algos || pool.defaultAlgoSet);
    if (workerData.algos_perf) addPoolPerf(poolAlgosPerf.get(workerData.pool), workerData.algos_perf);
}
function mergePoolAlgos(poolAlgos, poolAlgosPerf, poolName, minerAlgos) {
    if (!poolAlgos.has(poolName)) {
        poolAlgos.set(poolName, { ...minerAlgos });
        poolAlgosPerf.set(poolName, {});
        return;
    }
    const common = poolAlgos.get(poolName);
    for (const algo of Object.keys(common)) {
        if (!(algo in minerAlgos)) delete common[algo];
    }
}
function addPoolPerf(perf, minerPerf) {
    for (const [algo, value] of Object.entries(minerPerf)) perf[algo] = (perf[algo] || 0) + value;
}
function updatePoolAlgos(pools, poolAlgos, poolAlgosPerf) {
    let hashrateAlgo = "h/s";
    for (const [poolName, algos] of poolAlgos) {
        const pool = pools.get(poolName);
        if (!pool) continue;
        pool.updateAlgoPerf(algos, choosePoolPerf(pool, poolAlgosPerf.get(poolName)));
        hashrateAlgo = chooseHashrateAlgo(hashrateAlgo, Object.keys(algos));
    }
    return hashrateAlgo;
}
function choosePoolPerf(pool, perf) {
    return Object.keys(perf).length > 0 ? perf : pool.defaultAlgosPerf;
}
function chooseHashrateAlgo(current, algoKeys) {
    if (algoKeys.length !== 1) return "h/s";
    const algo = algoKeys[0];
    if (!["c29s", "c29v"].includes(algo)) return "h/s";
    return compatibleHashrateAlgo(current, algo);
}
function compatibleHashrateAlgo(current, algo) {
    if (current === "h/s") return algo;
    if (current === algo) return algo;
    return "h/s";
}
function createSummaryState({ globalStats, pools, isPoolUsable, hashrateAlgo, lastSummaryKey, lastSummaryLogAt, now = Date.now() }) {
    const averageDiff = globalStats.miners > 0 ? Math.floor(globalStats.diff / globalStats.miners) : 0;
    const activePools = Array.from(pools.keys()).filter((hostname) => isPoolUsable(hostname)).length;
    const hashrateBucket = bucketHashrate(globalStats.hashRate);
    const summaryKey = JSON.stringify({
        miners: globalStats.miners,
        hashrateBucket,
        averageDiff,
        activePools,
        algo: hashrateAlgo
    });
    return {
        shouldLog: shouldLogSummary(summaryKey, lastSummaryKey, now, lastSummaryLogAt),
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
function bucketHashrate(hashRate) {
    if (hashRate >= 1000) return Math.round(hashRate / 100) * 100;
    return Math.round(hashRate / 10) * 10;
}
function shouldLogSummary(summaryKey, lastSummaryKey, now, lastSummaryLogAt) {
    if (summaryKey !== lastSummaryKey) return true;
    return (now - lastSummaryLogAt) >= 60_000;
}
function buildMonitorSnapshot({ workers, pools, developerShare, hashrateAlgo, isPoolUsable }) {
    const miners = [];
    const offlineMiners = [];
    const seenNames = new Set();
    const poolHashrate = new Map();
    let totalMiners = 0;
    let totalHashrate = 0;
    for (const workerState of workers.values()) ({ totalMiners, totalHashrate } = collectWorkerMinerViews({
        workerState,
        pools,
        hashrateAlgo,
        miners,
        offlineMiners,
        seenNames,
        poolHashrate,
        totalMiners,
        totalHashrate
    }));
    for (const miner of offlineMiners) addOfflineMinerView(miners, seenNames, miner);
    miners.sort(compareMinerViews);
    const poolList = Array.from(pools.values())
        .filter((pool) => !pool.devPool || developerShare > 0)
        .map((pool) => poolSnapshotView(pool, poolHashrate, isPoolUsable))
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
function collectWorkerMinerViews(context) {
    let { totalMiners, totalHashrate } = context;
    for (const miner of context.workerState.stats.values()) {
        const view = createMinerView(miner, context.pools, context.hashrateAlgo);
        if (!view) continue;
        ({ totalMiners, totalHashrate } = addMinerView(
            context.miners,
            context.offlineMiners,
            context.seenNames,
            context.poolHashrate,
            view,
            totalMiners,
            totalHashrate
        ));
    }
    return { totalMiners, totalHashrate };
}
function addMinerView(miners, offlineMiners, seenNames, poolHashrate, view, totalMiners, totalHashrate) {
    if (view.active) return addActiveMinerView(miners, seenNames, poolHashrate, view, totalMiners, totalHashrate);
    offlineMiners.push(view);
    return { totalMiners, totalHashrate };
}
function compareMinerViews(left, right) {
    if (left.active === right.active) return right.avgSpeed - left.avgSpeed;
    return left.active ? -1 : 1;
}
function poolSnapshotView(pool, poolHashrate, isPoolUsable) {
    return {
        hostname: pool.hostname,
        username: pool.username || null,
        devPool: pool.devPool,
        percentage: Number(pool.share || 0).toFixed(2),
        active: isPoolUsable(pool.hostname),
        hashrate: poolHashrate.get(pool.hostname) || 0,
        height: templateValue(pool, "height"),
        targetDiff: templateValue(pool, "targetDiff"),
        algo: templateValue(pool, "algo"),
        variant: templateValue(pool, "variant")
    };
}
function templateValue(pool, key) {
    if (!pool.activeBlockTemplate) return null;
    return pool.activeBlockTemplate[key] || null;
}
function createMinerView(miner, pools, hashrateAlgo) {
    if (!miner) return null;
    return { ...miner, algo: pools.get(miner.pool)?.activeBlockTemplate?.algo || hashrateAlgo };
}
function addActiveMinerView(miners, seenNames, poolHashrate, view, totalMiners, totalHashrate) {
    miners.push(view);
    seenNames.add(view.logString);
    poolHashrate.set(view.pool, (poolHashrate.get(view.pool) || 0) + view.avgSpeed);
    return { totalMiners: totalMiners + 1, totalHashrate: totalHashrate + view.avgSpeed };
}
function addOfflineMinerView(miners, seenNames, miner) {
    if (seenNames.has(miner.logString)) return;
    miners.push(miner);
    seenNames.add(miner.logString);
}
module.exports = { buildMonitorSnapshot, collectWorkerStats, createSummaryState };
