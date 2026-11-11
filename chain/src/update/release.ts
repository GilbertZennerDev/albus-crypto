import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex } from "@noble/hashes/utils";
import { isSafeRelPath, publicKeyOf, sha256Hex, signManifest, type Envelope, type Manifest } from "./manifest.js";

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [relative(base, p).split("\\").join("/")];
  });
}

export function buildRelease(srcDir: string, outDir: string, version: string, notes: string, privateKeyHex: string, now = Date.now()): Manifest {
  const files = walk(srcDir).sort().map((path) => {
    if (!isSafeRelPath(path)) throw new Error(`Unsicherer Dateiname im Quellordner: ${path}`);
    const bytes = readFileSync(join(srcDir, path));
    return { path, sha256: sha256Hex(bytes), size: bytes.length };
  });
  if (files.length === 0) throw new Error("Quellordner ist leer");
  const m: Manifest = { product: "albus", version, notes, created: now, files };
  const text = JSON.stringify(m);
  for (const f of files) {
    const dest = join(outDir, version, f.path);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(srcDir, f.path), dest);
  }
  const env: Envelope = { manifest: text, signatures: [signManifest(text, privateKeyHex)] };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(env));
  return m;
}

function main() {
  const [cmd, src, out, version, notes] = process.argv.slice(2);
  const keyFile = process.env.RELEASE_KEY_FILE;
  if (!keyFile) throw new Error("RELEASE_KEY_FILE fehlt (Pfad zur geheimen Schluesseldatei, ausserhalb des Repos)");
  if (cmd === "keygen") {
    if (existsSync(keyFile)) throw new Error(`${keyFile} gibt es schon, ich ueberschreibe keinen Schluessel`);
    const priv = bytesToHex(ed25519.utils.randomPrivateKey());
    writeFileSync(keyFile, priv + "\n", { flag: "wx" });
    console.log(`Geheimer Schluessel gespeichert in ${keyFile}. Sichere ihn offline, verliere ihn nicht.\nOEFFENTLICHER Schluessel (in src/update/pinned-keys.ts eintragen):\n${publicKeyOf(priv)}`);
  } else if (cmd === "build") {
    if (!src || !out || !version) throw new Error("Aufruf: build <quellordner> <ausgabeordner> <version> \"<notizen>\"");
    if (!statSync(src).isDirectory()) throw new Error("Quellordner fehlt");
    const priv = readFileSync(keyFile, "utf8").trim();
    const m = buildRelease(src, out, version, notes ?? "", priv);
    console.log(`Release ${m.version}: ${m.files.length} Dateien, signiert. Zum Hochladen: ${out}`);
  } else throw new Error("Befehl: keygen oder build");
}

if (process.argv[1] && /release\.(ts|js)$/.test(process.argv[1])) {
  try {
    main();
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
