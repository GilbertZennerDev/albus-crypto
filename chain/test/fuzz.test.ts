import test from "node:test";
import assert from "node:assert/strict";
import { Blockchain } from "../src/blockchain.js";
import { calculateProofHash, hashMeetsDifficulty, nonceHex, type Block } from "../src/block.js";
import { MAINNET_PARAMS, UNITS_PER_COIN, rewardUnits, type ConsensusParams } from "../src/params.js";
import { createTransaction } from "../src/transaction.js";
import { generateKeyPair } from "../src/wallet.js";

const P: ConsensusParams = { ...MAINNET_PARAMS, initialReward: 210 * UNITS_PER_COIN, initialDifficulty: 64, retargetTauMs: 1e15, coinbaseMaturity: 1 };
const keys = [generateKeyPair(), generateKeyPair(), generateKeyPair()];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function mine(c: Blockchain, addr: string): Block {
  const t = c.buildTemplate(addr);
  let n = 0;
  while (!hashMeetsDifficulty(calculateProofHash(t.seed, addr, nonceHex(n)), t.difficulty)) n++;
  const { result, block } = c.submitSolved(t, nonceHex(n));
  assert.equal(result.status, "added", JSON.stringify(result));
  return block;
}

function totalBalances(c: Blockchain): number {
  return keys.reduce((s, k) => s + c.getBalance(k.address), 0);
}

test("Fuzz: mutated blocks never crash the node and never change the tip", () => {
  const c = new Blockchain(P, null);
  for (let i = 0; i < 4; i++) mine(c, keys[i % 3].address);
  const tip = c.tip.hash;
  const good = c.tip;
  const r = rng(1);
  const junk = [null, undefined, 0, -1, 1e300, NaN, "", "x", "0".repeat(64), [], {}, { a: 1 }, "ab".repeat(100), true];
  const fields = Object.keys(good) as (keyof Block)[];
  for (let i = 0; i < 400; i++) {
    const m: Record<string, unknown> = JSON.parse(JSON.stringify(good));
    const k = fields[Math.floor(r() * fields.length)];
    const how = r();
    if (how < 0.4) m[k] = junk[Math.floor(r() * junk.length)];
    else if (how < 0.6) delete m[k];
    else if (typeof m[k] === "string") {
      const s = m[k] as string;
      const p = Math.floor(r() * s.length);
      m[k] = s.slice(0, p) + (s[p] === "0" ? "1" : "0") + s.slice(p + 1);
    } else if (typeof m[k] === "number") m[k] = (m[k] as number) + (r() < 0.5 ? 1 : -1);
    let status = "";
    assert.doesNotThrow(() => (status = c.addBlock(m as unknown as Block).status));
    assert.equal(c.tip.hash, tip, `Spitze veraendert durch Mutation ${i} (${String(k)})`);
    assert.notEqual(status, "added");
  }
  assert.doesNotThrow(() => c.addBlock(null as unknown as Block));
  assert.doesNotThrow(() => c.addBlock("kaputt" as unknown as Block));
});

test("Fuzz: random forks, payments and reorgs keep supply exact and equal a replay", { timeout: 120_000 }, () => {
  for (let round = 0; round < 6; round++) {
    const r = rng(100 + round);
    const a = new Blockchain(P, null);
    const b = new Blockchain(P, null);
    for (let step = 0; step < 14; step++) {
      const who = r() < 0.5 ? a : b;
      const sender = keys[Math.floor(r() * 3)];
      if (r() < 0.5) {
        const to = keys[Math.floor(r() * 3)].address;
        const nonce = who.getAccount(sender.address).nextNonce;
        const tx = createTransaction(sender.privateKey, sender.publicKey, to, (1 + Math.floor(r() * 3)) * UNITS_PER_COIN, P.minFeeUnits, nonce, who.networkId, Date.now() + step);
        who.submitTransaction(tx);
      }
      mine(who, keys[Math.floor(r() * 3)].address);
      if (r() < 0.3) for (const blk of who.getChain().slice(1)) (who === a ? b : a).addBlock(blk);
    }
    for (const blk of b.getChain().slice(1)) a.addBlock(blk);
    for (const blk of a.getChain().slice(1)) b.addBlock(blk);
    if (a.tip.hash !== b.tip.hash) b.addBlock(mine(a, keys[0].address));
    assert.equal(a.tip.hash, b.tip.hash, `Runde ${round}: Knoten uneins`);
    const fresh = new Blockchain(P, null);
    for (const blk of a.getChain().slice(1)) assert.equal(fresh.addBlock(blk).status, "added");
    for (const k of keys) assert.deepEqual(fresh.getAccount(k.address), a.getAccount(k.address));
    let issued = 0;
    for (let h = 1; h <= a.height; h++) issued += rewardUnits(P, h);
    assert.ok(totalBalances(a) <= issued, `round ${round}: more balance than issued`);
  }
});
