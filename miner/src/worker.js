import { createHash } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";

// Each worker mines a disjoint slice of the nonce space (nonce = start, start+stride,
// start+2*stride, ...) so N workers never waste effort re-checking each other's nonces.
const { workerId, stride } = workerData;

// The `${seed}|${address}|` prefix is fixed for an entire job (millions of
// hash attempts). Hashing it fresh on every attempt means SHA-256 redoes the
// same compression rounds over and over for no reason — instead we hash the
// prefix once into a base digest state and .copy() that state per attempt,
// so each hash only pays for compressing the (short) nonce suffix.
let baseHash = null;
let target = "";
let seed = null;
let nonce = workerId;
let hashesSinceReport = 0;
let lastReport = Date.now();

const CLOCK_CHECK_EVERY = 8192;

parentPort.on("message", (msg) => {
  if (msg.type === "job") {
    seed = msg.seed;
    baseHash = createHash("sha256").update(`${msg.seed}|${msg.address}|`);
    target = "0".repeat(msg.difficulty);
    nonce = workerId; // restart this worker's slice of the space for the new challenge
  } else if (msg.type === "stop") {
    process.exit(0);
  }
});

function tick() {
  if (baseHash) {
    const batchEnd = Date.now() + 200; // hash in short bursts so we stay responsive to new jobs
    let sinceClockCheck = 0;
    for (;;) {
      const nonceHex = nonce.toString(16);
      const hash = baseHash.copy().update(nonceHex).digest("hex");
      hashesSinceReport++;
      if (hash.startsWith(target)) {
        parentPort.postMessage({ type: "share", nonce: nonceHex, seed });
      }
      nonce += stride;

      if (++sinceClockCheck >= CLOCK_CHECK_EVERY) {
        sinceClockCheck = 0;
        if (Date.now() >= batchEnd) break;
      }
    }
  }

  const now = Date.now();
  const elapsed = now - lastReport;
  if (elapsed > 1000) {
    parentPort.postMessage({ type: "hashrate", hashesPerSecond: (hashesSinceReport / elapsed) * 1000 });
    hashesSinceReport = 0;
    lastReport = now;
  }

  setImmediate(tick);
}

tick();
