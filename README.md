<div align="center">

# xmr-node-proxy

Lean mining proxy for XMR-style pools.

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--or--later-111111.svg" alt="GPL-3.0-or-later"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-111111.svg" alt="Node 18+">
  <img src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS-111111.svg" alt="Linux and macOS">
  <img src="https://img.shields.io/badge/focus-mining%20proxy-111111.svg" alt="Mining proxy">
</p>

</div>

It sits between miners and the upstream pool, keeps miner-facing difficulty local, fans out fresh jobs, balances miners across configured pools, and exposes a lightweight HTTP monitor for MoneroOcean-style XMR-family deployments.

## Highlights

- Modern Node.js runtime with `node >= 18`
- Local miner-facing difficulty control and job fanout
- Balancing and failover across configured upstream pools
- Built-in HTTP monitor with optional basic auth
- Structured logs with low operational noise

## What This Proxy Supports

- Miner side: XMR-style JSON-RPC methods such as `login`, `getjob`, `submit`, and `keepalive`
- Pool side: XMR-style jobs that expose proxy-compatible nonce offsets
- Good fit: Monero-style forks and MoneroOcean's XMR-family algo-switching path

Not a fit:

- Ethash / Etchash
- Kawpow
- Autolykos2
- MoneroOcean `XTM-C` / `c29` pool protocol

Those use different stratum families than this proxy's XMR-style path.

## Trust Model

This proxy is intended to sit in front of a controlled miner fleet, not to act as a zero-trust public pool edge.

- Normal miner-difficulty shares intentionally trust the miner-reported `result` so the proxy can keep per-share CPU cost low.
- The proxy still enforces job, template, and duplicate-share checks locally and can verify pool-target candidates, but it is not a hostile-miner firewall.
- If you need full cryptographic verification of every submitted share from untrusted miners, enforce that in a different layer.

## Quick Start

1. Install Node.js `18+` and build tools required for native hashing modules.
2. Clone the repo and install dependencies:

```bash
npm install
```

3. Copy the sample config and edit it for your wallet, pool, and ports:

```bash
cp config_example.json config.json
```

The bundled [`config_example.json`](./config_example.json) uses `YOUR_WALLET` placeholders on purpose. Replace those with your own wallet before you start the proxy.

4. Run the test suite before first deployment:

```bash
npm test
```

5. Start the proxy:

```bash
node proxy.js
```

Useful flags:

- `node proxy.js --config /path/to/config.json`
- `node proxy.js --workers 4`

Config reload:

- Send `SIGHUP` to the running proxy to reload `config.json` in place
- In `pm2`, use `pm2 sendSignal SIGHUP xnp`

## Which Install Method To Use

Three reasonable ways to run the proxy are supported here.

Manual local install:

- best if you want the clearest view of what is installed and how the proxy runs
- easiest path for development, debugging, and local edits
- downside: you install system packages and Node dependencies yourself

`install.sh`:

- best if you want a quick local setup on a supported Linux host without typing each install step yourself
- it sets up packages, local npm dependencies, default config, and self-signed certs
- downside: it still installs software directly onto the host machine and depends on distro package availability for Node.js `18+`

Docker:

- best if you want isolation from the host and a repeatable container image
- keeps the runtime inside the container instead of mixing files into the host system
- downside: you still need to understand volume mounts for `config.json` and optional cert files, so it is not always the simplest first path for a beginner

For most beginners:

- use manual local install if you want to learn the moving parts
- use `install.sh` if you are on Ubuntu and want the fastest host install
- use Docker if you already know basic container workflows or want cleaner isolation

## install.sh

For a supported Linux local install from a repo checkout:

```bash
bash install.sh
```

What it does:

- installs the required packages with `apt`, `dnf`, or `yum`, depending on the host
- runs local `npm install`
- creates `config.json` from `config_example.json` if needed
- generates `cert.key` and `cert.pem` only when both are missing
- verifies the install with `npm test`

Requirements:

- run it from an `xmr-node-proxy` checkout
- a Linux host with `apt`, `dnf`, or `yum`
- Ubuntu 26.04, Rocky/Alma/RHEL 9+, or another compatible distro with equivalent package names
- either `root` or a normal user with `sudo`

Safety notes:

- if apt installs a Node.js older than `18`, the script stops with an explicit error
- if only one of `cert.key` or `cert.pem` exists, the script stops instead of overwriting the surviving file

After it completes:

```bash
node proxy.js --config /path/to/xmr-node-proxy/config.json
```

## update.sh

For updating an existing checkout in place:

```bash
bash update.sh
```

Use it only when you want this checkout force-synced to the latest `origin/master` state.

Important:

- local repo changes are discarded
- untracked files in the repo are removed
- ignored files such as `config.json`, TLS certs, and `node_modules/` are left in place

## Docker

Build the image from the repo root:

```bash
docker build -t xmr-node-proxy .
```

Run it with a local config mounted into the container workdir:

- this example assumes your mounted `config.json` listens on `3333` and enables the HTTP monitor on `8081`
- adjust `-p` mappings to match your actual `listeningPorts[]` and `httpPort`
- the bundled `config_example.json` defaults to `httpEnable: false`, so turn that on first if you want the monitor on `8081`

```bash
docker run --rm -it -p 3333:3333 -p 8081:8081 -v "$PWD/config.json:/xmr-node-proxy/config.json:ro" xmr-node-proxy
```

If your config uses TLS listener files from the repo root, mount those too:

```bash
docker run --rm -it -p 3333:3333 -p 8443:8443 -p 8081:8081 -v "$PWD/config.json:/xmr-node-proxy/config.json:ro" -v "$PWD/cert.key:/xmr-node-proxy/cert.key:ro" -v "$PWD/cert.pem:/xmr-node-proxy/cert.pem:ro" xmr-node-proxy
```

## Minimal Config Example

For a single MoneroOcean upstream over TLS:

```json
{
  "pools": [
    {
      "hostname": "gulf.moneroocean.stream",
      "port": 20001,
      "ssl": true,
      "allowSelfSignedSSL": true,
      "share": 100,
      "username": "YOUR_WALLET",
      "password": "proxy",
      "keepAlive": true,
      "algo": ["rx/0"],
      "algo_perf": { "rx/0": 1 },
      "algo-min-time": 60,
      "blob_type": "cryptonote",
      "default": true
    }
  ],
  "listeningPorts": [
    {
      "port": 3333,
      "ssl": false,
      "diff": 1000
    }
  ],
  "bindAddress": "0.0.0.0",
  "httpEnable": true,
  "httpAddress": "127.0.0.1",
  "httpPort": 8081,
  "difficultySettings": {
    "minDiff": 1,
    "maxDiff": 10000000,
    "shareTargetTime": 30
  }
}
```

MoneroOcean note:

- TLS port `20001` currently requires `ssl: true` and `allowSelfSignedSSL: true`
- If your miner provides a real MoneroOcean `algo-perf` map, pass it through so pool-side algo selection stays accurate
- `algo-min-time` is optional; `0` still maps to the upstream pool's default stickiness window on `nodejs-pool`, which is effectively `60`

## Runtime

Default `node proxy.js` mode uses all CPU cores available on the host.

To cap worker count explicitly:

```bash
node proxy.js --workers 2
```

## PM2

Recommended production launch:

```bash
pm2 start proxy.js --name xnp -- --config /home/nodeproxy/xmr-node-proxy/config.json
pm2 save
```

PM2 best practice:

- Do not add `--log-date-format` here. The proxy already timestamps every log line, so PM2-side timestamps only duplicate output.
- `pm2 logs xnp` and `pm2 monit` work well with the new structured log format.
- `pm2-logrotate` is still a good companion for long-running nodes.
- `pm2 sendSignal SIGHUP xnp` reloads config without replacing the main process

## Logs

Logs now use one consistent format:

```text
2026-04-19 08:13:08 INF master pool.job host=gulf.moneroocean.stream height=3387651 algo=rx/0 target=5000
```

Format:

```text
timestamp level component event key=value...
```

Operational notes:

- Summary lines are throttled so they only print on meaningful change or once per minute
- Warnings and errors include the fields you usually need first: `host`, `port`, `miner`, `job`, `nonce`, `reason`, `error`
- If you are running behind another logger that already stamps lines, avoid adding a second timestamp layer
- Set `XNP_LOG_TIME=0` if you want the proxy to emit `level component event ...` without its own timestamp prefix

## Configuration Guide

Important fields:

- `pools[]`: upstream pools
- `pools[].share`: target balancing weight among active non-dev pools; `0` means backup-only
- `pools[].default`: choose the default pool; if older configs mark more than one, the last one wins
- `pools[].algo`, `pools[].algo_perf`, and optional `pools[].algo-min-time`: upstream algo declaration for pools such as MoneroOcean
- `listeningPorts[]`: miner-facing ports and their starting difficulty
- `difficultySettings`: local vardiff bounds shared across miner-facing ports
- `accessControl`: optional wallet/password allowlist that reloads from disk
- `httpEnable`, `httpAddress`, `httpPort`, `httpUser`, `httpPass`: built-in monitor and optional basic auth
- `tls.keyPath`, `tls.certPath`: local certificate pair for SSL listening ports
- `socketTimeoutMs`, `maxJsonLineBytes`: defensive limits for bad or stuck peers

Validation rules enforced at startup:

- At least one pool must exist
- At least one listening port must exist
- At least one default non-dev pool must exist
- `difficultySettings.minDiff`, `difficultySettings.maxDiff`, and `difficultySettings.shareTargetTime` must all be positive, and `minDiff <= maxDiff`

Notes:

- `daemonAddress` is not used by the current runtime. Remove it from older configs.
- Old `coinSettings` configs are rejected at startup. Rename that block to `difficultySettings`.
- The sample config intentionally uses placeholder wallets. The built-in developer-share path is separate and only applies if `developerShare > 0`.

## HTTP Monitor

Set `httpEnable: true` to expose the built-in monitor.

What it shows:

- connected miners
- hashrate and pool distribution
- active and fallback pools
- recent miner activity

If `httpUser` and `httpPass` are both set, the monitor requires HTTP basic auth.

## MoneroOcean Compatibility Notes

Recent live tests against MoneroOcean TLS upstream succeeded for:

- `rx/0`
- `rx/arq`
- `panthera`
- `ghostrider`
- `cn/gpu`

Important limits:

- The proxy only handles the XMR-style JSON-RPC path
- SupportXMR-style single-coin XMR pools continue to use that same path
- Active MoneroOcean algos that use non-XMR stratum families are out of scope here
- `XTM-C` / `c29` is a separate pool-side protocol and should not be treated as a drop-in extension of the XMR path

## Testing

The repo includes a local test suite. It does not need a live pool.

```bash
npm test
```

## Troubleshooting

`No active block template`

- The upstream pool is connected but has not produced a usable job yet.

`Unauthorized access`

- Check `accessControl.enabled` and the contents of the configured control file.

Duplicate timestamps in logs

- Remove PM2's `--log-date-format` or any equivalent external timestamp prefix.

TLS upstream fails on MoneroOcean `20001`

- Ensure `ssl: true` and `allowSelfSignedSSL: true` are both set.

Miners submit low-diff shares constantly

- Use a better matching listening port difficulty or set fixed difficulty on the miner if needed.

## Donations

If you want to support the project directly, optional XMR donations can be sent to:

`89TxfrUmqJJcb1V124WsUzA78Xa3UYHt7Bg8RGMhXVeZYPN8cE5CZEk58Y1m23ZMLHN7wYeJ9da5n5MXharEjrm41hSnWHL`

## Contributors

- [MoneroOcean](https://github.com/MoneroOcean) for long-running maintenance and ongoing proxy evolution
- Alexander Blair and [Snipa22](https://github.com/Snipa22) for the original public codebase and early architecture
- djfinch, [M5M400](https://github.com/M5M400), Learner, Mike Teehan, Ethorsen, and tosokr for follow-up fixes, compatibility work, and docs
- [1rV1N](https://github.com/1rV1N), MinerCircle, Mayday30, Connor, J. Meister, Mi!, Tom, mrmoo85, piratoskratos, slayerulan, sph34r, sunk818, sunxfof, tinyema, BK, and other smaller contributors for fixes and operational improvements
