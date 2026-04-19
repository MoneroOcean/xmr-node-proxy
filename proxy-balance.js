"use strict";

function normalizeCoinPercentages(coinState, isPoolUsable) {
    const percentageDelta = Math.abs(coinState.totalPercentage - 100);
    if (percentageDelta <= 0.001) return null;

    if (coinState.totalPercentage > 0) {
        const modifier = 100 / coinState.totalPercentage;
        for (const poolState of Object.values(coinState.pools)) {
            if (poolState.devPool || !isPoolUsable(poolState.name)) continue;
            poolState.percentage *= modifier;
        }
        return null;
    }

    if (coinState.activePoolCount > 0) {
        const addModifier = 100 / coinState.activePoolCount;
        for (const poolState of Object.values(coinState.pools)) {
            if (poolState.devPool || !isPoolUsable(poolState.name)) continue;
            poolState.percentage += addModifier;
        }
        return null;
    }

    return { coin: coinState.coin, reason: "no-active-pools" };
}

function createCoinState(coinName) {
    return {
        coin: coinName,
        pools: {},
        totalPercentage: 0,
        activePoolCount: 0,
        devPoolName: null,
        totalHashrate: 0
    };
}

function classifyPoolDeltas(coinState, developerShare, isPoolUsable) {
    const highPools = {};
    const lowPools = {};
    const devPoolName = coinState.devPoolName;
    const remainingHashrate = coinState.totalHashrate;

    if (devPoolName && coinState.pools[devPoolName]) {
        const devPool = coinState.pools[devPoolName];
        const devHashrate = Math.floor(remainingHashrate * (developerShare / 100));
        coinState.totalHashrate -= devHashrate;
        devPool.idealRate = devHashrate;
        if (isPoolUsable(devPoolName) && devPool.idealRate > devPool.hashrate) {
            lowPools[devPoolName] = devPool.idealRate - devPool.hashrate;
        } else if (!isPoolUsable(devPoolName) || devPool.idealRate < devPool.hashrate) {
            highPools[devPoolName] = devPool.hashrate - devPool.idealRate;
        }
    }

    for (const poolState of Object.values(coinState.pools)) {
        if (poolState.name === devPoolName) continue;
        poolState.idealRate = Math.floor(coinState.totalHashrate * (poolState.percentage / 100));
        if (isPoolUsable(poolState.name) && poolState.idealRate > poolState.hashrate) {
            lowPools[poolState.name] = poolState.idealRate - poolState.hashrate;
        } else if (!isPoolUsable(poolState.name) || poolState.idealRate < poolState.hashrate) {
            highPools[poolState.name] = poolState.hashrate - poolState.idealRate;
        }
    }

    return { devPoolName, highPools, lowPools };
}

function freeMinerCapacity(coinState, highPools, isPoolUsable) {
    const freedMiners = {};

    for (const [poolName, delta] of Object.entries(highPools)) {
        const poolState = coinState.pools[poolName];
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

function allocateFreedMiners(coinState, lowPools, freedMiners, devPoolName) {
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

        for (const donorPool of Object.keys(coinState.pools)) {
            if (donorPool in lowPools) continue;

            const donorState = coinState.pools[donorPool];
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
    const coinStates = {};
    const minerIndex = {};
    const warnings = [];

    for (const pool of pools) {
        if (!coinStates[pool.coin]) {
            coinStates[pool.coin] = createCoinState(pool.coin);
        }

        const coinState = coinStates[pool.coin];
        coinState.pools[pool.name] = {
            name: pool.name,
            devPool: pool.devPool === true,
            percentage: Number(pool.share || 0),
            idealRate: 0,
            hashrate: 0,
            miners: {}
        };

        if (pool.devPool) {
            coinState.devPoolName = pool.name;
        } else if (isPoolUsable(pool.name)) {
            coinState.totalPercentage += Number(pool.share || 0);
            coinState.activePoolCount += 1;
        }
    }

    for (const coinState of Object.values(coinStates)) {
        const warning = normalizeCoinPercentages(coinState, isPoolUsable);
        if (warning) warnings.push(warning);
    }

    for (const miner of miners) {
        if (!miner.active) continue;
        const coinState = coinStates[miner.coin];
        const poolState = coinState?.pools[miner.pool];
        if (!poolState) continue;

        const minerKey = `${miner.workerId}_${miner.minerId}`;
        minerIndex[minerKey] = miner;
        coinState.totalHashrate += miner.avgSpeed;
        poolState.hashrate += miner.avgSpeed;
        poolState.miners[minerKey] = miner.avgSpeed;
    }

    const changes = [];

    for (const coinState of Object.values(coinStates)) {
        const warning = warnings.find((entry) => entry.coin === coinState.coin);
        if (warning) continue;

        const { devPoolName, highPools, lowPools } = classifyPoolDeltas(coinState, developerShare, isPoolUsable);
        const freedMiners = freeMinerCapacity(coinState, highPools, isPoolUsable);
        const minerChanges = allocateFreedMiners(coinState, lowPools, freedMiners, devPoolName);

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
    }

    return { changes, warnings };
}

module.exports = {
    planPoolRebalance
};
