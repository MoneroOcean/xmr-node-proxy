"use strict";

const cluster = require("node:cluster");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

const {
    PROXY_VERSION,
    createLogger,
    loadJsonFile,
    normalizeConfig,
    parseArgs
} = require("./proxy-common");
const { MasterController } = require("./proxy-master");
const { WorkerController } = require("./proxy-worker");

class StandaloneProxyApp {
    constructor(options) {
        this.config = options.config;
        this.coinFactories = options.coinFactories || {};
        this.logger = options.logger || createLogger({ component: "xnp" });
        this.instanceId = options.instanceId || crypto.randomBytes(3);
        this.master = new MasterController({
            config: this.config,
            logger: this.logger.child("master"),
            coinFactories: this.coinFactories,
            instanceId: this.instanceId
        });
        this.worker = new WorkerController({
            config: this.config,
            logger: this.logger.child("worker"),
            coinFactories: this.coinFactories,
            instanceId: this.instanceId,
            sendToMaster: (message) => this.master.handleWorkerMessage("standalone", message)
        });
        this.master.attachWorker("standalone", (message) => this.worker.handleMasterMessage(message));
    }

    start() {
        this.logger.info("proxy.start", { mode: "standalone", version: PROXY_VERSION });
        this.master.start();
        this.worker.start();
    }

    async stop() {
        await this.worker.stop();
        await this.master.stop();
    }

    getBoundPorts() {
        return this.worker.getBoundPorts();
    }

    getMonitorSnapshot() {
        return this.master.getMonitorSnapshot();
    }

    getState() {
        return {
            master: this.master,
            worker: this.worker
        };
    }
}

function createStandaloneApp(rawConfig, options = {}) {
    const configPath = options.configPath || path.resolve(process.cwd(), "config.json");
    const config = normalizeConfig(rawConfig, configPath);
    return new StandaloneProxyApp({
        config,
        coinFactories: options.coinFactories,
        instanceId: options.instanceId,
        logger: options.logger
    });
}

function createMasterRuntime(options) {
    const { config, coinFactories, instanceId } = options;
    const logger = createLogger({ component: "master" });
    const master = new MasterController({
        config,
        logger,
        coinFactories,
        instanceId
    });

    let shuttingDown = false;

    function attachWorker(worker) {
        master.attachWorker(String(worker.id), (message) => {
            if (worker.isConnected()) worker.send(message);
        });
        worker.on("message", (message) => master.handleWorkerMessage(String(worker.id), message));
    }

    function spawnWorker() {
        const worker = cluster.fork({
            XNP_CONFIG_PATH: options.configPath,
            XNP_INSTANCE_ID: instanceId.toString("hex")
        });
        attachWorker(worker);
    }

    master.start();

    const workerCount = options.workerCount || os.cpus().length;
    logger.info("cluster.start", { workers: workerCount });
    for (let index = 0; index < workerCount; index += 1) {
        spawnWorker();
    }

    cluster.on("exit", (worker, code, signal) => {
        master.detachWorker(String(worker.id));
        logger.error("cluster.worker_exit", {
            pid: worker.process.pid,
            code,
            signal
        });
        if (!shuttingDown) spawnWorker();
    });

    async function stop() {
        if (shuttingDown) return;
        shuttingDown = true;
        for (const worker of Object.values(cluster.workers)) {
            if (worker) worker.kill();
        }
        await master.stop();
    }

    registerSignalHandlers(stop);
}

function createWorkerRuntime(options) {
    const { config, coinFactories, instanceId } = options;
    const logger = createLogger({ component: `worker.${cluster.worker?.id || 0}` });
    const worker = new WorkerController({
        config,
        logger,
        coinFactories,
        instanceId,
        sendToMaster: (message) => {
            if (typeof process.send === "function") process.send(message);
        }
    });

    process.on("message", (message) => worker.handleMasterMessage(message));
    worker.start();
    registerSignalHandlers(async () => {
        await worker.stop();
        process.exit(0);
    });
}

function registerSignalHandlers(stop) {
    const handler = async () => {
        try {
            await stop();
        } catch (error) {
            console.error(error);
            process.exitCode = 1;
        }
    };

    process.once("SIGINT", handler);
    process.once("SIGTERM", handler);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const configPath = process.env.XNP_CONFIG_PATH || args.config;
    const rawConfig = loadJsonFile(configPath);
    const config = normalizeConfig(rawConfig, configPath);
    const instanceId = process.env.XNP_INSTANCE_ID
        ? Buffer.from(process.env.XNP_INSTANCE_ID, "hex")
        : crypto.randomBytes(3);

    if (args.standalone) {
        const app = new StandaloneProxyApp({ config, instanceId });
        app.start();
        registerSignalHandlers(async () => {
            await app.stop();
            process.exit(0);
        });
        return;
    }

    if (cluster.isPrimary) {
        createMasterRuntime({
            config,
            configPath,
            instanceId,
            workerCount: args.workers,
            coinFactories: {}
        });
        return;
    }

    createWorkerRuntime({
        config,
        instanceId,
        coinFactories: {}
    });
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = {
    PROXY_VERSION,
    StandaloneProxyApp,
    createStandaloneApp
};
