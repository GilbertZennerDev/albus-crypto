import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { UNITS_PER_COIN } from "./params.js";
import { createTransaction, type Transaction } from "./transaction.js";
import { addressFromPublicKey } from "./wallet.js";

export interface Rule {
  to: string;
  percent: number;
}

export interface ShareState {
  baseline: number | null;
}

export interface ShareApi {
  networkId(): Promise<string>;
  account(address: string): Promise<{ spendable: number; nextNonce: number; minFee: number }>;
  pending(address: string): Promise<Transaction[]>;
  submit(tx: Transaction): Promise<{ ok: boolean; error?: string }>;
}

export interface ShareOptions {
  minShareUnits: number;
  includeExisting: boolean;
}

export function parseRules(text: string): Rule[] {
  const rules = text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [to, pct] = s.split(":");
      const percent = Number(pct);
      if (!/^albus1[0-9a-f]{40}$/.test(to ?? "")) throw new Error(`Ungültige Adresse: ${to}`);
      if (!Number.isFinite(percent) || percent <= 0 || percent > 100) throw new Error(`Ungültiger Prozentwert bei ${to}: ${pct}`);
      return { to, percent };
    });
  if (rules.length === 0) throw new Error("Keine Regel angegeben, Beispiel: albus1abc...:50");
  if (new Set(rules.map((r) => r.to)).size !== rules.length) throw new Error("Eine Adresse kommt doppelt vor");
  if (rules.reduce((a, r) => a + r.percent, 0) > 100) throw new Error("Die Prozente ergeben zusammen mehr als 100");
  return rules;
}

export interface ShareResult {
  sent: { to: string; amount: number; id: string }[];
  note: string;
}

export async function runOnce(
  api: ShareApi,
  keys: { privateKey: string; publicKey: string },
  rules: Rule[],
  state: ShareState,
  opts: ShareOptions,
): Promise<ShareResult> {
  const me = addressFromPublicKey(keys.publicKey);
  if (rules.some((r) => r.to === me)) throw new Error("Man kann nicht mit sich selbst teilen");
  const [networkId, acct, pending] = await Promise.all([api.networkId(), api.account(me), api.pending(me)]);
  const reserved = pending.reduce((a, t) => a + t.amount + t.fee, 0);
  const effective = acct.spendable - reserved;

  if (state.baseline === null) state.baseline = opts.includeExisting ? 0 : effective;
  if (effective < state.baseline) state.baseline = effective;
  const income = effective - state.baseline;
  if (income <= 0) return { sent: [], note: "keine neuen Einnahmen" };

  const planned = rules
    .map((r) => ({ to: r.to, share: Math.floor((income * r.percent) / 100) }))
    .filter((p) => p.share >= Math.max(opts.minShareUnits, 2 * acct.minFee))
    .map((p) => ({ to: p.to, share: p.share, amount: p.share - acct.minFee }));
  const total = planned.reduce((a, p) => a + p.share, 0);
  if (planned.length === 0) return { sent: [], note: "Anteile noch zu klein, sammle weiter" };
  if (total > effective) return { sent: [], note: "Guthaben reicht nicht für Anteile plus Gebühren" };

  const sent: ShareResult["sent"] = [];
  let nonce = acct.nextNonce;
  let spent = 0;
  for (const p of planned) {
    const tx = createTransaction(keys.privateKey, keys.publicKey, p.to, p.amount, acct.minFee, nonce, networkId);
    const r = await api.submit(tx);
    if (!r.ok) {
      state.baseline = effective - spent;
      return { sent, note: `Senden fehlgeschlagen: ${r.error}` };
    }
    sent.push({ to: p.to, amount: p.amount, id: tx.id });
    nonce++;
    spent += p.share;
  }
  state.baseline = effective - spent;
  return { sent, note: `${sent.length} Überweisung(en) gesendet` };
}

export function httpApi(base: string): ShareApi {
  const url = base.replace(/\/+$/, "");
  const get = async (path: string) => {
    const r = await fetch(url + path);
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json() as Promise<any>;
  };
  return {
    networkId: async () => (await get("/info")).networkId,
    account: async (a) => get(`/account/${a}`),
    pending: async (a) => (((await get("/mempool")) as { transactions: Transaction[] }).transactions ?? []).filter((t) => t.fromAddress === a),
    submit: async (tx) => {
      const r = await fetch(url + "/transactions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(tx) });
      return r.ok ? { ok: true } : { ok: false, error: ((await r.json().catch(() => ({}))) as any).error ?? `HTTP ${r.status}` };
    },
  };
}

export function readKey(file: string): { privateKey: string; publicKey: string } {
  const raw = readFileSync(file, "utf8").trim();
  let key = raw;
  try {
    key = (JSON.parse(raw) as { privateKey: string }).privateKey;
  } catch {
  }
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error("Schlüsseldatei: erwarte 64 Hex-Zeichen oder die Ausgabe von new-wallet");
  return { privateKey: key.toLowerCase(), publicKey: bytesToHex(secp256k1.getPublicKey(hexToBytes(key), true)) };
}

async function main() {
  const keyFile = process.env.ALBUS_KEY_FILE;
  const rulesText = process.env.SHARE;
  if (!keyFile || !rulesText) {
    console.log("Aufruf (PowerShell):\n  $env:ALBUS_KEY_FILE = 'wallet.json'\n  $env:SHARE = 'albus1...:50'   # mehrere mit Komma, Prozent nach dem Doppelpunkt\n  npx tsx src/auto-share.ts [--once] [--include-existing]\nWeitere: ALBUS_API (Standard http://127.0.0.1:4000), SHARE_INTERVAL_S (Standard 60), SHARE_MIN_COINS (Standard 0.01)");
    process.exit(1);
  }
  const keys = readKey(keyFile);
  const rules = parseRules(rulesText);
  const api = httpApi(process.env.ALBUS_API ?? "http://127.0.0.1:4000");
  const stateFile = process.env.SHARE_STATE ?? keyFile + ".share-state.json";
  const state: ShareState = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { baseline: null };
  const opts: ShareOptions = { minShareUnits: Math.round(Number(process.env.SHARE_MIN_COINS ?? "0.01") * UNITS_PER_COIN), includeExisting: process.argv.includes("--include-existing") };
  const once = process.argv.includes("--once");
  const interval = Math.max(10, Number(process.env.SHARE_INTERVAL_S ?? "60")) * 1000;
  console.log(`Teile von ${addressFromPublicKey(keys.publicKey)}: ${rules.map((r) => `${r.percent}% an ${r.to}`).join(", ")}`);
  for (;;) {
    try {
      const r = await runOnce(api, keys, rules, state, opts);
      writeFileSync(stateFile, JSON.stringify(state));
      console.log(`${new Date().toISOString()}  ${r.note}`);
      for (const s of r.sent) console.log(`  ${s.amount / UNITS_PER_COIN} ALB an ${s.to} (${s.id.slice(0, 12)}...)`);
    } catch (e) {
      console.log(`${new Date().toISOString()}  Fehler: ${(e as Error).message}`);
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, interval));
  }
}

if (process.argv[1] && /auto-share\.(ts|js)$/.test(process.argv[1])) void main();
