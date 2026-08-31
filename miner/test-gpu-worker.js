import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";

const seed = randomBytes(16).toString("hex"); // 32 hex chars
const address = "albus1" + randomBytes(20).toString("hex"); // 46 chars
const difficulty = 4;

console.log("seed:", seed);
console.log("address:", address);
console.log("difficulty:", difficulty);

const gpuWorkerPath = fileURLToPath(new URL("./src/gpu-worker.js", import.meta.url));
const worker = fork(gpuWorkerPath, { stdio: ["ignore", "inherit", "inherit", "ipc"] });

let sharesFound = 0;
let allValid = true;
let hashrateSeen = 0;

worker.on("message", (msg) => {
  if (msg.type === "ready") {
    console.log("GPU worker ready, sending job...");
    worker.send({ type: "job", seed, address, difficulty });
  } else if (msg.type === "hashrate") {
    hashrateSeen = msg.hashesPerSecond;
    console.log("hashrate:", (msg.hashesPerSecond / 1e6).toFixed(2), "MH/s");
  } else if (msg.type === "share") {
    sharesFound++;
    const fullMessage = `${seed}|${address}|${msg.nonce}`;
    const realHash = createHash("sha256").update(fullMessage, "utf-8").digest("hex");
    const target = "0".repeat(difficulty);
    const valid = realHash.startsWith(target);
    if (!valid) allValid = false;
    if (sharesFound % 500 === 0) console.log(`share #${sharesFound}: nonce=${msg.nonce} hash=${realHash} valid=${valid}`);
  } else if (msg.type === "gpu-error") {
    console.error("GPU ERROR:", msg.error);
    process.exit(1);
  }
});

worker.on("exit", (code) => {
  if (code !== null && code !== 0) {
    console.error(`GPU worker process exited with code ${code}`);
    process.exit(1);
  }
});

setTimeout(() => {
  worker.send({ type: "stop" });
  console.log(`\nDone. Shares found: ${sharesFound}, all valid: ${allValid}, last hashrate: ${(hashrateSeen / 1e6).toFixed(2)} MH/s`);
  setTimeout(() => process.exit(allValid && sharesFound > 0 ? 0 : 1), 300);
}, 8000);
