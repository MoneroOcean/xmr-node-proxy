"use strict";

const http = require("node:http");

const {
    PROXY_VERSION,
    escapeHtml,
    formatDurationMs,
    formatRelativeSeconds,
    humanHashrate,
    maybeUnref,
    safeEqual
} = require("./proxy-common");

class ProxyMonitor {
    constructor(options) {
        this.config = options.config;
        this.logger = options.logger;
        this.runtime = options.runtime;
        this.server = null;
    }

    start() {
        if (!this.config.httpEnable || this.server) return;

        this.server = http.createServer((request, response) => {
            if (!this.authorizeRequest(request, response)) return;
            const pathname = new URL(request.url, "http://localhost").pathname;

            if (pathname === "/") {
                const snapshot = this.runtime.getMonitorSnapshot();
                response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                response.end(this.renderHtml(snapshot));
                return;
            }

            if (pathname === "/json") {
                response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                response.end(JSON.stringify(this.runtime.getMonitorSnapshot(), null, 2));
                return;
            }

            response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            response.end("Not found");
        });

        this.server.listen(this.config.httpPort, this.config.httpAddress, () => {
            const address = this.server.address();
            this.logger.info("monitor.ready", {
                host: address.address,
                port: address.port
            });
        });
    }

    async stop() {
        if (!this.server) return;
        await new Promise((resolve) => this.server.close(resolve));
        this.server = null;
    }

    authorizeRequest(request, response) {
        if (!this.config.httpUser && !this.config.httpPass) return true;
        const header = request.headers.authorization;
        if (!header || !header.startsWith("Basic ")) {
            response.writeHead(401, { "WWW-Authenticate": "Basic realm=\"XNP\"" });
            response.end("Unauthorized");
            return false;
        }

        const encoded = header.slice("Basic ".length);
        let username = "";
        let password = "";
        try {
            const decoded = Buffer.from(encoded, "base64").toString("utf8");
            [username = "", password = ""] = decoded.split(":");
        } catch (_error) {
            response.writeHead(400);
            response.end("Malformed Authorization header");
            return false;
        }

        const isUsernameValid = safeEqual(username, this.config.httpUser || "");
        const isPasswordValid = safeEqual(password, this.config.httpPass || "");
        if (!isUsernameValid || !isPasswordValid) {
            response.writeHead(401, { "WWW-Authenticate": "Basic realm=\"XNP\"" });
            response.end("Unauthorized");
            return false;
        }
        return true;
    }

    renderPoolCards(snapshot) {
        const cards = [];
        for (const pool of snapshot.pools) {
            const algoLabel = pool.algo ? `, algo ${escapeHtml(pool.algo)}` : "";
            const variantLabel = pool.variant ? `, variant ${escapeHtml(pool.variant)}` : "";
            cards.push(`
                <section class="pool-card ${pool.active ? "pool-card--active" : "pool-card--inactive"}">
                    <h3>${escapeHtml(pool.hostname)}</h3>
                    <p>${escapeHtml(pool.coin.toUpperCase())} pool${pool.devPool ? " (dev)" : ""}</p>
                    <p>${humanHashrate(pool.hashrate, snapshot.hashrateAlgo)} routed, ${escapeHtml(pool.percentage)}%</p>
                    <p>height ${escapeHtml(String(pool.height ?? "?"))}, target ${escapeHtml(String(pool.targetDiff ?? "?"))}${algoLabel}${variantLabel}</p>
                </section>
            `);
        }
        return cards.join("\n");
    }

    renderMinerRows(snapshot) {
        return snapshot.miners.map((miner) => `
            <tr>
                <td>${escapeHtml(miner.logString)}</td>
                <td>${escapeHtml(miner.active ? humanHashrate(miner.avgSpeed, miner.algo) : "offline")}</td>
                <td>${escapeHtml(String(miner.diff))}</td>
                <td>${escapeHtml(String(miner.shares))}</td>
                <td>${escapeHtml(String(miner.hashes))}</td>
                <td>${escapeHtml(formatRelativeSeconds(miner.lastShare))}</td>
                <td>${escapeHtml(formatRelativeSeconds(miner.lastContact))}</td>
                <td>${escapeHtml(formatDurationMs(Date.now() - miner.connectTime))}</td>
                <td>${escapeHtml(miner.pool)}</td>
                <td>${escapeHtml(miner.agent || "")}</td>
            </tr>
        `).join("\n");
    }

    renderHtml(snapshot) {
        const theme = this.config.theme === "dark" ? "dark" : "light";
        const summary = `${snapshot.totalMiners} miners, ${humanHashrate(snapshot.totalHashrate, snapshot.hashrateAlgo)}`;
        return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="refresh" content="${escapeHtml(String(Math.max(5, this.config.refreshTime)))}">
    <title>XNP v${PROXY_VERSION}</title>
    <style>
        :root {
            color-scheme: ${theme === "dark" ? "dark" : "light"};
            --bg: ${theme === "dark" ? "#111827" : "#f7f8fb"};
            --panel: ${theme === "dark" ? "#1f2937" : "#ffffff"};
            --panel-border: ${theme === "dark" ? "#374151" : "#d9e1ea"};
            --text: ${theme === "dark" ? "#f3f4f6" : "#111827"};
            --muted: ${theme === "dark" ? "#9ca3af" : "#4b5563"};
            --accent: #0f766e;
            --accent-dim: rgba(15, 118, 110, 0.08);
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            background:
                radial-gradient(circle at top left, rgba(15, 118, 110, 0.18), transparent 36%),
                radial-gradient(circle at top right, rgba(245, 158, 11, 0.12), transparent 28%),
                var(--bg);
            color: var(--text);
            font: 14px/1.5 "IBM Plex Sans", "Segoe UI", sans-serif;
        }
        main {
            width: min(1500px, calc(100vw - 32px));
            margin: 0 auto;
            padding: 24px 0 48px;
        }
        header {
            display: flex;
            align-items: baseline;
            justify-content: space-between;
            gap: 24px;
            margin-bottom: 24px;
        }
        h1, h2, h3, p { margin: 0; }
        h1 {
            font: 600 28px/1.1 "Space Grotesk", "Segoe UI", sans-serif;
            letter-spacing: -0.04em;
        }
        .muted {
            color: var(--muted);
        }
        .hero,
        .table-shell {
            background: var(--panel);
            border: 1px solid var(--panel-border);
            border-radius: 18px;
            box-shadow: 0 20px 50px rgba(15, 23, 42, 0.08);
        }
        .hero {
            padding: 24px;
            margin-bottom: 20px;
        }
        .pool-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
            gap: 16px;
            margin-top: 20px;
        }
        .pool-card {
            padding: 16px;
            border-radius: 16px;
            border: 1px solid var(--panel-border);
            background: linear-gradient(180deg, var(--accent-dim), transparent);
        }
        .pool-card--inactive {
            opacity: 0.68;
            border-style: dashed;
        }
        .pool-card h3 {
            margin-bottom: 6px;
            font-size: 16px;
        }
        .table-shell {
            padding: 10px 12px 12px;
            overflow: hidden;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            table-layout: fixed;
        }
        thead th {
            text-align: left;
            color: var(--muted);
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            padding: 12px 10px;
        }
        tbody td {
            padding: 12px 10px;
            border-top: 1px solid var(--panel-border);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        tbody tr:hover {
            background: rgba(15, 118, 110, 0.05);
        }
        @media (max-width: 900px) {
            header {
                flex-direction: column;
                align-items: flex-start;
            }
            .table-shell {
                overflow-x: auto;
            }
            table {
                min-width: 980px;
            }
        }
    </style>
</head>
<body class="${theme}">
    <main>
        <header>
            <div>
                <h1>XNP v${PROXY_VERSION}</h1>
                <p class="muted">${escapeHtml(summary)}</p>
            </div>
            <p class="muted">Updated ${escapeHtml(formatDurationMs(snapshot.generatedAtAgeMs))} ago</p>
        </header>
        <section class="hero">
            <h2>Pool Routing</h2>
            <p class="muted">Active upstream pools, current job state, and routed hashrate split.</p>
            <div class="pool-grid">
                ${this.renderPoolCards(snapshot)}
            </div>
        </section>
        <section class="table-shell">
            <table>
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Hashrate</th>
                        <th>Diff</th>
                        <th>Shares</th>
                        <th>Hashes</th>
                        <th>Last Share</th>
                        <th>Last Ping</th>
                        <th>Connected</th>
                        <th>Pool</th>
                        <th>Agent</th>
                    </tr>
                </thead>
                <tbody>
                    ${this.renderMinerRows(snapshot)}
                </tbody>
            </table>
        </section>
    </main>
</body>
</html>`;
    }
}

module.exports = {
    ProxyMonitor
};
