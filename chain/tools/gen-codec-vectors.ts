import { writeFileSync } from "node:fs";
import { bytesToHex } from "@noble/hashes/utils";
import { sha256 } from "@noble/hashes/sha2";
import { encodeBlock, encodeTransaction } from "../src/codec.js";
import { buildProvenBlock, createGenesisBlock, transactionRoot } from "../src/block.js";
import { createCoinbaseTransaction, createTransaction } from "../src/transaction.js";
import { UNITS_PER_COIN } from "../src/params.js";

const priv = "0000000000000000000000000000000000000000000000000000000000000001";
const pub = "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";
const networkId = "ab".repeat(8);
const pay = createTransaction(priv, pub, "albus1" + "11".repeat(20), 5 * UNITS_PER_COIN, 100_000, 0, networkId, 1_700_000_000_000);
const cb = createCoinbaseTransaction("albus1" + "22".repeat(20), 10 * UNITS_PER_COIN, 3, 1_700_000_060_000);
const block = buildProvenBlock(3, 1_700_000_060_000, [cb, pay], "cd".repeat(32), 64, "ef".repeat(32), "albus1" + "22".repeat(20), "000000000000001f");
const genesis = createGenesisBlock();
const out = {
  note: "Feste Testvektoren fuer das Binaerformat (docs/BINARY_FORMAT.md), Regelwerk 4. Neu erzeugen mit: npx tsx chain/tools/gen-codec-vectors.ts",
  networkId,
  payment: { fields: pay, encoding: bytesToHex(encodeTransaction(pay)) },
  coinbase: { fields: cb, encoding: bytesToHex(encodeTransaction(cb)) },
  block: { fields: block, encoding: bytesToHex(encodeBlock(block)), transactionRoot: transactionRoot(block.transactions) },
  genesis: { fields: genesis, encoding: bytesToHex(encodeBlock(genesis)) },
};
writeFileSync(new URL("../../docs/vectors.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({
  txId: pay.id,
  txEncodingSha256: bytesToHex(sha256(encodeTransaction(pay))),
  txLen: encodeTransaction(pay).length,
  genesisHash: genesis.hash,
  genesisEncoding: out.genesis.encoding,
}, null, 1));
