import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { createGenesisBlock, buildProvenBlock, isBlockHashValid, type Block } from "./block.js";
import {
  createCoinbaseTransaction,
  createTransaction,
  isTransactionWellFormed,
  verifyTransactionSignature,
  type Transaction,
} from "./transaction.js";
import { generateKeyPair, type KeyPair } from "./wallet.js";
import { readJson, writeJsonAtomic } from "./storage.js";

const CHAIN_FILE = process.env.CHAIN_DATA_FILE ?? "data/chain.json";
const FAUCET_FILE = process.env.FAUCET_DATA_FILE ?? "data/faucet.json";
const DIFFICULTY_FILE = process.env.DIFFICULTY_DATA_FILE ?? "data/difficulty.json";

const GENESIS_SUPPLY = 1_000_000;
const MAX_TX_PER_BLOCK = Number(process.env.MAX_TX_PER_BLOCK ?? 50);

// Bitcoin-style halving schedule: the block reward halves every
// HALVING_INTERVAL_BLOCKS, converging on a fixed total supply instead of
// inflating forever (the original flat 25/block design had no cap at all —
// this is the single biggest lever for a credible "scarce asset" story).
// Reward is intentionally left as an exact fraction (no rounding) so the
// halving series can continue smoothly for hundreds of halvings — like
// Bitcoin's satoshi-denominated tail, just expressed as a decimal instead
// of an integer subunit.
const INITIAL_BLOCK_REWARD = Number(process.env.INITIAL_BLOCK_REWARD ?? 200);
const HALVING_INTERVAL_BLOCKS = Number(process.env.HALVING_INTERVAL_BLOCKS ?? 50_000);
export const MAX_SUPPLY = 21_000_000;

// Miners have no revenue once halvings shrink the block subsidy toward zero —
// a flat percentage transaction fee gives mining a permanent reason to keep
// running, same as Bitcoin's fee market is meant to take over long-term.
const FEE_RATE = Number(process.env.FEE_RATE ?? 0.005);

// Difficulty is "number of required leading hex-zero nibbles" rather than a
// continuous numeric target — each +1 is a 16x jump, coarser than Bitcoin's
// smooth retargeting, but it reuses the existing string-prefix hash check
// everywhere (miners, pool, block validation) with no protocol changes.
const INITIAL_BLOCK_DIFFICULTY = Number(process.env.INITIAL_BLOCK_DIFFICULTY ?? 5);
const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 10;
const TARGET_BLOCK_TIME_MS = Number(process.env.TARGET_BLOCK_TIME_MS ?? 30_000);
const RETARGET_INTERVAL_BLOCKS = Number(process.env.RETARGET_INTERVAL_BLOCKS ?? 20);

export function getBlockReward(height: number): number {
  const halvings = Math.floor(height / HALVING_INTERVAL_BLOCKS);
  return INITIAL_BLOCK_REWARD / 2 ** halvings;
}

interface ChainFile {
  chain: Block[];
}

interface DifficultyFile {
  difficulty: number;
  /** Timestamp of the block at the start of the current retarget window, for measuring actual elapsed time. */
  windowStartTimestamp: number;
  windowStartHeight: number;
}

export interface MiningJob {
  seed: string;
  index: number;
  previousHash: string;
  transactions: Transaction[];
  difficulty: number;
}

export class Blockchain {
  private chain: Block[];
  private mempool: Transaction[] = [];
  readonly faucet: KeyPair;
  private difficultyState: DifficultyFile;

  constructor() {
    let faucet = readJson<KeyPair>(FAUCET_FILE);
    if (!faucet) {
      faucet = generateKeyPair();
      writeJsonAtomic(FAUCET_FILE, faucet);
    }
    this.faucet = faucet;

    const existing = readJson<ChainFile>(CHAIN_FILE);
    if (existing && existing.chain.length > 0) {
      this.chain = existing.chain;
    } else {
      const genesisTx = createCoinbaseTransaction(this.faucet.address, GENESIS_SUPPLY);
      this.chain = [createGenesisBlock(genesisTx)];
      this.persist();
    }

    this.difficultyState =
      readJson<DifficultyFile>(DIFFICULTY_FILE) ?? {
        difficulty: INITIAL_BLOCK_DIFFICULTY,
        windowStartTimestamp: this.getLatestBlock().timestamp,
        windowStartHeight: this.getLatestBlock().index,
      };
  }

  private persist(): void {
    writeJsonAtomic(CHAIN_FILE, { chain: this.chain } satisfies ChainFile);
  }

  private persistDifficulty(): void {
    writeJsonAtomic(DIFFICULTY_FILE, this.difficultyState);
  }

  getChain(): Block[] {
    return this.chain;
  }

  getLatestBlock(): Block {
    return this.chain[this.chain.length - 1];
  }

  getMempool(): Transaction[] {
    return this.mempool;
  }

  getBlock(hashOrIndex: string): Block | undefined {
    if (/^\d+$/.test(hashOrIndex)) {
      return this.chain[Number(hashOrIndex)];
    }
    return this.chain.find((b) => b.hash === hashOrIndex);
  }

  getBalance(address: string): number {
    let balance = 0;
    for (const block of this.chain) {
      for (const tx of block.transactions) {
        if (tx.to === address) balance += tx.amount;
        if (tx.fromAddress === address) balance -= tx.amount + (tx.fee ?? 0);
      }
    }
    return balance;
  }

  private pendingOutgoing(address: string): number {
    return this.mempool
      .filter((tx) => tx.fromAddress === address)
      .reduce((sum, tx) => sum + tx.amount + (tx.fee ?? 0), 0);
  }

  submitTransaction(tx: Transaction): { ok: true } | { ok: false; error: string } {
    if (!isTransactionWellFormed(tx)) return { ok: false, error: "malformed transaction" };
    if (!verifyTransactionSignature(tx)) return { ok: false, error: "invalid signature" };
    if (this.mempool.some((t) => t.id === tx.id) || this.chain.some((b) => b.transactions.some((t) => t.id === tx.id))) {
      return { ok: false, error: "duplicate transaction" };
    }
    const address = tx.fromAddress as string;
    const fee = tx.amount * FEE_RATE;
    const available = this.getBalance(address) - this.pendingOutgoing(address);
    if (tx.amount + fee > available) return { ok: false, error: "insufficient balance" };
    tx.fee = fee;
    this.mempool.push(tx);
    return { ok: true };
  }

  faucetTransfer(to: string, amount: number): ReturnType<Blockchain["submitTransaction"]> {
    const tx = createTransaction(this.faucet.privateKey, this.faucet.publicKey, to, amount);
    return this.submitTransaction(tx);
  }

  getCurrentDifficulty(): number {
    return this.difficultyState.difficulty;
  }

  /**
   * Computes the job miners currently hash against — real, since it's
   * derived directly from the actual next block's content (previous hash,
   * height, and the exact transactions that would be included), rather than
   * an independent puzzle. A share whose hash also clears the current
   * difficulty against this seed IS a valid proof for this exact block.
   */
  getCurrentJob(): MiningJob {
    const previous = this.getLatestBlock();
    const index = previous.index + 1;
    const transactions = this.mempool.slice(0, MAX_TX_PER_BLOCK);
    const txIds = transactions
      .map((t) => t.id)
      .sort()
      .join(",");
    // Truncated to 32 hex chars (128 bits — plenty of collision resistance
    // for a non-secret job identifier) so the fixed seed|address| prefix
    // length miners hash against matches what the GPU kernel hardcodes
    // (see gpu-worker.js) — the old design used a 32-char random seed, and
    // the GPU kernel's fixed-layout optimization depends on that exact size.
    const seed = bytesToHex(sha256(utf8ToBytes(`${previous.hash}|${index}|${txIds}`))).slice(0, 32);
    return { seed, index, previousHash: previous.hash, transactions, difficulty: this.difficultyState.difficulty };
  }

  /**
   * Every RETARGET_INTERVAL_BLOCKS, compare real elapsed time against
   * TARGET_BLOCK_TIME_MS and adjust difficulty by one nibble (16x) in the
   * appropriate direction — coarse but keeps mining meaningfully hard as
   * real network hashrate changes, instead of a difficulty that never moves.
   */
  private maybeRetarget(newHeight: number): void {
    const blocksInWindow = newHeight - this.difficultyState.windowStartHeight;
    if (blocksInWindow < RETARGET_INTERVAL_BLOCKS) return;
    // elapsed floored at 1ms: real hashrate can clear a window in single-digit
    // milliseconds, and log16(expected/0) would be infinite/NaN.
    const elapsed = Math.max(1, this.getLatestBlock().timestamp - this.difficultyState.windowStartTimestamp);
    const expected = TARGET_BLOCK_TIME_MS * blocksInWindow;
    // Proportional, not a fixed +/-1 nibble per window: a network hashrate
    // wildly above/below whatever INITIAL_BLOCK_DIFFICULTY guessed would
    // otherwise take dozens of windows (and mint a full reward every block
    // along the way) to climb into the right range. Sizing the jump to
    // log16(expected/elapsed) converges in 1-2 windows regardless of how far
    // off the starting guess was, at the cost of a larger single jump when
    // hashrate is far from target (still bounded by MAX_RETARGET_STEP so one
    // wildly noisy window can't swing difficulty to an extreme).
    const MAX_RETARGET_STEP = 4;
    const rawStep = Math.round(Math.log(expected / elapsed) / Math.log(16));
    const step = Math.max(-MAX_RETARGET_STEP, Math.min(MAX_RETARGET_STEP, rawStep));
    if (step !== 0) {
      this.difficultyState.difficulty = Math.max(
        MIN_DIFFICULTY,
        Math.min(MAX_DIFFICULTY, this.difficultyState.difficulty + step),
      );
    }
    this.difficultyState.windowStartHeight = newHeight;
    this.difficultyState.windowStartTimestamp = this.getLatestBlock().timestamp;
    this.persistDifficulty();
  }

  /**
   * Splits `pool` proportionally across `contributors` (by share count),
   * minting one coinbase tx per contributor. The last contributor gets the
   * exact remainder so amounts sum to `pool` precisely rather than drifting
   * from float division. Not floored: a small pool split across many
   * contributors can be a fraction of a fraction, and integer-rounding that
   * to 0 would unfairly zero out small-but-real contributions.
   */
  private splitProportional(
    pool: number,
    contributors: [string, number][],
    totalShares: number,
    isFeeReward: boolean,
  ): Transaction[] {
    if (pool <= 0) return [];
    let distributed = 0;
    return contributors
      .map(([address, count], i) => {
        const isLast = i === contributors.length - 1;
        const amount = isLast ? pool - distributed : (pool * count) / totalShares;
        distributed += amount;
        return createCoinbaseTransaction(address, amount, isFeeReward);
      })
      .filter((tx) => tx.amount > 0);
  }

  /**
   * Finalizes a block from a proven (seed, proofAddress, nonce) triple. The
   * proof must match the job currently computable from live chain state —
   * if the mempool or chain head changed since the job was issued (another
   * block just landed, or a new transaction arrived), the seed won't match
   * and this returns null so the caller can just fetch a fresh job instead
   * of silently mining stale/duplicate content.
   */
  submitProof(
    seed: string,
    proofAddress: string,
    nonce: string,
    shares: Record<string, number>,
    fallbackAddress: string,
  ): Block | null {
    const job = this.getCurrentJob();
    if (job.seed !== seed) return null;

    const feeTotal = job.transactions.reduce((sum, tx) => sum + (tx.fee ?? 0), 0);
    const reward = getBlockReward(job.index);

    const contributors = Object.entries(shares).filter(([, count]) => count > 0);
    const totalShares = contributors.reduce((sum, [, count]) => sum + count, 0);

    let rewardTxs: Transaction[];
    if (totalShares > 0) {
      rewardTxs = [
        ...this.splitProportional(reward, contributors, totalShares, false),
        ...this.splitProportional(feeTotal, contributors, totalShares, true),
      ];
      if (rewardTxs.length === 0) rewardTxs = [createCoinbaseTransaction(fallbackAddress, reward + feeTotal)];
    } else {
      rewardTxs = [createCoinbaseTransaction(proofAddress, reward + feeTotal)];
    }

    const transactions = [...rewardTxs, ...job.transactions];
    const block = buildProvenBlock(job.index, transactions, job.previousHash, job.difficulty, seed, proofAddress, nonce);
    if (!isBlockHashValid(block)) throw new Error("submitted proof failed self-validation");

    this.mempool.splice(0, job.transactions.length);
    this.chain.push(block);
    this.maybeRetarget(block.index);
    this.persist();
    return block;
  }

  /** Fallback path when nobody is mining: pays out to fallbackAddress so pending transactions still eventually confirm. */
  mineFallbackBlock(fallbackAddress: string): Block | null {
    if (this.mempool.length === 0) return null;
    const job = this.getCurrentJob();
    const reward = getBlockReward(job.index);
    const feeTotal = job.transactions.reduce((sum, tx) => sum + (tx.fee ?? 0), 0);
    const rewardTxs = [createCoinbaseTransaction(fallbackAddress, reward + feeTotal)];
    const transactions = [...rewardTxs, ...job.transactions];
    // No real proof-of-work was done — this is an explicit, rare escape
    // hatch (long timer) so the chain doesn't stall forever with zero
    // miners, not a substitute for real mining. difficulty 0 makes any
    // nonce/seed pair trivially "valid" for self-check purposes.
    const block = buildProvenBlock(job.index, transactions, job.previousHash, 0, job.seed, fallbackAddress, "0");
    this.mempool.splice(0, job.transactions.length);
    this.chain.push(block);
    this.persist();
    return block;
  }

  getSupplyInfo() {
    let circulatingSupply = 0;
    for (const block of this.chain) {
      for (const tx of block.transactions) {
        // Only count genuinely new coinbase mints toward the supply cap —
        // fee-reward coinbase txs recycle existing money from senders to
        // miners and must not double-count as newly "mined".
        if (tx.fromAddress === null && !tx.isFeeReward) circulatingSupply += tx.amount;
      }
    }
    const nextHeight = this.getLatestBlock().index + 1;
    const currentReward = getBlockReward(nextHeight);
    const blocksUntilNextHalving = HALVING_INTERVAL_BLOCKS - (nextHeight % HALVING_INTERVAL_BLOCKS);
    return {
      circulatingSupply,
      maxSupply: MAX_SUPPLY,
      currentBlockReward: currentReward,
      blocksUntilNextHalving,
      currentDifficulty: this.difficultyState.difficulty,
    };
  }
}
