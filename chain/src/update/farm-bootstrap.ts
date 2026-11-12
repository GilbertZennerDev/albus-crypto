import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { downloadRelease } from "./installer.js";
import { PINNED_KEYS } from "./pinned-keys.js";

const url = process.env.ALBUS_UPDATE_URL ?? "https://albus.workflowsolved.com/releases";
const dirArg = process.argv.indexOf("--dir");
const dir = dirArg >= 0 && process.argv[dirArg + 1] ? process.argv[dirArg + 1] : (process.env.ALBUS_FARM_DIR ?? join(homedir(), "albus-farm"));
const win = process.platform === "win32";

async function main() {
  if (PINNED_KEYS.length === 0) throw new Error("In diesem Programm ist kein Release-Schluessel eingebaut. Es installiert nichts.");
  mkdirSync(dir, { recursive: true });
  const staging = join(dir, "staging");
  const m = await downloadRelease({ baseUrl: url, pinnedKeys: PINNED_KEYS, installedVersion: "0.0.0", stagingDir: staging, allowLocalHttp: process.env.ALBUS_ALLOW_LOCAL_HTTP === "1" });
  console.log(`Version ${m.version} geladen und geprueft.`);
  const agent = join(staging, "farm", "agent.mjs");
  const cpuSrc = win ? join(staging, "bin", "albus-cpu.exe") : join(staging, "bin-linux", "albus-cpu");
  for (const p of [agent, cpuSrc]) if (!existsSync(p)) throw new Error(`Im Release fehlt: ${p.slice(staging.length + 1)} (fuer dieses System gibt es noch kein Mining-Programm)`);
  const cpuDst = join(dir, win ? "albus-cpu.exe" : "albus-cpu");
  copyFileSync(agent, join(dir, "agent.mjs.new"));
  copyFileSync(cpuSrc, cpuDst + ".new");
  if (!win) chmodSync(cpuDst + ".new", 0o755);
  const { renameSync } = await import("node:fs");
  for (const f of [join(dir, "agent.mjs"), cpuDst]) renameSync(f + ".new", f);
  writeFileSync(join(dir, "version.txt"), m.version + "\n");
  rmSync(staging, { recursive: true, force: true });
  console.log(`Fertig: Version ${m.version} in ${dir}`);
}

main().catch((e) => {
  console.error("Fehler: " + (e as Error).message);
  process.exit(1);
});
