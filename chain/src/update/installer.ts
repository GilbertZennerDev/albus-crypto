import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { MAX_MANIFEST_BYTES, UpdateError, isSafeRelPath, sha256Hex, verifyEnvelope, type Manifest } from "./manifest.js";

export type FetchLike = (url: string, init?: { redirect?: "error" | "follow"; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; headers: { get(n: string): string | null } }>;

export interface DownloadOptions {
  baseUrl: string;
  pinnedKeys: string[];
  installedVersion: string;
  stagingDir: string;
  fetchImpl?: FetchLike;
  allowLocalHttp?: boolean;
  timeoutMs?: number;
}

function checkUrl(base: string, allowLocalHttp: boolean): URL {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new UpdateError("Ungueltige Update-Adresse");
  }
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.protocol !== "https:" && !(allowLocalHttp && u.protocol === "http:" && local)) throw new UpdateError("Updates nur ueber https");
  if (u.username || u.password) throw new UpdateError("Update-Adresse darf keine Zugangsdaten enthalten");
  return u;
}

async function getBytes(f: FetchLike, url: string, limit: number, timeoutMs: number): Promise<Uint8Array> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await f(url, { redirect: "error", signal: ctl.signal });
    if (!r.ok) throw new UpdateError(`Download fehlgeschlagen (${r.status}): ${url}`);
    const len = Number(r.headers.get("content-length") ?? "0");
    if (len > limit) throw new UpdateError("Datei ist groesser als angegeben");
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length > limit) throw new UpdateError("Datei ist groesser als angegeben");
    return buf;
  } catch (e) {
    if (e instanceof UpdateError) throw e;
    throw new UpdateError(`Download fehlgeschlagen: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function downloadRelease(o: DownloadOptions): Promise<Manifest> {
  const base = checkUrl(o.baseUrl, o.allowLocalHttp ?? false);
  const f = o.fetchImpl ?? (fetch as unknown as FetchLike);
  const timeout = o.timeoutMs ?? 60_000;
  const prefix = base.href.replace(/\/+$/, "");
  const raw = new TextDecoder().decode(await getBytes(f, `${prefix}/manifest.json`, MAX_MANIFEST_BYTES, timeout));
  let env: unknown;
  try {
    env = JSON.parse(raw);
  } catch {
    throw new UpdateError("Update-Umschlag ist kein gueltiges JSON");
  }
  const m = verifyEnvelope(env, o.pinnedKeys, o.installedVersion);

  const root = resolve(o.stagingDir);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  try {
    for (const file of m.files) {
      const target = resolve(root, file.path);
      if (!target.startsWith(root + sep)) throw new UpdateError(`Pfad verlaesst den Zielordner: ${file.path}`);
      const bytes = await getBytes(f, `${prefix}/${m.version}/${file.path.split("/").map(encodeURIComponent).join("/")}`, file.size, timeout);
      if (bytes.length !== file.size) throw new UpdateError(`Datei ist unvollstaendig: ${file.path}`);
      if (sha256Hex(bytes) !== file.sha256) throw new UpdateError(`Pruefsumme stimmt nicht: ${file.path}`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
  return m;
}

export interface Current {
  version: string;
  dir: string;
}

const pointerFile = (root: string) => join(root, "current.json");

export function readCurrent(root: string): Current | null {
  try {
    const c = JSON.parse(readFileSync(pointerFile(root), "utf8")) as Current;
    if (typeof c.version === "string" && isSafeRelPath(c.dir) && existsSync(join(root, c.dir))) return c;
  } catch {
  }
  return null;
}

function writePointer(root: string, c: Current): void {
  const tmp = pointerFile(root) + ".tmp";
  writeFileSync(tmp, JSON.stringify(c));
  renameSync(tmp, pointerFile(root));
}

export interface SwapHooks {
  stop(): Promise<void> | void;
  start(dir: string): Promise<void> | void;
  health(): Promise<boolean> | boolean;
}

export interface SwapResult {
  ok: boolean;
  version: string;
  rolledBack: boolean;
  error?: string;
}

export async function swapIn(root: string, m: Manifest, stagingDir: string, hooks: SwapHooks): Promise<SwapResult> {
  const rel = `versions/${m.version}`;
  const dest = join(root, rel);
  const old = readCurrent(root);
  mkdirSync(join(root, "versions"), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  renameSync(stagingDir, dest);

  const fail = async (error: string): Promise<SwapResult> => {
    let rolledBack = false;
    try {
      await hooks.stop();
      if (old) {
        writePointer(root, old);
        await hooks.start(join(root, old.dir));
        rolledBack = true;
      }
    } catch {
    }
    rmSync(dest, { recursive: true, force: true });
    return { ok: false, version: old?.version ?? "", rolledBack, error };
  };

  try {
    await hooks.stop();
    writePointer(root, { version: m.version, dir: rel });
    await hooks.start(dest);
    if (!(await hooks.health())) return await fail("Die neue Version ist nicht gesund gestartet");
  } catch (e) {
    return await fail((e as Error).message);
  }

  const keepDirs = new Set([m.version, old?.dir.split("/")[1]]);
  for (const d of readdirSync(join(root, "versions"))) if (!keepDirs.has(d)) rmSync(join(root, "versions", d), { recursive: true, force: true });
  return { ok: true, version: m.version, rolledBack: false };
}
