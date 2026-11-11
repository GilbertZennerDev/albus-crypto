import { createServer } from "node:http";
import express from "express";
import cors from "cors";
import { Blockchain } from "./blockchain.js";
import { ADDRESS_RE, normalizeTransaction } from "./transaction.js";
import { paramsFromEnv, UNITS_PER_COIN } from "./params.js";
import { JobFeed } from "./mining-ws.js";
import { P2P } from "./p2p.js";
import { PeerStats } from "./peer-stats.js";
import { rateLimit } from "./guard.js";
import { CpuMiner } from "./cpu-miner.js";

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? "127.0.0.1";
const DATA_DIR = process.env.DATA_DIR ?? "data";
const CHAIN_NAME = "Albus";
const CHAIN_SYMBOL = "ALB";
const PEERS = (process.env.PEERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const PUBLIC_URL = process.env.P2P_PUBLIC_URL || undefined;
const MINER_ADDRESS = process.env.MINER_ADDRESS;

const chain = new Blockchain(paramsFromEnv(), DATA_DIR);
const app = express();
app.set("trust proxy", true);
app.use(cors());
app.use(rateLimit(Number(process.env.RATE_READ_PER_MIN ?? 600), Number(process.env.RATE_WRITE_PER_MIN ?? 60)));
app.use(express.json({ limit: "1mb" }));

const server = createServer(app);
const feed = new JobFeed(chain);
const peerStats = new PeerStats(DATA_DIR);
setInterval(() => peerStats.save(), 60_000).unref();
const p2p = new P2P(chain, { dataDir: DATA_DIR, seeds: PEERS, publicUrl: PUBLIC_URL, stats: peerStats });

server.on("upgrade", (req, socket, head) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (path === "/mining/ws") feed.handleUpgrade(req, socket, head);
  else if (path === "/p2p") p2p.handleUpgrade(req, socket, head);
  else socket.destroy();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, name: CHAIN_NAME, symbol: CHAIN_SYMBOL, height: chain.height });
});

app.get("/info", (_req, res) => {
  res.json({
    name: CHAIN_NAME,
    symbol: CHAIN_SYMBOL,
    networkId: chain.networkId,
    genesis: chain.genesis.hash,
    height: chain.height,
    tip: chain.tip.hash,
    totalWork: chain.tipWork.toString(),
    difficulty: chain.getNextDifficulty(),
    mempool: chain.getMempool().length,
    minFee: chain.params.minFeeUnits,
    coinbaseMaturity: chain.params.coinbaseMaturity,
    referralBps: chain.params.referralBps ?? 0,
    unitsPerCoin: UNITS_PER_COIN,
    peers: p2p.status().peers.length,
  });
});

app.get("/stats/peers", (_req, res) => res.json({ days: peerStats.summary() }));

app.get("/p2p/status", (_req, res) => res.json(p2p.status()));

app.post("/p2p/peers", (req, res) => {
  if (!p2p.addPeer(req.body?.url)) return res.status(400).json({ error: "url must be ws:// or wss://" });
  res.status(201).json({ ok: true });
});

app.get("/chain", (req, res) => {
  const length = chain.height + 1;
  const limit = Math.max(1, Math.min(200, Math.floor(Number(req.query.limit)) || 50));
  const fromQ = Number(req.query.from);
  const from = Number.isFinite(fromQ) && req.query.from !== undefined ? Math.max(0, Math.floor(fromQ)) : Math.max(0, length - limit);
  res.json({ length, from, chain: chain.getChainRange(from, limit) });
});

app.get("/supply", (_req, res) => {
  res.json(chain.getSupplyInfo());
});

app.get("/blocks/:hashOrIndex", (req, res) => {
  const block = chain.getBlock(req.params.hashOrIndex);
  if (!block) return res.status(404).json({ error: "block not found" });
  res.json(block);
});

app.get("/tx/:id", (req, res) => {
  const f = chain.findTx(req.params.id);
  if (!f) return res.status(404).json({ error: "transaction not found in the active chain" });
  res.json({ ...f, confirmations: chain.height - f.height + 1 });
});

app.get("/address/:address/txs", (req, res) => {
  const limit = Math.max(1, Math.min(200, Math.floor(Number(req.query.limit)) || 50));
  const skip = Math.max(0, Math.floor(Number(req.query.skip)) || 0);
  res.json({ address: req.params.address, transactions: chain.txsOfAddress(req.params.address, limit, skip) });
});

app.post("/blocks", (req, res) => {
  const r = chain.addBlock(req.body, "api");
  if (r.status === "invalid") return res.status(400).json({ error: r.reason });
  res.status(r.status === "added" ? 201 : 200).json({ status: r.status });
});

app.get("/mempool", (_req, res) => {
  res.json({ length: chain.getMempool().length, transactions: chain.getMempool() });
});

app.get("/balance/:address", (req, res) => {
  const acc = chain.getAccount(req.params.address);
  res.json({ address: req.params.address, balance: acc.spendable, ...acc, unitsPerCoin: UNITS_PER_COIN });
});

app.get("/account/:address", (req, res) => {
  res.json({ address: req.params.address, ...chain.getAccount(req.params.address), minFee: chain.params.minFeeUnits, unitsPerCoin: UNITS_PER_COIN });
});

app.post("/transactions", (req, res) => {
  const tx = normalizeTransaction(req.body);
  if (!tx) return res.status(400).json({ error: "malformed transaction" });
  const result = chain.submitTransaction(tx, "api");
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.status(201).json({ ok: true });
});

app.post("/faucet", (_req, res) => {
  res.status(410).json({ error: "Fair launch: there is no faucet. ALB only comes from mining." });
});

app.get("/mining/challenge", (req, res) => {
  const address = String(req.query.address ?? "");
  if (!ADDRESS_RE.test(address)) return res.status(400).json({ error: "address query parameter required (Solo-Mining)" });
  res.json(feed.challenge(address, typeof req.query.invitation === "string" ? req.query.invitation.slice(0, 400) : undefined));
});

app.get("/mining/stats", (_req, res) => {
  res.json(feed.getStats());
});

app.post("/mining/submit", (req, res) => {
  const { address, nonce } = req.body ?? {};
  if (typeof address !== "string" || !ADDRESS_RE.test(address)) return res.status(400).json({ error: "invalid address" });
  const r = feed.legacySubmit(address, nonce);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.status(201).json(r);
});

server.listen(PORT, HOST, () => {
  console.log(
    `Albus node listening on ${HOST}:${PORT} (network ${chain.networkId}, height ${chain.height}, nodeId ${p2p.nodeId}; ws: /p2p, /mining/ws)`,
  );
});

if (process.env.CPU_MINE === "1") {
  if (!MINER_ADDRESS || !ADDRESS_RE.test(MINER_ADDRESS)) {
    console.error("CPU_MINE=1 needs MINER_ADDRESS=albus1...");
  } else {
    new CpuMiner(chain, MINER_ADDRESS, Number(process.env.CPU_MINE_THROTTLE_MS ?? 0), process.env.MINER_INVITATION).start();
    console.log(`Built-in CPU miner active for ${MINER_ADDRESS}`);
  }
}
