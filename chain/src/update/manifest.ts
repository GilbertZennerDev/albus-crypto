import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

export interface ManifestFile {
  path: string;
  sha256: string;
  size: number;
}

export interface Manifest {
  product: "albus";
  version: string;
  notes: string;
  created: number;
  files: ManifestFile[];
}

export interface Envelope {
  manifest: string;
  signatures: string[];
}

export const MAX_FILES = 2000;
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 600 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 1024 * 1024;

const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const HEX_RE = /^[0-9a-f]+$/;

export class UpdateError extends Error {}

export function signManifest(manifestText: string, privateKeyHex: string): string {
  return bytesToHex(ed25519.sign(utf8ToBytes(manifestText), hexToBytes(privateKeyHex)));
}

export function publicKeyOf(privateKeyHex: string): string {
  return bytesToHex(ed25519.getPublicKey(hexToBytes(privateKeyHex)));
}

export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

export function isSafeRelPath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > 200) return false;
  if (/[\\:\0*?"<>|]/.test(p) || p.startsWith("/") || p.includes("//")) return false;
  if (/[\u0000-\u001f]/.test(p)) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".." && !/[. ]$/.test(seg) && !/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(seg));
}

export function parseManifest(text: string): Manifest {
  if (text.length > MAX_MANIFEST_BYTES) throw new UpdateError("Update-Liste ist zu gross");
  let m: any;
  try {
    m = JSON.parse(text);
  } catch {
    throw new UpdateError("Update-Liste ist kein gueltiges JSON");
  }
  if (!m || typeof m !== "object" || m.product !== "albus") throw new UpdateError("Update-Liste gehoert nicht zu Albus");
  if (typeof m.version !== "string" || !VERSION_RE.test(m.version)) throw new UpdateError("Ungueltige Versionsnummer");
  if (typeof m.notes !== "string" || m.notes.length > 2000) throw new UpdateError("Ungueltige Notizen");
  if (!Number.isSafeInteger(m.created)) throw new UpdateError("Ungueltiges Datum");
  if (!Array.isArray(m.files) || m.files.length === 0 || m.files.length > MAX_FILES) throw new UpdateError("Ungueltige Dateiliste");
  const seen = new Set<string>();
  let total = 0;
  for (const f of m.files) {
    if (!f || typeof f !== "object" || !isSafeRelPath(f.path)) throw new UpdateError(`Unsicherer Dateipfad: ${String(f?.path)}`);
    if (typeof f.sha256 !== "string" || f.sha256.length !== 64 || !HEX_RE.test(f.sha256)) throw new UpdateError(`Ungueltige Pruefsumme bei ${f.path}`);
    if (!Number.isSafeInteger(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES) throw new UpdateError(`Ungueltige Groesse bei ${f.path}`);
    const key = f.path.toLowerCase();
    if (seen.has(key)) throw new UpdateError(`Datei doppelt in der Liste: ${f.path}`);
    seen.add(key);
    total += f.size;
  }
  if (total > MAX_TOTAL_BYTES) throw new UpdateError("Update ist zu gross");
  return m as Manifest;
}

export function verifyEnvelope(env: unknown, pinnedKeys: string[], installedVersion: string): Manifest {
  if (pinnedKeys.length === 0) throw new UpdateError("Kein Update-Schluessel eingebaut: Updates sind aus Sicherheitsgruenden aus");
  const e = env as Envelope;
  if (!e || typeof e.manifest !== "string" || !Array.isArray(e.signatures) || e.signatures.length > 8) throw new UpdateError("Update-Umschlag ist kaputt");
  const msg = utf8ToBytes(e.manifest);
  let ok = false;
  for (const sig of e.signatures) {
    if (typeof sig !== "string" || sig.length !== 128 || !HEX_RE.test(sig)) continue;
    for (const key of pinnedKeys) {
      try {
        if (ed25519.verify(hexToBytes(sig), msg, hexToBytes(key))) ok = true;
      } catch {
      }
    }
  }
  if (!ok) throw new UpdateError("Unterschrift der Update-Liste stimmt nicht");
  const m = parseManifest(e.manifest);
  if (compareVersions(m.version, installedVersion) <= 0) throw new UpdateError(`Version ${m.version} ist nicht neuer als ${installedVersion}`);
  return m;
}

export function sha256Hex(data: Uint8Array): string {
  return bytesToHex(sha256(data));
}
