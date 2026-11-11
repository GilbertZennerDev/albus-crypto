import { createHash } from "node:crypto";

const base = process.env.CHAIN ?? "127.0.0.1:4000";
const seconds = Number(process.argv[2] ?? 20);
const hint = Number(process.argv[3] ?? 0);
const address = "albus1" + "ab".repeat(20);

const ws = new WebSocket(`ws://${base}/mining/ws`);
let job = null, inner = null, nonce = 0, sent = 0, id = 0;
const res = { accepted: 0, blocks: 0 }, rej = {};

ws.onopen = () => ws.send(JSON.stringify({ type: "hello", address, agent: "node-test", hashrate: hint }));
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.type === "job") {
    job = m;
    inner = createHash("sha256").update(Buffer.from(m.seed + address.slice(6), "hex")).digest();
    if (m.clean) nonce = 0;
    ws.send(JSON.stringify({ type: "job_ack", jobId: m.jobId }));
  } else if (m.type === "submit_result") {
    if (m.accepted) { res.accepted++; if (m.isBlock) res.blocks++; }
    else rej[m.code] = (rej[m.code] ?? 0) + 1;
  }
};

const t0 = Date.now();
function loop() {
  if (Date.now() - t0 > seconds * 1000) return finish();
  if (job) {
    const zeros = "0".repeat(job.shareDifficulty), myJob = job;
    const end = Date.now() + 3;
    while (Date.now() < end) {
      const nh = (nonce++).toString(16).padStart(16, "0");
      if (createHash("sha256").update(inner).update(Buffer.from(nh, "hex")).digest("hex").startsWith(zeros)) {
        ws.send(JSON.stringify({ type: "submit", id: ++id, jobId: myJob.jobId, nonce: nh })); sent++;
      }
    }
  }
  setImmediate(loop);
}
async function finish() {
  await new Promise((r) => setTimeout(r, 300));
  const stats = await (await fetch(`http://${base}/mining/stats`)).json();
  console.log(JSON.stringify({ sent, ...res, rejected: rej, server: stats }, null, 1));
  ws.close(); process.exit(0);
}
ws.onclose = (e) => console.error("closed", e.code); ws.onerror = (e) => console.error("ws error", e.message ?? e.type);
setTimeout(loop, 300);
