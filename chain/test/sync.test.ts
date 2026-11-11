process.env.P2P_ALLOW_PRIVATE = "1";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Blockchain } from "../src/blockchain.js";
import { calculateProofHash, createGenesisBlock, hashMeetsDifficulty, headerOf, type Block, nonceHex } from "../src/block.js";
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
const grown = (n: number, cps?: Record<number, string>) => {
  const c = new Blockchain(P, null, cps);
  for (let i = 0; i < n; i++) mine(c);
  return c;
};

test("Header-first: valid header chain is accepted and carries the right work", () => {
  const a = grown(6);
  const b = new Blockchain(P, null);
  const headers = a.getChain().slice(1).map(headerOf);
  const r = b.verifyHeaders(headers, null);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.tip.work, a.tipWork);
  const r1 = b.verifyHeaders(headers.slice(0, 3), null);
  assert.equal(r1.ok, true);
  if (r1.ok) {
    const r2 = b.verifyHeaders(headers.slice(3), r1.tip);
    assert.equal(r2.ok, true);
    if (r2.ok) assert.equal(r2.tip.work, a.tipWork);
  }
});

test("Header-first: tampered, gapped or unlinked headers are refused", () => {
  const a = grown(5);
  const b = new Blockchain(P, null);
  const h = a.getChain().slice(1).map(headerOf);
  const bad = (mut: (x: typeof h) => void) => {
    const copy = structuredClone(h);
    mut(copy);
    return b.verifyHeaders(copy, null);
  };
  assert.equal(bad((x) => (x[2].timestamp += 1)).ok, false);
  assert.equal(bad((x) => (x[2].transactionRoot = "0".repeat(64))).ok, false);
  assert.equal(bad((x) => (x[1].difficulty += 1)).ok, false);
  assert.equal(bad((x) => x.splice(1, 1)).ok, false);
  assert.equal(bad((x) => (x[0].nonce = "zz")).ok, false);
  assert.equal(b.verifyHeaders(h.slice(2), null).ok, false);
  assert.equal(b.verifyHeaders([], null).ok, false);
});

test("Checkpoint: blocks and headers of another chain at that height are refused, reorg below is refused", () => {
  const a = grown(4);
  const cps = { 3: a.getBlock("3")!.hash };
  const good = new Blockchain(P, null, cps);
  for (const blk of a.getChain().slice(1)) assert.equal(good.addBlock(blk).status, "added");
  const other = new Blockchain(P, null);
  const other2 = generateKeyPair();
  for (let i = 0; i < 5; i++) {
    const t = other.buildTemplate(other2.address);
    let n = 0;
    while (!hashMeetsDifficulty(calculateProofHash(t.seed, other2.address, nonceHex(n)), t.difficulty)) n++;
    other.submitSolved(t, nonceHex(n));
  }
  const strict = new Blockchain(P, null, cps);
  const ok = strict.addBlock(other.getBlock("1") as Block);
  assert.equal(ok.status, "added");
  assert.equal(strict.addBlock(other.getBlock("2") as Block).status, "added");
  const r = strict.addBlock(other.getBlock("3") as Block);
  assert.equal(r.status, "invalid");
  assert.match((r as { reason: string }).reason, /Checkpoint/);
  assert.equal(strict.verifyHeaders(other.getChain().slice(1).map(headerOf), null).ok, false);
  const g5 = other.getBlock("5") as Block;
  assert.notEqual(good.addBlock(g5).status, "added");
  assert.equal(good.height, 4);
});

async function listen(chain: Blockchain, seeds: string[] = []): Promise<{ p2p: P2P; server: Server; url: string }> {
  const server = createServer();
  const p2p = new P2P(chain, { dataDir: null, seeds });
  server.on("upgrade", (req, socket, head) => p2p.handleUpgrade(req, socket, head));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { p2p, server, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/p2p` };
}

test("P2P: a fresh node syncs a long chain header-first and ends on the same tip", async () => {
  const a = grown(250);
  const na = await listen(a);
  const b = new Blockchain(P, null);
  const nb = await listen(b, [na.url]);
  const deadline = Date.now() + 15000;
  while (b.tip.hash !== a.tip.hash && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.equal(b.tip.hash, a.tip.hash);
  assert.equal(b.height, 250);
  na.server.closeAllConnections?.();
  na.server.close();
  nb.server.close();
});

after(() => setTimeout(() => process.exit(0), 50).unref());
