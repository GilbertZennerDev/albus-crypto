#!/usr/bin/env node
import { cpus } from "node:os";
import { MinerController, generateWallet } from "./miner-controller.js";
import { startControlServer } from "./server.js";

function parseArgs(argv) {
  // Must stay comfortably below the server's epoch length (AUTO_MINE_INTERVAL_MS,
  // default 20s) — every share found against a seed the server has already
  // rotated away from is dead on arrival ("share does not meet difficulty"),
  // so polling too slowly just wastes real hashing work.
  const args = { workers: cpus().length, api: "http://localhost:4000", interval: 4_000, port: 5178, gpu: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--address") args.address = argv[++i];
    else if (a === "--api") args.api = argv[++i];
    else if (a === "--workers") args.workers = Number(argv[++i]);
    else if (a === "--interval") args.interval = Number(argv[++i]);
    else if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--generate-wallet") args.generateWallet = true;
    else if (a === "--ui") args.ui = true;
    else if (a === "--no-gpu") args.gpu = false;
    else if (a === "--gpu-batch-size") args.gpuBatchSize = Number(argv[++i]);
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`Albus miner — mines PoW shares continuously and submits them to the API.

Headless (mines immediately, logs to console):
  node src/index.js --address albus1... [--api https://api.albus.workflowsolved.com] [--workers N]

Web UI (control start/stop and watch live stats from a browser):
  node src/index.js --ui [--port 5178] [--api https://api.albus.workflowsolved.com]
  then open http://localhost:5178

Wallet:
  node src/index.js --generate-wallet [--api https://api.albus.workflowsolved.com]

Options:
  --address <addr>   Wallet address to mine to (required unless --ui or --generate-wallet)
  --api <url>        Chain API base URL (default: http://localhost:4000)
  --workers <n>      Number of hashing threads (default: number of CPU cores)
  --interval <ms>    How often to poll for a fresh mining challenge (default: 4000)
  --no-gpu           Disable GPU mining (on by default; falls back to CPU-only automatically
                      if no compatible GPU/driver is found)
  --gpu-batch-size <n>  Threads per GPU dispatch (default: 2097152). If GPU mining crashes
                      repeatedly on your card, try starting smaller (e.g. 262144) instead of
                      waiting for the automatic per-crash shrink to get there
  --ui               Start the local web control panel instead of mining immediately
  --port <n>         Port for --ui (default: 5178)
  --generate-wallet  Create a new wallet via the API and print its keys, then exit
                      (SAVE the private key — it's the only way to spend earned ALB)
`);
}

async function runHeadless(args) {
  console.log(
    `Albus miner starting — address ${args.address}, ${args.workers} CPU threads${args.gpu ? " + GPU (if available)" : ""}, API ${args.api}`,
  );

  const controller = new MinerController();
  controller.start({
    address: args.address,
    api: args.api,
    workers: args.workers,
    interval: args.interval,
    gpu: args.gpu,
    gpuBatchSize: args.gpuBatchSize,
  });

  const statsTimer = setInterval(() => {
    const s = controller.getStatus();
    const gpuNote = s.gpuRequested ? (s.gpuActive ? " [GPU active]" : " [GPU unavailable]") : "";
    console.log(
      `[${new Date().toLocaleTimeString()}] ${s.hashrate.toFixed(0)} h/s total${gpuNote} | shares accepted: ${s.sharesAccepted}, rejected: ${s.sharesRejected}${s.capped ? " (capped for this epoch)" : ""}`,
    );
    if (s.lastError) console.error(s.lastError);
  }, 5000);

  const shutdown = () => {
    console.log("\nStopping miner...");
    clearInterval(statsTimer);
    controller.stop();
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();

  if (args.generateWallet) {
    const wallet = await generateWallet(args.api);
    console.log("New Albus wallet — save the private key somewhere safe, it is never shown again:\n");
    console.log(JSON.stringify(wallet, null, 2));
    return;
  }

  if (args.ui) {
    startControlServer(args.port, { api: args.api });
    return;
  }

  if (!args.address || !args.address.startsWith("albus1")) {
    console.error("Error: --address <albus1...> is required (or use --ui / --generate-wallet).\n");
    printHelp();
    process.exit(1);
  }

  await runHeadless(args);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
