# Albus (ALB)

A small, real single-node proof-of-work cryptocurrency, plus a webapp where new
users create a wallet, lend their browser's CPU to the network, and earn ALB
proportional to the work they actually contribute.

## How it works

- **`chain/`** — the node: PoW blocks (SHA-256, configurable leading-zero
  difficulty), ECDSA (secp256k1) signed transactions, a mempool, and a REST
  API. Chain state persists to `chain/data/chain.json`.
- **`web/`** — the webapp: wallet generation/import (private key never leaves
  the browser), balance + send, a block explorer, and the mining panel.
- **`miner/`** — a standalone offline CLI miner: same PoW-share protocol as
  the browser Web Worker, but runs continuously as a headless, multi-threaded
  process (no browser tab needed). See `miner/README.md`.
- **Mining pool** — the server issues a rotating challenge (`seed`,
  `difficulty`). Each browser runs a Web Worker that repeatedly hashes
  `sha256(seed|address|nonce)` looking for a hash with enough leading zeros —
  genuine CPU work, cheap for the server to verify. Every epoch
  (`AUTO_MINE_INTERVAL_MS`, default 20s) the server snapshots that epoch's
  verified shares, mines one real block, and splits the block reward across
  contributors proportional to shares — paid as real signed transactions from
  the pool wallet, not a custodial credit.

There is no peer-to-peer networking — this is intentionally a single
authoritative node (see `DEPLOYMENT.md` for why, and what multi-node would
require).

## Local development

```bash
cd chain && npm install && npm run dev   # API on :4000
cd web && npm install && npm run dev     # webapp on :5173, talks to :4000
```

`web/.env.development` points the webapp at `http://localhost:4000`.

## Deployment

See `DEPLOYMENT.md`.
