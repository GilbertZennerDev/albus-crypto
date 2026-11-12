import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Settings {
  autoUpdate: boolean;
}

export const DEFAULT_SETTINGS: Settings = { autoUpdate: true };

export function loadSettings(home: string): Settings {
  try {
    const f = join(home, "settings.json");
    if (!existsSync(f)) return { ...DEFAULT_SETTINGS };
    const j = JSON.parse(readFileSync(f, "utf8"));
    return { autoUpdate: typeof j.autoUpdate === "boolean" ? j.autoUpdate : DEFAULT_SETTINGS.autoUpdate };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(home: string, s: Settings): void {
  const f = join(home, "settings.json");
  writeFileSync(f + ".tmp", JSON.stringify(s, null, 2));
  renameSync(f + ".tmp", f);
}
