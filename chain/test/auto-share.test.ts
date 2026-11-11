import test, { after } from "node:test";
import assert from "node:assert/strict";
import { Blockchain } from "../src/blockchain.js";
import { calculateProofHash, hashMeetsDifficulty, nonceHex } from "../src/block.js";
import { MAINNET_PARAMS, UNITS_PER_COIN, type ConsensusParams } from "../src/params.js";
import { generateKeyPair } from "../src/wallet.js";
import { parseRules, runOnce, type ShareApi, type ShareState } from "../src/auto-share.js";

const P: ConsensusParams = { ...MAINNET_PARAMS, initialReward: 10 * UNITS_PER_COIN, initialDifficulty: 64, retargetTauMs: 1e15, coinbaseMaturity: 1 };
const me = generateKeyPair();
const she = generateKeyPair();
const third = generateKeyPair();
const opts = { minShareUnits: 0, includeExisting: false };

function mine(chain: Blockchain, to = me.address) {
  const t = chain.buildTemplate(to);
  let n = 0;
  while (!hashMeetsDifficulty(calculateProofHash(t.seed, to, nonceHex(n)), t.difficulty)) n++;
  assert.equal(chain.submitSolved(t, nonceHex(n)).result.status, "added");
}

const apiOf = (c: Blockchain): ShareApi => ({
  networkId: async () => c.networkId,
  account: async (a) => ({ ...c.getAccount(a), minFee: c.params.minFeeUnits }),
  pending: async (a) => c.getMempool().filter((t) => t.fromAddress === a),
  submit: async (tx) => {
    const r = c.submitTransaction(tx);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },
});

test("Regeln werden geprüft", () => {
  assert.throws(() => parseRules(""), /Keine Regel/);
  assert.throws(() => parseRules("nope:50"), /Adresse/);
  assert.throws(() => parseRules(`${she.address}:0`), /Prozent/);
  assert.throws(() => parseRules(`${she.address}:60,${third.address}:50`), /mehr als 100/);
  assert.throws(() => parseRules(`${she.address}:10,${she.address}:20`), /doppelt/);
  assert.equal(parseRules(`${she.address}:50, ${third.address}:25`).length, 2);
});

test("Auto-Teilen: nur neue Einnahmen, nichts doppelt, mit Fee", async () => {
  const c = new Blockchain(P, null);
  const api = apiOf(c);
  const state: ShareState = { baseline: null };
  const rules = parseRules(`${she.address}:50`);
  const fee = P.minFeeUnits;

  mine(c); mine(c);
  const first = await runOnce(api, me, rules, state, opts);
  assert.equal(first.sent.length, 0, "vorhandenes Guthaben wird nicht geteilt");

  mine(c);
  const r = await runOnce(api, me, rules, state, opts);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].amount, 5 * UNITS_PER_COIN - P.minFeeUnits, "Gebühr steckt im Anteil");

  const again = await runOnce(api, me, rules, state, opts);
  assert.equal(again.sent.length, 0, "wartende Überweisung darf nicht nochmal geteilt werden");

  mine(c);
  assert.equal(c.getBalance(she.address), 5 * UNITS_PER_COIN - fee);
  const afterConfirm = await runOnce(api, me, rules, state, opts);
  assert.equal(afterConfirm.sent.length, 1);
  assert.ok(Math.abs(afterConfirm.sent[0].amount - 5 * UNITS_PER_COIN) <= 2 * fee);
});

test("Auto-Teilen: mehrere Empfänger, kleine Beträge sammeln sich, Selbstausgabe senkt die Basis", async () => {
  const c = new Blockchain(P, null);
  const api = apiOf(c);
  const state: ShareState = { baseline: null };
  mine(c); mine(c);
  const rules = parseRules(`${she.address}:50,${third.address}:25`);
  await runOnce(api, me, rules, state, { minShareUnits: 0, includeExisting: false });
  mine(c);
  const r = await runOnce(api, me, rules, state, { minShareUnits: 0, includeExisting: false });
  assert.deepEqual(r.sent.map((s) => s.amount), [5 * UNITS_PER_COIN - P.minFeeUnits, 2.5 * UNITS_PER_COIN - P.minFeeUnits]);

  const big = { minShareUnits: 100 * UNITS_PER_COIN, includeExisting: false };
  mine(c);
  const small = await runOnce(api, me, rules, state, big);
  assert.equal(small.sent.length, 0);
  assert.match(small.note, /zu klein/);

  const st2: ShareState = { baseline: 10_000 * UNITS_PER_COIN };
  const low = await runOnce(api, me, rules, st2, opts);
  assert.equal(low.sent.length, 0);
  assert.ok(st2.baseline! < 10_000 * UNITS_PER_COIN, "Basis wurde nach unten gezogen");

  await assert.rejects(runOnce(api, me, parseRules(`${me.address}:10`), { baseline: 0 }, opts), /mit sich selbst/);
});

after(() => setTimeout(() => process.exit(0), 50).unref());
