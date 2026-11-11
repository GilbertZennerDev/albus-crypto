import test, { after } from "node:test";
import assert from "node:assert/strict";
import { Blockchain } from "../src/blockchain.js";
import { calculateProofHash, hashMeetsDifficulty, nonceHex, type Block } from "../src/block.js";
import { MAINNET_PARAMS, UNITS_PER_COIN, type ConsensusParams } from "../src/params.js";
import { createTransaction } from "../src/transaction.js";
import { generateKeyPair } from "../src/wallet.js";

const P: ConsensusParams = { ...MAINNET_PARAMS, initialReward: 210 * UNITS_PER_COIN, initialDifficulty: 64, retargetTauMs: 1e15, coinbaseMaturity: 1 };
const rich = generateKeyPair();
const other = generateKeyPair();

function mineBlock(chain: Blockchain): Block {
  const t = chain.buildTemplate(rich.address);
  let n = 0;
  while (!hashMeetsDifficulty(calculateProofHash(t.seed, rich.address, nonceHex(n)), t.difficulty)) n++;
  const { result, block } = chain.submitSolved(t, nonceHex(n));
  assert.equal(result.status, "added");
  return block;
}

function funded(): Blockchain {
  const c = new Blockchain(P, null);
  mineBlock(c);
  mineBlock(c);
  return c;
}

const tx = (c: Blockchain, nonce: number) =>
  createTransaction(rich.privateKey, rich.publicKey, other.address, 1, P.minFeeUnits, nonce, c.networkId);

test("Mempool-Flut: 5200 gültige Transaktionen füllen höchstens 5000 Plätze, schnell und ohne Speicherblähung", () => {
  const c = funded();
  const heap0 = process.memoryUsage().heapUsed;
  const t0 = Date.now();
  let ok = 0;
  let full = 0;
  const errs = new Map<string, number>();
  for (let i = 0; i < 5200; i++) {
    const r = c.submitTransaction(tx(c, i), "evil");
    if (r.ok) ok++;
    else { errs.set(r.error, (errs.get(r.error) ?? 0) + 1); if (/mempool full/.test(r.error)) full++; }
  }
  const ms = Date.now() - t0;
  const mb = (process.memoryUsage().heapUsed - heap0) / 1e6;
  console.log([...errs]);
  console.log(`5200 Transaktionen in ${ms} ms, ${ok} angenommen, ${full} abgewiesen, Heap +${mb.toFixed(1)} MB`);
  assert.equal(ok, 5000);
  assert.equal(full, 1, "die erste Transaktion über dem Limit meldet: Pool voll");
  assert.equal(ok + [...errs.values()].reduce((a, b) => a + b, 0), 5200);
  assert.equal(c.getMempool().length, 5000);
  assert.ok(ms < 30_000, `zu langsam: ${ms} ms`);
  assert.ok(mb < 150, `zu viel Speicher: ${mb} MB`);
});

test("Signatur-Flut: 3000 Transaktionen mit falscher Signatur werden billig abgewiesen", () => {
  const c = funded();
  const good = tx(c, 0);
  const donor = tx(c, 1);
  const t0 = Date.now();
  let rejected = 0;
  for (let i = 0; i < 3000; i++) {
    const r = c.submitTransaction({ ...good, signature: donor.signature }, "evil");
    if (!r.ok && /invalid signature/.test(r.error)) rejected++;
  }
  const ms = Date.now() - t0;
  console.log(`3000 falsche Signaturen in ${ms} ms (${(ms / 3000).toFixed(2)} ms pro Stück)`);
  assert.equal(rejected, 3000);
  assert.equal(c.getMempool().length, 0);
  assert.ok(ms / 3000 < 5, "mehr als 5 ms pro falscher Transaktion");
});

test("Volle Blöcke: 500 echte Transaktionen werden zügig geprüft und übernommen", () => {
  const c = funded();
  for (let i = 0; i < P.maxTxPerBlock; i++) assert.ok(c.submitTransaction(tx(c, i)).ok);
  const t = c.buildTemplate(rich.address);
  let n = 0;
  while (!hashMeetsDifficulty(calculateProofHash(t.seed, rich.address, nonceHex(n)), t.difficulty)) n++;
  const t0 = Date.now();
  const { result, block } = c.submitSolved(t, nonceHex(n));
  const ms = Date.now() - t0;
  console.log(`Block mit ${block.transactions.length} Transaktionen in ${ms} ms übernommen`);
  assert.equal(result.status, "added");
  assert.ok(block.transactions.length > 400);
  assert.ok(ms < 3000, `Block zu langsam geprüft: ${ms} ms`);

  const peer = new Blockchain(P, null);
  for (const b of c.getChain().slice(1)) {
    const s = Date.now();
    assert.equal(peer.addBlock(b, "peer").status, "added");
    if (b.transactions.length > 400) console.log(`Fremder Knoten prüft denselben Block in ${Date.now() - s} ms`);
  }
});

test("Riesen-Blöcke: 20000 Transaktionen oder zu viele Bytes werden sofort abgewiesen", () => {
  const c = funded();
  const good = mineBlock(new Blockchain(P, null));
  const base = c.buildTemplate(rich.address);
  const cb = good.transactions[0];
  const timestamp = Math.max(Date.now(), c.tip.timestamp + 1);
  const bomb = { ...good, index: base.index, previousHash: base.previousHash, difficulty: base.difficulty, timestamp, hash: "f".repeat(64), transactions: Array(20_000).fill(cb) } as Block;
  const t0 = Date.now();
  const r = c.addBlock(bomb, "evil");
  const ms = Date.now() - t0;
  console.log(`Block mit 20000 Einträgen abgewiesen in ${ms} ms: ${(r as { reason?: string }).reason}`);
  assert.equal(r.status, "invalid");
  assert.ok(ms < 100);
});

after(() => setTimeout(() => process.exit(0), 50).unref());
