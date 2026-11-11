process.env.P2P_ALLOW_PRIVATE = "1";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { Blockchain } from "../src/blockchain.js";
import { calculateProofHash, hashMeetsDifficulty, nonceHex } from "../src/block.js";
import { MAINNET_PARAMS, UNITS_PER_COIN, type ConsensusParams } from "../src/params.js";
import { generateKeyPair } from "../src/wallet.js";
import { P2P } from "../src/p2p.js";

const P: ConsensusParams = { ...MAINNET_PARAMS, initialReward: 210 * UNITS_PER_COIN, initialDifficulty: 64, retargetTauMs: 1e15, coinbaseMaturity: 1 };
const miner = generateKeyPair();

function mine(chain: Blockchain): void {
  const t = chain.buildTemplate(miner.address);
  let n = 0;
  while (!hashMeetsDifficulty(calculateProofHash(t.seed, miner.address, nonceHex(n)), t.difficulty)) n++;
  assert.equal(chain.submitSolved(t, nonceHex(n)).result.status, "added");
}

async function listen(chain: Blockchain, seeds: string[] = []): Promise<{ p2p: P2P; server: Server; url: string }> {
  const server = createServer();
  const p2p = new P2P(chain, { dataDir: null, seeds });
  server.on("upgrade", (req, socket, head) => p2p.handleUpgrade(req, socket, head));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { p2p, server, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/p2p` };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

async function sybil(url: string, ip: string): Promise<WebSocket | null> {
  const ws = new WebSocket(url, { headers: { "x-forwarded-for": ip } });
  ws.on("error", () => {});
  const ok = await new Promise<boolean>((res) => {
    ws.once("open", () => res(true));
    ws.once("error", () => res(false));
    ws.once("close", () => res(false));
  });
  return ok ? ws : null;
}

async function pair(honestBlocks: number) {
  const honestChain = new Blockchain(P, null);
  for (let i = 0; i < honestBlocks; i++) mine(honestChain);
  const honest = await listen(honestChain);
  const victimChain = new Blockchain(P, null);
  const victim = await listen(victimChain, [honest.url]);
  assert.ok(await until(() => victimChain.height === honestBlocks), "Opfer holt zuerst die ehrliche Kette");
  return { honestChain, honest, victimChain, victim };
}
const inbound = (p: P2P) => [...(p as any).peers].filter((x: any) => x.inbound).length as number;
const outbound = (p: P2P) => [...(p as any).peers].filter((x: any) => !x.inbound).length as number;

test("Eclipse: 100 gefälschte Absender füllen nur die Eingangs-Plätze, der ehrliche Ausgang bleibt", async () => {
  const { honestChain, victimChain, victim } = await pair(4);
  const socks: WebSocket[] = [];
  for (let i = 0; i < 100; i++) {
    const ws = await sybil(victim.url, `10.1.${Math.floor(i / 200)}.${i % 200}`);
    if (ws) socks.push(ws);
  }
  console.log(`Angreifer kam mit ${socks.length} von 100 Verbindungen hinein, Eingang belegt: ${inbound(victim.p2p)} (Limit 32)`);
  assert.ok(inbound(victim.p2p) <= 32, "Eingangs-Limit hält");
  assert.equal(outbound(victim.p2p), 1, "Die selbst gewählte ehrliche Verbindung bleibt bestehen");

  mine(honestChain);
  assert.ok(await until(() => victimChain.height === 5), "Neuer ehrlicher Block erreicht das Opfer trotz Umzingelung");
  socks.forEach((s) => s.terminate());
});

test("Eclipse: Adress-Flut füllt die Liste nur bis 200, vorhandene Verbindungen bleiben", async () => {
  const { honestChain, victimChain, victim, honest } = await pair(3);
  const ws = (await sybil(victim.url, "10.2.0.1"))!;
  assert.ok(ws);
  ws.send(JSON.stringify({ type: "hello", network: victimChain.networkId, nodeId: "evil-addr", height: 0, work: "0" }));
  const flood = (make: (i: number) => string) => {
    for (let m = 0; m < 300; m++) ws.send(JSON.stringify({ type: "peers", urls: Array.from({ length: 20 }, (_, k) => make(m * 20 + k)) }));
  };
  const known = (victim.p2p as any).known as Map<string, unknown>;

  flood((i) => `ws://127.0.0.1:${20000 + i}/p2p`);
  await sleep(1200);
  console.log(`Nach 6000 privaten Adressen: ${known.size} in der Liste (nur die ehrliche)`);
  assert.equal(known.size, 1, "private/lokale Adressen aus Gerüchten werden ignoriert");

  flood((i) => `ws://n${i}.albus-test.invalid:4000/p2p`);
  await sleep(1500);
  console.log(`Nach 6000 öffentlich aussehenden Adressen: ${known.size} in der Liste (Limit 200)`);
  assert.ok(known.size <= 200 && known.size > 1);
  assert.ok(known.has(honest.url), "Die ehrliche Start-Adresse bleibt in der Liste");
  assert.equal(outbound(victim.p2p) >= 1, true);

  mine(honestChain);
  assert.ok(await until(() => victimChain.height === 4), "Ehrlicher Block kommt trotz Adress-Flut an");
  ws.terminate();
});

test("Eclipse: Peer mit erfundener riesiger Arbeit ohne Beweise ändert die Kette nicht", async () => {
  const { victimChain, victim } = await pair(3);
  const tip = victimChain.tip.hash;
  const ws = (await sybil(victim.url, "10.3.0.1"))!;
  assert.ok(ws);
  ws.send(JSON.stringify({ type: "hello", network: victimChain.networkId, nodeId: "liar", height: 1_000_000, work: "9".repeat(60) }));
  await sleep(2500);
  assert.equal(victimChain.tip.hash, tip);
  assert.equal(victimChain.height, 3);
  assert.equal(outbound(victim.p2p), 1, "Ehrliche Verbindung bleibt trotz Lügner bestehen");
  ws.terminate();
});

after(() => setTimeout(() => process.exit(0), 50).unref());
