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
- **Mining pool, tied to real blocks** — the server issues a challenge
  (`seed`, `difficulty`) derived directly from the actual next block's
  content (previous hash, height, pending transactions). Each browser/CLI
  miner repeatedly hashes `sha256(seed|address|nonce)` looking for a hash
  with enough leading zeros — genuine work, cheap for the server to verify.
  A share that also clears the real (higher, auto-adjusting) block
  difficulty instantly finalizes a real block — not a fixed timer — and the
  reward plus that block's transaction fees are split across the epoch's
  contributors proportional to shares, paid as real signed transactions from
  the pool wallet, not a custodial credit.
- **Fixed 21,000,000 ALB supply**, halving every 50,000 blocks, and
  difficulty that retargets against real block-production time — see
  `chain/src/blockchain.ts`.

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
