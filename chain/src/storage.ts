import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  // rename-over-existing can transiently fail with EPERM/EBUSY if something
  // else (antivirus, a backup tool, another process) has the destination
  // open for an instant — rare, but a persistence hiccup should never take
  // the whole server down, so retry a few times before giving up quietly.
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      if (attempt >= 4) {
        console.error(`writeJsonAtomic: giving up persisting ${path} after repeated rename failures`, err);
        return;
      }
      // synchronous backoff — writeJsonAtomic is used from sync call sites
      // throughout, so this stays sync rather than threading async up
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
    }
  }
}
