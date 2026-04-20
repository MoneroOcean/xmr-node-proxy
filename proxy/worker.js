"use strict";

const fs = require("node:fs");
const net = require("node:net");
const tls = require("node:tls");

const {
    AccessControl,
    CircularBuffer,
    isPoolUsable: resolvePoolUsability,
    maybeUnref,
} = require("./common");
const { MinerProtocol } = require("./miner");

class WorkerController {
    constructor(options) {
        this.config = options.config;
        this.logger = options.logger;
        this.instanceId = options.instanceId;
        this.coins = options.coinsFactory({ instanceId: this.instanceId, logger: this.logger });
        this.sendToMaster = options.sendToMaster;
        this.accessControl = new AccessControl(this.config);
        this.activeMiners = new Map();
        this.pools = new Map();
        this.defaultPool = null;
        this.protocol = new MinerProtocol(this);
        this.servers = [];
        this.updateDiffTimer = null;
        this.publishStatsTimer = null;
        this.failoverTimer = null;
    }

    start() {
        this.loadPools();
        this.startServers();
        this.updateDiffTimer = maybeUnref(setInterval(() => {
            for (const miner of this.activeMiners.values()) miner.updateDifficulty();
        }, 45_000));
        this.publishStatsTimer = maybeUnref(setInterval(() => this.publishStats(), 10_000));
        this.failoverTimer = maybeUnref(setInterval(() => this.checkActivePools(), 90_000));
        this.sendToMaster({ type: "needPoolState" });
    }

    async stop() {
        if (this.updateDiffTimer) clearInterval(this.updateDiffTimer);
        if (this.publishStatsTimer) clearInterval(this.publishStatsTimer);
        if (this.failoverTimer) clearInterval(this.failoverTimer);
        this.updateDiffTimer = null;
        this.publishStatsTimer = null;
        this.failoverTimer = null;

        for (const serverInfo of this.servers) {
            await new Promise((resolve) => serverInfo.server.close(resolve));
        }
        this.servers = [];
        for (const miner of this.activeMiners.values()) {
            try {
                miner.socket.destroy();
            } catch (_error) {
                // Best effort cleanup.
            }
        }
        this.activeMiners.clear();
    }

    loadPools() {
        for (const poolConfig of this.config.pools) {
            this.ensurePool(poolConfig);
            if (poolConfig.default) {
                this.defaultPool = poolConfig.hostname;
            }
        }

        if (this.config.developerShare > 0 && !this.pools.has(this.coins.devPool.hostname)) {
            this.ensurePool(this.coins.devPool);
        }
    }

    ensurePool(poolConfig) {
        if (this.pools.has(poolConfig.hostname)) return this.pools.get(poolConfig.hostname);
        // Workers do miner-facing validation locally, so they must build the same
        // coins contract as the master.
        const poolState = {
            ...poolConfig,
            coins: this.coins,
            active: false,
            activeBlockTemplate: null,
            pastBlockTemplates: new CircularBuffer(4),
            defaultAlgoSet: Object.fromEntries(poolConfig.algo.map((algo) => [algo, 1]))
        };
        this.pools.set(poolConfig.hostname, poolState);
        return poolState;
    }

    isAllowedLogin(username, password) {
        try {
            return this.accessControl.isAllowed(username, password);
        } catch (error) {
            this.logger.error("access.reload_failed", { error: error.message });
            return false;
        }
    }

    isPoolUsable(hostname) {
        return resolvePoolUsability(
            this.pools,
            hostname,
            (pool) => pool.active && pool.activeBlockTemplate
        );
    }

    chooseInitialPool() {
        const defaultPool = this.defaultPool;
        if (defaultPool && this.isPoolUsable(defaultPool)) return defaultPool;
        for (const [hostname, pool] of this.pools) {
            if (pool.devPool) continue;
            if (this.isPoolUsable(hostname)) return hostname;
        }
        return defaultPool || null;
    }

    handleMasterMessage(message) {
        if (!message || typeof message !== "object") return;
        switch (message.type) {
        case "poolState":
            for (const hostname of message.data) {
                const pool = this.pools.get(hostname);
                if (pool) pool.active = true;
            }
            return;
        case "newBlockTemplate": {
            const pool = this.pools.get(message.host);
            if (!pool) return;
            if (pool.activeBlockTemplate) {
                pool.pastBlockTemplates.enq(pool.activeBlockTemplate);
            }
            pool.active = true;
            pool.activeBlockTemplate = new pool.coins.BlockTemplate(message.data);
            for (const miner of this.activeMiners.values()) {
                if (miner.pool === message.host) miner.pushNewJob();
            }
            return;
        }
        case "changePool": {
            const miner = this.activeMiners.get(message.worker);
            if (!miner || !this.pools.has(message.pool)) return;
            miner.pool = message.pool;
            miner.pushNewJob(true);
            return;
        }
        case "disablePool": {
            const pool = this.pools.get(message.pool);
            if (!pool) return;
            pool.active = false;
            this.checkActivePools();
            return;
        }
        case "enablePool": {
            const pool = this.pools.get(message.pool);
            if (!pool) return;
            pool.active = true;
            return;
        }
        default:
            this.logger.debug("worker", `Ignoring master message ${message.type}`);
        }
    }

    startServers() {
        for (const portData of this.config.listeningPorts) {
            const handler = (socket) => this.protocol.attachSocket(socket, portData);
            const server = portData.ssl
                ? tls.createServer({
                    key: fs.readFileSync(this.config.tls.keyPath),
                    cert: fs.readFileSync(this.config.tls.certPath)
                }, handler)
                : net.createServer(handler);

            server.on("error", (error) => {
                this.logger.error("listen.bind_failed", {
                    port: portData.port,
                    tls: portData.ssl,
                    error: error.message
                });
            });
            server.listen(portData.port, this.config.bindAddress, () => {
                const address = server.address();
                this.logger.info("listen.ready", {
                    host: address.address,
                    port: address.port,
                    tls: portData.ssl,
                    diff: portData.diff
                });
            });
            this.servers.push({ server, portData });
        }
    }

    getBoundPorts() {
        return this.servers.map(({ server, portData }) => {
            const address = server.address();
            return {
                requestedPort: portData.port,
                actualPort: address.port,
                ssl: portData.ssl
            };
        });
    }

    publishStats() {
        for (const [minerId, miner] of this.activeMiners) this.reportMinerStat(minerId, miner);
    }

    reportMinerStat(minerId, miner) {
        this.sendToMaster({
            type: "workerStats",
            minerID: minerId,
            data: miner.stats()
        });
    }

    removeMinerStat(minerId) {
        this.sendToMaster({
            type: "workerStatsRemove",
            minerID: minerId
        });
    }

    checkActivePools() {
        const reassignedMiners = [];
        for (const [hostname, pool] of this.pools) {
            if (pool.active) continue;
            const fallbackHost = this.chooseInitialPool();
            if (!fallbackHost || fallbackHost === hostname) continue;
            for (const miner of this.activeMiners.values()) {
                if (miner.pool !== hostname) continue;
                miner.pool = fallbackHost;
                reassignedMiners.push(miner);
                this.reportMinerStat(miner.id, miner);
            }
        }
        for (const miner of reassignedMiners) miner.pushNewJob(true);
    }
}

module.exports = {
    WorkerController
};
