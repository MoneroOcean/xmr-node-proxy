"use strict";

const cluster = require("node:cluster");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const createCoins = require("./coins/core");

const {
    PROXY_VERSION,
    createLogger,
    loadJsonFile,
    normalizeConfig,
    parseArgs
} = require("./proxy/common");
const { MasterController } = require("./proxy/master");
const { WorkerController } = require("./proxy/worker");

function loadRuntimeConfig(configPath) {
    const rawConfig = loadJsonFile(configPath);
    return normalizeConfig(rawConfig, configPath);
}

class StandaloneProxyApp {
    constructor(options) {
        this.configPath = options.configPath || path.resolve(process.cwd(), "config.json");
        this.coinsFactory = options.coinsFactory || createCoins;
        this.logger = options.logger || createLogger({ component: "xnp" });
        this.instanceId = options.instanceId || crypto.randomBytes(3);
        const initialConfig = options.config || loadRuntimeConfig(this.configPath);
        this.applyControllers(this.createControllers(initialConfig));
    }

    createControllers(config) {
        // Standalone mode keeps the normal master/worker boundary inside one process.
        // Tests and local protocol work use this path so runtime behavior stays close to clustered mode.
        const master = new MasterController({
            config,
            logger: this.logger.child("master"),
            coinsFactory: this.coinsFactory,
            instanceId: this.instanceId
        });
        const worker = new WorkerController({
            config,
            logger: this.logger.child("worker"),
            coinsFactory: this.coinsFactory,
            instanceId: this.instanceId,
            sendToMaster: (message) => master.handleWorkerMessage("standalone", message)
        });
        master.attachWorker("standalone", (message) => worker.handleMasterMessage(message));
        return { config, master, worker };
    }

    applyControllers(controllers) {
        this.config = controllers.config;
        this.master = controllers.master;
        this.worker = controllers.worker;
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

    async reload(rawConfig = null) {
        const nextConfig = rawConfig ? normalizeConfig(rawConfig, this.configPath) : loadRuntimeConfig(this.configPath);
        const nextControllers = this.createControllers(nextConfig);

        this.logger.info("config.reload_start", { mode: "standalone" });
        await this.worker.stop();
        await this.master.stop();
        this.applyControllers(nextControllers);
        this.master.start();
        this.worker.start();
        this.logger.info("config.reload_complete", { mode: "standalone" });
    }

    getBoundPorts() {
        return this.worker.getBoundPorts();
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
        configPath,
        coinsFactory: options.coinsFactory,
        instanceId: options.instanceId,
        logger: options.logger
    });
}

class ClusterRuntimeManager {
    constructor(options) {
        this.config = options.config;
        this.configPath = options.configPath;
        this.coinsFactory = options.coinsFactory || createCoins;
        this.instanceId = options.instanceId;
        this.logger = createLogger({ component: "master" });
        this.workerCount = options.workerCount || os.cpus().length;
        this.master = null;
        this.shuttingDown = false;
        this.reloading = false;
        this.exitListenerAttached = false;
        this.handleWorkerExit = this.handleWorkerExit.bind(this);
    }

    createMasterController(config) {
        // The primary process owns shared upstream state, balancing, stats, and the HTTP monitor.
        return new MasterController({
            config,
            logger: this.logger,
            coinsFactory: this.coinsFactory,
            instanceId: this.instanceId
        });
    }

    attachWorker(worker) {
        this.master.attachWorker(String(worker.id), (message) => {
            if (worker.isConnected()) worker.send(message);
        });
        worker.on("message", (message) => {
            if (!this.master) return;
            this.master.handleWorkerMessage(String(worker.id), message);
        });
    }

    spawnWorker() {
        const env = {
            XNP_CONFIG_PATH: this.configPath,
            XNP_INSTANCE_ID: this.instanceId.toString("hex")
        };

        const worker = cluster.fork(env);
        this.attachWorker(worker);
        return worker;
    }

    async stopWorkers() {
        const workers = Object.values(cluster.workers).filter(Boolean);
        await Promise.all(workers.map((worker) => new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                resolve();
            };

            const timeout = setTimeout(finish, 2_000);
            worker.once("exit", () => {
                clearTimeout(timeout);
                finish();
            });
            worker.kill();
        })));
    }

    start() {
        this.master = this.createMasterController(this.config);
        this.master.start();

        if (!this.exitListenerAttached) {
            cluster.on("exit", this.handleWorkerExit);
            this.exitListenerAttached = true;
        }

        this.logger.info("cluster.start", { workers: this.workerCount });
        for (let index = 0; index < this.workerCount; index += 1) {
            this.spawnWorker();
        }
    }

    handleWorkerExit(worker, code, signal) {
        if (this.master) {
            this.master.detachWorker(String(worker.id));
        }
        const log = this.shuttingDown || this.reloading ? this.logger.info.bind(this.logger) : this.logger.error.bind(this.logger);
        log("cluster.worker_exit", {
            pid: worker.process.pid,
            code,
            signal
        });
        if (!this.shuttingDown && !this.reloading) {
            this.spawnWorker();
        }
    }

    async reload() {
        if (this.shuttingDown || this.reloading) return false;

        const nextConfig = loadRuntimeConfig(this.configPath);
        this.logger.info("config.reload_start", { mode: "cluster" });
        this.reloading = true;

        try {
            await this.stopWorkers();
            if (this.master) await this.master.stop();
            this.config = nextConfig;
            this.master = this.createMasterController(this.config);
            this.master.start();
            for (let index = 0; index < this.workerCount; index += 1) {
                this.spawnWorker();
            }
            this.logger.info("config.reload_complete", { mode: "cluster" });
            return true;
        } catch (error) {
            this.logger.error("config.reload_failed", {
                mode: "cluster",
                error: error.message
            });
            throw error;
        } finally {
            this.reloading = false;
        }
    }

    async stop() {
        if (this.shuttingDown) return;
        this.shuttingDown = true;
        await this.stopWorkers();
        if (this.master) {
            await this.master.stop();
            this.master = null;
        }
    }
}

function createMasterRuntime(options) {
    const runtime = new ClusterRuntimeManager(options);
    runtime.start();
    registerSignalHandlers({
        reload: () => runtime.reload(),
        stop: () => runtime.stop()
    });
    return runtime;
}

function createWorkerRuntime(options) {
    const { config, coinsFactory, instanceId } = options;
    const logger = createLogger({ component: `worker.${cluster.worker?.id || 0}` });
    // Worker processes handle miner-facing sockets and talk back to the primary process for shared pool state.
    const worker = new WorkerController({
        config,
        logger,
        coinsFactory: coinsFactory || createCoins,
        instanceId,
        sendToMaster: (message) => {
            if (typeof process.send === "function") process.send(message);
        }
    });

    process.on("message", (message) => worker.handleMasterMessage(message));
    worker.start();
    registerSignalHandlers({
        stop: async () => {
            await worker.stop();
            process.exit(0);
        }
    });
}

function registerSignalHandlers({ stop, reload = null }) {
    const stopHandler = async () => {
        try {
            await stop();
        } catch (error) {
            console.error(error);
            process.exitCode = 1;
        }
    };

    const reloadHandler = async () => {
        if (typeof reload !== "function") return;
        try {
            await reload();
        } catch (error) {
            console.error(error);
        }
    };

    process.once("SIGINT", stopHandler);
    process.once("SIGTERM", stopHandler);
    if (typeof reload === "function") {
        process.on("SIGHUP", reloadHandler);
    }
}

async function main(options = {}) {
    const args = parseArgs(options.argv || process.argv.slice(2));
    const configPath = options.configPath || process.env.XNP_CONFIG_PATH || args.config;
    const config = options.config || loadRuntimeConfig(configPath);
    const instanceId = options.instanceId || (
        process.env.XNP_INSTANCE_ID
            ? Buffer.from(process.env.XNP_INSTANCE_ID, "hex")
            : crypto.randomBytes(3)
    );
    const coinsFactory = options.coinsFactory || createCoins;

    if (args.standalone) {
        const app = new StandaloneProxyApp({ config, configPath, instanceId, coinsFactory });
        app.start();
        registerSignalHandlers({
            reload: () => app.reload(),
            stop: async () => {
                await app.stop();
                process.exit(0);
            }
        });
        return;
    }

    if (cluster.isPrimary) {
        createMasterRuntime({
            config,
            configPath,
            instanceId,
            workerCount: args.workers,
            coinsFactory
        });
        return;
    }

    createWorkerRuntime({
        config,
        instanceId,
        coinsFactory
    });
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = {
    ClusterRuntimeManager,
    PROXY_VERSION,
    StandaloneProxyApp,
    createStandaloneApp,
    loadRuntimeConfig,
    main
};
