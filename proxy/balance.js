"use strict";

function normalizePoolPercentages(state, isPoolUsable) {
    const percentageDelta = Math.abs(state.totalPercentage - 100);
    if (percentageDelta <= 0.001) return null;

    if (state.totalPercentage > 0) {
        const modifier = 100 / state.totalPercentage;
        for (const poolState of Object.values(state.pools)) {
            if (poolState.devPool || !isPoolUsable(poolState.name)) continue;
            poolState.percentage *= modifier;
        }
        return null;
    }

    if (state.activePoolCount > 0) {
        const addModifier = 100 / state.activePoolCount;
        for (const poolState of Object.values(state.pools)) {
            if (poolState.devPool || !isPoolUsable(poolState.name)) continue;
            poolState.percentage += addModifier;
        }
        return null;
    }

    return { reason: "no-active-pools" };
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
    const remainingHashrate = state.totalHashrate;

    if (devPoolName && state.pools[devPoolName]) {
        const devPool = state.pools[devPoolName];
        const devHashrate = Math.floor(remainingHashrate * (developerShare / 100));
        state.totalHashrate -= devHashrate;
        devPool.idealRate = devHashrate;
        if (isPoolUsable(devPoolName) && devPool.idealRate > devPool.hashrate) {
            lowPools[devPoolName] = devPool.idealRate - devPool.hashrate;
        } else if (!isPoolUsable(devPoolName) || devPool.idealRate < devPool.hashrate) {
            highPools[devPoolName] = devPool.hashrate - devPool.idealRate;
        }
    }

    for (const poolState of Object.values(state.pools)) {
        if (poolState.name === devPoolName) continue;
        poolState.idealRate = Math.floor(state.totalHashrate * (poolState.percentage / 100));
        if (isPoolUsable(poolState.name) && poolState.idealRate > poolState.hashrate) {
            lowPools[poolState.name] = poolState.idealRate - poolState.hashrate;
        } else if (!isPoolUsable(poolState.name) || poolState.idealRate < poolState.hashrate) {
            highPools[poolState.name] = poolState.hashrate - poolState.idealRate;
        }
    }

    return { devPoolName, highPools, lowPools };
}

function freeMinerCapacity(state, highPools, isPoolUsable) {
    const freedMiners = {};

    for (const [poolName, delta] of Object.entries(highPools)) {
        const poolState = state.pools[poolName];
        if (!poolState) continue;

        let remainder = delta;
        for (const [minerKey, rate] of Object.entries(poolState.miners)) {
            if (rate === 0) continue;
            if (rate <= remainder || !isPoolUsable(poolName)) {
                remainder -= rate;
                freedMiners[minerKey] = rate;
                delete poolState.miners[minerKey];
            }
        }
    }

    return freedMiners;
}

function allocateFreedMiners(state, lowPools, freedMiners, devPoolName) {
    const minerChanges = {};

    for (const [poolName, needed] of Object.entries(lowPools)) {
        let remainder = needed;
        minerChanges[poolName] = [];

        for (const [minerKey, rate] of Object.entries(freedMiners)) {
            if (rate > remainder) continue;
            minerChanges[poolName].push(minerKey);
            remainder -= rate;
            delete freedMiners[minerKey];
        }

        if (remainder <= 100) continue;

        for (const donorPool of Object.keys(state.pools)) {
            if (donorPool in lowPools) continue;

            const donorState = state.pools[donorPool];
            for (const [minerKey, rate] of Object.entries(donorState.miners)) {
                if (rate > remainder || rate === 0) continue;
                minerChanges[poolName].push(minerKey);
                remainder -= rate;
                delete donorState.miners[minerKey];
                if (remainder < 50) break;
            }

            if (remainder < 50) break;
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

    return minerChanges;
}

function planPoolRebalance({ pools, miners, developerShare = 0, isPoolUsable }) {
    const state = createBalanceState();
    const minerIndex = {};
    const warnings = [];

    for (const pool of pools) {
        state.pools[pool.name] = {
            name: pool.name,
            devPool: pool.devPool === true,
            percentage: Number(pool.share || 0),
            idealRate: 0,
            hashrate: 0,
            miners: {}
        };

        if (pool.devPool) {
            state.devPoolName = pool.name;
        } else if (isPoolUsable(pool.name)) {
            state.totalPercentage += Number(pool.share || 0);
            state.activePoolCount += 1;
        }
    }

    const warning = normalizePoolPercentages(state, isPoolUsable);
    if (warning) warnings.push(warning);

    for (const miner of miners) {
        if (!miner.active) continue;
        const poolState = state.pools[miner.pool];
        if (!poolState) continue;

        const minerKey = `${miner.workerId}_${miner.minerId}`;
        minerIndex[minerKey] = miner;
        state.totalHashrate += miner.avgSpeed;
        poolState.hashrate += miner.avgSpeed;
        poolState.miners[minerKey] = miner.avgSpeed;
    }

    if (warnings.length > 0) {
        return { changes: [], warnings };
    }

    const { devPoolName, highPools, lowPools } = classifyPoolDeltas(state, developerShare, isPoolUsable);
    const freedMiners = freeMinerCapacity(state, highPools, isPoolUsable);
    const minerChanges = allocateFreedMiners(state, lowPools, freedMiners, devPoolName);
    const changes = [];

    for (const [poolName, minerKeys] of Object.entries(minerChanges)) {
        for (const minerKey of minerKeys) {
            const miner = minerIndex[minerKey];
            if (!miner) continue;
            changes.push({
                workerId: miner.workerId,
                minerId: miner.minerId,
                pool: poolName
            });
        }
    }

    return { changes, warnings };
}

module.exports = {
    planPoolRebalance
};
