import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Blockchain } from "../src/blockchain.js";
import { calculateProofHash, hashMeetsDifficulty, type Block, nonceHex } from "../src/block.js";
import { MAINNET_PARAMS, UNITS_PER_COIN, type ConsensusParams } from "../src/params.js";
import { generateKeyPair } from "../src/wallet.js";

const P: ConsensusParams = { ...MAINNET_PARAMS, initialReward: 210 * UNITS_PER_COIN, initialDifficulty: 64, retargetTauMs: 1e15, coinbaseMaturity: 1 };
const alice = generateKeyPair();
const bob = generateKeyPair();

function mine(c: Blockchain, addr = alice.address): Block {
  const t = c.buildTemplate(addr);
  let n = 0;
  while (!hashMeetsDifficulty(calculateProofHash(t.seed, addr, nonceHex(n)), t.difficulty)) n++;
  const { result, block } = c.submitSolved(t, nonceHex(n));
  assert.equal(result.status, "added");
  return block;
}
const tmp = () => mkdtempSync(join(tmpdir(), "albus-st-"));

test("Storage: cold blocks are still readable, state survives restart", () => {
  const dir = tmp();
  try {
    const c = new Blockchain(P, dir, undefined, 5);
    for (let i = 0; i < 20; i++) mine(c);
    assert.equal(c.getBlock("2")?.transactions.length, 1);
    assert.equal(c.getChain().length, 21);
    assert.equal(c.getChainRange(3, 4).length, 4);
    const bal = c.getAccount(alice.address);
    const tip = c.tip.hash;
    const d = new Blockchain(P, dir, undefined, 5);
    assert.equal(d.tip.hash, tip);
    assert.deepEqual(d.getAccount(alice.address), bal);
    assert.equal(d.getBlock("2")?.transactions.length, 1);
    mine(d);
    const e = new Blockchain(P, dir, undefined, 5);
    assert.equal(e.height, 21);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Storage: reorg deeper than the hot window is refused, inside is fine", () => {
  const dir = tmp();
  try {
    const c = new Blockchain(P, dir, undefined, 3);
    for (let i = 0; i < 10; i++) mine(c);
    const side = new Blockchain(P, null);
    for (let i = 1; i <= 2; i++) side.addBlock(c.getBlock(String(i)) as Block);
    for (let i = 0; i < 12; i++) mine(side, bob.address);
    const before = c.tip.hash;
    for (let i = 3; i <= side.height; i++) c.addBlock(side.getBlock(String(i)) as Block);
    assert.equal(c.tip.hash, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Storage: indexes find transactions and follow a reorg", () => {
  const c = new Blockchain(P, null);
  mine(c);
  mine(c);
  const pay = c.buildTemplate(alice.address);
  assert.ok(pay);
  const hist = c.txsOfAddress(alice.address);
  assert.equal(hist.length, 2);
  assert.equal(hist[0].height, 2);
  const id = hist[0].tx.id;
  assert.equal(c.findTx(id)?.height, 2);
  const side = new Blockchain(P, null);
  side.addBlock(c.getBlock("1") as Block);
  for (let i = 0; i < 3; i++) mine(side, bob.address);
  for (let i = 2; i <= side.height; i++) c.addBlock(side.getBlock(String(i)) as Block);
  assert.equal(c.height, 4);
  assert.equal(c.findTx(id), undefined);
  assert.equal(c.txsOfAddress(alice.address).length, 1);
  assert.equal(c.txsOfAddress(bob.address).length, 3);
});

test("Storage: truncated last line is cut off, next block is appended cleanly", () => {
  const dir = tmp();
  try {
    const c = new Blockchain(P, dir);
    for (let i = 0; i < 4; i++) mine(c);
    const file = join(dir, "blocks.jsonl");
    const good = statSync(file).size;
    appendFileSync(file, '{"index":5,"hash":"abc');
    const d = new Blockchain(P, dir);
    assert.equal(d.height, 4);
    assert.equal(statSync(file).size, good);
    mine(d);
    const e = new Blockchain(P, dir);
    assert.equal(e.height, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Storage: complete last line without newline gets its newline back", () => {
  const dir = tmp();
  try {
    const c = new Blockchain(P, dir);
    for (let i = 0; i < 3; i++) mine(c);
    const file = join(dir, "blocks.jsonl");
    writeFileSync(file, readFileSync(file, "utf-8").trimEnd());
    const d = new Blockchain(P, dir);
    assert.equal(d.height, 3);
    mine(d);
    assert.equal(new Blockchain(P, dir).height, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Storage: after restart old blocks are cold and only the window keeps undo data", () => {
  const dir = tmp();
  try {
    const c = new Blockchain(P, dir, undefined, 4);
    for (let i = 0; i < 15; i++) mine(c);
    const d = new Blockchain(P, dir, undefined, 4);
    let cold = 0;
    let undo = 0;
    for (const e of (d as any).entries.values()) {
      if (e.cold) cold++;
      if (e.undo) undo++;
    }
    assert.equal(cold, 11);
    assert.equal(undo, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Storage: reorg inside the hot window works with cooling active", () => {
  const dir = tmp();
  try {
    const c = new Blockchain(P, dir, undefined, 3);
    for (let i = 0; i < 10; i++) mine(c);
    const side = new Blockchain(P, null);
    for (let i = 1; i <= 8; i++) side.addBlock(c.getBlock(String(i)) as Block);
    for (let i = 0; i < 4; i++) mine(side, bob.address);
    for (let i = 9; i <= side.height; i++) c.addBlock(side.getBlock(String(i)) as Block);
    assert.equal(c.tip.hash, side.tip.hash);
    const re = new Blockchain(P, dir, undefined, 3);
    assert.equal(re.height, c.height);
    const fresh = new Blockchain(P, null);
    for (const blk of c.getChain().slice(1)) assert.equal(fresh.addBlock(blk).status, "added");
    for (const who of [alice.address, bob.address]) {
      assert.deepEqual(re.getAccount(who), fresh.getAccount(who));
      assert.deepEqual(c.getAccount(who), fresh.getAccount(who));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Storage: a broken line in the middle stops loading instead of overwriting", () => {
  const dir = tmp();
  try {
    const c = new Blockchain(P, dir);
    for (let i = 0; i < 3; i++) mine(c);
    const file = join(dir, "blocks.jsonl");
    const lines = readFileSync(file, "utf-8").split("\n");
    lines[1] = "{kaputt";
    writeFileSync(file, lines.join("\n"));
    assert.throws(() => new Blockchain(P, dir), /broken|line/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
