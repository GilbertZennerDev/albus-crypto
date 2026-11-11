import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { buildRelease } from "../src/update/release.js";
import { downloadRelease, readCurrent, swapIn } from "../src/update/installer.js";
import { publicKeyOf } from "../src/update/manifest.js";

const tmp = mkdtempSync(join(tmpdir(), "albus-e2e-"));
const priv = Buffer.from(ed25519.utils.randomPrivateKey()).toString("hex");
const pub = publicKeyOf(priv);
const marker = join(tmp, "laeuft.txt");

function src(version: string, bad = false): string {
  const d = join(tmp, "src-" + version);
  mkdirSync(join(d, "scripts"), { recursive: true });
  writeFileSync(join(d, "app.txt"), "Programm " + version);
  writeFileSync(join(d, "scripts", "stop.ps1"), `Remove-Item -LiteralPath '${marker}' -ErrorAction SilentlyContinue\n`);
  writeFileSync(join(d, "scripts", "start.ps1"), bad ? "exit 1\n" : `Set-Content -LiteralPath '${marker}' -Value '${version}'\n`);
  return d;
}
const ps = (script: string) => new Promise<void>((res, rej) => execFile("pwsh", ["-NoProfile", "-File", script], (e) => (e ? rej(e) : res())));

function serve(dir: string) {
  return new Promise<{ url: string; close(): void }>((resolve) => {
    const s = http.createServer((q, r) => {
      const p = join(dir, decodeURIComponent(new URL(q.url!, "http://x").pathname));
      if (!p.startsWith(dir) || !existsSync(p) || extname(p) === "") return void r.writeHead(404).end();
      r.end(readFileSync(p));
    });
    s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, close: () => s.close() }));
  });
}

test("Echtes Update 1.0.0 -> 1.1.0 mit pwsh, danach kaputtes 1.2.0 mit Rueckkehr", async () => {
  const root = join(tmp, "app");
  mkdirSync(root, { recursive: true });
  const rel = join(tmp, "rel");
  const hooks = () => ({
    stop: async () => { const c = readCurrent(root); if (c) await ps(join(root, c.dir, "scripts", "stop.ps1")); },
    start: (dir: string) => ps(join(dir, "scripts", "start.ps1")),
    health: async () => existsSync(marker),
  });
  const opts = (url: string, v: string) => ({ baseUrl: url, pinnedKeys: [pub], installedVersion: v, stagingDir: join(root, "staging"), allowLocalHttp: true });

  buildRelease(src("1.0.0"), rel, "1.0.0", "erste", priv);
  let srv = await serve(rel);
  let m = await downloadRelease(opts(srv.url, "0.0.0"));
  assert.equal((await swapIn(root, m, join(root, "staging"), hooks())).ok, true);
  srv.close();
  assert.equal(readFileSync(marker, "utf8").trim(), "1.0.0");

  buildRelease(src("1.1.0"), rel, "1.1.0", "neu", priv);
  srv = await serve(rel);
  m = await downloadRelease(opts(srv.url, "1.0.0"));
  const r = await swapIn(root, m, join(root, "staging"), hooks());
  srv.close();
  assert.deepEqual([r.ok, r.version, r.rolledBack], [true, "1.1.0", false]);
  assert.equal(readFileSync(marker, "utf8").trim(), "1.1.0");
  assert.equal(readCurrent(root)!.version, "1.1.0");
  assert.equal(readFileSync(join(root, readCurrent(root)!.dir, "app.txt"), "utf8"), "Programm 1.1.0");

  buildRelease(src("1.2.0", true), rel, "1.2.0", "kaputt", priv);
  srv = await serve(rel);
  m = await downloadRelease(opts(srv.url, "1.1.0"));
  const bad = await swapIn(root, m, join(root, "staging"), hooks());
  srv.close();
  assert.equal(bad.ok, false);
  assert.equal(bad.rolledBack, true);
  assert.equal(readCurrent(root)!.version, "1.1.0");
  assert.equal(readFileSync(marker, "utf8").trim(), "1.1.0");

  const evil = Buffer.from(ed25519.utils.randomPrivateKey()).toString("hex");
  buildRelease(src("1.3.0"), rel, "1.3.0", "boese", evil);
  srv = await serve(rel);
  await assert.rejects(downloadRelease(opts(srv.url, "1.1.0")));
  srv.close();
  assert.equal(readCurrent(root)!.version, "1.1.0");
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
  setTimeout(() => process.exit(0), 50).unref();
});
