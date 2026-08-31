import { IV, sha256Compress } from "./sha256-reference.js";
import { SHA256_MINER_WGSL, MAX_FOUND_PER_DISPATCH } from "./sha256.wgsl.js";

// Runs as its own child process (see miner-controller.js), not a worker_thread
// — the WebGPU native binding (Dawn) segfaults when it shares a process with
// other active worker_threads, so the GPU miner needs a fully isolated
// process instead. This shim keeps the rest of the file's shape identical to
// worker.js's worker_threads-based postMessage/on("message") protocol.
const parentPort = {
  postMessage: (msg) => process.send(msg),
  on: (event, cb) => process.on(event === "message" ? "message" : event, cb),
};

// Threads per dispatch. Read back happens once per dispatch (a GPU/CPU sync
// point), so bigger batches amortize that cost better but make the worker
// slower to notice a new job (epoch rotation) — this is a reasonable middle
// ground for consumer GPUs.
const THREADS_PER_DISPATCH = 2_097_152; // 256 workgroup size * 8192 workgroups
const WORKGROUP_SIZE = 256;

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

  const navigator = { gpu: create([]) };
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no WebGPU adapter available");
  const device = await adapter.requestDevice();

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
