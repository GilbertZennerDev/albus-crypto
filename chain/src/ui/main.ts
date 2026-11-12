import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runOnce, httpApi, readKey, type ShareState } from "../auto-share.js";
import { UNITS_PER_COIN } from "../params.js";
import { downloadRelease, readCurrent, swapIn } from "../update/installer.js";
import { UpdateError, verifyEnvelope } from "../update/manifest.js";
import { PINNED_KEYS } from "../update/pinned-keys.js";
import { loadFriends, rulesOf } from "./friends.js";
import { loadSettings } from "./settings.js";
import { createUiApp, type UpdateHooks } from "./server.js";
import { existsSync, writeFileSync } from "node:fs";

const home = process.env.ALBUS_HOME ?? join(process.env.LOCALAPPDATA ?? join(homedir(), ".albus"), "Albus");
const apiBase = process.env.ALBUS_API ?? "http://127.0.0.1:4000";
const port = Number(process.env.UI_PORT ?? 4777);
const root = join(home, "app");
mkdirSync(home, { recursive: true });
mkdirSync(root, { recursive: true });

const installed = readCurrent(root)?.version ?? "0.1.0";

let busy = false;
let lastNote: string | null = null;
const failedVersions = new Set<string>();

function restartSelf() {
  if (process.env.ALBUS_UI_TASK !== "1") return;
  execFile("pwsh", ["-NoProfile", "-Command", "Start-Sleep 2; Stop-ScheduledTask AlbusUi; Start-ScheduledTask AlbusUi"], { windowsHide: true }, () => {});
  setTimeout(() => process.exit(0), 1500).unref();
}

function restartMiner() {
  if (process.env.ALBUS_UI_TASK !== "1") return;
  execFile("pwsh", ["-NoProfile", "-Command", "Stop-ScheduledTask AlbusSupervisor -ErrorAction SilentlyContinue; Start-Sleep 2; Start-ScheduledTask AlbusSupervisor"], { windowsHide: true }, () => {});
}

function updates(): UpdateHooks | undefined {
  const url = process.env.ALBUS_UPDATE_URL;
  if (!url || PINNED_KEYS.length === 0) return undefined;
  const staging = join(root, "staging");
  const ps = (script: string, arg?: string) =>
    new Promise<void>((res, rej) => execFile("pwsh", ["-NoProfile", "-File", script, ...(arg ? [arg] : [])], (e) => (e ? rej(e) : res())));
  return {
    last: () => lastNote,
    async check() {
      try {
        const env = await (await fetch(url.replace(/\/+$/, "") + "/manifest.json", { redirect: "error", signal: AbortSignal.timeout(15000) })).json();
        const m = verifyEnvelope(env, PINNED_KEYS, readCurrent(root)?.version ?? installed);
        return { available: true, version: m.version, notes: m.notes };
      } catch (e) {
        if (e instanceof UpdateError && /nicht neuer/.test(e.message)) return { available: false };
        return { available: false, error: `Update check failed: ${(e as Error).message}` };
      }
    },
    async apply() {
      if (busy) return { ok: false, message: "An update is already running." };
      busy = true;
      try {
        const cur = readCurrent(root);
        const m = await downloadRelease({ baseUrl: url, pinnedKeys: PINNED_KEYS, installedVersion: cur?.version ?? installed, stagingDir: staging });
        const r = await swapIn(root, m, staging, {
          stop: () => (cur ? ps(join(root, cur.dir, "scripts", "stop.ps1")) : undefined),
          start: (dir) => ps(join(dir, "scripts", "start.ps1")),
          health: async () => {
            for (let i = 0; i < 30; i++) {
              try {
                if ((await fetch(apiBase.replace(/\/+$/, "") + "/health", { signal: AbortSignal.timeout(2000) })).ok) return true;
              } catch {
              }
              await new Promise((r) => setTimeout(r, 1000));
            }
            return false;
          },
        });
        if (r.ok) restartSelf();
        return r.ok ? { ok: true, message: `Updated to ${r.version}.` } : { ok: false, message: `${r.error}. ${r.rolledBack ? "The old version is running again." : ""}` };
      } catch (e) {
        return { ok: false, message: `Update failed, nothing was changed: ${(e as Error).message}` };
      } finally {
        busy = false;
      }
    },
  };
}

async function autoUpdateLoop(u: UpdateHooks) {
  await new Promise((r) => setTimeout(r, 2 * 60_000));
  for (;;) {
    try {
      if (loadSettings(home).autoUpdate) {
        const c = await u.check();
        const at = new Date().toLocaleString();
        if (c.error) lastNote = `${at}: ${c.error}`;
        else if (!c.available) lastNote = `${at}: you have the newest version.`;
        else if (c.version && failedVersions.has(c.version)) lastNote = `${at}: version ${c.version} failed before, not trying again until restart.`;
        else {
          console.log(`${new Date().toISOString()}  Automatic update to ${c.version}`);
          const r = await u.apply();
          if (!r.ok && c.version) failedVersions.add(c.version);
          lastNote = `${at}: ${r.message}`;
          console.log(`${new Date().toISOString()}  ${r.message}`);
        }
      }
    } catch (e) {
      lastNote = `Automatic update error: ${(e as Error).message}`;
    }
    await new Promise((r) => setTimeout(r, 6 * 3600_000));
  }
}

async function shareLoop() {
  const stateFile = join(home, "share-state.json");
  const walletFile = join(home, "wallet.json");
  const api = httpApi(apiBase);
  for (;;) {
    await new Promise((r) => setTimeout(r, 60_000));
    try {
      let keys: ReturnType<typeof readKey> | null = null;
      try {
        keys = existsSync(walletFile) ? readKey(walletFile) : null;
      } catch {
        keys = null;
      }
      const list = loadFriends(home);
      const rules = rulesOf(list);
      if (!keys || !list.shareEnabled || rules.length === 0) continue;
      const state: ShareState = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { baseline: null };
      const r = await runOnce(api, keys, rules, state, { minShareUnits: Math.round(0.01 * UNITS_PER_COIN), includeExisting: false });
      writeFileSync(stateFile, JSON.stringify(state));
      if (r.sent.length) console.log(`${new Date().toISOString()}  ${r.note}`);
    } catch (e) {
      console.log(`${new Date().toISOString()}  Share error: ${(e as Error).message}`);
    }
  }
}

const token = randomBytes(24).toString("hex");
const upd = updates();
const app = createUiApp({ home, apiBase, token, hosts: [`127.0.0.1:${port}`, `localhost:${port}`], version: installed, updates: upd, onWalletChanged: restartMiner, farmApi: process.env.ALBUS_FARM_API ?? "https://api.albus.workflowsolved.com" });
app.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`Albus miner UI: ${url}`);
  if (process.env.ALBUS_NO_BROWSER !== "1" && process.platform === "win32") execFile("cmd", ["/c", "start", "", url]);
});
void shareLoop();
if (upd) void autoUpdateLoop(upd);
