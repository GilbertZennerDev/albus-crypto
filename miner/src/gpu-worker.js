import { IV, sha256Compress } from "./sha256-reference.js";
import { SHA256_MINER_WGSL, MAX_FOUND_PER_DISPATCH } from "./sha256.wgsl.js";

// Runs as its own child process (see miner-controller.js), not a worker_thread
// — the WebGPU native binding (Dawn) segfaults when it shares a process with
// other active worker_threads, so the GPU miner needs a fully isolated
// process instead. This shim keeps the rest of the file's shape identical to
// worker.js's worker_threads-based postMessage/on("message") protocol.
//
// Tried swapping to @sylphx/webgpu (wgpu-rs based, not Dawn) to sidestep
// Dawn's sustained-load instability (see miner-controller.js) — reverted:
// every published version (0.13.0 through the current 1.0.5) ships a macOS
// ARM64 Mach-O binary inside its win32-x64-msvc package by mistake, so it
// doesn't run on Windows at all. Worth revisiting if that upstream bug ever
// gets fixed.
const parentPort = {
  postMessage: (msg) => process.send(msg),
  on: (event, cb) => process.on(event === "message" ? "message" : event, cb),
};

// Threads per dispatch. Read back happens once per dispatch (a GPU/CPU sync
// point), so bigger batches amortize that cost better but make the worker
// slower to notice a new job (epoch rotation), and — per real-world reports
// of crashes on at least one RTX card — bigger batches also seem to
// correlate with instability in this Node WebGPU binding. MinerController
// shrinks this (via env var) on each auto-restart after a crash, so a card
// that can't sustain the default settles at whatever batch size it can.
const WORKGROUP_SIZE = 256;
const THREADS_PER_DISPATCH = Number(process.env.GPU_THREADS_PER_DISPATCH) || 2_097_152;

let baseNonce = 0;
let currentJob = null; // { seed, address, difficulty }
let running = true;

function bytesFromAscii(str) {
  return Buffer.from(str, "utf-8");
}

/** Precomputes the midstate after the job's fixed 80-byte `${seed}|${address}|` prefix's first 64 bytes. */
function prepareJob(seed, address, difficulty) {
  const prefix = `${seed}|${address}|`;
  const prefixBytes = bytesFromAscii(prefix);
  if (prefixBytes.length !== 80) {
    // The kernel hardcodes the 96-byte total message layout (80-byte prefix +
    // 16-char nonce), which assumes exactly this seed/address length — a
    // format change on the server side would silently break GPU mining.
    throw new Error(`GPU miner expects an 80-byte seed|address| prefix, got ${prefixBytes.length}`);
  }
  const block0 = prefixBytes.subarray(0, 64);
  const tail16 = prefixBytes.subarray(64, 80);
  const midstate = sha256Compress(IV, block0);
  const tailWords = new Uint32Array(4);
  for (let i = 0; i < 4; i++) {
    tailWords[i] = (tail16[i * 4] << 24) | (tail16[i * 4 + 1] << 16) | (tail16[i * 4 + 2] << 8) | tail16[i * 4 + 3];
  }
  return { seed, midstate, tailWords, difficulty };
}

async function main() {
  const { create, globals } = await import("webgpu");
  const { GPUBufferUsage, GPUMapMode } = globals;

  // On Windows, letting Dawn auto-pick a backend can land on Vulkan (a
  // translation layer on some driver/OS combos) instead of D3D12 (Dawn's
  // most mature, native Windows backend) — a plausible contributor to the
  // sustained-load crashes this file otherwise works around via process
  // isolation and batch shrinking. Forcing d3d12 explicitly is documented,
  // low-risk, and worth it even if it only reduces crash frequency rather
  // than eliminating it outright. Falls back to Dawn's own auto-selection
  // if d3d12 isn't available on this machine (e.g. non-Windows).
  const dawnArgs = process.platform === "win32" ? ["backend=d3d12"] : [];
  let navigator = { gpu: create(dawnArgs) };
  let adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter && dawnArgs.length > 0) {
    navigator = { gpu: create([]) };
    adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  }
  if (!adapter) throw new Error("no WebGPU adapter available");
  const device = await adapter.requestDevice();

  // A lost device (driver reset/TDR, out-of-memory, etc.) turns further GPU
  // calls into either rejected promises or — on this binding, at least
  // sometimes — a native crash if we keep calling into it regardless. Catch
  // the graceful signal when the binding gives us one, and stop cleanly
  // instead of continuing to hammer a dead device.
  device.lost.then((info) => {
    running = false;
    parentPort.postMessage({ type: "gpu-error", error: `GPU device lost: ${info.message || info.reason}` });
    process.exit(1);
  });

  const module = device.createShaderModule({ code: SHA256_MINER_WGSL });
  const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });

  const PARAMS_SIZE = 64; // 3x vec4<u32> + 4x u32, see sha256.wgsl.js's Params struct
  const paramsBuf = device.createBuffer({ size: PARAMS_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const countBuf = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const noncesBuf = device.createBuffer({ size: MAX_FOUND_PER_DISPATCH * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readCountBuf = device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const readNoncesBuf = device.createBuffer({ size: MAX_FOUND_PER_DISPATCH * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const zero4 = new Uint32Array(1);

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: paramsBuf } },
      { binding: 1, resource: { buffer: countBuf } },
      { binding: 2, resource: { buffer: noncesBuf } },
    ],
  });

  let hashesSinceReport = 0;
  let lastReport = Date.now();

  parentPort.postMessage({ type: "ready" });

  while (running) {
    if (!currentJob) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    const job = currentJob;

    const params = new Uint32Array(16);
    params.set(job.midstate.subarray(0, 4), 0); // h0123
    params.set(job.midstate.subarray(4, 8), 4); // h4567
    params.set(job.tailWords, 8); // tail
    params[12] = baseNonce >>> 0;
    params[13] = job.difficulty;
    device.queue.writeBuffer(paramsBuf, 0, params);
    device.queue.writeBuffer(countBuf, 0, zero4);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(THREADS_PER_DISPATCH / WORKGROUP_SIZE);
    pass.end();
    encoder.copyBufferToBuffer(countBuf, 0, readCountBuf, 0, 4);
    encoder.copyBufferToBuffer(noncesBuf, 0, readNoncesBuf, 0, MAX_FOUND_PER_DISPATCH * 4);
    device.queue.submit([encoder.finish()]);
    // Explicit wait on top of mapAsync's own — cheap, and defends against
    // this binding's mapAsync not always fully waiting for prior queued work
    // before resolving (suspected contributor to the crashes this guards).
    await device.queue.onSubmittedWorkDone();

    await readCountBuf.mapAsync(GPUMapMode.READ);
    const foundCount = Math.min(new Uint32Array(readCountBuf.getMappedRange().slice(0))[0], MAX_FOUND_PER_DISPATCH);
    readCountBuf.unmap();

    if (foundCount > 0) {
      await readNoncesBuf.mapAsync(GPUMapMode.READ);
      const nonces = new Uint32Array(readNoncesBuf.getMappedRange().slice(0, foundCount * 4));
      readNoncesBuf.unmap();
      for (const nonce of nonces) {
        const nonceHex = nonce.toString(16).padStart(16, "0");
        parentPort.postMessage({ type: "share", nonce: nonceHex, seed: job.seed });
      }
    }

    baseNonce = (baseNonce + THREADS_PER_DISPATCH) >>> 0;
    hashesSinceReport += THREADS_PER_DISPATCH;

    const now = Date.now();
    const elapsed = now - lastReport;
    if (elapsed > 500) {
      parentPort.postMessage({ type: "hashrate", hashesPerSecond: (hashesSinceReport / elapsed) * 1000 });
      hashesSinceReport = 0;
      lastReport = now;
    }
  }
}

parentPort.on("message", (msg) => {
  if (msg.type === "job") {
    try {
      currentJob = prepareJob(msg.seed, msg.address, msg.difficulty);
      baseNonce = 0;
    } catch (err) {
      parentPort.postMessage({ type: "gpu-error", error: err.message });
      currentJob = null;
    }
  } else if (msg.type === "stop") {
    running = false;
    process.exit(0);
  }
});

main().catch((err) => {
  parentPort.postMessage({ type: "gpu-error", error: err.message });
  process.exit(1);
});
