import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { cpus, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import WebSocket from "ws";

const ADDRESS_RE = /^albus1[0-9a-f]{40}$/;
const CPU_NONCE_START = "1000000000000";
const argv = process.argv.slice(2);
const opt = (flag: string, env: string, dflt: string): string => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : (process.env[env] ?? dflt);
};

const address = opt("--address", "ALBUS_ADDRESS", "").trim().toLowerCase();
const chainWs = opt("--chain-ws", "ALBUS_CHAIN_WS", "wss://api.albus.workflowsolved.com/mining/ws");
const name = opt("--name", "ALBUS_NAME", hostname()).slice(0, 40);
const threads = Math.max(1, Number(opt("--threads", "ALBUS_THREADS", String(cpus().length))) || 1);
const duty = Math.min(100, Math.max(1, Number(opt("--duty", "ALBUS_DUTY", "100")) || 100));
const here = dirname(fileURLToPath(import.meta.url));
const exe = process.platform === "win32" ? "albus-cpu.exe" : "albus-cpu";
const cpuPath = opt("--cpu", "ALBUS_CPU", [join(here, exe), join(here, "..", "bin", exe), join(process.cwd(), exe)].find((p) => existsSync(p)) ?? join(here, exe));

const log = (m: string) => console.log(`${new Date().toISOString()}  ${m}`);

if (!ADDRESS_RE.test(address)) {
  console.error("Address missing or wrong. Use --address albus1... (the address of your wallet, no key needed).");
  process.exit(2);
}
if (!existsSync(cpuPath)) {
  console.error(`Miner program not found: ${cpuPath}`);
  process.exit(2);
}

let worker: ChildProcessWithoutNullStreams | null = null;
let workerReady = false;
let rate = 0;
let ws: WebSocket | null = null;
let wsOpen = false;
let curJob: { jobId: string; seed: string; shareDiff: number; blockDiff: number } | null = null;
let nextId = 1;
let stopping = false;
const stats = { accepted: 0, rejected: 0, blocks: 0 };

const toWorker = (line: string) => {
  if (worker && !worker.killed && worker.stdin.writable) worker.stdin.write(line + "\n");
};

function pushJob(): void {
  if (!curJob || !workerReady) return;
  toWorker(`job ${curJob.jobId} ${curJob.seed} ${address} ${curJob.shareDiff} ${curJob.blockDiff} ${CPU_NONCE_START}`);
}

function startWorker(): void {
  workerReady = false;
  const w = spawn(cpuPath, ["--threads", String(threads)], { stdio: ["pipe", "pipe", "pipe"] });
  worker = w;
  createInterface({ input: w.stdout }).on("line", (line) => {
    if (line.startsWith("share ")) {
      const [, jobId, nonce] = line.split(" ");
      if (wsOpen && jobId && nonce) {
        ws!.send(JSON.stringify({ type: "submit", id: nextId++, jobId, nonce }));
      }
    } else if (line.startsWith("hashrate ")) {
      rate = Number(line.split(" ")[1]) || 0;
    } else if (line.startsWith("ready ")) {
      workerReady = true;
      log(`Miner ready: ${line.slice(6)}`);
      toWorker(`duty ${duty}`);
      toWorker("resume");
      pushJob();
      connect();
    } else if (line.startsWith("fatal ")) {
      log(`Miner error: ${line.slice(6)}`);
    }
  });
  w.stderr.on("data", (d) => log(`miner: ${String(d).trim()}`));
  w.on("exit", (code) => {
    workerReady = false;
    if (stopping) return;
    log(`Miner stopped (code ${code}), restarting in 5 s`);
    setTimeout(startWorker, 5000);
  });
}

let backoff = 1000;
function connect(): void {
  if (stopping || ws) return;
  const s = new WebSocket(chainWs, { handshakeTimeout: 15000, maxPayload: 64 * 1024 });
  ws = s;
  s.on("open", () => {
    wsOpen = true;
    backoff = 1000;
    log(`Connected to ${chainWs} as "${name}"`);
    s.send(JSON.stringify({ type: "hello", address, name, agent: "albus-farm/1.0", hashrate: rate || 25_000_000 * threads }));
  });
  s.on("message", (data) => {
    let m: any;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (m.type === "job") {
      const same = curJob?.jobId === m.jobId;
      curJob = { jobId: String(m.jobId), seed: String(m.seed), shareDiff: Number(m.shareDifficulty), blockDiff: Number(m.blockDifficulty) };
      if (same) toWorker(`diff ${curJob.shareDiff} ${curJob.blockDiff}`);
      else {
        pushJob();
        log(`New job ${curJob.jobId}`);
      }
      s.send(JSON.stringify({ type: "job_ack", jobId: curJob.jobId }));
    } else if (m.type === "submit_result") {
      if (m.accepted) {
        stats.accepted++;
        if (m.isBlock) {
          stats.blocks++;
          log("BLOCK accepted by the chain");
        }
      } else stats.rejected++;
    } else if (m.type === "error") {
      log(`Server: ${data.toString().slice(0, 200)}`);
    }
  });
  const gone = (why: string) => {
    if (ws !== s) return;
    ws = null;
    wsOpen = false;
    if (stopping) return;
    log(`Connection lost (${why}), retry in ${Math.round(backoff / 1000)} s`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  };
  s.on("close", () => gone("closed"));
  s.on("error", (e) => gone(e.message));
}

setInterval(() => {
  if (wsOpen && rate > 0) ws!.send(JSON.stringify({ type: "hashrate", hashrate: rate }));
}, 10_000).unref();
setInterval(() => log(`${(rate / 1e6).toFixed(1)} MH/s, ${stats.accepted} shares accepted, ${stats.rejected} refused, ${stats.blocks} blocks`), 5 * 60_000).unref();

function stop(): void {
  stopping = true;
  toWorker("quit");
  ws?.close();
  setTimeout(() => process.exit(0), 800).unref();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

log(`Albus farm agent: ${name}, ${threads} threads, address ${address}`);
startWorker();
