"use strict";

const http = require("node:http");

const {
    PROXY_VERSION,
    escapeHtml,
    formatDurationMs,
    formatRelativeSeconds,
    humanHashrate,
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
                response.end(`${JSON.stringify(this.runtime.getMonitorRawState())}\r\n`);
                return;
            }

            if (pathname === "/snapshot") {
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

    getMoneroOceanDashboardUrl(pool) {
        if (!pool || !pool.username || !/moneroocean/i.test(pool.hostname || "")) return null;
        return `https://moneroocean.stream/#/dashboard?addr=${encodeURIComponent(pool.username)}`;
    }

    renderPoolCards(snapshot) {
        const cards = [];
        for (const pool of snapshot.pools) {
            const algoLabel = pool.algo ? `, algo ${escapeHtml(pool.algo)}` : "";
            const variantLabel = pool.variant ? `, variant ${escapeHtml(pool.variant)}` : "";
            const dashboardUrl = this.getMoneroOceanDashboardUrl(pool);
            const titleMarkup = dashboardUrl
                ? `<a class="pool-card__link" href="${escapeHtml(dashboardUrl)}" target="_blank" rel="noreferrer" title="Open MoneroOcean dashboard">${escapeHtml(pool.hostname)}</a>`
                : escapeHtml(pool.hostname);
            cards.push(`
                <section class="pool-card ${pool.active ? "pool-card--active" : "pool-card--inactive"}">
                    <h3>${titleMarkup}</h3>
                    <p>${escapeHtml(pool.coin.toUpperCase())} pool${pool.devPool ? " (dev)" : ""}</p>
                    <p>${humanHashrate(pool.hashrate, snapshot.hashrateAlgo)} routed, ${escapeHtml(pool.percentage)}%</p>
                    <p>height ${escapeHtml(String(pool.height ?? "?"))}, target ${escapeHtml(String(pool.targetDiff ?? "?"))}${algoLabel}${variantLabel}</p>
                </section>
            `);
        }
        return cards.join("\n");
    }

    renderTableCell(content, { sortValue = "", title = "", className = "" } = {}) {
        const classAttr = className ? ` class="${className}"` : "";
        const sortAttr = ` data-sort-value="${escapeHtml(String(sortValue ?? ""))}"`;
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
        return `<td${classAttr}${sortAttr}${titleAttr}>${content}</td>`;
    }

    renderAgentCell(agent) {
        if (!agent) return "";
        const display = String(agent).split(/\s+/, 1)[0] || String(agent);
        return `
            <div class="tooltip" title="${escapeHtml(agent)}">
                <span class="tooltip__label">${escapeHtml(display)}</span>
                <span class="tooltiptext">${escapeHtml(agent)}</span>
            </div>
        `;
    }

    renderMinerRows(snapshot) {
        return snapshot.miners.map((miner) => `
            <tr>
                ${this.renderTableCell(escapeHtml(miner.logString), {
        sortValue: miner.logString,
        title: miner.logString
    })}
                ${this.renderTableCell(escapeHtml(miner.active ? humanHashrate(miner.avgSpeed, miner.algo) : "offline"), {
        sortValue: miner.active ? miner.avgSpeed : -1,
        title: miner.active ? humanHashrate(miner.avgSpeed, miner.algo) : "offline"
    })}
                ${this.renderTableCell(escapeHtml(String(miner.diff)), {
        sortValue: miner.diff,
        title: String(miner.diff)
    })}
                ${this.renderTableCell(escapeHtml(String(miner.shares)), {
        sortValue: miner.shares,
        title: String(miner.shares)
    })}
                ${this.renderTableCell(escapeHtml(String(miner.hashes)), {
        sortValue: miner.hashes,
        title: String(miner.hashes)
    })}
                ${this.renderTableCell(escapeHtml(formatRelativeSeconds(miner.lastShare)), {
        sortValue: miner.lastShare,
        title: formatRelativeSeconds(miner.lastShare)
    })}
                ${this.renderTableCell(escapeHtml(formatRelativeSeconds(miner.lastContact)), {
        sortValue: miner.lastContact,
        title: formatRelativeSeconds(miner.lastContact)
    })}
                ${this.renderTableCell(escapeHtml(formatDurationMs(Date.now() - miner.connectTime)), {
        sortValue: miner.connectTime,
        title: formatDurationMs(Date.now() - miner.connectTime)
    })}
                ${this.renderTableCell(escapeHtml(miner.pool), {
        sortValue: miner.pool,
        title: miner.pool
    })}
                ${this.renderTableCell(this.renderAgentCell(miner.agent || ""), {
        sortValue: miner.agent || "",
        title: miner.agent || ""
    })}
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
            color-scheme: light dark;
            --accent: #0f766e;
            --accent-dim: rgba(15, 118, 110, 0.08);
            --hover: rgba(15, 118, 110, 0.08);
            --shadow: 0 20px 50px rgba(15, 23, 42, 0.08);
        }
        * { box-sizing: border-box; }
        body.light {
            color-scheme: light;
            --bg: #f7f8fb;
            --panel: #ffffff;
            --panel-border: #d9e1ea;
            --text: #111827;
            --muted: #4b5563;
            --tooltip-bg: #111827;
            --tooltip-text: #f9fafb;
        }
        body.dark {
            color-scheme: dark;
            --bg: #111827;
            --panel: #1f2937;
            --panel-border: #374151;
            --text: #f3f4f6;
            --muted: #9ca3af;
            --hover: rgba(15, 118, 110, 0.14);
            --shadow: 0 20px 50px rgba(0, 0, 0, 0.32);
            --tooltip-bg: #f3f4f6;
            --tooltip-text: #111827;
        }
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
        .header-actions {
            display: flex;
            align-items: center;
            gap: 16px;
        }
        h1, h2, h3, p { margin: 0; }
        h1 {
            font: 600 28px/1.1 "Space Grotesk", "Segoe UI", sans-serif;
            letter-spacing: -0.04em;
        }
        .header-title {
            cursor: pointer;
            user-select: none;
        }
        .muted {
            color: var(--muted);
        }
        .theme-toggle {
            appearance: none;
            border: 1px solid var(--panel-border);
            border-radius: 999px;
            padding: 8px 14px;
            background: var(--panel);
            color: var(--text);
            font: inherit;
            cursor: pointer;
            transition: transform 120ms ease, background 120ms ease;
        }
        .theme-toggle:hover {
            background: var(--accent-dim);
            transform: translateY(-1px);
        }
        .hero,
        .table-shell {
            background: var(--panel);
            border: 1px solid var(--panel-border);
            border-radius: 18px;
            box-shadow: var(--shadow);
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
        .pool-card__link {
            color: inherit;
            text-decoration: none;
            text-shadow: 0 0 5px rgba(64, 196, 255, 0.7);
        }
        .pool-card__link:hover {
            text-decoration: underline;
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
        thead th.table-header--sortable {
            cursor: pointer;
            user-select: none;
            position: relative;
        }
        thead th.table-header--sortable:hover,
        thead th.table-header--sortable.is-hovered,
        thead th.table-header--sortable.is-sorted {
            color: var(--text);
        }
        .sort-indicator {
            display: inline-block;
            margin-left: 6px;
            color: var(--muted);
        }
        thead th[data-sort-dir="asc"] .sort-indicator::before {
            content: "↑";
        }
        thead th[data-sort-dir="desc"] .sort-indicator::before {
            content: "↓";
        }
        thead th[data-sort-dir=""] .sort-indicator::before,
        thead th:not([data-sort-dir]) .sort-indicator::before {
            content: "↕";
        }
        tbody td {
            padding: 12px 10px;
            border-top: 1px solid var(--panel-border);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        tbody tr:hover {
            background: var(--hover);
        }
        tbody td.is-hovered,
        thead th.is-hovered {
            background: var(--hover);
        }
        .tooltip {
            position: relative;
            display: inline-flex;
            max-width: 100%;
            align-items: center;
        }
        .tooltip__label {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .tooltiptext {
            visibility: hidden;
            opacity: 0;
            transition: opacity 120ms ease;
            position: absolute;
            left: 50%;
            bottom: calc(100% + 8px);
            transform: translateX(-50%);
            min-width: 180px;
            max-width: 360px;
            padding: 8px 10px;
            border-radius: 10px;
            background: var(--tooltip-bg);
            color: var(--tooltip-text);
            text-transform: none;
            letter-spacing: normal;
            text-align: center;
            white-space: normal;
            z-index: 20;
            box-shadow: 0 14px 36px rgba(15, 23, 42, 0.24);
        }
        .tooltip:hover .tooltiptext {
            visibility: visible;
            opacity: 1;
        }
        @media (max-width: 900px) {
            header {
                flex-direction: column;
                align-items: flex-start;
            }
            .header-actions {
                width: 100%;
                justify-content: space-between;
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
                <h1 class="header-title" id="theme-title" title="Toggle theme">XNP v${PROXY_VERSION}</h1>
                <p class="muted">${escapeHtml(summary)}</p>
            </div>
            <div class="header-actions">
                <button class="theme-toggle" id="theme-toggle" type="button" title="Toggle theme">Toggle Theme</button>
                <p class="muted">Updated ${escapeHtml(formatDurationMs(snapshot.generatedAtAgeMs))} ago</p>
            </div>
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
                        <th class="table-header--sortable" data-sort-type="text" data-sort-dir="" tabindex="0" role="button" aria-sort="none">Name<span class="sort-indicator" aria-hidden="true"></span></th>
                        <th class="table-header--sortable" data-sort-type="number" data-sort-dir="" tabindex="0" role="button" aria-sort="none">Hashrate<span class="sort-indicator" aria-hidden="true"></span></th>
                        <th class="table-header--sortable" data-sort-type="number" data-sort-dir="" tabindex="0" role="button" aria-sort="none">Diff<span class="sort-indicator" aria-hidden="true"></span></th>
                        <th class="table-header--sortable" data-sort-type="number" data-sort-dir="" tabindex="0" role="button" aria-sort="none">Shares<span class="sort-indicator" aria-hidden="true"></span></th>
                        <th class="table-header--sortable" data-sort-type="number" data-sort-dir="" tabindex="0" role="button" aria-sort="none">Hashes<span class="sort-indicator" aria-hidden="true"></span></th>
                        <th class="table-header--sortable" data-sort-type="number" data-sort-dir="" tabindex="0" role="button" aria-sort="none">Last Share<span class="sort-indicator" aria-hidden="true"></span></th>
                        <th class="table-header--sortable" data-sort-type="number" data-sort-dir="" tabindex="0" role="button" aria-sort="none">Last Ping<span class="sort-indicator" aria-hidden="true"></span></th>
                        <th class="table-header--sortable" data-sort-type="number" data-sort-dir="" tabindex="0" role="button" aria-sort="none">Connected<span class="sort-indicator" aria-hidden="true"></span></th>
                        <th class="table-header--sortable" data-sort-type="text" data-sort-dir="" tabindex="0" role="button" aria-sort="none">Pool<span class="sort-indicator" aria-hidden="true"></span></th>
                        <th class="table-header--sortable" data-sort-type="text" data-sort-dir="" tabindex="0" role="button" aria-sort="none">Agent<span class="sort-indicator" aria-hidden="true"></span></th>
                    </tr>
                </thead>
                <tbody>
                    ${this.renderMinerRows(snapshot)}
                </tbody>
            </table>
        </section>
    </main>
    <script>
        (() => {
            const themeStorageKey = "xnp-monitor-theme";
            const headers = Array.from(document.querySelectorAll("thead th[data-sort-type]"));
            const tbody = document.querySelector("tbody");

            function applyTheme(themeName) {
                document.body.classList.remove("light", "dark");
                document.body.classList.add(themeName === "dark" ? "dark" : "light");
            }

            function toggleTheme() {
                const nextTheme = document.body.classList.contains("dark") ? "light" : "dark";
                applyTheme(nextTheme);
                try {
                    window.localStorage.setItem(themeStorageKey, nextTheme);
                } catch (_error) {
                    // Ignore storage failures and keep the in-memory toggle.
                }
            }

            function clearHoveredColumn() {
                for (const header of headers) header.classList.remove("is-hovered");
                for (const cell of document.querySelectorAll("tbody td.is-hovered")) {
                    cell.classList.remove("is-hovered");
                }
            }

            function hoverColumn(columnIndex) {
                clearHoveredColumn();
                if (!headers[columnIndex]) return;
                headers[columnIndex].classList.add("is-hovered");
                for (const row of tbody.querySelectorAll("tr")) {
                    const cell = row.children[columnIndex];
                    if (cell) cell.classList.add("is-hovered");
                }
            }

            function parseSortValue(value, type) {
                if (type === "number") {
                    const numericValue = Number(value);
                    return Number.isFinite(numericValue) ? numericValue : 0;
                }
                return String(value || "").toLowerCase();
            }

            function sortRows(columnIndex, type) {
                const header = headers[columnIndex];
                if (!header) return;

                const direction = header.dataset.sortDir === "asc" ? "desc" : "asc";
                const rows = Array.from(tbody.querySelectorAll("tr"));

                rows.sort((leftRow, rightRow) => {
                    const leftValue = parseSortValue(leftRow.children[columnIndex]?.dataset.sortValue, type);
                    const rightValue = parseSortValue(rightRow.children[columnIndex]?.dataset.sortValue, type);

                    if (type === "number") {
                        return direction === "asc" ? leftValue - rightValue : rightValue - leftValue;
                    }
                    return direction === "asc"
                        ? leftValue.localeCompare(rightValue)
                        : rightValue.localeCompare(leftValue);
                });

                for (const candidate of headers) {
                    candidate.dataset.sortDir = "";
                    candidate.setAttribute("aria-sort", "none");
                    candidate.classList.remove("is-sorted");
                }

                header.dataset.sortDir = direction;
                header.setAttribute("aria-sort", direction === "asc" ? "ascending" : "descending");
                header.classList.add("is-sorted");

                for (const row of rows) tbody.appendChild(row);
                hoverColumn(columnIndex);
            }

            try {
                const storedTheme = window.localStorage.getItem(themeStorageKey);
                if (storedTheme) applyTheme(storedTheme);
            } catch (_error) {
                // Ignore storage failures and fall back to the server-provided theme.
            }

            for (const toggleTarget of [document.getElementById("theme-toggle"), document.getElementById("theme-title")]) {
                if (!toggleTarget) continue;
                toggleTarget.addEventListener("click", toggleTheme);
            }

            headers.forEach((header, columnIndex) => {
                const type = header.dataset.sortType || "text";
                header.addEventListener("mouseenter", () => hoverColumn(columnIndex));
                header.addEventListener("mouseleave", clearHoveredColumn);
                header.addEventListener("click", () => sortRows(columnIndex, type));
                header.addEventListener("keydown", (event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    sortRows(columnIndex, type);
                });
            });
        })();
    </script>
</body>
</html>`;
    }
}

module.exports = {
    ProxyMonitor
};
