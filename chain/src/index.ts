import express from "express";
import cors from "cors";
import { Blockchain } from "./blockchain.js";
import { generateKeyPair } from "./wallet.js";
import { MiningPool, MAX_BATCH_SIZE } from "./mining-pool.js";

const PORT = Number(process.env.PORT ?? 4000);
// Escape hatch only: pays out to the faucet address so pending transactions
// still eventually confirm if literally nobody is mining. Real blocks are
// produced the instant a share clears the actual network difficulty (see
// /mining/submit-batch below) — not on a fixed schedule.
const FALLBACK_MINE_INTERVAL_MS = Number(process.env.FALLBACK_MINE_INTERVAL_MS ?? 5 * 60_000);
const CHAIN_NAME = "Albus";
const CHAIN_SYMBOL = "ALB";

const chain = new Blockchain();
const pool = new MiningPool();
const app = express();
// Behind Caddy: trust its X-Forwarded-For so req.ip is the real client IP,
// not the proxy's — the mining-pool's per-IP share cap depends on this.
app.set("trust proxy", true);
app.use(cors());
app.use(express.json());

// Guards against two near-simultaneous qualifying shares both trying to
// finalize the same job.
let finalizing = false;

function tryFinalizeBlock(seed: string, proofAddress: string, nonce: string): void {
  if (finalizing) return;
  finalizing = true;
  try {
    const block = chain.submitProof(seed, proofAddress, nonce, pool.snapshotShares(), chain.faucet.address);
    if (block) pool.setJob(chain.getCurrentJob().seed);
  } catch (err) {
    console.error("block finalization failed", err);
  } finally {
    finalizing = false;
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, name: CHAIN_NAME, symbol: CHAIN_SYMBOL, height: chain.getLatestBlock().index });
});

app.get("/chain", (_req, res) => {
  res.json({ length: chain.getChain().length, chain: chain.getChain() });
});

app.get("/supply", (_req, res) => {
  res.json(chain.getSupplyInfo());
});

app.get("/blocks/:hashOrIndex", (req, res) => {
  const block = chain.getBlock(req.params.hashOrIndex);
  if (!block) return res.status(404).json({ error: "block not found" });
  res.json(block);
});

app.get("/mempool", (_req, res) => {
  res.json({ length: chain.getMempool().length, transactions: chain.getMempool() });
});

app.get("/balance/:address", (req, res) => {
  res.json({ address: req.params.address, balance: chain.getBalance(req.params.address) });
});

app.post("/wallet", (_req, res) => {
  res.json(generateKeyPair());
});

app.post("/transactions", (req, res) => {
  const { id, fromPublicKey, fromAddress, to, amount, timestamp, signature } = req.body ?? {};
  const result = chain.submitTransaction({ id, fromPublicKey, fromAddress, to, amount, timestamp, signature });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.status(201).json({ ok: true });
});

app.post("/faucet", (req, res) => {
  const { to, amount } = req.body ?? {};
  if (typeof to !== "string" || typeof amount !== "number") {
    return res.status(400).json({ error: "to (string) and amount (number) are required" });
  }
  const capped = Math.min(amount, 100);
  const result = chain.faucetTransfer(to, capped);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.status(201).json({ ok: true, amount: capped });
});

// Proof-of-work "lend your processing power" pool: any number of browsers/CLI
// miners hash against the current job; a verified share is real work, dedup'd
// and checked server-side. Shares are also checked against the real
// block-finding difficulty — the instant one clears it, that exact proof
// finalizes a real block (see tryFinalizeBlock), and the reward + fees are
// split across the epoch's contributors proportional to shares submitted.
app.get("/mining/challenge", (_req, res) => {
  const job = chain.getCurrentJob();
  pool.setJob(job.seed);
  res.json(pool.getChallenge(job.difficulty));
});

app.get("/mining/shares", (_req, res) => {
  res.json({ shares: pool.getShares() });
});

app.post("/mining/submit", (req, res) => {
  const { address, nonce } = req.body ?? {};
  const result = pool.submitShare(address, nonce, req.ip ?? "unknown", chain.getCurrentDifficulty());
  if (!result.ok) return res.status(400).json({ error: result.error });
  if (result.blockFound) tryFinalizeBlock(pool.getSeed(), address, nonce);
  res.status(201).json(result);
});

// A fast miner can find thousands of shares per second — one HTTP request
// per share overwhelms connection handling on both ends at that volume, so
// clients batch found nonces and submit them together here instead.
app.post("/mining/submit-batch", (req, res) => {
  const { address, nonces } = req.body ?? {};
  if (!Array.isArray(nonces) || nonces.length === 0 || nonces.length > MAX_BATCH_SIZE) {
    return res.status(400).json({ error: `nonces must be a non-empty array of at most ${MAX_BATCH_SIZE}` });
  }
  const seedBeforeBatch = pool.getSeed();
  const result = pool.submitShares(address, nonces, req.ip ?? "unknown", chain.getCurrentDifficulty());
  if (result.blockFoundNonce) tryFinalizeBlock(seedBeforeBatch, address, result.blockFoundNonce);
  res.status(201).json(result);
});

app.listen(PORT, () => {
  console.log(`Albus chain API listening on :${PORT}`);
});

if (FALLBACK_MINE_INTERVAL_MS > 0) {
  setInterval(() => {
    try {
      const block = chain.mineFallbackBlock(chain.faucet.address);
      if (block) pool.setJob(chain.getCurrentJob().seed);
    } catch (err) {
      console.error("fallback mining failed", err);
    }
  }, FALLBACK_MINE_INTERVAL_MS);
}
