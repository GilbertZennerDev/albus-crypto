import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiApp } from "../src/ui/server.js";
import { loadFriends, validateFriends, rulesOf } from "../src/ui/friends.js";
import { verifyInvitation } from "../src/transaction.js";
import { generateKeyPair } from "../src/wallet.js";

const TOKEN = "ab".repeat(24);
const tmp = mkdtempSync(join(tmpdir(), "albus-ui-"));
let n = 0;
const A = (c: string) => "albus1" + c.repeat(40);
const [f1, f2] = [generateKeyPair().address, generateKeyPair().address];

function fakeFetch(referralBps: number | null) {
  return (async (url: string) => {
    const body = url.endsWith("/info") ? { networkId: "net0123456789abcd", height: 7, referralBps } : { spendable: 5e8, immature: 1e8, unitsPerCoin: 1e8 };
    return { ok: true, json: async () => body };
  }) as unknown as typeof fetch;
}

async function start(referralBps: number | null = null) {
  const home = join(tmp, `h${n++}`);
  rmSync(home, { recursive: true, force: true });
  (await import("node:fs")).mkdirSync(home, { recursive: true });
  let port = 0;
  const hosts: string[] = [];
  const app = createUiApp({ home, apiBase: "http://node.test", token: TOKEN, hosts, version: "1.2.3", fetchImpl: fakeFetch(referralBps) });
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  port = (srv.address() as { port: number }).port;
  hosts.push(`127.0.0.1:${port}`, `localhost:${port}`);
  const call = (path: string, o: { method?: string; headers?: Record<string, string>; body?: unknown; host?: string } = {}) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
      const data = o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body);
      const req = http.request({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers: { host: o.host ?? `127.0.0.1:${port}`, ...(data ? { "content-length": String(Buffer.byteLength(data)) } : {}), ...o.headers } }, (res) => {
        let t = "";
        res.on("data", (c) => (t += c));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text: t }));
      });
      req.on("error", reject);
      req.end(data);
    });
  const good = { "x-albus-token": TOKEN, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" };
  return { home, port, call, good, close: () => srv.close() };
}

test("Host check: a foreign Host header (DNS rebinding) gets nothing, not even the page", async () => {
  const s = await start();
  try {
    for (const host of ["evil.example", `evil.example:${s.port}`, "127.0.0.1", `127.0.0.1:${s.port + 1}`]) {
      assert.equal((await s.call("/", { host })).status, 403, host);
      assert.equal((await s.call("/api/state", { host, headers: { "x-albus-token": TOKEN } })).status, 403, host);
    }
    const ok = await s.call("/", { host: `localhost:${s.port}` });
    assert.equal(ok.status, 200);
    assert.match(ok.text, new RegExp(TOKEN));
  } finally {
    s.close();
  }
});

test("API needs the token: missing, wrong, short, array all fail", async () => {
  const s = await start();
  try {
    for (const h of [{}, { "x-albus-token": "nope" }, { "x-albus-token": TOKEN.slice(1) }, { "x-albus-token": TOKEN + "0" }]) assert.equal((await s.call("/api/state", { headers: h })).status, 401);
    assert.equal((await s.call("/api/state", { headers: { "x-albus-token": TOKEN } })).status, 200);
  } finally {
    s.close();
  }
});

test("Writes need a matching Origin and JSON (CSRF): foreign or missing origin, form posts, even with the token", async () => {
  const s = await start();
  try {
    const body = { friends: [], inviter: null, shareEnabled: false };
    const put = (headers: Record<string, string>, b: unknown = body) => s.call("/api/friends", { method: "PUT", headers, body: b });
    assert.equal((await put({ "x-albus-token": TOKEN, "content-type": "application/json" })).status, 403);
    assert.equal((await put({ ...s.good, origin: "http://evil.example" })).status, 403);
    assert.equal((await put({ ...s.good, origin: "null" })).status, 403);
    assert.equal((await put({ ...s.good, origin: `http://127.0.0.1:${s.port}.evil.example` })).status, 403);
    assert.equal((await put({ ...s.good, "content-type": "application/x-www-form-urlencoded" }, "friends=1")).status, 415);
    assert.equal((await put({ ...s.good, "content-type": "text/plain" }, JSON.stringify(body))).status, 415);
    assert.equal((await put({ "content-type": "application/json", origin: `http://127.0.0.1:${s.port}` })).status, 401);
    assert.equal((await put(s.good)).status, 200);
    assert.equal((await s.call("/api/wallet/create", { method: "POST", headers: { "x-albus-token": TOKEN }, body: {} })).status, 403);
    assert.equal((await s.call("/api/friends", { method: "PUT", headers: s.good, body: "{broken" })).status, 400);
  } finally {
    s.close();
  }
});

test("No CORS and strict security headers", async () => {
  const s = await start();
  try {
    const r = await s.call("/", { headers: { origin: "http://evil.example" } });
    assert.equal(r.headers["access-control-allow-origin"], undefined);
    assert.match(String(r.headers["content-security-policy"]), /default-src 'none'/);
    assert.match(String(r.headers["content-security-policy"]), /frame-ancestors 'none'/);
    assert.equal(r.headers["x-frame-options"], "DENY");
    const pre = await s.call("/api/friends", { method: "OPTIONS", headers: { origin: "http://evil.example", "access-control-request-method": "PUT" } });
    assert.equal(pre.headers["access-control-allow-origin"], undefined);
    assert.doesNotMatch((await s.call("/app.js")).text, new RegExp(TOKEN));
  } finally {
    s.close();
  }
});

test("Wallet: created once, never overwritten, private key never in any answer", async () => {
  const s = await start();
  try {
    const c = await s.call("/api/wallet/create", { method: "POST", headers: s.good, body: {} });
    assert.equal(c.status, 200);
    const file = JSON.parse(readFileSync(join(s.home, "wallet.json"), "utf8"));
    assert.equal(JSON.parse(c.text).address, file.address);
    const before = readFileSync(join(s.home, "wallet.json"), "utf8");
    assert.equal((await s.call("/api/wallet/create", { method: "POST", headers: s.good, body: {} })).status, 409);
    assert.equal(readFileSync(join(s.home, "wallet.json"), "utf8"), before);
    for (const path of ["/api/state"]) assert.doesNotMatch((await s.call(path, { headers: { "x-albus-token": TOKEN } })).text, new RegExp(file.privateKey));
    assert.doesNotMatch(c.text, new RegExp(file.privateKey));
    const st = JSON.parse((await s.call("/api/state", { headers: { "x-albus-token": TOKEN } })).text);
    assert.deepEqual([st.address, st.version, st.node.height, st.account.spendable], [file.address, "1.2.3", 7, 5e8]);
  } finally {
    s.close();
  }
});

test("Friends list: strict validation and persistence", async () => {
  const s = await start();
  try {
    await s.call("/api/wallet/create", { method: "POST", headers: s.good, body: {} });
    const me = JSON.parse(readFileSync(join(s.home, "wallet.json"), "utf8")).address as string;
    const put = (b: unknown) => s.call("/api/friends", { method: "PUT", headers: s.good, body: b });
    const fr = (name: string, address: string, percent: number) => ({ name, address, percent });
    const bad: unknown[] = [
      null, 5, { friends: "x" }, { friends: [null] },
      { friends: [fr("", f1, 1)] }, { friends: [fr("x".repeat(41), f1, 1)] }, { friends: [fr("<b>", f1, 1)] }, { friends: [fr("a\u0007", f1, 1)] },
      { friends: [fr("a", "albus1xyz", 1)] }, { friends: [fr("a", f1.toUpperCase(), 1)] }, { friends: [fr("a", me, 1)] },
      { friends: [fr("a", f1, 1), fr("b", f1, 1)] }, { friends: [fr("a", f1, -1)] }, { friends: [fr("a", f1, 101)] }, { friends: [fr("a", f1, 0.001)] },
      { friends: [fr("a", f1, "10")] }, { friends: [fr("a", f1, NaN)] },
      { friends: [fr("a", f1, 60), fr("b", f2, 60)] },
      { friends: [], inviter: me }, { friends: [], inviter: "nope" }, { friends: [], inviter: 5 }, { friends: [], shareEnabled: "yes" },
      { friends: Array.from({ length: 51 }, (_, i) => fr("f" + i, A(String.fromCharCode(97 + (i % 6))) + "", 0)) },
    ];
    for (const b of bad) assert.equal((await put(b)).status, 400, JSON.stringify(b)?.slice(0, 80));
    assert.equal(existsSync(join(s.home, "friends.json")), false);
    const ok = { friends: [fr("Mia", f1, 60), fr("Jo", f2, 40.5 - 0.5)], inviter: f1, shareEnabled: true };
    assert.equal((await put({ ...ok, extra: "ignored", friends: ok.friends.map((f) => ({ ...f, evil: 1 })) })).status, 200);
    const saved = loadFriends(s.home);
    assert.deepEqual(saved, ok);
    assert.deepEqual(rulesOf(saved), [{ to: f1, percent: 60 }, { to: f2, percent: 40 }]);
    assert.equal(JSON.parse(readFileSync(join(s.home, "friends.json"), "utf8")).friends[0].evil, undefined);
  } finally {
    s.close();
  }
});

test("Sharing cannot be switched on without a wallet; broken friends.json means: share nothing", async () => {
  const s = await start();
  try {
    const r = await s.call("/api/friends", { method: "PUT", headers: s.good, body: { friends: [{ name: "a", address: f1, percent: 10 }], shareEnabled: true } });
    assert.equal(r.status, 400);
    writeFileSync(join(s.home, "friends.json"), "{ not json");
    assert.deepEqual(loadFriends(s.home), { friends: [], inviter: null, shareEnabled: false });
    writeFileSync(join(s.home, "friends.json"), JSON.stringify({ friends: [{ name: "a", address: "bad", percent: 100 }], shareEnabled: true }));
    assert.equal(loadFriends(s.home).shareEnabled, false);
  } finally {
    s.close();
  }
});

test("Invitation: hidden on mainnet, needs an inviter, valid and bound to the network on a testnet", async () => {
  const main = await start(null);
  try {
    await main.call("/api/wallet/create", { method: "POST", headers: main.good, body: {} });
    assert.equal((await main.call("/api/invitation", { method: "POST", headers: main.good, body: {} })).status, 409);
    assert.equal(existsSync(join(main.home, "invitation.txt")), false);
    assert.equal(JSON.parse((await main.call("/api/state", { headers: { "x-albus-token": TOKEN } })).text).node.referralBps, null);
  } finally {
    main.close();
  }
  const s = await start(1000);
  try {
    await s.call("/api/wallet/create", { method: "POST", headers: s.good, body: {} });
    assert.equal((await s.call("/api/invitation", { method: "POST", headers: s.good, body: {} })).status, 409);
    await s.call("/api/friends", { method: "PUT", headers: s.good, body: { friends: [{ name: "Mia", address: f1, percent: 0 }], inviter: f1 } });
    const r = await s.call("/api/invitation", { method: "POST", headers: s.good, body: {} });
    assert.equal(r.status, 200);
    const text = JSON.parse(r.text).invitation as string;
    const { parseInvitation } = await import("../src/transaction.js");
    const inv = parseInvitation(text)!;
    const me = JSON.parse(readFileSync(join(s.home, "wallet.json"), "utf8")).address;
    assert.equal(verifyInvitation(inv, me, "net0123456789abcd"), true);
    assert.equal(verifyInvitation(inv, me, "net000000000000ff"), false);
    assert.equal(inv.referrer, f1);
  } finally {
    s.close();
  }
});

test("Without update setup, update routes say so", async () => {
  const s = await start();
  try {
    assert.equal((await s.call("/api/update/check", { method: "POST", headers: s.good, body: {} })).status, 409);
    assert.equal((await s.call("/api/update/apply", { method: "POST", headers: s.good, body: {} })).status, 409);
    assert.equal(JSON.parse((await s.call("/api/state", { headers: { "x-albus-token": TOKEN } })).text).updatesAvailable, false);
  } finally {
    s.close();
  }
});

test("validateFriends: names are only text, the page inserts them with textContent", () => {
  const { APP_JS } = require_page();
  assert.doesNotMatch(APP_JS, /innerHTML|insertAdjacentHTML|document\.write|eval\(/);
  assert.equal(validateFriends({ friends: [{ name: " Mia ", address: f1, percent: 5 }] }, null).friends[0].name, "Mia");
});

function require_page() {
  const src = readFileSync(new URL("../src/ui/page.ts", import.meta.url), "utf8");
  return { APP_JS: src.slice(src.indexOf("export const APP_JS")) };
}

after(() => {
  rmSync(tmp, { recursive: true, force: true });
  setTimeout(() => process.exit(0), 50).unref();
});
