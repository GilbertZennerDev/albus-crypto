import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { downloadRelease, readCurrent, swapIn } from "./installer.js";
import { PINNED_KEYS } from "./pinned-keys.js";

const url = process.env.ALBUS_UPDATE_URL ?? "https://albus.workflowsolved.com/releases";
const home = process.env.ALBUS_HOME ?? join(process.env.LOCALAPPDATA ?? join(homedir(), ".albus"), "Albus");
const root = join(home, "app");
const noStart = process.argv.includes("--no-start");
const ps = (script: string) => new Promise<void>((res, rej) => execFile("pwsh", ["-NoProfile", "-File", script], (e) => (e ? rej(e) : res())));

async function main() {
  if (PINNED_KEYS.length === 0) throw new Error("In diesem Programm ist kein Release-Schluessel eingebaut. Es installiert nichts.");
  mkdirSync(root, { recursive: true });
  const cur = readCurrent(root);
  const staging = join(root, "staging");
  const m = await downloadRelease({ baseUrl: url, pinnedKeys: PINNED_KEYS, installedVersion: cur?.version ?? "0.0.0", stagingDir: staging });
  console.log(`Version ${m.version} geladen und geprueft (${m.files.length} Dateien).`);
  const r = await swapIn(root, m, staging, {
    stop: () => (cur && !noStart ? ps(join(root, cur.dir, "scripts", "stop.ps1")) : undefined),
    start: (dir) => (noStart ? undefined : ps(join(dir, "scripts", "start.ps1"))),
    health: async () => {
      if (noStart) return true;
      for (let i = 0; i < 30; i++) {
        try {
          if ((await fetch("http://127.0.0.1:4000/health", { signal: AbortSignal.timeout(2000) })).ok) return true;
        } catch {
        }
        await new Promise((r2) => setTimeout(r2, 1000));
      }
      return false;
    },
  });
  if (!r.ok) throw new Error(`${r.error}${r.rolledBack ? " (alte Version laeuft wieder)" : ""}`);
  console.log(`Fertig: Version ${r.version}. Oberflaeche: http://127.0.0.1:4777/`);
}

main().catch((e) => {
  console.error("Fehler: " + (e as Error).message);
  process.exit(1);
});
