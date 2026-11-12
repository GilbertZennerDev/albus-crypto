import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { Blockchain, Template } from "./blockchain.js";
import { NONCE_RE, calculateProofHash, hashHasHexZeros, hashMeetsDifficulty } from "./block.js";
import { hexZerosFloor, targetOf } from "./difficulty.js";
import { ConnLimiter, clientIp } from "./guard.js";
import { ADDRESS_RE } from "./transaction.js";

const TARGET_SHARES_PER_SEC = Number(process.env.WS_TARGET_SHARES_PER_SEC ?? 16);
const SHARE_DIFFICULTY = 4;
const LEVEL_GRACE_MS = 3000;
const HEARTBEAT_MS = 15_000;
const TEMPLATE_REFRESH_MS = 5_000;

export type RejectCode = "stale-job" | "duplicate" | "low-difficulty" | "malformed" | "limit" | "no-hello";

interface Client {
  ws: WebSocket;
  address?: string;
  invitation?: string;
  agent?: string;
  name?: string;
  hashrate: number;
  accepted: number;
  connectedAt: number;
  template?: Template;
  jobId: string;
  epoch: number;
  builtAt: number;
  seen: Set<string>;
  shareDifficulty: number;
  prevShareDifficulty: number;
  levelChangedAt: number;
  alive: boolean;
  sentAt: number;
  sentJobId: string;
}

export class JobFeed {
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private clients = new Set<Client>();
  private conns = new ConnLimiter(Number(process.env.MINING_MAX_CONN_PER_IP ?? 8));
  private legacy = new Map<string, Template>();

  readonly stats = {
    startedAt: Date.now(),
    accepted: 0,
    blocks: 0,
    rejected: { "stale-job": 0, duplicate: 0, "low-difficulty": 0, malformed: 0, limit: 0, "no-hello": 0 } as Record<RejectCode, number>,
    switchLatencyMs: { count: 0, total: 0, max: 0 },
    recentBlockTimes: [] as number[],
  };

  constructor(private chain: Blockchain) {
    this.wss.on("connection", (ws) => this.onConnection(ws));
    chain.on("tip", () => this.refreshAll(true));
    setInterval(() => this.refreshAll(false), TEMPLATE_REFRESH_MS).unref();
    setInterval(() => this.heartbeat(), HEARTBEAT_MS).unref();
    setInterval(() => this.logStats(), 60_000).unref();
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const ip = clientIp(req);
    if (!this.conns.acquire(ip)) {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("close", () => this.conns.release(ip));
      this.wss.emit("connection", ws, req);
    });
  }

  private refreshAll(force: boolean): void {
    const wanted = Math.min(this.chain.getMempool().length, this.chain.params.maxTxPerBlock);
    for (const c of this.clients) {
      if (!c.address || !c.template) continue;
      const stale = c.template.previousHash !== this.chain.tip.hash;
      const newTxs = c.template.transactions.length - 1 !== wanted && Date.now() - c.builtAt >= TEMPLATE_REFRESH_MS;
      if (stale || (!force && newTxs)) this.newJob(c, stale);
    }
  }

  private newJob(c: Client, clean: boolean): void {
    if (!c.address) return;
    c.template = this.chain.buildTemplate(c.address, c.invitation);
    c.builtAt = Date.now();
    c.epoch++;
    c.jobId = `${c.template.index}:${c.template.seed}`;
    c.seen = new Set();
    this.sendJob(c, clean);
  }

  private levelFor(c: Client, hashrate: number): number {
    const block = c.template ? hexZerosFloor(c.template.difficulty) : SHARE_DIFFICULTY;
    const raw = hashrate > 0 ? Math.round(Math.log(hashrate / TARGET_SHARES_PER_SEC) / Math.log(16)) : SHARE_DIFFICULTY;
    return Math.max(1, Math.min(block, Math.max(SHARE_DIFFICULTY, raw)));
  }

  private effectiveLevel(c: Client): number {
    return Math.min(c.shareDifficulty, c.template ? hexZerosFloor(c.template.difficulty) : SHARE_DIFFICULTY);
  }

  private sendJob(c: Client, clean: boolean): void {
    if (c.ws.readyState !== WebSocket.OPEN || !c.template) return;
    c.sentAt = Date.now();
    c.sentJobId = c.jobId;
    c.ws.send(
      JSON.stringify({
        type: "job",
        jobId: c.jobId,
        epoch: c.epoch,
        seed: c.template.seed,
        shareDifficulty: this.effectiveLevel(c),
        blockDifficulty: hexZerosFloor(c.template.difficulty),
        clean,
        nonceStart: "0",
        nonceStride: "1",
      }),
    );
  }

  private onConnection(ws: WebSocket): void {
    const c: Client = {
      ws,
      hashrate: 0,
      accepted: 0,
      connectedAt: Date.now(),
      jobId: "",
      epoch: 0,
      builtAt: 0,
      seen: new Set(),
      shareDifficulty: SHARE_DIFFICULTY,
      prevShareDifficulty: SHARE_DIFFICULTY,
      levelChangedAt: 0,
      alive: true,
      sentAt: 0,
      sentJobId: "",
    };
    this.clients.add(c);
    ws.on("pong", () => (c.alive = true));
    ws.on("close", () => this.clients.delete(c));
    ws.on("error", () => this.clients.delete(c));
    ws.on("message", (data) => {
      c.alive = true;
      try {
        this.onMessage(c, JSON.parse(data.toString()));
      } catch {
        ws.send(JSON.stringify({ type: "error", code: "malformed" }));
      }
    });
  }

  private onMessage(c: Client, msg: any): void {
    switch (msg?.type) {
      case "hello": {
        if (typeof msg.address !== "string" || !ADDRESS_RE.test(msg.address)) {
          c.ws.send(JSON.stringify({ type: "error", code: "malformed", error: "invalid address" }));
          return;
        }
        const addr: string = msg.address;
        c.address = addr;
        c.invitation = typeof msg.invitation === "string" && msg.invitation.length <= 400 ? msg.invitation : undefined;
        c.agent = typeof msg.agent === "string" ? msg.agent.slice(0, 64) : undefined;
        const nm = typeof msg.name === "string" ? msg.name.replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 40) : "";
        c.name = nm || undefined;
        c.template = this.chain.buildTemplate(addr, c.invitation);
        c.builtAt = Date.now();
        c.epoch++;
        c.jobId = `${c.template.index}:${c.template.seed}`;
        this.applyHashrate(c, Number(msg.hashrate) || 0);
        c.ws.send(JSON.stringify({ type: "hello_ack", serverTime: Date.now() }));
        this.sendJob(c, true);
        return;
      }
      case "hashrate": {
        const before = c.shareDifficulty;
        this.applyHashrate(c, Number(msg.hashrate) || 0);
        if (c.shareDifficulty !== before) this.sendJob(c, false);
        return;
      }
      case "job_ack": {
        if (msg.jobId === c.sentJobId && c.sentAt > 0) {
          const dt = Date.now() - c.sentAt;
          c.sentAt = 0;
          const s = this.stats.switchLatencyMs;
          s.count++;
          s.total += dt;
          if (dt > s.max) s.max = dt;
        }
        return;
      }
      case "ping":
        c.ws.send(JSON.stringify({ type: "pong", t: msg.t }));
        return;
      case "submit":
        this.onSubmit(c, msg);
        return;
      default:
        c.ws.send(JSON.stringify({ type: "error", code: "malformed", error: "unknown message type" }));
    }
  }

  private applyHashrate(c: Client, hashrate: number): void {
    c.hashrate = Number.isFinite(hashrate) && hashrate > 0 ? hashrate : 0;
    const level = this.levelFor(c, hashrate);
    if (level !== c.shareDifficulty) {
      c.prevShareDifficulty = c.shareDifficulty;
      c.shareDifficulty = level;
      c.levelChangedAt = Date.now();
    }
  }

  private reject(c: Client, id: unknown, code: RejectCode): void {
    this.stats.rejected[code]++;
    c.ws.send(JSON.stringify({ type: "submit_result", id, accepted: false, isBlock: false, code, currentJobId: c.jobId }));
  }

  private onSubmit(c: Client, msg: any): void {
    if (!c.address || !c.template) return this.reject(c, msg.id, "no-hello");
    if (typeof msg.nonce !== "string" || !NONCE_RE.test(msg.nonce)) return this.reject(c, msg.id, "malformed");
    if (c.template.previousHash !== this.chain.tip.hash) this.newJob(c, true);
    if (msg.jobId !== c.jobId) return this.reject(c, msg.id, "stale-job");
    if (c.seen.has(msg.nonce)) return this.reject(c, msg.id, "duplicate");

    const t = c.template;
    const hash = calculateProofHash(t.seed, c.address, msg.nonce);
    const solves = hashMeetsDifficulty(hash, t.difficulty);
    let level = this.effectiveLevel(c);
    if (!solves && !hashHasHexZeros(hash, level)) {
      const grace = c.prevShareDifficulty < level && Date.now() - c.levelChangedAt < LEVEL_GRACE_MS;
      level = Math.min(c.prevShareDifficulty, hexZerosFloor(t.difficulty));
      if (!grace || !hashHasHexZeros(hash, level)) return this.reject(c, msg.id, "low-difficulty");
    }
    c.seen.add(msg.nonce);
    c.accepted++;
    this.stats.accepted++;

    let isBlock = false;
    if (solves) isBlock = this.found(t, msg.nonce);
    c.ws.send(
      JSON.stringify({ type: "submit_result", id: msg.id, accepted: true, isBlock, code: "ok", currentJobId: c.jobId }),
    );
  }

  private found(t: Template, nonce: string): boolean {
    const { result, block } = this.chain.submitSolved(t, nonce);
    if (result.status === "added") {
      this.stats.blocks++;
      this.stats.recentBlockTimes.push(Date.now());
      if (this.stats.recentBlockTimes.length > 200) this.stats.recentBlockTimes.shift();
      console.log(`Block ${block.index} gefunden (${block.hash.slice(0, 16)}...) fuer ${t.proofAddress}`);
      return true;
    }
    console.warn("Gefundener Block abgelehnt:", result);
    return false;
  }

  challenge(address: string, invitation?: string): { seed: string; difficulty: number; target: string } {
    const t = this.chain.buildTemplate(address, invitation);
    this.legacy.set(address, t);
    if (this.legacy.size > 1000) this.legacy.delete(this.legacy.keys().next().value as string);
    return { seed: t.seed, difficulty: t.difficulty, target: targetOf(t.difficulty).toString(16).padStart(64, "0") };
  }

  legacySubmit(address: string, nonce: string): { ok: boolean; error?: string; isBlock?: boolean } {
    const t = this.legacy.get(address);
    if (!t) return { ok: false, error: "erst /mining/challenge?address= abrufen" };
    if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) return { ok: false, error: "invalid nonce" };
    if (!hashMeetsDifficulty(calculateProofHash(t.seed, address, nonce), t.difficulty)) {
      return { ok: false, error: "share does not meet block difficulty (Solo-Mining: nur Block-Treffer zaehlen)" };
    }
    if (!this.found(t, nonce)) return { ok: false, error: "block rejected (stale)" };
    return { ok: true, isBlock: true };
  }

  private heartbeat(): void {
    for (const c of this.clients) {
      if (!c.alive) {
        c.ws.terminate();
        this.clients.delete(c);
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }

  workers(address: string) {
    const now = Date.now();
    return [...this.clients]
      .filter((c) => c.address === address)
      .map((c) => ({ name: c.name ?? c.agent ?? "miner", agent: c.agent ?? "", hashrate: c.hashrate, accepted: c.accepted, onlineSec: Math.round((now - c.connectedAt) / 1000) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getStats() {
    const s = this.stats;
    const now = Date.now();
    const rej = s.rejected;
    const totalRej = Object.values(rej).reduce((a, b) => a + b, 0);
    return {
      uptimeSec: Math.round((now - s.startedAt) / 1000),
      clients: this.clients.size,
      blockDifficulty: this.chain.getNextDifficulty(),
      shareDifficultyBase: SHARE_DIFFICULTY,
      accepted: s.accepted,
      rejected: rej,
      staleRate: s.accepted + totalRej > 0 ? rej["stale-job"] / (s.accepted + totalRej) : 0,
      blocks: s.blocks,
      blocksLastMinute: s.recentBlockTimes.filter((t) => now - t < 60_000).length,
      switchLatencyMs: {
        avg: s.switchLatencyMs.count ? s.switchLatencyMs.total / s.switchLatencyMs.count : 0,
        max: s.switchLatencyMs.max,
        samples: s.switchLatencyMs.count,
      },
    };
  }

  private logStats(): void {
    if (this.clients.size === 0 && this.stats.accepted === 0) return;
    console.log("mining-ws", JSON.stringify(this.getStats()));
  }
}
