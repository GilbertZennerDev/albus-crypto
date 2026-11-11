import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { calculateProofHash, hashHasHexZeros , nonceHex } from "../src/block.js";

const PORT = 4121;
const A = "albus1" + "1".repeat(40);
const B = "albus1" + "2".repeat(40);

function grind(seed: string, address: string, difficulty: number): string {
  for (let n = 0; ; n++) {
    const nonce = nonceHex(n);
    if (hashHasHexZeros(calculateProofHash(seed, address, nonce), difficulty)) return nonce;
  }
}

type Msg = Record<string, any>;

function client(address: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/mining/ws`);
  const inbox: Msg[] = [];
  const waiters: Array<() => void> = [];
  ws.on("message", (d) => {
    inbox.push(JSON.parse(d.toString()));
    waiters.splice(0).forEach((w) => w());
  });
  const next = async (pred: (m: Msg) => boolean, ms = 8000): Promise<Msg> => {
    const end = Date.now() + ms;
    for (;;) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(i, 1)[0];
      if (Date.now() > end) throw new Error("Timeout, Inbox: " + JSON.stringify(inbox));
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 200);
      });
    }
  };
  const open = new Promise<void>((r, j) => {
    ws.on("open", () => r());
    ws.on("error", j);
  });
  const send = (m: Msg) => ws.send(JSON.stringify(m));
  return { ws, next, send, open, hello: () => send({ type: "hello", address, agent: "albus-supervisor/1.0", hashrate: 6e9 }) };
}

test("Mining feed: hello -> job -> submit -> block; a second worker then gets a new job", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "albus-feed-"));
  const node = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: dir, INITIAL_DIFFICULTY: "128", RETARGET_TAU_MS: "1e15", CPU_MINE: "" },
    stdio: "ignore",
  });
  try {
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/info`)).ok) break;
      } catch {}
      if (i > 60) throw new Error("Knoten startet nicht");
      await new Promise((r) => setTimeout(r, 250));
    }
    const a = client(A);
    const b = client(B);
    await Promise.all([a.open, b.open]);
    a.hello();
    b.hello();
    await a.next((m) => m.type === "hello_ack");
    const jobA = await a.next((m) => m.type === "job");
    const jobB = await b.next((m) => m.type === "job");
    for (const j of [jobA, jobB]) {
      assert.equal(typeof j.jobId, "string");
      assert.match(j.seed, /^[0-9a-f]{64}$/);
      assert.equal(j.blockDifficulty, 2);
      assert.equal(typeof j.shareDifficulty, "number");
      assert.equal(typeof j.epoch, "number");
    }
    a.send({ type: "job_ack", jobId: jobA.jobId });
    a.send({ type: "hashrate", hashrate: 6e9 });

    a.send({ type: "submit", id: 1, jobId: "0:deadbeef", nonce: nonceHex(0) });
    const stale = await a.next((m) => m.type === "submit_result" && m.id === 1);
    assert.equal(stale.accepted, false);
    assert.equal(stale.code, "stale-job");

    b.send({ type: "submit", id: 7, jobId: jobB.jobId, nonce: grind(jobB.seed, B, jobB.blockDifficulty) });
    const ok = await b.next((m) => m.type === "submit_result" && m.id === 7);
    assert.equal(ok.accepted, true, JSON.stringify(ok));
    assert.equal(ok.isBlock, true);
    assert.equal(ok.code, "ok");

    const info: any = await (await fetch(`http://127.0.0.1:${PORT}/info`)).json();
    assert.equal(info.height, 1);
    const bal: any = await (await fetch(`http://127.0.0.1:${PORT}/balance/${B}`)).json();
    assert.equal(bal.total, 10 * 100_000_000);

    const fresh = await a.next((m) => m.type === "job" && m.jobId !== jobA.jobId);
    assert.equal(fresh.clean, true);
    assert.ok(fresh.jobId.startsWith("2:"), fresh.jobId);

    a.send({ type: "submit", id: 2, jobId: jobA.jobId, nonce: nonceHex(0) });
    assert.equal((await a.next((m) => m.type === "submit_result" && m.id === 2)).code, "stale-job");
    a.send({ type: "submit", id: 3, jobId: fresh.jobId, nonce: grind(fresh.seed, A, fresh.blockDifficulty) });
    const ok2 = await a.next((m) => m.type === "submit_result" && m.id === 3);
    assert.equal(ok2.isBlock, true);
    const balA: any = await (await fetch(`http://127.0.0.1:${PORT}/balance/${A}`)).json();
    assert.equal(balA.total, 10 * 100_000_000);
    a.ws.close();
    b.ws.close();
  } finally {
    node.kill();
    await new Promise((r) => setTimeout(r, 500));
    rmSync(dir, { recursive: true, force: true });
  }
});
