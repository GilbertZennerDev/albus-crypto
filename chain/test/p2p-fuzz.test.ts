process.env.P2P_ALLOW_PRIVATE = "1";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { Blockchain } from "../src/blockchain.js";
import { calculateProofHash, hashMeetsDifficulty, type Block, nonceHex } from "../src/block.js";
import { MAINNET_PARAMS, UNITS_PER_COIN, type ConsensusParams } from "../src/params.js";
import { generateKeyPair } from "../src/wallet.js";
import { P2P } from "../src/p2p.js";

const P: ConsensusParams = { ...MAINNET_PARAMS, initialReward: 210 * UNITS_PER_COIN, initialDifficulty: 64, retargetTauMs: 1e15, coinbaseMaturity: 1 };
const miner = generateKeyPair();

function mine(chain: Blockchain): Block {
  const t = chain.buildTemplate(miner.address);
  let n = 0;
  while (!hashMeetsDifficulty(calculateProofHash(t.seed, miner.address, nonceHex(n)), t.difficulty)) n++;
  const { result, block } = chain.submitSolved(t, nonceHex(n));
  assert.equal(result.status, "added");
  return block;
}
const grown = (n: number) => {
  const c = new Blockchain(P, null);
  for (let i = 0; i < n; i++) mine(c);
  return c;
};

async function listen(chain: Blockchain, seeds: string[] = [], banMs = 0): Promise<{ p2p: P2P; server: Server; url: string }> {
  const server = createServer();
  const p2p = new P2P(chain, { dataDir: null, seeds, banMs });
  server.on("upgrade", (req, socket, head) => p2p.handleUpgrade(req, socket, head));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { p2p, server, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/p2p` };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connect(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  ws.on("error", () => {});
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });
  return ws;
}

const hello = (chain: Blockchain, extra: Record<string, unknown> = {}) => ({
  type: "hello",
  network: chain.networkId,
  nodeId: "fuzz" + Math.random().toString(16).slice(2, 10),
  height: 0,
  work: "0",
  ...extra,
});

let seed = 0xa1b05;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];

function junk(depth = 0): unknown {
  const leaves: unknown[] = [
    null, undefined, true, false, 0, -1, 1.5, NaN, Infinity, 2 ** 60, "", "x", "0".repeat(64), "9".repeat(5000),
    [], {}, [null], [[]], { hash: 1 }, { hash: "a" }, { index: "1" }, { transactions: 5 }, { transactions: [null] },
  ];
  if (depth > 3 || rnd() < 0.5) return pick(leaves);
  if (rnd() < 0.5) return Array.from({ length: Math.floor(rnd() * 5) }, () => junk(depth + 1));
  const o: Record<string, unknown> = {};
  for (const k of ["hash", "index", "previousHash", "timestamp", "difficulty", "transactions", "nonce", "id", "to", "amount"]) {
    if (rnd() < 0.4) o[k] = junk(depth + 1);
  }
  return o;
}

const TYPES = ["getpeers", "peers", "tx", "block", "getblocks", "blocks", "getheaders", "headers", "wat", "", 7, null];

test("P2P-Fuzz: kaputte Nachrichten jeder Art bringen den Knoten nicht zu Fall", async () => {
  const a = grown(8);
  const tip = a.tip.hash;
  const na = await listen(a);

  for (let round = 0; round < 40; round++) {
    const ws = await connect(na.url);
    ws.send(JSON.stringify(hello(a)));
    for (let i = 0; i < 25; i++) {
      if (ws.readyState !== WebSocket.OPEN) break;
      const t = pick(TYPES);
      const body: Record<string, unknown> = { type: t };
      for (const k of ["tx", "block", "blocks", "headers", "locator", "hashes", "peers", "from", "count"]) {
        if (rnd() < 0.5) body[k] = junk();
      }
      const kind = rnd();
      ws.send(kind < 0.8 ? JSON.stringify(body) : kind < 0.9 ? "{kaputt" : JSON.stringify(junk()));
    }
    await sleep(5);
    ws.terminate();
  }

  assert.equal(a.tip.hash, tip, "Kette darf sich durch Müll nicht ändern");

  const b = new Blockchain(P, null);
  const nb = await listen(b, [na.url]);
  const deadline = Date.now() + 15000;
  while (b.tip.hash !== a.tip.hash && Date.now() < deadline) await sleep(100);
  assert.equal(b.tip.hash, a.tip.hash);

  na.server.closeAllConnections?.();
  na.server.close();
  nb.server.closeAllConnections?.();
  nb.server.close();
});

test("P2P-Fuzz: Hello mit riesigem work-String blockiert den Event-Loop nicht spürbar", async () => {
  const a = grown(2);
  const na = await listen(a);
  const ws = await connect(na.url);

  let worst = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 5);

  ws.send(JSON.stringify(hello(a, { work: "9".repeat(3 * 1024 * 1024) })));
  await sleep(1500);
  clearInterval(timer);
  console.log(`Event-Loop-Pause durch 3-MB-work-String: ${worst} ms`);
  ws.terminate();
  na.server.closeAllConnections?.();
  na.server.close();
  assert.ok(worst < 100, `Event-Loop stand ${worst} ms still`);
});

test("P2P-Fuzz: Hello mit height=Infinity oder Müll-Feldern wird sauber behandelt", async () => {
  const a = grown(3);
  const tip = a.tip.hash;
  const na = await listen(a);
  for (const extra of [{ height: 1e308 }, { height: "abc" }, { height: -5 }, { work: "-1" }, { work: "1e9" }, { work: 12 }, { url: 5 }, { url: "x".repeat(10000) }]) {
    const ws = await connect(na.url);
    ws.send(JSON.stringify(hello(a, extra)));
    await sleep(30);
    ws.send(JSON.stringify({ type: "getheaders", locator: [a.tip.hash] }));
    await sleep(30);
    ws.terminate();
  }
  assert.equal(a.tip.hash, tip);
  const ws = await connect(na.url);
  const got = new Promise<string>((res) => ws.once("message", (d) => res(d.toString())));
  ws.send(JSON.stringify(hello(a)));
  assert.match(await got, /getpeers/);
  ws.terminate();
  na.server.closeAllConnections?.();
  na.server.close();
});

const closed = (ws: WebSocket) => new Promise<void>((r) => (ws.readyState === WebSocket.CLOSED ? r() : ws.once("close", () => r())));

test("P2P-Schutz: nach drei Strikes wird die IP gesperrt und kommt nicht mehr herein", async () => {
  const a = grown(1);
  const na = await listen(a, [], 60_000);
  const ws = await connect(na.url);
  ws.send(JSON.stringify(hello(a)));
  for (let i = 0; i < 3; i++) ws.send("{kaputt");
  await closed(ws);
  const again = new WebSocket(na.url);
  again.on("error", () => {});
  const opened = await new Promise<boolean>((res) => {
    again.once("open", () => res(true));
    again.once("error", () => res(false));
    again.once("close", () => res(false));
  });
  assert.equal(opened, false, "gesperrte IP darf sich nicht wieder verbinden");
  na.server.closeAllConnections?.();
  na.server.close();
});

test("P2P-Schutz: zu viele Bytes in 10 s trennen den Peer", async () => {
  const a = grown(1);
  const na = await listen(a);
  const ws = await connect(na.url);
  ws.send(JSON.stringify(hello(a)));
  const filler = JSON.stringify({ type: "peers", peers: ["x".repeat(3 * 1024 * 1024)] });
  for (let i = 0; i < 14; i++) ws.send(filler);
  await Promise.race([closed(ws), sleep(5000)]);
  assert.equal(ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING, true);
  na.server.closeAllConnections?.();
  na.server.close();
});

after(() => setTimeout(() => process.exit(0), 50).unref());
