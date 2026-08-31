#!/usr/bin/env node
import { Worker } from "node:worker_threads";
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  // Must stay comfortably below the server's epoch length (AUTO_MINE_INTERVAL_MS,
  // default 20s) — every share found against a seed the server has already
  // rotated away from is dead on arrival ("share does not meet difficulty"),
  // so polling too slowly just wastes real hashing work.
  const args = { workers: cpus().length, api: "http://localhost:4000", interval: 4_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--address") args.address = argv[++i];
    else if (a === "--api") args.api = argv[++i];
    else if (a === "--workers") args.workers = Number(argv[++i]);
    else if (a === "--interval") args.interval = Number(argv[++i]);
    else if (a === "--generate-wallet") args.generateWallet = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`Albus offline miner — mines PoW shares continuously and submits them to the API.

Usage:
  node src/index.js --address albus1... [--api https://api.albus.workflowsolved.com] [--workers N]
  node src/index.js --generate-wallet [--api https://api.albus.workflowsolved.com]

Options:
  --address <addr>   Wallet address to mine to (required unless --generate-wallet)
  --api <url>        Chain API base URL (default: http://localhost:4000)
  --workers <n>      Number of hashing threads (default: number of CPU cores)
  --interval <ms>    How often to poll for a fresh mining challenge (default: 10000)
  --generate-wallet  Create a new wallet via the API and print its keys, then exit
                      (SAVE the private key — it's the only way to spend earned ALB)
`);
}

async function generateWallet(api) {
  const res = await fetch(`${api}/wallet`, { method: "POST" });
  if (!res.ok) throw new Error(`wallet generation failed: ${res.status}`);
  const wallet = await res.json();
  console.log("New Albus wallet — save the private key somewhere safe, it is never shown again:\n");
  console.log(JSON.stringify(wallet, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();

  if (args.generateWallet) {
    await generateWallet(args.api);
    return;
  }

  if (!args.address || !args.address.startsWith("albus1")) {
    console.error("Error: --address <albus1...> is required (or use --generate-wallet to create one).\n");
    printHelp();
    process.exit(1);
  }

  console.log(`Albus miner starting — address ${args.address}, ${args.workers} threads, API ${args.api}`);

  const workers = [];
  const hashrates = new Map();
  let currentChallenge = null;
  let sharesAccepted = 0;
  let sharesRejected = 0;
  // Once the server says we've hit its per-IP share cap for this epoch, stop
  // spending round trips on submissions that can only be rejected — the
  // workers keep hashing locally (cheap) but we drop found shares on the
  // floor until the next challenge (new epoch) comes in.
  let capped = false;
  // A locally-valid share (it passed our own difficulty check before being
  // submitted) that the server rejects as "does not meet difficulty" almost
  // always means the epoch rotated between when we last polled and when we
  // found the share — waiting for the next scheduled poll wastes hashing
  // work on a dead seed in the meantime, so refetch immediately instead.
  // Debounced since a burst of stale shares would otherwise trigger a
  // refetch storm.
  let lastReactiveRefresh = 0;
  function refreshChallengeReactively() {
    const now = Date.now();
    if (now - lastReactiveRefresh < 500) return;
    lastReactiveRefresh = now;
    void refreshChallenge();
  }

  for (let i = 0; i < args.workers; i++) {
    const worker = new Worker(new URL("./worker.js", import.meta.url), {
      workerData: { workerId: i, stride: args.workers },
    });
    worker.on("message", (msg) => {
      if (msg.type === "hashrate") {
        hashrates.set(worker.threadId, msg.hashesPerSecond);
      } else if (msg.type === "share") {
        if (msg.seed !== currentChallenge?.seed) return; // stale share from a just-rotated epoch
        if (capped) return;
        submitShare(args.api, args.address, msg.nonce)
          .then((res) => {
            if (res.ok) {
              sharesAccepted++;
            } else {
              sharesRejected++;
              if (res.error === "share limit reached for this epoch") capped = true;
              else if (res.error === "share does not meet difficulty") refreshChallengeReactively();
            }
          })
          .catch(() => sharesRejected++);
      }
    });
    worker.on("error", (err) => console.error(`worker ${i} error:`, err));
    workers.push(worker);
  }

  async function refreshChallenge() {
    try {
      const res = await fetch(`${args.api}/mining/challenge`);
      const challenge = await res.json();
      if (challenge.seed !== currentChallenge?.seed) {
        currentChallenge = challenge;
        capped = false;
        for (const worker of workers) {
          worker.postMessage({ type: "job", seed: challenge.seed, difficulty: challenge.difficulty, address: args.address });
        }
      }
    } catch (err) {
      console.error("failed to fetch mining challenge:", err.message);
    }
  }

  async function submitShare(api, address, nonce) {
    const res = await fetch(`${api}/mining/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, nonce }),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({}));
    return { ok: false, error: body.error };
  }

  await refreshChallenge();
  const challengeTimer = setInterval(refreshChallenge, args.interval);

  const statsTimer = setInterval(() => {
    const total = [...hashrates.values()].reduce((sum, h) => sum + h, 0);
    console.log(
      `[${new Date().toLocaleTimeString()}] ${total.toFixed(0)} h/s total | shares accepted: ${sharesAccepted}, rejected: ${sharesRejected}${capped ? " (capped for this epoch)" : ""}`,
    );
  }, 5000);

  function shutdown() {
    console.log("\nStopping miner...");
    clearInterval(challengeTimer);
    clearInterval(statsTimer);
    for (const worker of workers) worker.postMessage({ type: "stop" });
    setTimeout(() => process.exit(0), 500);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
