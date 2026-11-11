import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Blockchain } from "../src/blockchain.js";
import { buildProvenBlock, calculateProofHash, computeSeed, createGenesisBlock, hashMeetsDifficulty, merkleProof, transactionRoot, verifyMerkleProof, type Block, nonceHex } from "../src/block.js";
import { createCoinbaseTransaction, createTransaction, type Transaction } from "../src/transaction.js";
import { MAINNET_PARAMS, UNITS_PER_COIN, isUnits, networkIdOf, parseCoins, rewardUnits, type ConsensusParams } from "../src/params.js";
import { generateKeyPair } from "../src/wallet.js";

const P: ConsensusParams = { ...MAINNET_PARAMS, initialReward: 210 * UNITS_PER_COIN, initialDifficulty: 64, retargetTauMs: 1e15, coinbaseMaturity: 1 };
const A = UNITS_PER_COIN;
const MIN_FEE = P.minFeeUnits;
const NET = networkIdOf(P, createGenesisBlock().hash);
const alice = generateKeyPair();
const bob = generateKeyPair();
const carol = generateKeyPair();

function grind(seed: string, address: string, difficulty: number): string {
  for (let n = 0; ; n++) {
    const nonce = nonceHex(n);
    if (hashMeetsDifficulty(calculateProofHash(seed, address, nonce), difficulty)) return nonce;
  }
}

function mine(chain: Blockchain, address: string): Block {
  const t = chain.buildTemplate(address);
  const { result, block } = chain.submitSolved(t, grind(t.seed, address, t.difficulty));
  assert.equal(result.status, "added", JSON.stringify(result));
  return block;
}

function craft(
  chain: Blockchain,
  o: { address: string; txs?: Transaction[]; coinbaseUnits?: number; difficulty?: number; parent?: Block },
): Block {
  const parent = o.parent ?? chain.tip;
  const index = parent.index + 1;
  const timestamp = parent.timestamp + 1000;
  const difficulty = o.difficulty ?? chain.getNextDifficulty();
  const txs = o.txs ?? [];
  const fees = txs.reduce((sum, t) => sum + t.fee, 0);
  const cb = createCoinbaseTransaction(o.address, o.coinbaseUnits ?? rewardUnits(P, index) + fees, index, timestamp);
  const all = [cb, ...txs];
  const seed = computeSeed(parent.hash, index, timestamp, difficulty, all);
  return buildProvenBlock(index, timestamp, all, parent.hash, difficulty, seed, o.address, grind(seed, o.address, difficulty));
}

let ts = Date.now();
const pay = (from: typeof alice, to: string, amount: number, nonce = 0, fee = MIN_FEE) =>
  createTransaction(from.privateKey, from.publicKey, to, amount, fee, nonce, NET, ts++);
const payOn = (c: Blockchain, from: typeof alice, to: string, amount: number, nonce = 0, fee = MIN_FEE) =>
  createTransaction(from.privateKey, from.publicKey, to, amount, fee, nonce, c.networkId, ts++);
const reason = (r: { status: string }) => (r as { reason?: string }).reason ?? "";

test("Genesis is deterministic (two processes, same hash)", () => {
  const code = `import("./src/block.ts").then(m=>console.log(m.createGenesisBlock().hash))`;
  const run = () => execFileSync(process.execPath, ["--import", "tsx", "-e", code], { encoding: "utf-8" }).trim();
  const a = run();
  const b = run();
  assert.equal(a, b);
  assert.equal(a, createGenesisBlock().hash);
  assert.equal(new Blockchain(P, null).networkId, new Blockchain(P, null).networkId);
});

test("Units: amounts are exact integers, text input is parsed by digits", () => {
  assert.equal(parseCoins("1"), 100_000_000);
  assert.equal(parseCoins("0.00000001"), 1);
  assert.equal(parseCoins("12.34567891"), 1_234_567_891);
  assert.equal(parseCoins("0.000000001"), null);
  assert.equal(parseCoins("-1"), null);
  assert.equal(parseCoins("0"), null);
  assert.equal(parseCoins("1e3"), null);
  assert.equal(isUnits(1.5), false);
  assert.equal(isUnits(0), false);
  assert.equal(isUnits(100_000), true);
});

test("Float amounts and sub-minimum fees are refused", () => {
  const c = new Blockchain(P, null);
  mine(c, alice.address);
  assert.throws(() => pay(alice, bob.address, 5 * A + 0.5));
  assert.equal(c.submitTransaction(pay(alice, bob.address, 5 * A, 0, MIN_FEE - 1)).ok, false);
  const r = c.addBlock(craft(c, { address: alice.address, txs: [pay(alice, bob.address, 5 * A, 0, MIN_FEE - 1)] }));
  assert.equal(r.status, "invalid");
});

test("Mining pays the miner directly, no premine", () => {
  const c = new Blockchain(P, null);
  assert.equal(c.getAccount(alice.address).total, 0);
  mine(c, alice.address);
  mine(c, alice.address);
  assert.equal(c.height, 2);
  const acc = c.getAccount(alice.address);
  assert.equal(acc.total, 420 * A);
  assert.equal(acc.spendable, 210 * A);
  assert.equal(acc.immature, 210 * A);
});

test("Same seed+nonce with a changed transaction list is rejected", () => {
  const c = new Blockchain(P, null);
  mine(c, alice.address);
  assert.equal(c.submitTransaction(pay(alice, bob.address, 5 * A)).ok, true);
  const good = c.buildTemplate(alice.address);
  assert.equal(good.transactions.length, 2);
  const nonce = grind(good.seed, alice.address, good.difficulty);
  const evil = buildProvenBlock(good.index, good.timestamp, [good.transactions[0]], good.previousHash, good.difficulty, good.seed, alice.address, nonce);
  const r = c.addBlock(evil);
  assert.equal(r.status, "invalid");
  assert.match(reason(r), /seed/);
  const evil2 = buildProvenBlock(good.index, good.timestamp + 5, good.transactions, good.previousHash, good.difficulty, good.seed, alice.address, nonce);
  assert.equal(c.addBlock(evil2).status, "invalid");
});

test("Coinbase overpayment is rejected", () => {
  const c = new Blockchain(P, null);
  const r = c.addBlock(craft(c, { address: alice.address, coinbaseUnits: rewardUnits(P, 1) + 1 }));
  assert.equal(r.status, "invalid");
  assert.match(reason(r), /coinbase/);
});

test("Wrong difficulty is rejected", () => {
  const c = new Blockchain({ ...P, initialDifficulty: 100 }, null);
  const r = c.addBlock(craft(c, { address: alice.address, difficulty: 80 }));
  assert.equal(r.status, "invalid");
  assert.match(reason(r), /difficulty/);
});

test("Overdraft and double spend are rejected", () => {
  const c = new Blockchain(P, null);
  mine(c, alice.address);
  assert.equal(c.submitTransaction(pay(alice, bob.address, 1000 * A)).ok, false);
  assert.equal(c.submitTransaction(pay(alice, bob.address, 150 * A)).ok, true);
  assert.equal(c.submitTransaction(pay(alice, carol.address, 150 * A, 1)).ok, false);
  const bad = craft(c, { address: bob.address, txs: [pay(alice, bob.address, 150 * A, 0), pay(alice, carol.address, 150 * A, 1)] });
  const r = c.addBlock(bad);
  assert.equal(r.status, "invalid");
  assert.match(reason(r), /balance/);
  assert.equal(c.height, 1);
});

test("Repeated transaction (replay) is rejected", () => {
  const c = new Blockchain(P, null);
  mine(c, alice.address);
  const t = pay(alice, bob.address, 10 * A);
  assert.equal(c.submitTransaction(t).ok, true);
  mine(c, carol.address);
  assert.equal(c.getBalance(bob.address), 10 * A);
  assert.equal(c.submitTransaction(t).ok, false);
  const r = c.addBlock(craft(c, { address: carol.address, txs: [t] }));
  assert.equal(r.status, "invalid");
  assert.match(reason(r), /nonce/);
});

test("Fee goes to the miner, total supply stays consistent", () => {
  const c = new Blockchain(P, null);
  mine(c, alice.address);
  assert.equal(c.submitTransaction(pay(alice, bob.address, 100 * A)).ok, true);
  mine(c, carol.address);
  assert.equal(c.getBalance(bob.address), 100 * A);
  assert.equal(c.getBalance(alice.address), 110 * A - MIN_FEE);
  assert.equal(c.getAccount(carol.address).total, 210 * A + MIN_FEE);
  assert.equal(c.getAccount(alice.address).nextNonce, 1);
});

test("Heavier chain wins (reorg), transactions return to the mempool", () => {
  const a = new Blockchain(P, null);
  const b = new Blockchain(P, null);
  mine(a, alice.address);
  assert.equal(b.addBlock(a.tip).status, "added");
  assert.equal(a.submitTransaction(pay(alice, bob.address, 20 * A)).ok, true);
  mine(a, alice.address);
  assert.equal(a.getBalance(bob.address), 20 * A);
  mine(b, carol.address);
  mine(b, carol.address);
  mine(b, carol.address);
  for (const blk of b.getChain().slice(2)) a.addBlock(blk);
  assert.equal(a.tip.hash, b.tip.hash);
  assert.equal(a.height, 4);
  assert.equal(a.getBalance(bob.address), 0);
  assert.equal(a.getMempool().length, 1);
  assert.equal(a.getAccount(carol.address).total, 630 * A);
});

test("Orphan blocks arriving out of order are adopted later", () => {
  const a = new Blockchain(P, null);
  const b = new Blockchain(P, null);
  for (let i = 0; i < 4; i++) mine(a, alice.address);
  for (const blk of a.getChain().slice(1).reverse()) b.addBlock(blk);
  assert.equal(b.tip.hash, a.tip.hash);
});

test("Invalid but longer side chain is not adopted", () => {
  const a = new Blockchain(P, null);
  mine(a, alice.address);
  const fork = a.tip;
  mine(a, alice.address);
  const tipBefore = a.tip.hash;
  const bad = craft(a, { address: carol.address, parent: fork, txs: [pay(alice, bob.address, 5000 * A)] });
  a.addBlock(bad);
  const next = craft(a, { address: carol.address, parent: bad });
  const r = a.addBlock(next);
  assert.notEqual(r.status, "added" && (r as { isTip: boolean }).isTip, true);
  assert.equal(a.tip.hash, tipBefore);
  assert.equal(a.height, 2);
  assert.equal(a.getBalance(carol.address), 0);
});

test("Save and load yield the same chain", () => {
  const dir = mkdtempSync(join(tmpdir(), "albus-"));
  try {
    const a = new Blockchain(P, dir);
    mine(a, alice.address);
    a.submitTransaction(pay(alice, bob.address, 7 * A));
    mine(a, alice.address);
    const b = new Blockchain(P, dir);
    assert.equal(b.tip.hash, a.tip.hash);
    assert.equal(b.getBalance(bob.address), 7 * A);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Data from a different rule set makes startup fail loudly", () => {
  const dir = mkdtempSync(join(tmpdir(), "albus-"));
  try {
    mine(new Blockchain(P, dir), alice.address);
    assert.throws(() => new Blockchain({ ...P, initialDifficulty: 80 }, dir), /another ruleset/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Difficulty is derived from the chain (adjusts every block)", () => {
  const p: ConsensusParams = { ...P, retargetTauMs: 60_000 };
  const c = new Blockchain(p, null);
  for (let i = 0; i < 3; i++) assert.equal(c.addBlock(craft(c, { address: alice.address })).status, "added");
  const d = c.getNextDifficulty();
  assert.ok(d > 64, `1-s-Abstaende sind viel schneller als 60 s, erwartet mehr Schwierigkeit, war ${d}`);
  assert.equal(c.addBlock(craft(c, { address: alice.address, difficulty: 64 })).status, "invalid");
  assert.equal(c.addBlock(craft(c, { address: alice.address })).status, "added");
});

test("Time rules: median of predecessors and future limit", () => {
  const c = new Blockchain(P, null);
  for (let i = 0; i < 5; i++) assert.equal(c.addBlock(craft(c, { address: alice.address })).status, "added");
  const old = craft(c, { address: alice.address });
  const stale = buildProvenBlock(old.index, c.getChain()[1].timestamp, old.transactions, old.previousHash, old.difficulty, computeSeed(old.previousHash, old.index, c.getChain()[1].timestamp, old.difficulty, old.transactions), alice.address, "0".repeat(16));
  assert.equal(c.addBlock(stale).status, "invalid");
  const future = Date.now() + 10 * 60 * 1000;
  const t = c.buildTemplate(alice.address);
  const seed = computeSeed(t.previousHash, t.index, future, t.difficulty, t.transactions.map((x) => ({ ...x, timestamp: future })));
  const fb = buildProvenBlock(t.index, future, t.transactions.map((x) => ({ ...x, timestamp: future })), t.previousHash, t.difficulty, seed, alice.address, grind(seed, alice.address, t.difficulty));
  assert.match(reason(c.addBlock(fb)), /future/);
});

test("Transaction from another network is invalid here (replay protection)", () => {
  const c = new Blockchain(P, null);
  mine(c, alice.address);
  const foreign = createTransaction(alice.privateKey, alice.publicKey, bob.address, 5 * A, MIN_FEE, 0, "0000000000000000", ts++);
  assert.equal(c.submitTransaction(foreign).ok, false);
  assert.equal(c.submitTransaction(pay(alice, bob.address, 5 * A)).ok, true);
});

test("Max supply and era length match the base parameters", () => {
  const m = MAINNET_PARAMS;
  assert.equal((m.initialReward / UNITS_PER_COIN) * m.halvingInterval * 2, 21_000_000);
  assert.equal(Math.round((m.halvingInterval * m.targetBlockTimeMs) / 86_400_000), 729);
});

test("Nonce: strictly in order, no gaps, no repeat", () => {
  const c = new Blockchain(P, null);
  mine(c, alice.address);
  assert.equal(c.submitTransaction(pay(alice, bob.address, A, 1)).ok, false);
  assert.equal(c.submitTransaction(pay(alice, bob.address, A, 0)).ok, true);
  assert.equal(c.submitTransaction(pay(alice, bob.address, 2 * A, 0)).ok, false);
  assert.equal(c.submitTransaction(pay(alice, bob.address, 2 * A, 1)).ok, true);
  assert.equal(c.getAccount(alice.address).nextNonce, 2);
  const gap = craft(c, { address: carol.address, txs: [pay(alice, bob.address, A, 1)] });
  assert.match(reason(c.addBlock(gap)), /nonce/);
  mine(c, carol.address);
  assert.equal(c.getMempool().length, 0);
  assert.equal(c.getBalance(bob.address), 3 * A);
  assert.equal(c.getAccount(alice.address).nextNonce, 2);
});

test("Coinbase maturity: mined coins are spendable only after the waiting time", () => {
  const c = new Blockchain({ ...P, coinbaseMaturity: 3 }, null);
  mine(c, alice.address);
  mine(c, carol.address);
  assert.equal(c.getAccount(alice.address).spendable, 0);
  assert.equal(c.getAccount(alice.address).immature, 210 * A);
  assert.equal(c.submitTransaction(payOn(c, alice, bob.address, A)).ok, false);
  const early = craft(c, { address: carol.address, txs: [payOn(c, alice, bob.address, A)] });
  assert.match(reason(c.addBlock(early)), /balance/);
  mine(c, carol.address);
  assert.equal(c.submitTransaction(payOn(c, alice, bob.address, A)).ok, true);
  mine(c, carol.address);
  assert.equal(c.getBalance(bob.address), A);
  assert.equal(c.getAccount(alice.address).spendable, 209 * A - MIN_FEE);
});

test("Fee market: highest fee first, but per sender strictly by nonce", () => {
  const p2 = { ...P, maxTxPerBlock: 2 };
  const c = new Blockchain(p2, null);
  mine(c, alice.address);
  mine(c, bob.address);
  assert.equal(c.submitTransaction(payOn(c, alice, carol.address, A, 0, MIN_FEE)).ok, true);
  assert.equal(c.submitTransaction(payOn(c, alice, carol.address, A, 1, 50 * MIN_FEE)).ok, true);
  assert.equal(c.submitTransaction(payOn(c, bob, carol.address, A, 0, 5 * MIN_FEE)).ok, true);
  const picked = c.buildTemplate(carol.address).transactions.slice(1).map((x) => `${x.fromAddress === alice.address ? "alice" : "bob"}:${x.nonce}`);
  assert.deepEqual(picked, ["bob:0", "alice:0"]);

  const p1 = { ...P, maxTxPerBlock: 1 };
  const c2 = new Blockchain(p1, null);
  mine(c2, alice.address);
  mine(c2, bob.address);
  assert.equal(c2.submitTransaction(payOn(c2, alice, carol.address, A, 0, 100 * MIN_FEE)).ok, true);
  assert.equal(c2.submitTransaction(payOn(c2, bob, carol.address, A, 0, 5 * MIN_FEE)).ok, true);
  const t2 = c2.buildTemplate(carol.address);
  assert.equal(t2.transactions.length, 2);
  assert.equal(t2.transactions[1].fromAddress, alice.address);
  assert.equal(t2.transactions[0].amount, rewardUnits(p1, 3) + 100 * MIN_FEE);
});

test("Merkle root: proofs verify, tampering and odd counts behave, no duplicate-leaf mutation", () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => pay(alice, bob.address, A + i, i));
  for (const n of [1, 2, 3, 4, 5, 7, 8]) {
    const txs = mk(n);
    const root = transactionRoot(txs);
    for (let i = 0; i < n; i++) {
      const pr = merkleProof(txs, i) as { side: "l" | "r"; hash: string }[];
      assert.equal(verifyMerkleProof(txs[i], pr, root), true, `n=${n} i=${i}`);
      assert.equal(verifyMerkleProof(txs[(i + 1) % n === i ? 0 : (i + 1) % n], pr, root), n === 1);
    }
  }
  const three = mk(3);
  assert.notEqual(transactionRoot(three), transactionRoot([...three, three[2]]));
  assert.notEqual(transactionRoot(three), transactionRoot([three[1], three[0], three[2]]));
  assert.equal(merkleProof(three, 3), null);
});

function snapshot(c: Blockchain) {
  return [alice, bob, carol].map((k) => JSON.stringify(c.getAccount(k.address)));
}

test("Undo data: reorg over several blocks equals a fresh replay from genesis", () => {
  const p = { ...P, coinbaseMaturity: 2 };
  const a = new Blockchain(p, null);
  const b = new Blockchain(p, null);
  for (let i = 0; i < 3; i++) {
    const blk = mine(a, alice.address);
    assert.equal(b.addBlock(blk).status, "added");
  }
  assert.equal(a.submitTransaction(payOn(a, alice, bob.address, 7 * A)).ok, true);
  mine(a, bob.address);
  mine(a, alice.address);
  assert.equal(b.submitTransaction(payOn(b, alice, carol.address, 9 * A)).ok, true);
  for (let i = 0; i < 4; i++) mine(b, i % 2 ? carol.address : alice.address);
  for (const blk of b.getChain().slice(4)) a.addBlock(blk);
  assert.equal(a.tip.hash, b.tip.hash);
  const fresh = new Blockchain(p, null);
  for (const blk of b.getChain().slice(1)) assert.equal(fresh.addBlock(blk).status, "added");
  assert.deepEqual(snapshot(a), snapshot(fresh));
  assert.equal(a.getBalance(bob.address), 0);
  const c = new Blockchain(p, null);
  for (const blk of a.getChain().slice(1)) c.addBlock(blk);
  assert.deepEqual(snapshot(c), snapshot(a));
});

test("Undo data: side chain that turns invalid late leaves state untouched", () => {
  const p = { ...P, coinbaseMaturity: 2 };
  const a = new Blockchain(p, null);
  mine(a, alice.address);
  mine(a, alice.address);
  const fork = a.tip;
  mine(a, alice.address);
  mine(a, bob.address);
  const before = snapshot(a);
  const tipBefore = a.tip.hash;
  const ok1 = craft(a, { address: carol.address, parent: fork });
  const ok2 = craft(a, { address: carol.address, parent: ok1 });
  const bad = craft(a, { address: carol.address, parent: ok2, txs: [payOn(a, alice, bob.address, 9999 * A)] });
  a.addBlock(ok1);
  a.addBlock(ok2);
  a.addBlock(bad);
  assert.equal(a.tip.hash, tipBefore);
  assert.deepEqual(snapshot(a), before);
  mine(a, alice.address);
  assert.equal(a.height, 5);
});

test("Ruleset 4: unpadded nonce and short seed are refused, padded form is canonical", () => {
  assert.throws(() => calculateProofHash("1".repeat(64), alice.address, "0"));
  assert.throws(() => calculateProofHash("1".repeat(32), alice.address, "0".repeat(16)));
  assert.equal(calculateProofHash("1".repeat(64), alice.address, "00000000000000ff"), calculateProofHash("1".repeat(64), alice.address, nonceHex(255)));
});
