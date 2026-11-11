import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils";
import { Blockchain } from "../src/blockchain.js";
import { calculateProofHash, nonceHex } from "../src/block.js";
import { MAINNET_PARAMS } from "../src/params.js";

test("Web-Miner-Formel (miner.worker.ts) stimmt mit calculateProofHash ueberein", () => {
  const seed = "ab".repeat(32);
  const address = "albus1" + "cd".repeat(20);
  const buf = concatBytes(sha256(concatBytes(hexToBytes(seed), hexToBytes(address.slice(6)))), new Uint8Array(8));
  const view = new DataView(buf.buffer, 32, 8);
  for (const nonce of [0, 1, 255, 4294967295, 4294967296, 2 ** 40 + 12345, Number.MAX_SAFE_INTEGER]) {
    view.setUint32(0, Math.floor(nonce / 4294967296));
    view.setUint32(4, nonce >>> 0);
    assert.equal(bytesToHex(sha256(buf)), calculateProofHash(seed, address, nonce.toString(16).padStart(16, "0")));
    assert.equal(nonce.toString(16).padStart(16, "0"), nonceHex(nonce));
  }
});

test("Old data directories (ruleset 3) are refused, the file stays unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "albus-r4-"));
  try {
    const old = {
      index: 1, timestamp: 1_800_000_000_000, transactions: [], previousHash: "0".repeat(64), nonce: "1f",
      difficulty: 64, hash: "0".repeat(64), seed: "ab".repeat(16), proofAddress: "albus1" + "cd".repeat(20),
    };
    const line = JSON.stringify(old) + "\n";
    writeFileSync(join(dir, "blocks.jsonl"), line);
    assert.throws(() => new Blockchain(MAINNET_PARAMS, dir), /rules of this version|ruleset/);
    assert.equal(readFileSync(join(dir, "blocks.jsonl"), "utf-8"), line);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
