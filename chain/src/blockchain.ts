import { EventEmitter } from "node:events";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import {
  buildProvenBlock,
  calculateProofHash,
  computeSeed,
  computeSeedFromRoot,
  createGenesisBlock,
  hashMeetsDifficulty,
  workOf,
  type Block,
  type BlockHeader,
  transactionRoot,
  NONCE_RE,
  SEED_RE,
} from "./block.js";
import {
  ADDRESS_RE,
  coinbaseId,
  createCoinbaseTransaction,
  isTransactionWellFormed,
  parseInvitation,
  verifyInvitation,
  verifyTransactionSignature,
  type Invitation,
  type Transaction,
} from "./transaction.js";
import { SUB } from "./difficulty.js";
import { CHECKPOINTS, MAX_SUPPLY_COINS, networkIdOf, rewardUnits, toCoins, type ConsensusParams } from "./params.js";

const MAX_MEMPOOL = 5000;
const MAX_ORPHANS = 200;
export const HOT_WINDOW = 10_000;
const HASH_RE = /^[0-9a-f]{64}$/;

export interface HeaderTip {
  block: BlockHeader;
  parent: HeaderNode | null;
  anchor: number;
  work: bigint;
}

interface Entry {
  block: Block;
  work: bigint;
  parent: Entry | null;
  anchor: number;
  invalid: boolean;
  undo?: Undo;
  txRoot: string;
  offset?: number;
  len?: number;
  cold?: boolean;
}

interface Undo {
  balances: [string, number | undefined][];
  nonces: [string, number | undefined][];
  immatureAdded: number;
  immatureReleased?: { height: number; entry: Immature };
  referrerAdded?: string;
}

interface Immature {
  to: string;
  units: number;
  ref?: string;
  refUnits?: number;
}

interface Ledger {
  balances: Map<string, number>;
  nonces: Map<string, number>;
  immature: Map<number, Immature>;
  referrers: Map<string, string>;
}

export interface AccountInfo {
  spendable: number;
  immature: number;
  total: number;
  nextNonce: number;
}

export interface Template {
  index: number;
  timestamp: number;
  previousHash: string;
  difficulty: number;
  transactions: Transaction[];
  proofAddress: string;
  seed: string;
}

export type AddResult =
  | { status: "added"; isTip: boolean }
  | { status: "known" }
  | { status: "orphan" }
  | { status: "invalid"; reason: string };

export type TxResult = { ok: true } | { ok: false; error: string };

function emptyLedger(): Ledger {
  return { balances: new Map(), nonces: new Map(), immature: new Map(), referrers: new Map() };
}

export interface HeaderNode {
  block: { index: number; timestamp: number; difficulty: number };
  parent: HeaderNode | null;
  anchor: number;
}

export function nextDifficulty(p: ConsensusParams, parent: HeaderNode): number {
  if (parent.block.index === 0) return p.initialDifficulty;
  const lag = parent.block.timestamp - parent.anchor - p.targetBlockTimeMs * (parent.block.index - 1);
  const d = p.initialDifficulty - Math.trunc((SUB * lag) / p.retargetTauMs);
  return Math.max(p.minDifficulty, Math.min(p.maxDifficulty, d));
}

export function medianTimePast(p: ConsensusParams, parent: HeaderNode): number {
  const times: number[] = [];
  for (let e: HeaderNode | null = parent; e && times.length < p.medianTimeBlocks; e = e.parent) times.push(e.block.timestamp);
  times.sort((x, y) => x - y);
  return times[Math.floor(times.length / 2)];
}

export class Blockchain extends EventEmitter {
  readonly params: ConsensusParams;
  readonly genesis: Block;
  readonly networkId: string;

  private entries = new Map<string, Entry>();
  private active: Entry[] = [];
  private ledger: Ledger = emptyLedger();
  private mempool: Transaction[] = [];
  private orphans = new Map<string, Block[]>();
  private orphanCount = 0;
  private blocksFile: string | null = null;
  private loading = false;
  private checkpoints: Record<number, string>;
  private hotWindow: number;
  private coolMark = 0;
  private fileSize = 0;
  private diskPos = new Map<string, { offset: number; len: number }>();
  private txIndex = new Map<string, number>();
  private addrIndex = new Map<string, number[]>();

  constructor(
    params: ConsensusParams,
    dataDir: string | null,
    checkpoints: Record<number, string> = CHECKPOINTS,
    hotWindow = HOT_WINDOW,
  ) {
    super();
    this.params = params;
    this.checkpoints = checkpoints;
    this.hotWindow = hotWindow;
    this.genesis = createGenesisBlock();
    this.networkId = networkIdOf(params, this.genesis.hash);
    const g: Entry = { block: this.genesis, work: 0n, parent: null, anchor: 0, invalid: false, txRoot: transactionRoot([]) };
    this.entries.set(this.genesis.hash, g);
    this.active = [g];

    if (dataDir) {
      mkdirSync(dataDir, { recursive: true });
      this.blocksFile = join(dataDir, "blocks.jsonl");
      this.moveLegacyAside(dataDir);
      this.load();
    }
  }

  private moveLegacyAside(dataDir: string): void {
    const legacy = join(dataDir, "chain.json");
    if (existsSync(legacy) && !existsSync(this.blocksFile as string)) {
      const target = join(dataDir, "chain.pre-p2p.json");
      if (!existsSync(target)) {
        renameSync(legacy, target);
        console.warn(`Old chain (different format) moved to ${target}. The P2P network starts over with its own genesis.`);
      }
    }
  }

  private load(): void {
    if (!this.blocksFile || !existsSync(this.blocksFile)) return;
    const fd = openSync(this.blocksFile, "r");
    const total = statSync(this.blocksFile).size;
    this.loading = true;
    let lineNo = 0;
    let goodEnd = 0;
    let needNewline = false;
    const handle = (line: Buffer, offset: number, hasNewline: boolean): void => {
      lineNo++;
      const end = offset + line.length + (hasNewline ? 1 : 0);
      if (line.toString("utf-8").trim() === "") {
        goodEnd = end;
        return;
      }
      let block: Block;
      try {
        block = JSON.parse(line.toString("utf-8"));
      } catch {
        if (!hasNewline) {
          console.warn("Last line of blocks.jsonl is truncated and will be removed.");
          return;
        }
        throw new Error(`blocks.jsonl line ${lineNo} is broken; check the file, nothing will be overwritten.`);
      }
      if (block && typeof block.hash === "string") this.diskPos.set(block.hash, { offset, len: line.length });
      const r = this.addBlock(block, "disk");
      if (r.status === "invalid") {
        if (this.entries.size <= 1) {
          throw new Error(
            `blocks.jsonl line ${lineNo} does not match the rules of this version (${r.reason}). Network ${this.networkId}. ` +
              "The file probably comes from another ruleset: move it aside (nothing will be overwritten).",
          );
        }
        console.warn(`blocks.jsonl line ${lineNo} is skipped (${r.reason}).`);
      }
      goodEnd = end;
      if (!hasNewline) needNewline = true;
    };
    try {
      const CH = 1 << 20;
      const buf = Buffer.alloc(CH);
      let rest: Buffer = Buffer.alloc(0);
      let restStart = 0;
      let pos = 0;
      while (pos < total) {
        const n = readSync(fd, buf, 0, CH, pos);
        if (n <= 0) break;
        pos += n;
        const data = rest.length ? Buffer.concat([rest, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
        let from = 0;
        for (let i = data.indexOf(10, from); i !== -1; i = data.indexOf(10, from)) {
          handle(data.subarray(from, i), restStart + from, true);
          from = i + 1;
        }
        rest = data.subarray(from);
        restStart += from;
      }
      if (rest.length) handle(rest, restStart, false);
    } finally {
      closeSync(fd);
      this.loading = false;
      this.diskPos.clear();
    }
    if (goodEnd < total) truncateSync(this.blocksFile, goodEnd);
    if (needNewline) {
      appendFileSync(this.blocksFile, "\n");
      goodEnd++;
    }
    this.fileSize = goodEnd;
  }

  get tip(): Block {
    return this.active[this.active.length - 1].block;
  }
  get tipWork(): bigint {
    return this.active[this.active.length - 1].work;
  }
  get height(): number {
    return this.active.length - 1;
  }
  private bodyOf(e: Entry): Block {
    if (!e.cold) return e.block;
    if (!this.blocksFile || e.offset === undefined || e.len === undefined) throw new Error("block content not available");
    const fd = openSync(this.blocksFile, "r");
    try {
      const buf = Buffer.alloc(e.len);
      readSync(fd, buf, 0, e.len, e.offset);
      const b = JSON.parse(buf.toString("utf-8")) as Block;
      if (b.hash !== e.block.hash) throw new Error("blocks.jsonl no longer matches the index");
      return b;
    } finally {
      closeSync(fd);
    }
  }
  getChain(): Block[] {
    return this.active.map((e) => this.bodyOf(e));
  }
  getChainRange(from: number, limit: number): Block[] {
    return this.active.slice(from, from + limit).map((e) => this.bodyOf(e));
  }
  getMempool(): Transaction[] {
    return this.mempool;
  }
  getBlock(hashOrIndex: string): Block | undefined {
    const e = /^\d+$/.test(hashOrIndex) ? this.active[Number(hashOrIndex)] : this.entries.get(hashOrIndex);
    return e ? this.bodyOf(e) : undefined;
  }
  hasBlock(hash: string): boolean {
    return this.entries.has(hash);
  }
  isOnActiveChain(hash: string): boolean {
    const e = this.entries.get(hash);
    return !!e && this.active[e.block.index] === e;
  }
  getBalance(address: string): number {
    return this.ledger.balances.get(address) ?? 0;
  }
  getAccount(address: string): AccountInfo {
    const spendable = this.ledger.balances.get(address) ?? 0;
    let immature = 0;
    for (const c of this.ledger.immature.values()) {
      if (c.to === address) immature += c.units;
      if (c.ref === address) immature += c.refUnits ?? 0;
    }
    const pending = this.pendingOf(address, this.mempool);
    return { spendable, immature, total: spendable + immature, nextNonce: (this.ledger.nonces.get(address) ?? 0) + pending.count };
  }
  getNextDifficulty(): number {
    return nextDifficulty(this.params, this.active[this.active.length - 1]);
  }

  getLocator(): string[] {
    const out: string[] = [];
    let step = 1;
    for (let h = this.height; h > 0; h -= step) {
      out.push(this.active[h].block.hash);
      if (out.length >= 10) step *= 2;
    }
    out.push(this.genesis.hash);
    return out;
  }

  blocksAfterLocator(locator: string[], max: number): { blocks: Block[]; more: boolean } {
    let from = 0;
    for (const hash of locator) {
      if (typeof hash === "string" && this.isOnActiveChain(hash)) {
        from = (this.entries.get(hash) as Entry).block.index;
        break;
      }
    }
    const slice = this.getChainRange(from + 1, max);
    return { blocks: slice, more: from + 1 + max < this.active.length };
  }

  verifyHeaders(headers: BlockHeader[], base: HeaderTip | null): { ok: true; tip: HeaderTip } | { ok: false; reason: string } {
    if (!Array.isArray(headers) || headers.length === 0) return { ok: false, reason: "no headers" };
    const p = this.params;
    let parent: HeaderNode | null = base;
    let work = base ? base.work : 0n;
    let parentHash = base ? base.block.hash : null;
    let tip: HeaderTip | null = base;
    for (const h of headers) {
      if (!h || typeof h !== "object") return { ok: false, reason: "not a header" };
      if (!parent) {
        const known = this.entries.get(h.previousHash);
        if (!known) return { ok: false, reason: "unknown parent" };
        if (known.invalid) return { ok: false, reason: "parent is invalid" };
        parent = known;
        work = known.work;
        parentHash = known.block.hash;
      }
      if (!Number.isSafeInteger(h.index) || h.index !== parent.block.index + 1) return { ok: false, reason: "wrong index" };
      if (h.previousHash !== parentHash) return { ok: false, reason: "wrong link to parent" };
      if (!Number.isSafeInteger(h.timestamp) || h.timestamp <= medianTimePast(p, parent)) return { ok: false, reason: "timestamp too old" };
      if (h.timestamp > Date.now() + p.maxFutureMs) return { ok: false, reason: "timestamp too far in the future" };
      if (h.difficulty !== nextDifficulty(p, parent)) return { ok: false, reason: "wrong difficulty" };
      if (typeof h.proofAddress !== "string" || !ADDRESS_RE.test(h.proofAddress)) return { ok: false, reason: "invalid address" };
      if (typeof h.nonce !== "string" || !NONCE_RE.test(h.nonce)) return { ok: false, reason: "invalid nonce" };
      if (typeof h.transactionRoot !== "string" || !HASH_RE.test(h.transactionRoot)) return { ok: false, reason: "invalid root" };
      if (h.seed !== computeSeedFromRoot(h.previousHash, h.index, h.timestamp, h.difficulty, h.transactionRoot)) return { ok: false, reason: "seed does not match" };
      if (h.hash !== calculateProofHash(h.seed, h.proofAddress, h.nonce)) return { ok: false, reason: "wrong hash" };
      if (!hashMeetsDifficulty(h.hash, h.difficulty)) return { ok: false, reason: "hash does not meet the difficulty" };
      const cp = this.checkpoints[h.index];
      if (cp && cp !== h.hash) return { ok: false, reason: "Checkpoint verletzt" };
      work += workOf(h.difficulty);
      tip = { block: h, parent, anchor: h.index === 1 ? h.timestamp : parent.anchor, work };
      parent = tip;
      parentHash = h.hash;
    }
    return { ok: true, tip: tip as HeaderTip };
  }

  headersAfterLocator(locator: string[], max: number): { headers: BlockHeader[]; more: boolean } {
    let from = 0;
    for (const hash of locator) {
      if (typeof hash === "string" && this.isOnActiveChain(hash)) {
        from = (this.entries.get(hash) as Entry).block.index;
        break;
      }
    }
    const headers = this.active.slice(from + 1, from + 1 + max).map((e): BlockHeader => {
      const { transactions: _t, ...rest } = e.block;
      return { ...rest, transactionRoot: e.txRoot };
    });
    return { headers, more: from + 1 + max < this.active.length };
  }

  private checkBlock(b: Block, parent: Entry): string | null {
    const p = this.params;
    if (!b || typeof b !== "object") return "not a block";
    if (b.index !== parent.block.index + 1) return "wrong index";
    if (b.previousHash !== parent.block.hash) return "wrong parent";
    if (!Number.isSafeInteger(b.timestamp) || b.timestamp <= medianTimePast(p, parent)) return "timestamp not after the median of the previous blocks";
    if (!this.loading && b.timestamp > Date.now() + p.maxFutureMs) return "timestamp too far in the future";
    if (b.difficulty !== nextDifficulty(p, parent)) return "wrong difficulty";
    if (typeof b.proofAddress !== "string" || !ADDRESS_RE.test(b.proofAddress)) return "invalid address";
    if (typeof b.nonce !== "string" || !NONCE_RE.test(b.nonce)) return "invalid nonce";
    if (!Array.isArray(b.transactions) || b.transactions.length < 1 || b.transactions.length > p.maxTxPerBlock + 1) {
      return "invalid transaction count";
    }
    if (JSON.stringify(b).length > p.maxBlockBytes) return "block too large";
    if (b.seed !== computeSeed(b.previousHash, b.index, b.timestamp, b.difficulty, b.transactions)) {
      return "seed does not match the block content";
    }
    if (b.hash !== calculateProofHash(b.seed, b.proofAddress, b.nonce)) return "wrong hash";
    if (!hashMeetsDifficulty(b.hash, b.difficulty)) return "hash does not meet the difficulty";

    const [cb, ...rest] = b.transactions;
    const ids = new Set<string>();
    let fees = 0;
    for (const tx of rest) {
      if (!isTransactionWellFormed(tx) || tx.fromPublicKey === null) return "invalid transaction";
      if (!verifyTransactionSignature(tx, this.networkId)) return "invalid signature";
      if (tx.fee < p.minFeeUnits) return "fee below the minimum";
      if (ids.has(tx.id)) return "duplicate transaction in block";
      ids.add(tx.id);
      fees += tx.fee;
    }
    const expected = rewardUnits(p, b.index) + fees;
    if (!cb || cb.fromPublicKey !== null || cb.fromAddress !== null || cb.signature !== null) return "coinbase missing";
    if (cb.to !== b.proofAddress) return "coinbase does not go to the proof address";
    if (cb.amount !== expected || cb.fee !== 0 || cb.nonce !== 0) return "wrong coinbase amount";
    if (cb.timestamp !== b.timestamp) return "wrong coinbase timestamp";
    let inv: Invitation | undefined;
    if (cb.referrer !== undefined || cb.referrerKey !== undefined || cb.referrerSig !== undefined) {
      if (!p.referralBps) return "referrer not allowed on this network";
      inv = { referrer: cb.referrer as string, key: cb.referrerKey as string, sig: cb.referrerSig as string };
      if (!verifyInvitation(inv, cb.to, this.networkId)) return "invalid invitation (not signed by the miner)";
    }
    if (cb.id !== coinbaseId(cb.to, expected, b.index, inv)) return "wrong coinbase id";
    if (ids.has(cb.id)) return "duplicate transaction in block";
    return null;
  }

  private applyBlock(ledger: Ledger, b: Block): { err: string | null; undo?: Undo } {
    const balances = new Map<string, number>();
    const nonces = new Map<string, number>();
    const bal = (a: string) => balances.get(a) ?? ledger.balances.get(a) ?? 0;
    const nonceOf = (a: string) => nonces.get(a) ?? ledger.nonces.get(a) ?? 0;

    const due = b.index - this.params.coinbaseMaturity;
    const released = ledger.immature.get(due);
    if (released) {
      balances.set(released.to, bal(released.to) + released.units);
      if (released.ref) balances.set(released.ref, bal(released.ref) + (released.refUnits ?? 0));
    }
    const cb = b.transactions[0];
    const bound = ledger.referrers.get(cb.to);
    if (cb.referrer && bound) return { err: "miner already has an inviter" };
    const inviter = cb.referrer ?? bound;

    for (const tx of b.transactions) {
      if (tx.fromAddress === null) continue;
      if (tx.nonce !== nonceOf(tx.fromAddress)) return { err: "wrong nonce (replay or gap)" };
      const cost = tx.amount + tx.fee;
      const have = bal(tx.fromAddress);
      if (have < cost) return { err: "balance too low (overdraft/double spend, coinbase may not be mature yet)" };
      balances.set(tx.fromAddress, have - cost);
      nonces.set(tx.fromAddress, tx.nonce + 1);
      balances.set(tx.to, bal(tx.to) + tx.amount);
    }
    const undo: Undo = { balances: [], nonces: [], immatureAdded: b.index };
    for (const [k, v] of balances) {
      undo.balances.push([k, ledger.balances.get(k)]);
      ledger.balances.set(k, v);
    }
    for (const [k, v] of nonces) {
      undo.nonces.push([k, ledger.nonces.get(k)]);
      ledger.nonces.set(k, v);
    }
    if (released) {
      undo.immatureReleased = { height: due, entry: released };
      ledger.immature.delete(due);
    }
    if (cb.referrer) {
      ledger.referrers.set(cb.to, cb.referrer);
      undo.referrerAdded = cb.to;
    }
    const bonus = inviter ? Math.floor((rewardUnits(this.params, b.index) * (this.params.referralBps ?? 0)) / 10000) : 0;
    ledger.immature.set(b.index, bonus > 0 ? { to: cb.to, units: cb.amount - bonus, ref: inviter, refUnits: bonus } : { to: cb.to, units: cb.amount });
    this.indexBlock(b);
    return { err: null, undo };
  }

  private indexBlock(b: Block): void {
    for (const tx of b.transactions) {
      this.txIndex.set(tx.id, b.index);
      for (const a of [tx.fromAddress, tx.to]) {
        if (!a) continue;
        const list = this.addrIndex.get(a);
        if (!list) this.addrIndex.set(a, [b.index]);
        else if (list[list.length - 1] !== b.index) list.push(b.index);
      }
    }
  }

  private unindexBlock(b: Block): void {
    for (const tx of b.transactions) {
      this.txIndex.delete(tx.id);
      for (const a of [tx.fromAddress, tx.to]) {
        if (!a) continue;
        const list = this.addrIndex.get(a);
        if (!list) continue;
        if (list[list.length - 1] === b.index) list.pop();
        if (list.length === 0) this.addrIndex.delete(a);
      }
    }
  }

  findTx(id: string): { tx: Transaction; height: number; blockHash: string } | undefined {
    const height = this.txIndex.get(id);
    if (height === undefined) return undefined;
    const e = this.active[height];
    const tx = this.bodyOf(e).transactions.find((t) => t.id === id);
    return tx ? { tx, height, blockHash: e.block.hash } : undefined;
  }

  txsOfAddress(address: string, limit = 50, skip = 0): { tx: Transaction; height: number }[] {
    const heights = this.addrIndex.get(address) ?? [];
    const out: { tx: Transaction; height: number }[] = [];
    let skipped = 0;
    for (let i = heights.length - 1; i >= 0 && out.length < limit; i--) {
      const txs = this.bodyOf(this.active[heights[i]]).transactions.filter((t) => t.to === address || t.fromAddress === address);
      for (let k = txs.length - 1; k >= 0 && out.length < limit; k--) {
        if (skipped < skip) skipped++;
        else out.push({ tx: txs[k], height: heights[i] });
      }
    }
    return out;
  }

  private undoBlock(ledger: Ledger, e: Entry): void {
    const u = e.undo as Undo;
    this.unindexBlock(e.block);
    ledger.immature.delete(u.immatureAdded);
    if (u.immatureReleased) ledger.immature.set(u.immatureReleased.height, u.immatureReleased.entry);
    if (u.referrerAdded) ledger.referrers.delete(u.referrerAdded);
    for (const [k, v] of u.nonces) v === undefined ? ledger.nonces.delete(k) : ledger.nonces.set(k, v);
    for (const [k, v] of u.balances) v === undefined ? ledger.balances.delete(k) : ledger.balances.set(k, v);
  }

  addBlock(block: Block, source = "local"): AddResult {
    if (!block || typeof block !== "object" || typeof block.hash !== "string") return { status: "invalid", reason: "not a block" };
    if (this.entries.has(block.hash)) return { status: "known" };
    if (!Number.isSafeInteger(block.index) || block.index < 1) return { status: "invalid", reason: "invalid index" };

    const parent = this.entries.get(block.previousHash);
    if (!parent) return this.keepOrphan(block);
    if (parent.invalid) return { status: "invalid", reason: "parent is invalid" };

    const cp = this.checkpoints[block.index];
    if (cp && cp !== block.hash) return { status: "invalid", reason: "Checkpoint verletzt" };
    const err = this.checkBlock(block, parent);
    if (err) return { status: "invalid", reason: err };

    const entry: Entry = {
      block,
      work: parent.work + workOf(block.difficulty),
      parent,
      anchor: block.index === 1 ? block.timestamp : parent.anchor,
      invalid: false,
      txRoot: transactionRoot(block.transactions),
    };
    const tipEntry = this.active[this.active.length - 1];
    let isTip = false;

    if (parent === tipEntry) {
      const applied = this.applyBlock(this.ledger, block);
      if (applied.err) return { status: "invalid", reason: applied.err };
      entry.undo = applied.undo;
      this.entries.set(block.hash, entry);
      this.active.push(entry);
      isTip = true;
      this.afterTipChange([]);
    } else {
      this.entries.set(block.hash, entry);
      if (entry.work > tipEntry.work) {
        const switched = this.reorgTo(entry);
        if (switched !== null) {
          entry.invalid = true;
          this.entries.delete(block.hash);
          return { status: "invalid", reason: switched };
        }
        isTip = true;
      }
    }

    this.persistBlock(entry);
    this.cool();
    this.emit("block", { block, source, isTip });
    this.adoptOrphans(block.hash, source);
    return { status: "added", isTip };
  }

  private reorgTo(target: Entry): string | null {
    const path: Entry[] = [];
    for (let e: Entry | null = target; e; e = e.parent) path.push(e);
    path.reverse();
    const common = this.commonHeight(path);
    for (const h of Object.keys(this.checkpoints).map(Number)) {
      if (h > common && h <= this.height) return "reorg below a checkpoint refused";
    }
    const oldTail = this.active.slice(common + 1);
    if (oldTail.some((e) => !e.undo)) return `reorg deeper than ${this.hotWindow} blocks refused`;
    for (let i = oldTail.length - 1; i >= 0; i--) this.undoBlock(this.ledger, oldTail[i]);

    const applied: Entry[] = [];
    for (let i = common + 1; i < path.length; i++) {
      const r = this.applyBlock(this.ledger, path[i].block);
      if (r.err) {
        for (let j = i; j < path.length; j++) path[j].invalid = true;
        for (let k = applied.length - 1; k >= 0; k--) this.undoBlock(this.ledger, applied[k]);
        for (const e of oldTail) e.undo = this.applyBlock(this.ledger, e.block).undo;
        return `side chain invalid at block ${path[i].block.index}: ${r.err}`;
      }
      path[i].undo = r.undo;
      applied.push(path[i]);
    }
    const newSet = new Set(path.map((e) => e.block.hash));
    const orphanedTxs: Transaction[] = [];
    for (const e of oldTail) {
      if (!newSet.has(e.block.hash)) orphanedTxs.push(...e.block.transactions.filter((t) => t.fromAddress !== null));
    }
    const depth = oldTail.length;
    this.active = path;
    this.afterTipChange(orphanedTxs);
    if (depth > 0) console.log(`Reorg: ${depth} block(s) rolled back, new height ${this.height}`);
    this.emit("reorg", { depth });
    return null;
  }

  private commonHeight(newPath: Entry[]): number {
    let h = 0;
    while (h + 1 < newPath.length && h + 1 < this.active.length && newPath[h + 1] === this.active[h + 1]) h++;
    return h;
  }

  private keepOrphan(block: Block): AddResult {
    if (
      typeof block.seed !== "string" ||
      typeof block.nonce !== "string" ||
      !NONCE_RE.test(block.nonce) ||
      typeof block.seed !== "string" ||
      !SEED_RE.test(block.seed) ||
      typeof block.proofAddress !== "string" ||
      !ADDRESS_RE.test(block.proofAddress) ||
      !Number.isSafeInteger(block.difficulty) ||
      block.difficulty < this.params.minDifficulty ||
      block.difficulty > this.params.maxDifficulty ||
      block.hash !== calculateProofHash(block.seed, block.proofAddress, block.nonce) ||
      !hashMeetsDifficulty(block.hash, block.difficulty)
    ) {
      return { status: "invalid", reason: "Waise ohne gueltigen Beweis" };
    }
    if (this.orphanCount >= MAX_ORPHANS) return { status: "orphan" };
    const list = this.orphans.get(block.previousHash) ?? [];
    if (!list.some((b) => b.hash === block.hash)) {
      list.push(block);
      this.orphans.set(block.previousHash, list);
      this.orphanCount++;
    }
    return { status: "orphan" };
  }

  private adoptOrphans(parentHash: string, source: string): void {
    const list = this.orphans.get(parentHash);
    if (!list) return;
    this.orphans.delete(parentHash);
    this.orphanCount -= list.length;
    for (const b of list) this.addBlock(b, source);
  }

  private persistBlock(entry: Entry): void {
    if (!this.blocksFile) return;
    if (this.loading) {
      const pos = this.diskPos.get(entry.block.hash);
      if (pos) {
        entry.offset = pos.offset;
        entry.len = pos.len;
        this.diskPos.delete(entry.block.hash);
      }
      return;
    }
    const line = JSON.stringify(entry.block);
    const bytes = Buffer.byteLength(line);
    appendFileSync(this.blocksFile, line + "\n");
    entry.offset = this.fileSize;
    entry.len = bytes;
    this.fileSize += bytes + 1;
  }

  private cool(): void {
    while (this.coolMark < this.height - this.hotWindow) {
      const e = this.active[++this.coolMark];
      if (e.offset === undefined || e.cold) continue;
      e.block = { ...e.block, transactions: [] };
      e.cold = true;
      e.undo = undefined;
    }
  }

  private pendingOf(address: string, pool: Transaction[]): { cost: number; count: number } {
    let cost = 0;
    let count = 0;
    for (const tx of pool) {
      if (tx.fromAddress === address) {
        cost += tx.amount + tx.fee;
        count++;
      }
    }
    return { cost, count };
  }

  private checkMempoolTx(tx: Transaction, pool: Transaction[]): string | null {
    if (!isTransactionWellFormed(tx)) return "malformed transaction";
    if (tx.fee < this.params.minFeeUnits) return "fee below minimum";
    if (!verifyTransactionSignature(tx, this.networkId)) return "invalid signature";
    if (pool.some((t) => t.id === tx.id)) return "duplicate transaction";
    const from = tx.fromAddress as string;
    const pending = this.pendingOf(from, pool);
    const expected = (this.ledger.nonces.get(from) ?? 0) + pending.count;
    if (tx.nonce !== expected) return `wrong nonce (expected ${expected})`;
    const due = this.ledger.immature.get(this.height + 1 - this.params.coinbaseMaturity);
    const maturing = (due && due.to === from ? due.units : 0) + (due && due.ref === from ? (due.refUnits ?? 0) : 0);
    const available = (this.ledger.balances.get(from) ?? 0) + maturing - pending.cost;
    if (tx.amount + tx.fee > available) return "insufficient balance";
    return null;
  }

  private evictFor(tx: Transaction): boolean {
    const lastOf = new Map<string, Transaction>();
    for (const t of this.mempool) {
      const cur = lastOf.get(t.fromAddress as string);
      if (!cur || t.nonce > cur.nonce) lastOf.set(t.fromAddress as string, t);
    }
    let victim: Transaction | null = null;
    for (const t of lastOf.values()) if (!victim || t.fee < victim.fee) victim = t;
    if (!victim || victim.fee >= tx.fee || victim.fromAddress === tx.fromAddress) return false;
    this.mempool = this.mempool.filter((t) => t !== victim);
    return true;
  }

  submitTransaction(tx: Transaction, source = "local"): TxResult {
    const err = this.checkMempoolTx(tx, this.mempool);
    if (err) return { ok: false, error: err };
    if (this.mempool.length >= MAX_MEMPOOL && !this.evictFor(tx)) return { ok: false, error: "mempool full (fee too low)" };
    this.mempool.push(tx);
    this.emit("tx", { tx, source });
    return { ok: true };
  }

  private afterTipChange(returned: Transaction[]): void {
    const candidates = [...returned, ...this.mempool].sort((x, y) => x.nonce - y.nonce);
    const kept: Transaction[] = [];
    for (const tx of candidates) {
      if (this.checkMempoolTx(tx, kept) === null) kept.push(tx);
    }
    this.mempool = kept;
    this.emit("tip", this.tip);
  }

  private pickTransactions(max: number): Transaction[] {
    const queues = new Map<string, Transaction[]>();
    for (const tx of this.mempool) {
      const q = queues.get(tx.fromAddress as string) ?? [];
      q.push(tx);
      queues.set(tx.fromAddress as string, q);
    }
    for (const q of queues.values()) q.sort((x, y) => x.nonce - y.nonce);
    const picked: Transaction[] = [];
    while (picked.length < max) {
      let best: Transaction[] | null = null;
      for (const q of queues.values()) if (q.length && (!best || q[0].fee > best[0].fee)) best = q;
      if (!best) break;
      picked.push(best.shift() as Transaction);
    }
    return picked;
  }

  buildTemplate(address: string, invitation?: string): Template {
    if (!ADDRESS_RE.test(address)) throw new Error("invalid miner address");
    const parsed = parseInvitation(invitation);
    const inv = this.params.referralBps && parsed && !this.ledger.referrers.has(address) && verifyInvitation(parsed, address, this.networkId) ? parsed : undefined;
    const tipEntry = this.active[this.active.length - 1];
    const index = tipEntry.block.index + 1;
    const timestamp = Math.max(Date.now(), medianTimePast(this.params, tipEntry) + 1);
    const difficulty = nextDifficulty(this.params, tipEntry);
    const picked = this.pickTransactions(this.params.maxTxPerBlock);
    const fees = picked.reduce((sum, t) => sum + t.fee, 0);
    const coinbase = createCoinbaseTransaction(address, rewardUnits(this.params, index) + fees, index, timestamp, inv);
    const transactions = [coinbase, ...picked];
    const seed = computeSeed(tipEntry.block.hash, index, timestamp, difficulty, transactions);
    return { index, timestamp, previousHash: tipEntry.block.hash, difficulty, transactions, proofAddress: address, seed };
  }

  submitSolved(t: Template, nonce: string): { result: AddResult; block: Block } {
    const block = buildProvenBlock(t.index, t.timestamp, t.transactions, t.previousHash, t.difficulty, t.seed, t.proofAddress, nonce);
    return { result: this.addBlock(block, "local"), block };
  }

  getSupplyInfo() {
    let units = 0;
    const p = this.params;
    for (let h = 1; h <= this.height; ) {
      const segEnd = Math.min(this.height, (Math.floor(h / p.halvingInterval) + 1) * p.halvingInterval - 1);
      units += rewardUnits(p, h) * (segEnd - h + 1);
      h = segEnd + 1;
    }
    const nextHeight = this.height + 1;
    return {
      circulatingSupply: toCoins(units),
      maxSupply: MAX_SUPPLY_COINS,
      currentBlockReward: toCoins(rewardUnits(p, nextHeight)),
      blocksUntilNextHalving: p.halvingInterval - (nextHeight % p.halvingInterval),
      currentDifficulty: this.getNextDifficulty(),
    };
  }
}
