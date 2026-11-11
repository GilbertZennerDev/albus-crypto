import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Blockchain } from "../src/blockchain.js";
import { buildProvenBlock, calculateProofHash, computeSeed, createGenesisBlock, hashMeetsDifficulty, nonceHex, type Block } from "../src/block.js";
import { decodeBlock, encodeBlock } from "../src/codec.js";
import { createCoinbaseTransaction, createInvitation, createTransaction, encodeInvitation, type Invitation } from "../src/transaction.js";
import { MAINNET_PARAMS, UNITS_PER_COIN, networkIdOf, paramsFromEnv, rewardUnits, type ConsensusParams } from "../src/params.js";
import { addressFromPublicKey, generateKeyPair, type KeyPair } from "../src/wallet.js";

const A = UNITS_PER_COIN;
const TEST: ConsensusParams = { ...MAINNET_PARAMS, initialReward: 10 * A, initialDifficulty: 64, retargetTauMs: 1e15, coinbaseMaturity: 1, referralBps: 1000 };
const NOREF: ConsensusParams = { ...TEST };
delete NOREF.referralBps;
const NET = new Blockchain(TEST, null).networkId;

const [newcomer, friend, other, third] = [generateKeyPair(), generateKeyPair(), generateKeyPair(), generateKeyPair()];
const invite = (me: KeyPair, by: string, net = NET): Invitation => createInvitation(me.privateKey, me.publicKey, by, net);

function grind(seed: string, address: string, difficulty: number): string {
  for (let n = 0; ; n++) {
    const nonce = nonceHex(n);
    if (hashMeetsDifficulty(calculateProofHash(seed, address, nonce), difficulty)) return nonce;
  }
}

function mine(chain: Blockchain, miner: KeyPair, inv?: Invitation): Block {
  const t = chain.buildTemplate(miner.address, inv && encodeInvitation(inv));
  const { result, block } = chain.submitSolved(t, grind(t.seed, miner.address, t.difficulty));
  assert.equal(result.status, "added", JSON.stringify(result));
  return block;
}

function craft(chain: Blockchain, address: string, inv: Invitation | undefined, parent: Block = chain.tip): Block {
  const index = parent.index + 1;
  const timestamp = parent.timestamp + 1000;
  const difficulty = chain.getNextDifficulty();
  const cb = createCoinbaseTransaction(address, rewardUnits(chain.params, index), index, timestamp, inv);
  const seed = computeSeed(parent.hash, index, timestamp, difficulty, [cb]);
  return buildProvenBlock(index, timestamp, [cb], parent.hash, difficulty, seed, address, grind(seed, address, difficulty));
}

const reason = (r: { status: string }) => (r as { reason?: string }).reason ?? "";
const everything = (c: Blockchain, who: KeyPair[]) => who.reduce((n, w) => n + c.getAccount(w.address).total, 0);
const inviterOf = (c: Blockchain, w: KeyPair) => c.buildTemplate(w.address, encodeInvitation(invite(w, third.address))).transactions[0].referrer;

test("Mainnet stays untouched: network id is pinned and has no referral", () => {
  const c = new Blockchain(MAINNET_PARAMS, null);
  assert.equal(c.networkId, "5612ab3f9ec5bebf");
  assert.equal("referralBps" in MAINNET_PARAMS, false);
  assert.equal(networkIdOf(paramsFromEnv({}), createGenesisBlock().hash), "5612ab3f9ec5bebf");
  assert.equal(networkIdOf(paramsFromEnv({ REFERRAL_BPS: "0" }), createGenesisBlock().hash), "5612ab3f9ec5bebf");
  assert.equal(networkIdOf(paramsFromEnv({ REFERRAL_BPS: "garbage" }), createGenesisBlock().hash), "5612ab3f9ec5bebf");
  assert.notEqual(networkIdOf(paramsFromEnv({ REFERRAL_BPS: "1000" }), createGenesisBlock().hash), "5612ab3f9ec5bebf");
});

test("A network without the rule ignores the wish and refuses handmade blocks with an inviter", () => {
  const c = new Blockchain(NOREF, null);
  mine(c, newcomer, invite(newcomer, friend.address, c.networkId));
  assert.equal(c.tip.transactions[0].referrer, undefined);
  const r = c.addBlock(craft(c, newcomer.address, invite(newcomer, friend.address, c.networkId)));
  assert.equal(r.status, "invalid");
  assert.match(reason(r), /referrer/);
});

test("The inviter gets exactly 10 % of the reward, the miner the rest", () => {
  const c = new Blockchain(TEST, null);
  mine(c, newcomer, invite(newcomer, friend.address));
  assert.equal(c.tip.transactions[0].referrer, friend.address);
  assert.equal(c.tip.transactions[0].amount, 10 * A);
  assert.deepEqual([c.getAccount(newcomer.address).immature, c.getAccount(friend.address).immature], [9 * A, 1 * A]);
  mine(c, other);
  assert.deepEqual([c.getBalance(newcomer.address), c.getBalance(friend.address)], [9 * A, 1 * A]);
});

test("Fees stay completely with the miner, only the reward is split", () => {
  const c = new Blockchain(TEST, null);
  mine(c, third);
  mine(c, other);
  const tx = createTransaction(third.privateKey, third.publicKey, friend.address, 1 * A, TEST.minFeeUnits, 0, c.networkId, Date.now());
  assert.deepEqual(c.submitTransaction(tx), { ok: true });
  mine(c, newcomer, invite(newcomer, friend.address));
  assert.equal(c.tip.transactions[0].amount, 10 * A + TEST.minFeeUnits);
  mine(c, other);
  assert.equal(c.getBalance(friend.address), 1 * A + 1 * A);
  assert.equal(c.getBalance(newcomer.address), 9 * A + TEST.minFeeUnits);
});

test("After the binding block, later blocks need no invitation and still pay the inviter", () => {
  const c = new Blockchain(TEST, null);
  mine(c, newcomer, invite(newcomer, friend.address));
  const second = mine(c, newcomer);
  assert.equal(second.transactions[0].referrer, undefined);
  mine(c, other);
  mine(c, other);
  assert.equal(c.getBalance(friend.address), 2 * A);
  assert.equal(c.getBalance(newcomer.address), 18 * A);
});

test("The inviter is written once: nobody can swap it, not even the miner", () => {
  const c = new Blockchain(TEST, null);
  mine(c, newcomer, invite(newcomer, friend.address));
  assert.equal(inviterOf(c, newcomer), undefined);
  const r = c.addBlock(craft(c, newcomer.address, invite(newcomer, other.address)));
  assert.equal(r.status, "invalid");
  assert.match(reason(r), /already has an inviter/);
  mine(c, newcomer);
  mine(c, other);
  mine(c, other);
  assert.equal(c.getBalance(friend.address), 2 * A);
});

test("Without an invitation nobody is bound; a miner can still add one later, once", () => {
  const c = new Blockchain(TEST, null);
  mine(c, other);
  assert.equal(c.getAccount(other.address).immature, 10 * A);
  mine(c, other, invite(other, friend.address));
  mine(c, third);
  mine(c, third);
  assert.equal(c.getBalance(friend.address), 1 * A);
  assert.equal(c.getBalance(other.address), 10 * A + 9 * A);
});

test("Nobody can be their own inviter", () => {
  const c = new Blockchain(TEST, null);
  assert.equal(c.buildTemplate(newcomer.address, encodeInvitation(invite(newcomer, newcomer.address))).transactions[0].referrer, undefined);
  const r = c.addBlock(craft(c, newcomer.address, invite(newcomer, newcomer.address)));
  assert.equal(r.status, "invalid");
});

test("Hijack attempts: a stranger cannot bind or rewrite somebody else's inviter", () => {
  const c = new Blockchain(TEST, null);
  const victim = generateKeyPair();
  const attacker = generateKeyPair();
  let r = c.addBlock(craft(c, victim.address, invite(attacker, attacker.address)));
  assert.equal(r.status, "invalid");
  const forged = { ...invite(attacker, attacker.address), key: victim.publicKey };
  r = c.addBlock(craft(c, victim.address, forged));
  assert.equal(r.status, "invalid");
  assert.equal(c.buildTemplate(victim.address, encodeInvitation(invite(attacker, attacker.address))).transactions[0].referrer, undefined);
  const real = invite(victim, friend.address);
  r = c.addBlock(craft(c, victim.address, { ...real, referrer: attacker.address }));
  assert.equal(r.status, "invalid");
  assert.equal(c.height, 0);
  r = c.addBlock(craft(c, victim.address, invite(victim, friend.address, "0".repeat(16))));
  assert.equal(r.status, "invalid");
  mine(c, victim);
  mine(c, victim, invite(victim, friend.address));
  assert.equal(c.getAccount(friend.address).immature, 1 * A);
});

test("Tampering: swapping the inviter after mining breaks the block", () => {
  const c = new Blockchain(TEST, null);
  const t = c.buildTemplate(newcomer.address, encodeInvitation(invite(newcomer, friend.address)));
  const nonce = grind(t.seed, newcomer.address, t.difficulty);
  const swapped = { ...t, transactions: [{ ...t.transactions[0], referrer: third.address }] };
  assert.equal(c.submitSolved(swapped, nonce).result.status, "invalid");
  const other2 = invite(newcomer, third.address);
  const cb = createCoinbaseTransaction(newcomer.address, 10 * A, t.index, t.timestamp, other2);
  const r = c.submitSolved({ ...t, transactions: [cb] }, nonce).result;
  assert.equal(r.status, "invalid");
  assert.match(reason(r), /seed/);
  const bare = createCoinbaseTransaction(newcomer.address, 10 * A, t.index, t.timestamp);
  assert.equal(c.submitSolved({ ...t, transactions: [bare] }, nonce).result.status, "invalid");
  assert.equal(c.height, 0);
  assert.equal(c.submitSolved(t, nonce).result.status, "added");
});

test("Broken fields are refused, never crash", () => {
  const c = new Blockchain(TEST, null);
  const good = invite(newcomer, friend.address);
  const bad: unknown[] = [
    [friend.address],
    { toString: () => friend.address },
    12,
    "albus1" + "0".repeat(40),
    friend.address.toUpperCase(),
  ];
  for (const v of bad) {
    const b = craft(c, newcomer.address, good);
    const cb = { ...b.transactions[0], referrer: v } as never;
    assert.equal(c.addBlock({ ...b, transactions: [cb] }).status, "invalid");
    const cb2 = { ...b.transactions[0], referrerKey: v } as never;
    assert.equal(c.addBlock({ ...b, transactions: [cb2] }).status, "invalid");
    const cb3 = { ...b.transactions[0], referrerSig: v } as never;
    assert.equal(c.addBlock({ ...b, transactions: [cb3] }).status, "invalid");
  }
  const b = craft(c, newcomer.address, good);
  const half = { ...b.transactions[0], referrerSig: undefined } as never;
  assert.equal(c.addBlock({ ...b, transactions: [half] }).status, "invalid");
  assert.equal(c.height, 0);
});

test("Binary format: blocks with an inviter survive encode/decode, old blocks stay the same", () => {
  const c = new Blockchain(TEST, null);
  const withRef = mine(c, newcomer, invite(newcomer, friend.address));
  const without = mine(c, other);
  const back = decodeBlock(encodeBlock(withRef), addressFromPublicKey);
  assert.deepEqual(back, withRef);
  assert.equal(encodeBlock(withRef).length, encodeBlock(without).length + 20 + 33 + 64);
  assert.deepEqual(decodeBlock(encodeBlock(without), addressFromPublicKey), without);
});

test("Sybil attack: a ring of fake friends earns exactly as much as without any invitation", () => {
  const ring = Array.from({ length: 5 }, generateKeyPair);
  const blocks = 20;
  const withRing = new Blockchain(TEST, null);
  for (let i = 0; i < blocks; i++) {
    const me = ring[i % 5];
    mine(withRing, me, i < 5 ? invite(me, ring[(i + 1) % 5].address) : undefined);
  }
  const plain = new Blockchain(NOREF, null);
  for (let i = 0; i < blocks; i++) mine(plain, ring[i % 5]);
  mine(withRing, other);
  mine(plain, other);
  assert.equal(everything(withRing, ring), blocks * 10 * A);
  assert.equal(everything(plain, ring), blocks * 10 * A);
  assert.equal(withRing.getAccount(other.address).immature, 10 * A);
});

test("Nothing is created from nothing: all money = rewards, also during maturity", () => {
  const c = new Blockchain(TEST, null);
  const all = [newcomer, friend, other, third];
  const plan: [KeyPair, KeyPair | undefined][] = [[newcomer, friend], [friend, other], [other, undefined], [third, newcomer], [newcomer, undefined], [friend, undefined], [third, undefined]];
  plan.forEach(([m, r], i) => {
    mine(c, m, r && invite(m, r.address));
    assert.equal(everything(c, all), (i + 1) * 10 * A);
  });
});

test("Reorg: undo and replay give the same ledger as a fresh start, binding included", () => {
  const a = new Blockchain(TEST, null);
  mine(a, newcomer, invite(newcomer, friend.address));
  mine(a, newcomer);
  mine(a, other);
  assert.equal(a.getAccount(friend.address).total, 2 * A);

  const b = new Blockchain(TEST, null);
  mine(b, newcomer, invite(newcomer, other.address));
  mine(b, third);
  mine(b, newcomer);
  mine(b, third);
  mine(b, other);
  for (let h = 1; h <= b.height; h++) {
    const r = a.addBlock(b.getBlock(String(h)) as Block, "peer");
    assert.notEqual(r.status, "invalid", JSON.stringify(r));
  }
  assert.equal(a.tip.hash, b.tip.hash);

  const fresh = new Blockchain(TEST, null);
  for (let h = 1; h <= b.height; h++) assert.equal(fresh.addBlock(b.getBlock(String(h)) as Block, "peer").status, "added");
  for (const w of [newcomer, friend, other, third]) assert.deepEqual(a.getAccount(w.address), fresh.getAccount(w.address));
  assert.equal(a.getAccount(friend.address).total, 0);
  assert.equal(inviterOf(a, newcomer), undefined);
  assert.equal(inviterOf(fresh, newcomer), undefined);

  const c = new Blockchain(TEST, null);
  for (let i = 0; i < 7; i++) mine(c, third);
  for (let h = 1; h <= c.height; h++) a.addBlock(c.getBlock(String(h)) as Block, "peer");
  assert.equal(a.tip.hash, c.tip.hash);
  assert.equal(inviterOf(a, newcomer), third.address);
  assert.deepEqual(a.getAccount(third.address), c.getAccount(third.address));
  assert.equal(everything(a, [newcomer, friend, other]), 0);
});

test("Restart: the node rebuilds bindings and splits from its files, also from cold blocks", () => {
  const dir = mkdtempSync(join(tmpdir(), "albus-ref-"));
  try {
    const a = new Blockchain(TEST, dir, undefined, 3);
    mine(a, newcomer, invite(newcomer, friend.address));
    for (let i = 0; i < 6; i++) mine(a, i % 2 ? other : newcomer);
    const before = [newcomer, friend, other].map((w) => a.getAccount(w.address));
    const cold = a.getBlock("1") as Block;
    assert.equal(cold.transactions[0].referrer, friend.address);
    const b = new Blockchain(TEST, dir, undefined, 3);
    assert.equal(b.tip.hash, a.tip.hash);
    assert.deepEqual([newcomer, friend, other].map((w) => b.getAccount(w.address)), before);
    assert.equal(inviterOf(b, newcomer), undefined);
    mine(b, newcomer);
    assert.equal(b.tip.transactions[0].referrer, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("The inviter can spend the share in the very block that releases it", () => {
  const c = new Blockchain(TEST, null);
  mine(c, newcomer, invite(newcomer, friend.address));
  const tx = createTransaction(friend.privateKey, friend.publicKey, other.address, 1 * A - TEST.minFeeUnits - 1, TEST.minFeeUnits, 0, c.networkId, Date.now());
  assert.deepEqual(c.submitTransaction(tx), { ok: true });
  mine(c, third);
  assert.equal(c.getBalance(other.address), 1 * A - TEST.minFeeUnits - 1);
});

after(() => setTimeout(() => process.exit(0), 50).unref());
