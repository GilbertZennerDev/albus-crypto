# albus-miner

A standalone, offline CLI miner for Albus. Mines the same PoW-share protocol as
the browser Web Worker in `../web/`, but runs continuously as a headless
process — multi-threaded, no browser tab required.

## Usage

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
| `--address` | — | Wallet address to mine to (required) |
| `--api` | `http://localhost:4000` | Chain API base URL |
| `--workers` | number of CPU cores | Hashing threads |
| `--interval` | `4000` | How often (ms) to poll for a fresh challenge — keep this well under the server's `AUTO_MINE_INTERVAL_MS` epoch length, or shares get mined against a seed the server has already rotated away from |
| `--generate-wallet` | — | Print a new wallet and exit |

Save the private key from `--generate-wallet` somewhere safe — it's the only
way to spend earned ALB, and it's never shown again.

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
