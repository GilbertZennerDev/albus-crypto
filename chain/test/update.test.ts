import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { compareVersions, isSafeRelPath, publicKeyOf, sha256Hex, signManifest, verifyEnvelope, type Envelope } from "../src/update/manifest.js";
import { downloadRelease, readCurrent, swapIn, type SwapHooks } from "../src/update/installer.js";
import { buildRelease } from "../src/update/release.js";

const priv = () => bytesToHex(ed25519.utils.randomPrivateKey());
const KEY = priv();
const PUB = publicKeyOf(KEY);
const tmp = mkdtempSync(join(tmpdir(), "albus-upd-"));
let n = 0;
const dir = (name: string) => join(tmp, `${name}${n++}`);

function makeSrc(files: Record<string, string>): string {
  const d = dir("src");
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(d, p, ".."), { recursive: true });
    writeFileSync(join(d, p), c);
  }
  return d;
}

async function serve(root: string, tamper?: (path: string, body: Buffer) => Buffer | null) {
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const f = join(root, p);
    if (!f.startsWith(root) || !existsSync(f)) return void res.writeHead(404).end();
    let body: Buffer | null = readFileSync(f);
    if (tamper) body = tamper(p, body);
    if (body === null) return void res.writeHead(500).end();
    res.writeHead(200, { "content-length": String(body.length) }).end(body);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => srv.close() };
}

const opts = (url: string, extra = {}) => ({ baseUrl: url, pinnedKeys: [PUB], installedVersion: "1.0.0", stagingDir: dir("stage"), allowLocalHttp: true, timeoutMs: 5000, ...extra });
const release = (files: Record<string, string>, version: string, key = KEY) => {
  const out = dir("rel");
  buildRelease(makeSrc(files), out, version, "test", key);
  return out;
};

test("Version compare and safe paths", () => {
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("0.9.9", "1.0.0"), -1);
  for (const bad of ["../x", "/x", "a/../b", "a\\b", "C:/x", "a//b", "", ".", "a/.", "con", "nul.txt", "a/b ", "x:y", "a\0b", "a/b."]) assert.equal(isSafeRelPath(bad), false, bad);
  for (const good of ["a.txt", "bin/albus-gpu.exe", "chain/index.js"]) assert.equal(isSafeRelPath(good), true, good);
});

test("Good release: download, verify, every byte arrives", async () => {
  const out = release({ "a.txt": "hallo", "bin/b.exe": "zwei" }, "1.1.0");
  const s = await serve(out);
  try {
    const o = opts(s.url);
    const m = await downloadRelease(o);
    assert.equal(m.version, "1.1.0");
    assert.equal(readFileSync(join(o.stagingDir, "bin/b.exe"), "utf8"), "zwei");
  } finally {
    s.close();
  }
});

test("Attacks on the manifest: wrong key, tampered text, no key built in, no signature", async () => {
  const out = release({ "a.txt": "x" }, "1.1.0");
  const env = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as Envelope;
  assert.throws(() => verifyEnvelope(env, [publicKeyOf(priv())], "1.0.0"), /Unterschrift/);
  assert.throws(() => verifyEnvelope({ ...env, manifest: env.manifest.replace("1.1.0", "9.9.9") }, [PUB], "1.0.0"), /Unterschrift/);
  assert.throws(() => verifyEnvelope(env, [], "1.0.0"), /Schluessel/);
  assert.throws(() => verifyEnvelope({ ...env, signatures: [] }, [PUB], "1.0.0"), /Unterschrift/);
  assert.throws(() => verifyEnvelope({ ...env, signatures: ["zz"] }, [PUB], "1.0.0"), /Unterschrift/);
  assert.throws(() => verifyEnvelope(null, [PUB], "1.0.0"), /kaputt/);
  assert.throws(() => verifyEnvelope({ manifest: 5, signatures: [] }, [PUB], "1.0.0"), /kaputt/);
  assert.equal(verifyEnvelope(env, [publicKeyOf(priv()), PUB], "1.0.0").version, "1.1.0");
});

test("Downgrade and replay: same or older version is refused", async () => {
  const env = JSON.parse(readFileSync(join(release({ "a": "x" }, "1.0.0"), "manifest.json"), "utf8")) as Envelope;
  assert.throws(() => verifyEnvelope(env, [PUB], "1.0.0"), /nicht neuer/);
  assert.throws(() => verifyEnvelope(env, [PUB], "2.0.0"), /nicht neuer/);
});

test("Signed but evil manifest: zip-slip style paths, duplicates, bad sizes are refused", () => {
  const sign = (files: unknown) => {
    const text = JSON.stringify({ product: "albus", version: "1.1.0", notes: "", created: 1, files });
    return { manifest: text, signatures: [signManifest(text, KEY)] };
  };
  const h = "a".repeat(64);
  assert.throws(() => verifyEnvelope(sign([{ path: "../evil.exe", sha256: h, size: 1 }]), [PUB], "1.0.0"), /Unsicher/);
  assert.throws(() => verifyEnvelope(sign([{ path: "C:/evil.exe", sha256: h, size: 1 }]), [PUB], "1.0.0"), /Unsicher/);
  assert.throws(() => verifyEnvelope(sign([{ path: "a", sha256: h, size: 1 }, { path: "A", sha256: h, size: 1 }]), [PUB], "1.0.0"), /doppelt/);
  assert.throws(() => verifyEnvelope(sign([{ path: "a", sha256: "xyz", size: 1 }]), [PUB], "1.0.0"), /Pruefsumme/);
  assert.throws(() => verifyEnvelope(sign([{ path: "a", sha256: h, size: -1 }]), [PUB], "1.0.0"), /Groesse/);
  assert.throws(() => verifyEnvelope(sign([]), [PUB], "1.0.0"), /Dateiliste/);
  assert.throws(() => verifyEnvelope(sign("nope"), [PUB], "1.0.0"), /Dateiliste/);
  const bad = { manifest: JSON.stringify({ product: "other", version: "1.1.0", notes: "", created: 1, files: [] }), signatures: [] as string[] };
  bad.signatures.push(signManifest(bad.manifest, KEY));
  assert.throws(() => verifyEnvelope(bad, [PUB], "1.0.0"), /Albus/);
});

test("Tampered file, truncated file, missing file: nothing is left behind", async () => {
  const out = release({ "a.txt": "hello world", "b.txt": "second" }, "1.1.0");
  const cases: [string, (p: string, b: Buffer) => Buffer | null, RegExp][] = [
    ["flipped byte", (p, b) => (p.endsWith("a.txt") ? Buffer.from("hellO world") : b), /Pruefsumme/],
    ["truncated", (p, b) => (p.endsWith("b.txt") ? b.subarray(0, 3) : b), /unvollstaendig/],
    ["too long", (p, b) => (p.endsWith("a.txt") ? Buffer.concat([b, Buffer.from("extra")]) : b), /groesser/],
    ["server error", (p, b) => (p.endsWith("b.txt") ? null : b), /fehlgeschlagen/],
  ];
  for (const [name, fn, re] of cases) {
    const s = await serve(out, fn);
    try {
      const o = opts(s.url);
      await assert.rejects(downloadRelease(o), re, name);
      assert.equal(existsSync(o.stagingDir), false, name);
    } finally {
      s.close();
    }
  }
});

test("Transport rules: https only, no credentials, no redirects", async () => {
  await assert.rejects(downloadRelease(opts("http://example.com/x", { allowLocalHttp: false })), /https/);
  await assert.rejects(downloadRelease(opts("http://127.0.0.1:1/x", { allowLocalHttp: false })), /https/);
  await assert.rejects(downloadRelease(opts("http://example.com/x")), /https/);
  await assert.rejects(downloadRelease(opts("https://user:pw@example.com/x")), /Zugangsdaten/);
  await assert.rejects(downloadRelease(opts("nonsense")), /Ungueltige/);
  const redirect = http.createServer((_q, r) => void r.writeHead(302, { location: "http://evil.invalid/" }).end());
  await new Promise<void>((r) => redirect.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(downloadRelease(opts(`http://127.0.0.1:${(redirect.address() as { port: number }).port}`)), /fehlgeschlagen/);
  } finally {
    redirect.close();
  }
});

function hooks(log: string[], healthy: boolean): SwapHooks {
  return {
    stop: () => void log.push("stop"),
    start: (d) => void log.push("start " + d.replace(/\\/g, "/").split("/").slice(-2).join("/")),
    health: () => healthy,
  };
}

async function install(root: string, files: Record<string, string>, version: string, h: SwapHooks) {
  const out = release(files, version);
  const s = await serve(out);
  try {
    const o = opts(s.url, { installedVersion: readCurrent(root)?.version ?? "0.0.1" });
    const m = await downloadRelease(o);
    return await swapIn(root, m, o.stagingDir, h);
  } finally {
    s.close();
  }
}

test("Swap: new version goes live, old one is kept for rollback, user data is never touched", async () => {
  const root = dir("root");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "user-data.json"), "friends");
  const log: string[] = [];
  assert.equal((await install(root, { "app.js": "v1" }, "1.0.0", hooks(log, true))).ok, true);
  assert.equal((await install(root, { "app.js": "v2" }, "1.1.0", hooks(log, true))).ok, true);
  assert.equal(readCurrent(root)?.version, "1.1.0");
  assert.equal(readFileSync(join(root, "versions/1.1.0/app.js"), "utf8"), "v2");
  assert.equal(existsSync(join(root, "versions/1.0.0/app.js")), true);
  assert.equal((await install(root, { "app.js": "v3" }, "1.2.0", hooks(log, true))).ok, true);
  assert.equal(existsSync(join(root, "versions/1.0.0")), false);
  assert.equal(readFileSync(join(root, "user-data.json"), "utf8"), "friends");
});

test("Swap with a failing health check rolls back to the old version", async () => {
  const root = dir("root");
  mkdirSync(root, { recursive: true });
  await install(root, { "app.js": "v1" }, "1.0.0", hooks([], true));
  const log: string[] = [];
  const r = await install(root, { "app.js": "bad" }, "1.1.0", hooks(log, false));
  assert.deepEqual([r.ok, r.rolledBack, r.version], [false, true, "1.0.0"]);
  assert.equal(readCurrent(root)?.version, "1.0.0");
  assert.equal(existsSync(join(root, "versions/1.1.0")), false);
  assert.deepEqual(log, ["stop", "start versions/1.1.0", "stop", "start versions/1.0.0"]);
});

test("Swap where start() throws also rolls back, and a crash in rollback does not hide the error", async () => {
  const root = dir("root");
  mkdirSync(root, { recursive: true });
  await install(root, { "app.js": "v1" }, "1.0.0", hooks([], true));
  let calls = 0;
  const h: SwapHooks = { stop: () => {}, start: () => { if (calls++ === 0) throw new Error("kaputt"); }, health: () => true };
  const r = await install(root, { "app.js": "v2" }, "1.1.0", h);
  assert.deepEqual([r.ok, r.rolledBack], [false, true]);
  assert.match(r.error ?? "", /kaputt/);
  assert.equal(readCurrent(root)?.version, "1.0.0");
});

test("Sanity: sha256Hex matches a known value", () => {
  assert.equal(sha256Hex(utf8ToBytes("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
  setTimeout(() => process.exit(0), 50).unref();
});
