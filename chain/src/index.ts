import express from "express";
import cors from "cors";
import { Blockchain } from "./blockchain.js";
import { generateKeyPair } from "./wallet.js";
import { MiningPool } from "./mining-pool.js";

const PORT = Number(process.env.PORT ?? 4000);
const AUTO_MINE_INTERVAL_MS = Number(process.env.AUTO_MINE_INTERVAL_MS ?? 20_000);
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

app.get("/health", (_req, res) => {
  res.json({ ok: true, name: CHAIN_NAME, symbol: CHAIN_SYMBOL, height: chain.getLatestBlock().index });
});

app.get("/chain", (_req, res) => {
  res.json({ length: chain.getChain().length, chain: chain.getChain() });
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

// Proof-of-work "lend your processing power" pool: any number of browsers hash
// against the current challenge; a verified share is real work, dedup'd and
// checked server-side. Each epoch (AUTO_MINE_INTERVAL_MS) the shares tally is
// snapshotted, a block is mined, and the block reward is split across that
// epoch's contributors proportional to shares submitted.
app.get("/mining/challenge", (_req, res) => {
  res.json(pool.getChallenge());
});

app.get("/mining/shares", (_req, res) => {
  res.json({ shares: pool.getShares() });
});

app.post("/mining/submit", (req, res) => {
  const { address, nonce } = req.body ?? {};
  const result = pool.submitShare(address, nonce, req.ip ?? "unknown");
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.status(201).json(result);
});

app.listen(PORT, () => {
  console.log(`Albus chain API listening on :${PORT}`);
});

if (AUTO_MINE_INTERVAL_MS > 0) {
  setInterval(() => {
    const snapshot = pool.rotateEpoch();
    try {
      chain.mineEpoch(snapshot, chain.faucet.address);
    } catch (err) {
      console.error("epoch mining failed", err);
    }
  }, AUTO_MINE_INTERVAL_MS);
}
