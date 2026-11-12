import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { readKey } from "../auto-share.js";
import { createInvitation, encodeInvitation, ADDRESS_RE } from "../transaction.js";
import { addressFromPublicKey, generateKeyPair } from "../wallet.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { loadFriends, saveFriends, validateFriends, FriendsError } from "./friends.js";
import { loadSettings, saveSettings } from "./settings.js";
import { APP_CSS, APP_JS, indexHtml } from "./page.js";

export interface UpdateHooks {
  check(): Promise<{ available: boolean; version?: string; notes?: string; error?: string }>;
  apply(): Promise<{ ok: boolean; message: string }>;
  last?(): string | null;
}

export interface UiConfig {
  home: string;
  apiBase: string;
  token: string;
  hosts: string[];
  version: string;
  updates?: UpdateHooks;
  fetchImpl?: typeof fetch;
  onWalletChanged?: () => void;
  farmApi?: string;
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createUiApp(cfg: UiConfig) {
  const app = express();
  app.disable("x-powered-by");
  const f = cfg.fetchImpl ?? fetch;
  const walletFile = join(cfg.home, "wallet.json");
  const walletJson = (): { privateKey?: string; address?: string } | null => {
    try {
      return existsSync(walletFile) ? JSON.parse(readFileSync(walletFile, "utf8")) : null;
    } catch {
      return null;
    }
  };
  const hasKey = () => /^[0-9a-f]{64}$/i.test(walletJson()?.privateKey ?? "");
  const ownAddress = (): string | null => {
    try {
      if (hasKey()) return addressFromPublicKey(readKey(walletFile).publicKey);
      const a = walletJson()?.address;
      return typeof a === "string" && ADDRESS_RE.test(a) ? a : null;
    } catch {
      return null;
    }
  };

  app.use((req, res, next) => {
    if (!cfg.hosts.includes(String(req.headers.host ?? "").toLowerCase())) return void res.status(403).type("text/plain").send("forbidden host");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.get("/", (_q, res) => void res.type("html").send(indexHtml(cfg.token)));
  app.get("/app.js", (_q, res) => void res.type("js").send(APP_JS));
  app.get("/app.css", (_q, res) => void res.type("css").send(APP_CSS));

  const guard = (req: Request, res: Response, next: NextFunction) => {
    const t = req.headers["x-albus-token"];
    if (typeof t !== "string" || !same(t, cfg.token)) return void res.status(401).json({ error: "missing or wrong token" });
    if (req.method !== "GET") {
      const origin = String(req.headers.origin ?? "");
      if (!cfg.hosts.some((h) => origin === `http://${h}`)) return void res.status(403).json({ error: "bad origin" });
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return void res.status(415).json({ error: "json only" });
    }
    next();
  };
  app.use("/api", guard, express.json({ limit: "64kb" }));

  const node = async (path: string): Promise<any | null> => {
    try {
      const r = await f(cfg.apiBase.replace(/\/+$/, "") + path, { signal: AbortSignal.timeout(3000) });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  };

  app.get("/api/state", async (_q, res) => {
    const address = ownAddress();
    const [info, acct] = await Promise.all([node("/info"), address ? node(`/account/${address}`) : null]);
    res.json({
      version: cfg.version,
      address,
      hasKey: hasKey(),
      node: info && { networkId: info.networkId, height: info.height, referralBps: info.referralBps ?? null },
      account: acct && { spendable: acct.spendable, immature: acct.immature, unitsPerCoin: acct.unitsPerCoin },
      ...loadFriends(cfg.home, address),
      updatesAvailable: Boolean(cfg.updates),
      ...loadSettings(cfg.home),
      lastUpdate: cfg.updates?.last?.() ?? null,
    });
  });

  app.post("/api/wallet/create", (_q, res) => {
    if (existsSync(walletFile)) return void res.status(409).json({ error: "A wallet already exists. It is never overwritten." });
    const k = generateKeyPair();
    writeFileSync(walletFile, JSON.stringify(k, null, 2), { flag: "wx" });
    cfg.onWalletChanged?.();
    res.json({ address: k.address, file: walletFile });
  });

  app.post("/api/wallet/address", (req, res) => {
    if (existsSync(walletFile)) return void res.status(409).json({ error: "A wallet already exists. It is never overwritten." });
    const raw = (req.body as { address?: unknown } | null)?.address;
    const address = typeof raw === "string" ? raw.trim() : "";
    if (!ADDRESS_RE.test(address)) return void res.status(400).json({ error: "That is not a valid Albus address (albus1 + 40 characters)." });
    writeFileSync(walletFile, JSON.stringify({ address }, null, 2), { flag: "wx" });
    cfg.onWalletChanged?.();
    res.json({ address, file: walletFile });
  });

  app.get("/api/farm", async (_q, res) => {
    const address = ownAddress();
    if (!address) return void res.json({ address: null, workers: [], count: 0, hashrate: 0 });
    if (!cfg.farmApi) return void res.json({ address, workers: [], count: 0, hashrate: 0, note: "No farm server configured." });
    try {
      const r = await f(cfg.farmApi.replace(/\/+$/, "") + "/mining/workers/" + address, { signal: AbortSignal.timeout(8000), redirect: "error" });
      if (r.status === 404) return void res.json({ address, workers: [], count: 0, hashrate: 0, note: "The server does not know the farm list yet (it needs an update)." });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = (await r.json()) as { workers?: unknown[] };
      const workers = (Array.isArray(j.workers) ? j.workers : []).slice(0, 500).map((w: any) => ({
        name: String(w?.name ?? "").slice(0, 40),
        agent: String(w?.agent ?? "").slice(0, 64),
        hashrate: Number(w?.hashrate) || 0,
        accepted: Number(w?.accepted) || 0,
        onlineSec: Number(w?.onlineSec) || 0,
      }));
      res.json({ address, workers, count: workers.length, hashrate: workers.reduce((a, w) => a + w.hashrate, 0) });
    } catch {
      res.json({ address, workers: [], count: 0, hashrate: 0, note: "The farm list is not reachable right now." });
    }
  });

  app.post("/api/wallet/import", (req, res) => {
    if (existsSync(walletFile)) return void res.status(409).json({ error: "A wallet already exists. It is never overwritten." });
    const raw = (req.body as { privateKey?: unknown } | null)?.privateKey;
    const key = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(key)) return void res.status(400).json({ error: "The private key must be 64 characters (0-9, a-f)." });
    let publicKey: string;
    try {
      publicKey = bytesToHex(secp256k1.getPublicKey(hexToBytes(key), true));
    } catch {
      return void res.status(400).json({ error: "That is not a valid private key." });
    }
    const k = { privateKey: key, publicKey, address: addressFromPublicKey(publicKey) };
    writeFileSync(walletFile, JSON.stringify(k, null, 2), { flag: "wx" });
    cfg.onWalletChanged?.();
    res.json({ address: k.address, file: walletFile });
  });

  app.put("/api/friends", (req, res) => {
    try {
      const clean = validateFriends(req.body, ownAddress());
      if (clean.shareEnabled && !ownAddress()) throw new FriendsError("Create a wallet first");
      saveFriends(cfg.home, clean);
      res.json(clean);
    } catch (e) {
      if (e instanceof FriendsError) return void res.status(400).json({ error: e.message });
      throw e;
    }
  });

  app.post("/api/invitation", async (_q, res) => {
    if (!hasKey()) return void res.status(409).json({ error: "This computer only knows the address, not the private key. Create the invitation on the computer that has the key." });
    const info = await node("/info");
    if (!info) return void res.status(502).json({ error: "The node is not reachable." });
    if (!info.referralBps) return void res.status(409).json({ error: "This network has no Friends with Benefits." });
    const inviter = loadFriends(cfg.home, ownAddress()).inviter;
    if (!inviter || !ADDRESS_RE.test(inviter)) return void res.status(409).json({ error: "Pick who invited you first." });
    const k = readKey(walletFile);
    const text = encodeInvitation(createInvitation(k.privateKey, k.publicKey, inviter, info.networkId));
    writeFileSync(join(cfg.home, "invitation.txt"), text);
    res.json({ invitation: text, file: join(cfg.home, "invitation.txt") });
  });

  app.put("/api/settings", (req, res) => {
    const a = (req.body as { autoUpdate?: unknown } | null)?.autoUpdate;
    if (typeof a !== "boolean") return void res.status(400).json({ error: "autoUpdate must be true or false" });
    saveSettings(cfg.home, { autoUpdate: a });
    res.json({ autoUpdate: a });
  });

  app.post("/api/update/check", async (_q, res) => {
    if (!cfg.updates) return void res.status(409).json({ error: "Updates are not set up in this build." });
    res.json(await cfg.updates.check());
  });
  app.post("/api/update/apply", async (_q, res) => {
    if (!cfg.updates) return void res.status(409).json({ error: "Updates are not set up in this build." });
    res.json(await cfg.updates.apply());
  });

  app.use((err: Error, _q: Request, res: Response, _n: NextFunction) => {
    if ((err as { type?: string }).type === "entity.parse.failed") return void res.status(400).json({ error: "bad json" });
    res.status(500).json({ error: "internal error" });
  });
  return app;
}
