import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { ConnLimiter, clientIp, isPublicWsUrl } from "./guard.js";
import type { Blockchain, HeaderTip } from "./blockchain.js";
import type { Block } from "./block.js";
import { normalizeTransaction } from "./transaction.js";
import { readJson, writeJsonAtomic } from "./storage.js";

const ALLOW_PRIVATE = process.env.P2P_ALLOW_PRIVATE === "1";
const MAX_CONN_PER_IP = Number(process.env.P2P_MAX_CONN_PER_IP ?? 4);
const URL_RE = /^wss?:\/\/[^\s/]+(\/[^\s]*)?$/;
const MAX_KNOWN = 200;
const MAX_BLOCKS_PER_MSG = 100;
const MAX_HEADERS_PER_MSG = 500;
const STRIKES_BEFORE_BAN = 3;
const MSG_LIMIT_PER_10S = 600;
const BYTES_LIMIT_PER_10S = 32 * 1024 * 1024;
const DEFAULT_BAN_MS = 10 * 60_000;
const MAX_BANNED = 5_000;

interface Peer {
  id: number;
  ws: WebSocket;
  inbound: boolean;
  url?: string;
  nodeId?: string;
  advertised?: string;
  height: number;
  work: bigint;
  strikes: number;
  alive: boolean;
  msgWindowStart: number;
  msgCount: number;
  byteCount: number;
  ip?: string;
  connectedAt: number;
  headerTip?: HeaderTip | null;
}

interface KnownAddr {
  fails: number;
  nextTry: number;
}

export interface P2POptions {
  dataDir: string | null;
  seeds: string[];
  publicUrl?: string;
  maxOutbound?: number;
  maxInbound?: number;
  banMs?: number;
}

export class P2P {
  readonly nodeId = randomBytes(8).toString("hex");
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  private peers = new Set<Peer>();
  private conns = new ConnLimiter(MAX_CONN_PER_IP);
  private known = new Map<string, KnownAddr>();
  private connecting = new Set<string>();
  private selfUrls = new Set<string>();
  private nextId = 1;
  private peersFile: string | null;
  private maxOutbound: number;
  private maxInbound: number;

  constructor(private chain: Blockchain, private opts: P2POptions) {
    this.maxOutbound = opts.maxOutbound ?? 8;
    this.maxInbound = opts.maxInbound ?? 32;
    this.peersFile = opts.dataDir ? join(opts.dataDir, "peers.json") : null;
    if (opts.publicUrl) this.selfUrls.add(opts.publicUrl);

    for (const url of [...(this.peersFile ? readJson<string[]>(this.peersFile) ?? [] : []), ...opts.seeds]) this.learn(url);

    this.wss.on("connection", (ws, req) => this.onSocket(ws, true, undefined, clientIp(req)));

    chain.on("block", ({ block, source }: { block: Block; source: string }) => {
      if (source === "disk" || source.startsWith("sync:")) return;
      this.broadcast({ type: "block", block }, source);
    });
    chain.on("tx", ({ tx, source }: { tx: unknown; source: string }) => this.broadcast({ type: "tx", tx }, source));

    setInterval(() => this.connectLoop(), 5_000).unref();
    setInterval(() => this.heartbeat(), 20_000).unref();
    setTimeout(() => this.connectLoop(), 200).unref();
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.inboundCount() >= this.maxInbound) {
      socket.destroy();
      return;
    }
    const ip = clientIp(req);
    if (this.isBanned(ip)) {
      socket.destroy();
      return;
    }
    if (!this.conns.acquire(ip)) {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("close", () => this.conns.release(ip));
      this.wss.emit("connection", ws, req);
    });
  }

  private learn(url: unknown, gossip = false): void {
    if (typeof url !== "string" || url.length > 200 || !URL_RE.test(url)) return;
    if (gossip && !ALLOW_PRIVATE && !isPublicWsUrl(url)) return;
    if (this.selfUrls.has(url) || this.known.has(url) || this.known.size >= MAX_KNOWN) return;
    this.known.set(url, { fails: 0, nextTry: 0 });
    this.saveKnown();
  }

  private saveKnown(): void {
    if (this.peersFile) writeJsonAtomic(this.peersFile, [...this.known.keys()]);
  }

  addPeer(url: string): boolean {
    if (typeof url !== "string" || !URL_RE.test(url)) return false;
    this.learn(url);
    this.connectLoop();
    return true;
  }

  private outboundCount(): number {
    return [...this.peers].filter((p) => !p.inbound).length;
  }
  private inboundCount(): number {
    return [...this.peers].filter((p) => p.inbound).length;
  }

  private connectLoop(): void {
    if (this.outboundCount() + this.connecting.size >= this.maxOutbound) return;
    const connectedUrls = new Set([...this.peers].map((p) => p.url).filter(Boolean));
    const now = Date.now();
    for (const [url, st] of this.known) {
      if (this.outboundCount() + this.connecting.size >= this.maxOutbound) break;
      if (connectedUrls.has(url) || this.connecting.has(url) || this.selfUrls.has(url) || st.nextTry > now) continue;
      this.connect(url, st);
    }
  }

  private connect(url: string, st: KnownAddr): void {
    this.connecting.add(url);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { handshakeTimeout: 5_000, maxPayload: 4 * 1024 * 1024 });
    } catch {
      this.connecting.delete(url);
      return;
    }
    let opened = false;
    ws.on("open", () => {
      opened = true;
      this.connecting.delete(url);
      st.fails = 0;
      this.onSocket(ws, false, url);
    });
    const fail = () => {
      if (opened) return;
      this.connecting.delete(url);
      st.fails++;
      st.nextTry = Date.now() + Math.min(120_000, 5_000 * 2 ** Math.min(st.fails, 5));
    };
    ws.on("error", fail);
    ws.on("close", fail);
  }

  private banned = new Map<string, number>();

  private isBanned(ip: string): boolean {
    const until = this.banned.get(ip);
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    this.banned.delete(ip);
    return false;
  }

  private ban(peer: Peer): void {
    const ms = this.opts.banMs ?? DEFAULT_BAN_MS;
    if (!peer.ip || ms <= 0) return;
    if (this.banned.size >= MAX_BANNED) this.banned.delete(this.banned.keys().next().value as string);
    this.banned.set(peer.ip, Date.now() + ms);
  }

  private onSocket(ws: WebSocket, inbound: boolean, url?: string, ip?: string): void {
    const peer: Peer = {
      ip,
      id: this.nextId++,
      ws,
      inbound,
      url,
      height: 0,
      work: 0n,
      strikes: 0,
      alive: true,
      msgWindowStart: Date.now(),
      msgCount: 0,
      byteCount: 0,
      connectedAt: Date.now(),
    };
    this.peers.add(peer);
    ws.on("pong", () => (peer.alive = true));
    ws.on("close", () => this.peers.delete(peer));
    ws.on("error", () => this.peers.delete(peer));
    ws.on("message", (data) => {
      peer.alive = true;
      const now = Date.now();
      if (now - peer.msgWindowStart > 10_000) {
        peer.msgWindowStart = now;
        peer.msgCount = 0;
        peer.byteCount = 0;
      }
      peer.byteCount += (data as Buffer).length ?? 0;
      if (++peer.msgCount > MSG_LIMIT_PER_10S || peer.byteCount > BYTES_LIMIT_PER_10S) {
        this.ban(peer);
        return this.drop(peer, "too many messages");
      }
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return this.strike(peer, "not JSON");
      }
      try {
        this.onMessage(peer, msg);
      } catch (err) {
        console.error("p2p error while handling message", msg?.type, err);
        this.strike(peer, "error");
      }
    });
    this.send(peer, this.helloMessage());
  }

  private helloMessage() {
    return {
      type: "hello",
      network: this.chain.networkId,
      nodeId: this.nodeId,
      url: this.opts.publicUrl,
      height: this.chain.height,
      work: this.chain.tipWork.toString(),
      agent: "albus-chain/0.2",
    };
  }

  private send(peer: Peer, msg: unknown): void {
    if (peer.ws.readyState === WebSocket.OPEN) peer.ws.send(JSON.stringify(msg));
  }

  private drop(peer: Peer, why: string): void {
    console.log(`p2p: Peer ${peer.nodeId ?? peer.id} getrennt (${why})`);
    this.peers.delete(peer);
    peer.ws.close();
    setTimeout(() => peer.ws.terminate(), 1_000).unref();
  }

  private strike(peer: Peer, why: string): void {
    peer.strikes++;
    if (peer.strikes >= STRIKES_BEFORE_BAN) this.ban(peer);
    if (peer.strikes >= STRIKES_BEFORE_BAN) this.drop(peer, `${why} (too many errors)`);
  }

  private heartbeat(): void {
    for (const p of [...this.peers]) {
      if (!p.alive) {
        p.ws.terminate();
        this.peers.delete(p);
        continue;
      }
      p.alive = false;
      p.ws.ping();
    }
  }

  private ready(): Peer[] {
    return [...this.peers].filter((p) => p.nodeId);
  }

  private broadcast(msg: unknown, exceptSource?: string): void {
    for (const p of this.ready()) {
      if (exceptSource === `peer:${p.id}` || exceptSource === `sync:${p.id}`) continue;
      this.send(p, msg);
    }
  }

  private onMessage(peer: Peer, msg: any): void {
    if (msg?.type === "hello") return this.onHello(peer, msg);
    if (!peer.nodeId) return this.drop(peer, "message before hello");
    switch (msg?.type) {
      case "getpeers":
        this.send(peer, { type: "peers", urls: [...this.known.keys()].slice(0, 20) });
        return;
      case "peers":
        if (Array.isArray(msg.urls)) for (const u of msg.urls.slice(0, 20)) this.learn(u, true);
        return;
      case "tx": {
        const tx = normalizeTransaction(msg.tx);
        if (!tx) return this.strike(peer, "invalid transaction");
        this.chain.submitTransaction(tx, `peer:${peer.id}`);
        return;
      }
      case "block":
        this.onBlock(peer, msg.block, `peer:${peer.id}`, false);
        return;
      case "getblocks": {
        const locator = Array.isArray(msg.locator) ? msg.locator.slice(0, 40) : [];
        const { blocks, more } = this.chain.blocksAfterLocator(locator, MAX_BLOCKS_PER_MSG);
        this.send(peer, { type: "blocks", blocks, more });
        return;
      }
      case "blocks":
        this.onBlocks(peer, msg);
        return;
      case "getheaders": {
        const locator = Array.isArray(msg.locator) ? msg.locator.slice(0, 40) : [];
        const { headers, more } = this.chain.headersAfterLocator(locator, MAX_HEADERS_PER_MSG);
        this.send(peer, { type: "headers", headers, more });
        return;
      }
      case "headers":
        this.onHeaders(peer, msg);
        return;
      default:
        this.strike(peer, "unbekannter Typ");
    }
  }

  private onHello(peer: Peer, msg: any): void {
    if (peer.nodeId) return;
    if (msg.network !== this.chain.networkId) return this.drop(peer, "anderes Netz (networkId/Genesis)");
    if (typeof msg.nodeId !== "string" || msg.nodeId.length > 32) return this.drop(peer, "bad hello");
    if (msg.nodeId === this.nodeId) {
      if (peer.url) {
        this.selfUrls.add(peer.url);
        this.known.delete(peer.url);
        this.saveKnown();
      }
      return this.drop(peer, "connection to myself");
    }
    if ([...this.peers].some((p) => p !== peer && p.nodeId === msg.nodeId)) return this.drop(peer, "peer already connected");
    peer.nodeId = msg.nodeId;
    peer.height = Number(msg.height) || 0;
    if (typeof msg.work !== "string" || msg.work.length > 80) return this.drop(peer, "bad work");
    try {
      peer.work = BigInt(msg.work);
    } catch {
      return this.drop(peer, "bad work");
    }
    if (typeof msg.url === "string") {
      peer.advertised = msg.url;
      this.learn(msg.url, true);
    }
    console.log(`p2p: connected to ${peer.nodeId} (${peer.inbound ? "inbound" : "outbound"}), height ${peer.height}`);
    this.send(peer, { type: "getpeers" });
    for (const tx of this.chain.getMempool().slice(0, 100)) this.send(peer, { type: "tx", tx });
    if (peer.work > this.chain.tipWork) this.requestHeaders(peer);
  }

  private requestHeaders(peer: Peer): void {
    peer.headerTip = null;
    this.send(peer, { type: "getheaders", locator: this.chain.getLocator() });
  }

  private onHeaders(peer: Peer, msg: any): void {
    if (!Array.isArray(msg.headers) || msg.headers.length > MAX_HEADERS_PER_MSG) return this.strike(peer, "bad headers");
    if (msg.headers.length === 0) {
      peer.headerTip = null;
      return;
    }
    const r = this.chain.verifyHeaders(msg.headers, peer.headerTip ?? null);
    if (!r.ok) {
      peer.headerTip = null;
      console.log(`p2p: headers from ${peer.nodeId} rejected: ${r.reason}`);
      return this.strike(peer, "invalid headers");
    }
    peer.headerTip = r.tip;
    if (msg.more === true) {
      this.send(peer, { type: "getheaders", locator: [r.tip.block.hash] });
      return;
    }
    peer.headerTip = null;
    if (r.tip.work > this.chain.tipWork) this.requestBlocks(peer);
  }

  private requestBlocks(peer: Peer): void {
    this.send(peer, { type: "getblocks", locator: this.chain.getLocator() });
  }

  private onBlock(peer: Peer, raw: any, source: string, quiet: boolean): "added" | "known" | "orphan" | "invalid" {
    const r = this.chain.addBlock(raw as Block, source);
    if (r.status === "invalid") {
      if (!quiet) console.log(`p2p: Block von ${peer.nodeId} abgelehnt: ${r.reason}`);
      this.strike(peer, "invalid block");
    } else if (r.status === "orphan") {
      this.requestHeaders(peer);
    } else if (r.status === "added" && r.isTip && raw?.index > peer.height) {
      peer.height = raw.index;
    }
    return r.status;
  }

  private onBlocks(peer: Peer, msg: any): void {
    if (!Array.isArray(msg.blocks) || msg.blocks.length > MAX_BLOCKS_PER_MSG) return this.strike(peer, "bad blocks");
    const before = this.chain.tip.hash;
    let added = 0;
    for (const raw of msg.blocks) {
      const s = this.onBlock(peer, raw, `sync:${peer.id}`, false);
      if (s === "added") added++;
      if (s === "invalid") return;
    }
    if (this.chain.tip.hash !== before) {
      this.broadcast({ type: "block", block: this.chain.tip }, `sync:${peer.id}`);
    }
    if (msg.more === true && added > 0) this.requestBlocks(peer);
  }

  status() {
    return {
      nodeId: this.nodeId,
      networkId: this.chain.networkId,
      peers: this.ready().map((p) => ({
        nodeId: p.nodeId,
        direction: p.inbound ? "in" : "out",
        url: p.url ?? p.advertised ?? null,
        height: p.height,
        strikes: p.strikes,
        connectedSec: Math.round((Date.now() - p.connectedAt) / 1000),
      })),
      knownAddresses: [...this.known.keys()],
    };
  }
}
