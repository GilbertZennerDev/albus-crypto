import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const shaBuf = (b) => createHash("sha256").update(b).digest();

let st = 0x9e3779b97f4a7c15n;
const rnd64 = () => {
  st ^= st << 13n; st &= 0xffffffffffffffffn;
  st ^= st >> 7n;
  st ^= st << 17n; st &= 0xffffffffffffffffn;
  return st;
};
const rndHex = (n) => { let s = ""; while (s.length < n) s += rnd64().toString(16).padStart(16, "0"); return s.slice(0, n); };
const nonceHex = (n) => n.toString(16).padStart(16, "0");

const innerOf = (job) => shaBuf(Buffer.concat([Buffer.from(job.seed, "hex"), Buffer.from(job.address.slice(6), "hex")]));
const proof = (job, nonce) => {
  const n = Buffer.alloc(8);
  n.writeBigUInt64BE(nonce);
  return shaBuf(Buffer.concat([innerOf(job), n]));
};

const jobs = [];
for (let i = 0; i < 4; i++) jobs.push({ seed: rndHex(64), address: "albus1" + rndHex(40) });
jobs.push({ seed: "0".repeat(64), address: "albus1" + "0".repeat(40) });
jobs.push({ seed: "f".repeat(64), address: "albus1" + "f".repeat(40) });

const MAX = 0xffffffffffffffffn;
const vectors = [];
for (const job of jobs) {
  const ns = [0n, 1n, 0xfn, 0x10n, 0xffn, 0xffffn, 0xfffffffn, 0xffffffffn, 0x100000000n, 0x100000001n, 0x1ffffffffn, 0x200000000n,
    0xfffffffffn, 0x123456789abcdefn, 0x8000000000000000n, MAX - 1n, MAX];
  for (let i = 0; i < 6; i++) ns.push(rnd64());
  for (const n of ns) vectors.push({ ...job, nonce: nonceHex(n), hash: proof(job, n).toString("hex") });
}

const scans = [];
const scanJob = jobs[0];
const scanSpecs = [
  [0n, 1n << 22n, 3],
  [0xfffffn - 200000n, 1n << 20n, 3],
  [0xffffffffn - 500000n, 1n << 20n, 3],
  [0x1ffffffffn - 100000n, 1n << 18n, 2],
  [0xfffffffffn - 100000n, 1n << 18n, 2],
  [0x123456789000n, 1n << 20n, 3],
  [0x7fffffff00000000n - 1000n, 1n << 16n, 2],
  [MAX - 70000n, 70001n, 2],
];
for (const [start, count, diff] of scanSpecs) {
  const hits = [];
  const want = "0".repeat(diff);
  const inner = innerOf(scanJob);
  const buf = Buffer.concat([inner, Buffer.alloc(8)]);
  for (let i = 0n; i < count; i++) {
    buf.writeBigUInt64BE(start + i, 32);
    if (shaBuf(buf).toString("hex").startsWith(want)) hits.push(nonceHex(start + i));
  }
  scans.push({ ...scanJob, start: nonceHex(start), count: count.toString(), diff, hits });
}

const targets = [];
for (let n = 1; n <= 10; n++) {
  const zeros = "0".repeat(n);
  targets.push({ n, below: zeros + "f".repeat(64 - n), exact: zeros + "1" + "0".repeat(63 - n), fail: "0".repeat(n - 1) + "1" + "f".repeat(64 - n) });
}

writeFileSync(join(here, "vectors.json"), JSON.stringify({ vectors, scans, targets }, null, 1));
console.log(`vectors=${vectors.length} scans=${scans.map((s) => s.hits.length).join(",")} targets=${targets.length}`);
