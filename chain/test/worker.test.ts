import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Blockchain } from "../src/blockchain.js";
import { MAINNET_PARAMS, UNITS_PER_COIN } from "../src/params.js";
import { hexZerosFloor } from "../src/difficulty.js";

const BIN = process.env.ALBUS_BIN ?? "D:\\app-builder\\AlbusCrypto\\fresh-worker\\build\\bin";
const EXE = join(BIN, "albus-gpu.exe");
const ADDR = "albus1" + "e".repeat(40);

test("native GPU worker finds blocks that a second node accepts", { skip: !existsSync(EXE), timeout: 90_000 }, async () => {
  const a = new Blockchain({ ...MAINNET_PARAMS, initialReward: 210 * UNITS_PER_COIN, initialDifficulty: 128, retargetTauMs: 1e15 }, null);
  const b = new Blockchain({ ...MAINNET_PARAMS, initialReward: 210 * UNITS_PER_COIN, initialDifficulty: 128, retargetTauMs: 1e15 }, null);
  const w = spawn(EXE, ["--device", "0", "--target-ms", "20"], { stdio: ["pipe", "pipe", "ignore"] });
  const rl = createInterface({ input: w.stdout });
  let job = "";
  let tmpl = a.buildTemplate(ADDR);
  const send = () => {
    job = `${tmpl.index}:${tmpl.seed}`;
    w.stdin.write(`job ${job} ${tmpl.seed} ${ADDR} ${Math.min(hexZerosFloor(tmpl.difficulty), 4)} ${hexZerosFloor(tmpl.difficulty)} 0\n`);
  };
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("zu langsam")), 80_000);
    rl.on("line", (line) => {
      const t = line.trim().split(/\s+/);
      if (t[0] === "fatal") return reject(new Error(line));
      if (t[0] === "ready") {
        w.stdin.write("duty 100\nresume\n");
        return send();
      }
      if (t[0] !== "share" || t[3] !== "1" || t[1] !== job) return;
      const { result, block } = a.submitSolved(tmpl, t[2]);
      assert.equal(result.status, "added", JSON.stringify(result));
      assert.equal(b.addBlock(block, "net").status, "added");
      if (a.height >= 5) {
        clearTimeout(timer);
        resolve();
      } else {
        tmpl = a.buildTemplate(ADDR);
        send();
      }
    });
  });
  try {
    await done;
  } finally {
    w.stdin.write("quit\n");
    setTimeout(() => w.kill(), 1500).unref();
  }
  assert.equal(a.height, 5);
  assert.equal(b.tip.hash, a.tip.hash);
  assert.equal(b.getAccount(ADDR).total, 5 * 210 * UNITS_PER_COIN);
});
