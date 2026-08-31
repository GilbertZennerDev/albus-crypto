# Deploying Albus

Same shared-Hetzner-box pattern as `../guess-pw`, `../touch-me`, `../TraceRoute`:
no ports published from this stack — the shared edge Caddy
(`feierblum-caddy-1`, part of `../feierblum-networking`) reverse-proxies in by
container name over the external `feierblum_default` network.

## One-time server setup

```bash
mkdir -p /opt/albus-crypto
cd /opt/albus-crypto
git clone <this repo> .
cp .env.example .env   # fill in VITE_ALBUS_API_URL and any chain tuning
```

Merge `caddy/Caddyfile.snippet` into `../feierblum-networking/caddy/Caddyfile`,
then reload that Caddy (`docker exec feierblum-caddy-1 caddy reload
--config /etc/caddy/Caddyfile` or `docker compose restart caddy` from
`feierblum-networking/`).

## Deploying a new version

The box is low-RAM, so images are built locally and shipped, not built on the
server — same workaround as `guess-pw/deploy.ps1` and
`workflow_solved/deploy.ps1`.

```powershell
.\deploy.ps1
```

This builds `albus-chain` and `albus-web` locally, `docker save`s them,
`scp`s the tarballs to `/opt/albus-crypto` on the server, and runs `docker load` +
`docker compose up -d` there — so the server's `docker compose up -d` just
starts the already-loaded images instead of rebuilding.

Update `$ServerHost` / `$ServerPath` in `deploy.ps1` if they differ from the
guess-pw box.

## Chain data persistence

`chain/data/` (chain state, the pool wallet's keypair, and the current
share-epoch ledger) lives in the `albus_chain_data` Docker volume — it
survives redeploys. Back it up before anything destructive
(`docker run --rm -v albus_chain_data:/data -v $PWD:/backup alpine
tar czf /backup/albus-chain-data.tgz -C /data .`).

## Tuning

Set in `.env` (see `.env.example`):

- `INITIAL_BLOCK_DIFFICULTY` — starting leading hex zeros required to
  actually find a block. This adjusts itself automatically afterward (see
  retargeting below) — a block is now produced the instant someone's real
  proof-of-work clears it, not on a timer.
- `SHARE_DIFFICULTY` — leading hex zeros required for a pool share (the
  anti-Sybil/accounting bar, always ≤ the real block difficulty). Lower =
  contributors earn shares (and thus reward-split credit) faster.
- `TARGET_BLOCK_TIME_MS` / `RETARGET_INTERVAL_BLOCKS` — every
  `RETARGET_INTERVAL_BLOCKS` blocks, difficulty moves by one hex nibble
  (16x) if the real average block time drifted far from
  `TARGET_BLOCK_TIME_MS`, keeping mining meaningfully hard as real network
  hashrate changes.
- `FEE_RATE` — fraction of each transaction's amount charged as a fee, paid
  to whichever miners find the block that confirms it (on top of the block
  reward) — gives mining a permanent revenue source as halvings shrink the
  block subsidy.
- `FALLBACK_MINE_INTERVAL_MS` — escape hatch only: pays out to the pool
  wallet so pending transactions still eventually confirm if literally
  nobody is mining. Not the normal way blocks are produced.

## Why single-node

The chain intentionally has no peer-to-peer gossip/consensus — one
authoritative node holds the real chain, verifies signatures and shares, and
mines blocks. Multi-node would need block/transaction gossip, a
longest-chain-wins fork-choice rule, and the mining-pool share ledger would
need to be reconciled across nodes (or centralized at a pool coordinator
regardless) — meaningfully more surface area than this demo currency needs
right now. `chain/src/blockchain.ts` is the place to start if that's ever
worth doing.
