import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { Blockchain } from "../src/blockchain.js";
import { calculateProofHash, createGenesisBlock, transactionRoot, hashMeetsDifficulty, type Block, nonceHex } from "../src/block.js";
import { decodeBlock, decodeTransaction, encodeBlock, encodeTransaction } from "../src/codec.js";
import { MAINNET_PARAMS, UNITS_PER_COIN, type ConsensusParams } from "../src/params.js";
import { createTransaction } from "../src/transaction.js";
import { addressFromPublicKey, generateKeyPair } from "../src/wallet.js";

const P: ConsensusParams = { ...MAINNET_PARAMS, initialReward: 210 * UNITS_PER_COIN, initialDifficulty: 64, retargetTauMs: 1e15, coinbaseMaturity: 1 };
const alice = generateKeyPair();
const bob = generateKeyPair();

function mine(c: Blockchain, addr: string, txs = true): Block {
  const t = c.buildTemplate(addr);
  let n = 0;
  while (!hashMeetsDifficulty(calculateProofHash(t.seed, addr, nonceHex(n)), t.difficulty)) n++;
  const { result, block } = c.submitSolved(t, nonceHex(n));
  assert.equal(result.status, "added");
  return block;
}

function sampleChain(): Blockchain {
  const c = new Blockchain(P, null);
  mine(c, alice.address);
  mine(c, bob.address);
  const tx = createTransaction(alice.privateKey, alice.publicKey, bob.address, 5 * UNITS_PER_COIN, 100_000, 0, c.networkId);
  assert.equal(c.submitTransaction(tx).ok, true);
  mine(c, alice.address);
  return c;
}

test("Codec: blocks and transactions survive a round trip unchanged (incl. genesis)", () => {
  const c = sampleChain();
  for (const b of c.getChain()) {
    const back = decodeBlock(encodeBlock(b), addressFromPublicKey);
    assert.deepEqual(back, b);
  }
  const withTx = c.getChain().find((b) => b.transactions.length > 1) as Block;
  const tx = withTx.transactions[1];
  assert.deepEqual(decodeTransaction(encodeTransaction(tx), addressFromPublicKey), tx);
  assert.deepEqual(decodeBlock(encodeBlock(createGenesisBlock()), addressFromPublicKey), createGenesisBlock());
});

test("Codec: strict decoder refuses extra bytes, truncation, bad kinds and oversized numbers", () => {
  const c = sampleChain();
  const b = c.getChain()[3];
  const enc = encodeBlock(b);
  assert.throws(() => decodeBlock(Uint8Array.from([...enc, 0]), addressFromPublicKey), /trailing bytes/);
  for (const cut of [1, 5, enc.length - 1]) assert.throws(() => decodeBlock(enc.slice(0, cut), addressFromPublicKey), /short|length|wrong/);
  const tx = c.getChain().find((x) => x.transactions.length > 1)!.transactions[1];
  const t = encodeTransaction(tx);
  const badKind = Uint8Array.from(t);
  badKind[0] = 2;
  assert.throws(() => decodeTransaction(badKind, addressFromPublicKey), /transaction kind/);
  const big = Uint8Array.from(t);
  big.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 1 + 32 + 20);
  assert.throws(() => decodeTransaction(big, addressFromPublicKey), /large/);
  assert.throws(() => encodeTransaction({ ...tx, amount: 1.5 }), /u64/);
  assert.throws(() => encodeTransaction({ ...tx, id: tx.id.toUpperCase() }), /hex/);
});

test("Codec: binary form is clearly smaller than JSON", () => {
  const c = sampleChain();
  const b = c.getChain().find((x) => x.transactions.length > 1) as Block;
  const bin = encodeBlock(b).length;
  const json = Buffer.byteLength(JSON.stringify(b));
  console.log(`Block mit 2 Transaktionen: Binaer ${bin} B, JSON ${json} B`);
  assert.ok(bin < json * 0.6);
});

test("Codec: golden vectors are fixed (second implementations must match them)", () => {
  const priv = "0000000000000000000000000000000000000000000000000000000000000001";
  const pub = "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";
  const to = "albus1" + "11".repeat(20);
  const tx = createTransaction(priv, pub, to, 5 * UNITS_PER_COIN, 100_000, 0, "ab".repeat(8), 1_700_000_000_000);
  const hex = bytesToHex(encodeTransaction(tx));
  const g = bytesToHex(encodeBlock(createGenesisBlock()));
  const vec = {
    txId: tx.id,
    txEncodingSha256: bytesToHex(sha256(encodeTransaction(tx))),
    genesisEncoding: g,
    genesisHash: createGenesisBlock().hash,
  };
  assert.equal(vec.txId, "e37cab034af8ea1f870d7d4818c08b8406a6a1a81ddd96b7f71f1ca6ba17c772");
  assert.equal(vec.txEncodingSha256, "0b8e4efc7da6fb2970d577df6d847e657b5e09e73e98d8e73240f1bb2acce4e2");
  assert.equal(hex.length / 2, 216);
  assert.equal(vec.genesisHash, "8284122e12e14b1e6faf32973ef6edf86450d8956018dca74e2e5f4516d0ea36");
  assert.equal(
    vec.genesisEncoding,
    "00000000000001a1a9015800000000000000000000000000000000000000000000000000000000000000000000008284122e12e14b1e6faf32973ef6edf86450d8956018dca74e2e5f4516d0ea36000000000000000000000000",
  );
  assert.equal(decodeTransaction(Uint8Array.from(Buffer.from(hex, "hex")), addressFromPublicKey).id, tx.id);
  assert.equal(tx.signature, createTransaction(priv, pub, to, 5 * UNITS_PER_COIN, 100_000, 0, "ab".repeat(8), 1_700_000_000_000).signature);
});

const vectors = JSON.parse(readFileSync(new URL("../../docs/vectors.json", import.meta.url), "utf-8"));
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

test("Codec: vectors file (payment, coinbase, block with both, genesis) decodes and re-encodes to the same bytes", () => {
  for (const k of ["payment", "coinbase"] as const) {
    const tx = decodeTransaction(unhex(vectors[k].encoding), addressFromPublicKey);
    assert.deepEqual(tx, vectors[k].fields);
    assert.equal(bytesToHex(encodeTransaction(vectors[k].fields)), vectors[k].encoding);
  }
  const b = decodeBlock(unhex(vectors.block.encoding), addressFromPublicKey);
  assert.deepEqual(b, vectors.block.fields);
  assert.equal(bytesToHex(encodeBlock(vectors.block.fields)), vectors.block.encoding);
  assert.equal(transactionRoot(b.transactions), vectors.block.transactionRoot);
  assert.equal(bytesToHex(encodeBlock(vectors.genesis.fields)), vectors.genesis.encoding);
});

test("Codec: mutated encodings are either refused or encode back to exactly the same bytes", () => {
  let seed = 12345;
  const rnd = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed % n;
  };
  const originals = [vectors.block.encoding, vectors.payment.encoding, vectors.genesis.encoding].map(unhex);
  let accepted = 0;
  let refused = 0;
  for (let i = 0; i < 20000; i++) {
    const src = originals[i % 3];
    const x = Uint8Array.from(src);
    const flips = 1 + rnd(3);
    for (let f = 0; f < flips; f++) x[rnd(x.length)] ^= 1 << rnd(8);
    const m = rnd(8) === 0 ? x.slice(0, rnd(x.length)) : x;
    const isTx = i % 3 === 1;
    try {
      const again = isTx ? encodeTransaction(decodeTransaction(m, addressFromPublicKey)) : encodeBlock(decodeBlock(m, addressFromPublicKey));
      assert.equal(bytesToHex(again), bytesToHex(m), "Decoder hat eine zweite Darstellung akzeptiert");
      accepted++;
    } catch (e) {
      assert.ok(e instanceof Error && !(e instanceof assert.AssertionError), String(e));
      refused++;
    }
  }
  console.log(`Mutationstest: ${accepted} akzeptiert (gleiche Bytes), ${refused} abgelehnt`);
  assert.ok(refused > 0);
});
