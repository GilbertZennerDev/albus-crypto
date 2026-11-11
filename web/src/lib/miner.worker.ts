/// <reference lib="webworker" />
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils";

type InMessage =
  | { type: "start"; address: string; seed: string; target: string }
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
  void run(msg.address, msg.seed, msg.target, myGeneration);
};

const CLOCK_CHECK_EVERY = 4096;

async function run(address: string, seed: string, target: string, myGeneration: number) {
  const msgBuf = concatBytes(sha256(concatBytes(hexToBytes(seed), hexToBytes(address.slice(6)))), new Uint8Array(8));
  const nonceView = new DataView(msgBuf.buffer, 32, 8);
  let nonce = 0;
  let hashes = 0;
  let lastReport = performance.now();

  outer: while (generation === myGeneration) {
    for (let i = 0; i < CLOCK_CHECK_EVERY; i++) {
      nonceView.setUint32(0, Math.floor(nonce / 4294967296));
      nonceView.setUint32(4, nonce >>> 0);
      const hash = bytesToHex(sha256(msgBuf));
      hashes++;
      if (hash < target) {
        postMessage({ type: "share", nonce: nonce.toString(16).padStart(16, "0") } satisfies OutMessage);
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
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
