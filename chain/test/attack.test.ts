import test, { after } from "node:test";
import assert from "node:assert/strict";
import { Blockchain } from "../src/blockchain.js";
import { buildProvenBlock, calculateProofHash, computeSeed, hashMeetsDifficulty, type Block, nonceHex } from "../src/block.js";
import { MAINNET_PARAMS, UNITS_PER_COIN, rewardUnits, type ConsensusParams } from "../src/params.js";
import { createCoinbaseTransaction } from "../src/transaction.js";
import { generateKeyPair } from "../src/wallet.js";

const P: ConsensusParams = { ...MAINNET_PARAMS, initialReward: 210 * UNITS_PER_COIN, initialDifficulty: 128, coinbaseMaturity: 1 };
const honest = generateKeyPair();
const attacker = generateKeyPair();

function forge(chain: Blockchain, timestamp: number, who = honest.address, rewardOffset = 0): Block {
  const t = chain.buildTemplate(who);
  const coinbase = createCoinbaseTransaction(who, rewardUnits(chain.params, t.index) + rewardOffset, t.index, timestamp);
  const transactions = [coinbase];
  const seed = computeSeed(t.previousHash, t.index, timestamp, t.difficulty, transactions);
  let n = 0;
  while (!hashMeetsDifficulty(calculateProofHash(seed, who, nonceHex(n)), t.difficulty)) n++;
  return buildProvenBlock(t.index, timestamp, transactions, t.previousHash, t.difficulty, seed, who, nonceHex(n));
}

const nextStamp = (c: Blockchain) => {
  const times = c.getChain().slice(-P.medianTimeBlocks).map((b) => b.timestamp).sort((a, b) => a - b);
  return { median: times[Math.floor(times.length / 2)] };
};

function grown(n: number, who = honest.address): Blockchain {
  const c = new Blockchain(P, null);
  for (let i = 0; i < n; i++) assert.equal(c.addBlock(forge(c, Math.max(Date.now(), nextStamp(c).median + 1), who), "t").status, "added");
  return c;
}

test("Zeitstempel-Lügner: Zukunft, Vergangenheit und genau der Mittelwert werden abgelehnt", () => {
  const c = grown(12);
  const tip = c.tip.hash;
  const { median } = nextStamp(c);

  const future = c.addBlock(forge(c, Date.now() + 3 * 60_000), "evil");
  assert.equal(future.status, "invalid");
  assert.match((future as { reason: string }).reason, /future/);
  assert.equal(c.addBlock(forge(c, median), "evil").status, "invalid", "genau der Mittelwert ist zu alt");
  assert.equal(c.addBlock(forge(c, median - 60_000), "evil").status, "invalid", "vor dem Mittelwert ist zu alt");
  assert.equal(c.addBlock(forge(c, Number.MAX_SAFE_INTEGER), "evil").status, "invalid");
  assert.equal(c.tip.hash, tip, "Lügen dürfen die Kette nicht verändern");

  assert.equal(c.addBlock(forge(c, Date.now() + P.maxFutureMs - 5_000), "ok").status, "added");
});

test("Zeitstempel-Lügner: 2 Minuten Vorsprung verschieben die Schwierigkeit nur minimal", () => {
  const a = grown(12);
  const b = new Blockchain(P, null);
  for (const blk of a.getChain().slice(1)) assert.equal(b.addBlock(blk, "t").status, "added");

  assert.equal(a.addBlock(forge(a, Date.now()), "t").status, "added");
  assert.equal(b.addBlock(forge(b, Date.now() + P.maxFutureMs - 5_000), "t").status, "added");

  const dA = a.buildTemplate(honest.address).difficulty;
  const dB = b.buildTemplate(honest.address).difficulty;
  console.log(`Schwierigkeit ehrlich ${dA}, mit 115 s Vorsprung ${dB} (Einheit: 1/16 Bit)`);
  assert.ok(Math.abs(dA - dB) <= 2, `Unterschied ${Math.abs(dA - dB)} ist zu gross`);
});

test("Reorg-Bombe: lange Abzweigung mit einem kaputten Block mittendrin wechselt nichts", () => {
  const main = grown(30);
  const tip = main.tip.hash;

  const fork = new Blockchain(P, null);
  const blocks: Block[] = [];
  for (let i = 0; i < 27; i++) {
    const b = forge(fork, Math.max(Date.now(), nextStamp(fork).median + 1), attacker.address);
    fork.addBlock(b, "t");
    blocks.push(b);
  }
  blocks.push(forge(fork, Math.max(Date.now(), nextStamp(fork).median + 1), attacker.address, 1));

  const t0 = Date.now();
  const results = blocks.map((b) => main.addBlock(b, "evil").status);
  console.log(`Reorg-Bombe verarbeitet in ${Date.now() - t0} ms`);
  assert.equal(results[results.length - 1], "invalid");
  assert.equal(main.tip.hash, tip);
  assert.equal(main.height, 30);
  assert.equal(main.getBalance(attacker.address), 0, "Angreifer bekommt nichts");
});

test("Reorg: eine echt schwerere Abzweigung gewinnt, Geldmenge bleibt exakt", () => {
  const main = grown(10);
  const fork = new Blockchain(P, null);
  const blocks: Block[] = [];
  for (let i = 0; i < 14; i++) {
    const b = forge(fork, Math.max(Date.now(), nextStamp(fork).median + 1), attacker.address);
    fork.addBlock(b, "t");
    blocks.push(b);
  }
  for (const b of blocks) main.addBlock(b, "peer");
  assert.equal(main.tip.hash, fork.tip.hash);
  const supply = main.getSupplyInfo();
  assert.equal(supply.circulatingSupply, 14 * 210);
});

test("Orphan-Flut: tausende Blöcke ohne bekannten Vorgänger sprengen den Speicher nicht", () => {
  const c = grown(5);
  const other = new Blockchain({ ...P, retargetTauMs: 1e15 }, null);
  const spam: Block[] = [];
  for (let i = 0; i < 400; i++) {
    const b = forge(other, Math.max(Date.now(), nextStamp(other).median + 1), attacker.address);
    other.addBlock(b, "t");
    spam.push(b);
  }
  const tip = c.tip.hash;
  const t0 = Date.now();
  for (const b of spam.slice(1)) c.addBlock(b, "evil");
  console.log(`400 Orphans verarbeitet in ${Date.now() - t0} ms`);
  const pool = (c as unknown as { orphans: Map<string, Block[]> }).orphans;
  let held = 0;
  for (const list of pool.values()) held += list.length;
  assert.ok(held <= 200, `Orphan-Pool hält ${held} Blöcke`);
  assert.equal(c.tip.hash, tip);
});

after(() => setTimeout(() => process.exit(0), 50).unref());
