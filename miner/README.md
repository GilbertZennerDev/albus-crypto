# albus-miner

A standalone, offline CLI miner for Albus. Mines the same PoW-share protocol as
the browser Web Worker in `../web/`, but runs continuously as a headless
process — multi-threaded, no browser tab required.

## Usage

### Web UI (recommended) — control start/stop and watch live stats from a browser

```bash
node src/index.js --ui --api https://api.albus.workflowsolved.com
# then open http://localhost:5178
```

The UI remembers your address/API URL/thread count in the browser's
`localStorage`, so you don't need to re-enter them next time. Mining keeps
running as a background process on this machine even if you close the tab —
open the page again any time to check stats or press Stop.

### Headless CLI — mines immediately, logs to the terminal

```bash
# 1. Get a wallet (or use one exported from the webapp)
node src/index.js --generate-wallet --api https://api.albus.workflowsolved.com

# 2. Mine to it, continuously, using all CPU cores
node src/index.js \
  --address albus1... \
  --api https://api.albus.workflowsolved.com
```

Options:

| Flag | Default | Meaning |
|---|---|---|
| `--address` | — | Wallet address to mine to (required unless `--ui` or `--generate-wallet`) |
| `--api` | `http://localhost:4000` | Chain API base URL |
| `--workers` | number of CPU cores | Hashing threads |
| `--interval` | `4000` | How often (ms) to poll for a fresh challenge — keep this well under the server's `AUTO_MINE_INTERVAL_MS` epoch length, or shares get mined against a seed the server has already rotated away from |
| `--ui` | — | Start the local web control panel instead of mining immediately |
| `--port` | `5178` | Port for `--ui` |
| `--generate-wallet` | — | Print a new wallet and exit |

Save the private key from `--generate-wallet` somewhere safe — it's the only
way to spend earned ALB, and it's never shown again.

The UI server exposes `GET /api/status`, `POST /api/start`, `POST /api/stop`,
and `GET /api/defaults` on `localhost` only — nothing is exposed to the
network, so it's safe to run without authentication.

## GPU mining

GPU mining is on by default (`--no-gpu` to disable) and gives a massive
speedup — 100-200x a single CPU thread on a mid-range GPU — since it runs a
real SHA-256 compute shader (WGSL, via the `webgpu` package's Node bindings,
so it works on NVIDIA/AMD/Intel without any CUDA/vendor lock-in). CPU threads
and the GPU mine simultaneously for combined hashrate.

**Known issue**: the underlying `webgpu` Node binding is not fully stable
under sustained load and can crash (verified via `npm run test:gpu`, a
standalone stress test) after anywhere from a few seconds to a few minutes,
independent of anything else running. This is a third-party native-binding
issue, not a bug in the mining kernel itself — the kernel has been validated
bit-for-bit correct against Node's own `crypto.createHash("sha256")` across
tens of thousands of samples with zero invalid shares.

Given that, the GPU miner runs in its own child process (so a crash can't
take down CPU mining or the rest of the app) and auto-restarts up to 5 times
on an unexpected crash. If it keeps crashing past that, it disables itself
and the miner continues CPU-only — check `lastError` in `/api/status` (or
the CLI's console output) to see whether GPU mining is currently active.

## How it works

Each worker thread hashes a disjoint slice of the nonce space
(`nonce = workerId, workerId+N, workerId+2N, ...` for N workers) against
`sha256(seed|address|nonce)`, looking for a hash with enough leading zeros.
A found nonce is submitted to `/mining/submit`; the server verifies it
independently and credits a share. Every epoch, the chain mines a block and
splits the reward across that epoch's contributors proportional to shares.

The hot loop hashes the fixed `seed|address|` prefix once per job and clones
that digest state per nonce attempt (`Hash.copy()`), so each attempt only
pays for compressing the short nonce suffix — about 20% faster than hashing
the full string fresh every time.
