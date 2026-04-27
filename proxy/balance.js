"use strict";

function normalizePoolPercentages(state, isPoolUsable) {
    const percentageDelta = Math.abs(state.totalPercentage - 100);
    if (percentageDelta <= 0.001) return null;
    if (state.totalPercentage > 0) {
        adjustUsablePoolPercentages(state, isPoolUsable, (poolState) => {
            poolState.percentage *= 100 / state.totalPercentage;
        });
        return null;
    }
    if (state.activePoolCount > 0) {
        adjustUsablePoolPercentages(state, isPoolUsable, (poolState) => {
            poolState.percentage += 100 / state.activePoolCount;
        });
        return null;
    }
    return { reason: "no-active-pools" };
}
function adjustUsablePoolPercentages(state, isPoolUsable, update) {
    for (const poolState of Object.values(state.pools)) {
        if (!poolState.devPool && isPoolUsable(poolState.name)) update(poolState);
    }
}
function createBalanceState() {
    return {
        pools: {},
        totalPercentage: 0,
        activePoolCount: 0,
        devPoolName: null,
        totalHashrate: 0
    };
}

function classifyPoolDeltas(state, developerShare, isPoolUsable) {
    const highPools = {};
    const lowPools = {};
    const devPoolName = state.devPoolName;
    applyDeveloperPoolDelta(state, developerShare, isPoolUsable, highPools, lowPools);
    for (const poolState of Object.values(state.pools)) {
        if (poolState.name === devPoolName) continue;
        poolState.idealRate = Math.floor(state.totalHashrate * (poolState.percentage / 100));
        assignPoolDelta(poolState, isPoolUsable, highPools, lowPools);
    }
    return { devPoolName, highPools, lowPools };
}
function applyDeveloperPoolDelta(state, developerShare, isPoolUsable, highPools, lowPools) {
    const devPoolName = state.devPoolName;
    if (!devPoolName || !state.pools[devPoolName]) return;
    const devPool = state.pools[devPoolName];
    const devHashrate = Math.floor(state.totalHashrate * (developerShare / 100));
    state.totalHashrate -= devHashrate;
    devPool.idealRate = devHashrate;
    assignPoolDelta(devPool, isPoolUsable, highPools, lowPools);
}
function assignPoolDelta(poolState, isPoolUsable, highPools, lowPools) {
    if (poolNeedsHashrate(poolState, isPoolUsable)) {
        lowPools[poolState.name] = poolState.idealRate - poolState.hashrate;
    } else if (poolHasExcessHashrate(poolState, isPoolUsable)) {
        highPools[poolState.name] = poolState.hashrate - poolState.idealRate;
    }
}
function poolNeedsHashrate(poolState, isPoolUsable) {
    return isPoolUsable(poolState.name) && poolState.idealRate > poolState.hashrate;
}
function poolHasExcessHashrate(poolState, isPoolUsable) {
    return !isPoolUsable(poolState.name) || poolState.idealRate < poolState.hashrate;
}
function freeMinerCapacity(state, highPools, isPoolUsable) {
    const freedMiners = {};
    for (const [poolName, delta] of Object.entries(highPools)) {
        const poolState = state.pools[poolName];
        if (!poolState) continue;
        freePoolMiners(poolState, delta, !isPoolUsable(poolName), freedMiners);
    }
    return freedMiners;
}
function freePoolMiners(poolState, delta, force, freedMiners) {
    let remainder = delta;
    for (const [minerKey, rate] of Object.entries(poolState.miners)) {
        if (rate === 0) continue;
        if (!shouldFreeMiner(rate, remainder, force)) continue;
        remainder -= rate;
        freedMiners[minerKey] = rate;
        delete poolState.miners[minerKey];
    }
}
function shouldFreeMiner(rate, remainder, force) {
    return rate <= remainder || force;
}
function allocateFreedMiners(state, lowPools, freedMiners, devPoolName) {
    const minerChanges = {};
    for (const [poolName, needed] of Object.entries(lowPools)) {
        minerChanges[poolName] = [];
        allocatePoolMiners(state, lowPools, freedMiners, minerChanges[poolName], needed);
    }
    for (const poolName of Object.keys(lowPools)) {
        distributeRemainingMiners(poolName, devPoolName, minerChanges, freedMiners);
    }
    return minerChanges;
}
function distributeRemainingMiners(poolName, devPoolName, minerChanges, freedMiners) {
    if (poolName === devPoolName) return;
    if (!minerChanges[poolName]) minerChanges[poolName] = [];
    for (const minerKey of Object.keys(freedMiners)) {
        minerChanges[poolName].push(minerKey);
        delete freedMiners[minerKey];
    }
}
function allocatePoolMiners(state, lowPools, freedMiners, changes, needed) {
    const remainder = takeFreedMiners(changes, freedMiners, needed);
    if (!(remainder <= 100)) takeDonorMiners(state, lowPools, changes, remainder);
}
function takeFreedMiners(changes, freedMiners, remainder) {
    for (const [minerKey, rate] of Object.entries(freedMiners)) {
        if (rate > remainder) continue;
        changes.push(minerKey);
        remainder -= rate;
        delete freedMiners[minerKey];
    }
    return remainder;
}
function takeDonorMiners(state, lowPools, changes, remainder) {
    for (const donorPool of Object.keys(state.pools)) {
        if (donorPool in lowPools) continue;
        remainder = takeFromDonorPool(state.pools[donorPool], changes, remainder);
        if (remainder < 50) break;
    }
}
function takeFromDonorPool(donorState, changes, remainder) {
    for (const [minerKey, rate] of Object.entries(donorState.miners)) {
        remainder = takeDonorMiner(donorState, changes, minerKey, rate, remainder);
        if (remainder < 50) break;
    }
    return remainder;
}
function takeDonorMiner(donorState, changes, minerKey, rate, remainder) {
    if (rate === 0) return remainder;
    if (rate > remainder) return remainder;
    changes.push(minerKey);
    delete donorState.miners[minerKey];
    return remainder - rate;
}
function planPoolRebalance({ pools, miners, developerShare = 0, isPoolUsable }) {
    const state = createBalanceState();
    const minerIndex = {};
    const warnings = buildBalanceInputs(state, minerIndex, pools, miners, isPoolUsable);
    if (warnings.length > 0) return { changes: [], warnings };
    const { devPoolName, highPools, lowPools } = classifyPoolDeltas(state, developerShare, isPoolUsable);
    const freedMiners = freeMinerCapacity(state, highPools, isPoolUsable);
    const minerChanges = allocateFreedMiners(state, lowPools, freedMiners, devPoolName);
    const changes = [];
    collectMinerChanges(changes, minerIndex, minerChanges);
    return { changes, warnings };
}
function buildBalanceInputs(state, minerIndex, pools, miners, isPoolUsable) {
    const warnings = [];
    for (const pool of pools) addPoolToState(state, pool, isPoolUsable);
    const warning = normalizePoolPercentages(state, isPoolUsable);
    if (warning) warnings.push(warning);
    for (const miner of miners) addMinerToState(state, minerIndex, miner);
    return warnings;
}
function collectMinerChanges(changes, minerIndex, minerChanges) {
    for (const [poolName, minerKeys] of Object.entries(minerChanges)) addMinerChanges(changes, minerIndex, poolName, minerKeys);
}
function addMinerChanges(changes, minerIndex, poolName, minerKeys) {
    for (const minerKey of minerKeys) {
        const miner = minerIndex[minerKey];
        if (miner) changes.push({ workerId: miner.workerId, minerId: miner.minerId, pool: poolName });
    }
}
function addPoolToState(state, pool, isPoolUsable) {
    state.pools[pool.name] = {
        name: pool.name,
        devPool: pool.devPool === true,
        percentage: Number(pool.share || 0),
        idealRate: 0,
        hashrate: 0,
        miners: {}
    };
    if (pool.devPool) state.devPoolName = pool.name;
    addActivePoolShare(state, pool, isPoolUsable);
}
function addActivePoolShare(state, pool, isPoolUsable) {
    if (pool.devPool) return;
    if (!isPoolUsable(pool.name)) return;
    state.totalPercentage += Number(pool.share || 0);
    state.activePoolCount += 1;
}
function addMinerToState(state, minerIndex, miner) {
    if (!miner.active) return;
    const poolState = state.pools[miner.pool];
    if (!poolState) return;
    const minerKey = `${miner.workerId}_${miner.minerId}`;
    minerIndex[minerKey] = miner;
    state.totalHashrate += miner.avgSpeed;
    poolState.hashrate += miner.avgSpeed;
    poolState.miners[minerKey] = miner.avgSpeed;
}
module.exports = { planPoolRebalance };
