/// <reference lib="webworker" />
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

type InMessage =
  | { type: "start"; address: string; seed: string; difficulty: number }
  | { type: "stop" };

type OutMessage = { type: "share"; nonce: string } | { type: "hashrate"; hashesPerSecond: number };

let generation = 0;

self.onmessage = (e: MessageEvent<InMessage>) => {
  const msg = e.data;
  if (msg.type === "stop") {
    generation++;
    return;
  }
  const myGeneration = ++generation;
  void run(msg.address, msg.seed, msg.difficulty, myGeneration);
};

// How many hashes between checking the clock / yielding to the event loop.
// Too small and per-iteration overhead (performance.now(), await) dominates;
// too large and the worker is slow to notice a stop/restart. This value
// keeps yields to roughly every few milliseconds even at multi-MH/s rates.
const CLOCK_CHECK_EVERY = 4096;

async function run(address: string, seed: string, difficulty: number, myGeneration: number) {
  const target = "0".repeat(difficulty);
  // Hash the fixed `${seed}|${address}|` prefix once and clone that digest
  // state per attempt, so SHA-256 only redoes compression on the (short)
  // nonce suffix instead of the whole prefix every single hash.
  const base = sha256.create().update(utf8ToBytes(`${seed}|${address}|`));
  let nonce = 0;
  let hashes = 0;
  let lastReport = performance.now();

  outer: while (generation === myGeneration) {
    for (let i = 0; i < CLOCK_CHECK_EVERY; i++) {
      const nonceHex = nonce.toString(16);
      const hash = bytesToHex(base.clone().update(utf8ToBytes(nonceHex)).digest());
      hashes++;
      if (hash.startsWith(target)) {
        postMessage({ type: "share", nonce: nonceHex } satisfies OutMessage);
      }
      nonce++;
      if (generation !== myGeneration) break outer;
    }

    const now = performance.now();
    const elapsed = now - lastReport;
    if (elapsed > 500) {
      postMessage({ type: "hashrate", hashesPerSecond: (hashes / elapsed) * 1000 } satisfies OutMessage);
      hashes = 0;
      lastReport = now;
    }
    // yield so the worker stays responsive to stop/start messages
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
