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

async function run(address: string, seed: string, difficulty: number, myGeneration: number) {
  const target = "0".repeat(difficulty);
  let nonce = 0;
  let hashes = 0;
  let lastReport = performance.now();

  while (generation === myGeneration) {
    const nonceHex = nonce.toString(16);
    const hash = bytesToHex(sha256(utf8ToBytes(`${seed}|${address}|${nonceHex}`)));
    hashes++;
    if (hash.startsWith(target)) {
      postMessage({ type: "share", nonce: nonceHex } satisfies OutMessage);
    }
    nonce++;

    if (nonce % 2000 === 0) {
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
}
