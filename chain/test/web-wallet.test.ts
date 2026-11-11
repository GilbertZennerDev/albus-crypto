import test from "node:test";
import assert from "node:assert/strict";
import { Blockchain } from "../src/blockchain.js";
import { MAINNET_PARAMS, parseCoins as chainParse } from "../src/params.js";
import { generateKeyPair } from "../src/wallet.js";
import { calculateProofHash, hashMeetsDifficulty , nonceHex } from "../src/block.js";
import { createSignedTransaction, formatUnits, keyPairFromPrivateKey, parseCoins } from "../../web/src/lib/wallet.js";

test("Web wallet: signed transaction is accepted by the chain, text parsing matches", () => {
  const P = { ...MAINNET_PARAMS, initialDifficulty: 64, retargetTauMs: 1e15, coinbaseMaturity: 1 };
  const c = new Blockchain(P, null);
  const me = generateKeyPair();
  const w = keyPairFromPrivateKey(me.privateKey);
  assert.equal(w.address, me.address);
  const t = c.buildTemplate(me.address);
  let n = 0;
  while (!hashMeetsDifficulty(calculateProofHash(t.seed, me.address, nonceHex(n)), t.difficulty)) n++;
  assert.equal(c.submitSolved(t, nonceHex(n)).result.status, "added");
  const other = generateKeyPair();
  const tx = createSignedTransaction(w, other.address, parseCoins("1.5") as number, P.minFeeUnits, c.getAccount(me.address).nextNonce, c.networkId);
  const sr = c.submitTransaction(tx);
  assert.equal(sr.ok, true, JSON.stringify(sr));
  for (const s of ["0.1", "12.34567891", "7", "0.00000001"]) {
    assert.equal(parseCoins(s), chainParse(s));
    assert.equal(formatUnits(parseCoins(s) as number), s);
  }
});
