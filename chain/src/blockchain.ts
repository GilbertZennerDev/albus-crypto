import { createGenesisBlock, mineBlock, isBlockHashValid, type Block } from "./block.js";
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

const GENESIS_SUPPLY = 1_000_000;
const DIFFICULTY = Number(process.env.MINING_DIFFICULTY ?? 4);
const MAX_TX_PER_BLOCK = Number(process.env.MAX_TX_PER_BLOCK ?? 50);

// Bitcoin-style halving schedule: the block reward halves every
// HALVING_INTERVAL_BLOCKS, converging on a fixed total supply instead of
// inflating forever (the original flat 25/block design had no cap at all —
// this is the single biggest lever for a credible "scarce asset" story).
// Reward is intentionally left as an exact fraction (no rounding) so the
// halving series can continue smoothly for hundreds of halvings — like
// Bitcoin's satoshi-denominated tail, just expressed as a decimal instead
// of an integer subunit. 200 reward * 50,000 blocks * 2 (geometric sum) =
// 20,000,000 ALB minted under this schedule, on top of the ~1,000,000+ that
// already exists from genesis and pre-halving blocks — landing close to a
// deliberately Bitcoin-echoing ~21,000,000 total.
const INITIAL_BLOCK_REWARD = Number(process.env.INITIAL_BLOCK_REWARD ?? 200);
const HALVING_INTERVAL_BLOCKS = Number(process.env.HALVING_INTERVAL_BLOCKS ?? 50_000);
export const MAX_SUPPLY = 21_000_000;

export function getBlockReward(height: number): number {
  const halvings = Math.floor(height / HALVING_INTERVAL_BLOCKS);
  return INITIAL_BLOCK_REWARD / 2 ** halvings;
}

interface ChainFile {
  chain: Block[];
}

export class Blockchain {
  private chain: Block[];
  private mempool: Transaction[] = [];
  readonly faucet: KeyPair;

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
  }

  private persist(): void {
    writeJsonAtomic(CHAIN_FILE, { chain: this.chain } satisfies ChainFile);
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
        if (tx.fromAddress === address) balance -= tx.amount;
      }
    }
    return balance;
  }

  private pendingOutgoing(address: string): number {
    return this.mempool
      .filter((tx) => tx.fromAddress === address)
      .reduce((sum, tx) => sum + tx.amount, 0);
  }

  submitTransaction(tx: Transaction): { ok: true } | { ok: false; error: string } {
    if (!isTransactionWellFormed(tx)) return { ok: false, error: "malformed transaction" };
    if (!verifyTransactionSignature(tx)) return { ok: false, error: "invalid signature" };
    if (this.mempool.some((t) => t.id === tx.id) || this.chain.some((b) => b.transactions.some((t) => t.id === tx.id))) {
      return { ok: false, error: "duplicate transaction" };
    }
    const address = tx.fromAddress as string;
    const available = this.getBalance(address) - this.pendingOutgoing(address);
    if (tx.amount > available) return { ok: false, error: "insufficient balance" };
    this.mempool.push(tx);
    return { ok: true };
  }

  faucetTransfer(to: string, amount: number): ReturnType<Blockchain["submitTransaction"]> {
    const tx = createTransaction(this.faucet.privateKey, this.faucet.publicKey, to, amount);
    return this.submitTransaction(tx);
  }

  /**
   * Mines one block, splitting the block reward across this epoch's proof-of-work
   * contributors proportional to verified shares. Falls back to `fallbackAddress`
   * (the pool wallet) when nobody contributed shares this epoch, so the chain still
   * makes progress on pending transactions.
   */
  mineEpoch(shares: Record<string, number>, fallbackAddress: string): Block | null {
    const contributors = Object.entries(shares).filter(([, count]) => count > 0);
    const totalShares = contributors.reduce((sum, [, count]) => sum + count, 0);
    if (totalShares === 0 && this.mempool.length === 0) return null;

    const toMine = this.mempool.splice(0, MAX_TX_PER_BLOCK);
    const previous = this.getLatestBlock();
    const reward = getBlockReward(previous.index + 1);

    let rewardTxs: Transaction[];
    if (totalShares > 0) {
      // Not floored: a halved reward split across many contributors can be a
      // fraction of a fraction, and integer-rounding that to 0 constantly
      // would unfairly zero out small-but-real contributions. The last
      // contributor gets the exact remainder so amounts sum to `reward`
      // precisely rather than drifting from float division.
      let distributed = 0;
      rewardTxs = contributors.map(([address, count], i) => {
        const isLast = i === contributors.length - 1;
        const amount = isLast ? reward - distributed : (reward * count) / totalShares;
        distributed += amount;
        return createCoinbaseTransaction(address, amount);
      }).filter((tx) => tx.amount > 0);
      if (rewardTxs.length === 0) rewardTxs = [createCoinbaseTransaction(fallbackAddress, reward)];
    } else {
      rewardTxs = [createCoinbaseTransaction(fallbackAddress, reward)];
    }

    const transactions = [...rewardTxs, ...toMine];
    const block = mineBlock(previous.index + 1, transactions, previous.hash, DIFFICULTY);
    if (!isBlockHashValid(block)) throw new Error("mined block failed self-validation");
    this.chain.push(block);
    this.persist();
    return block;
  }

  getSupplyInfo() {
    let circulatingSupply = 0;
    for (const block of this.chain) {
      for (const tx of block.transactions) {
        if (tx.fromAddress === null) circulatingSupply += tx.amount; // coinbase: newly minted
      }
    }
    const nextHeight = this.getLatestBlock().index + 1;
    const currentReward = getBlockReward(nextHeight);
    const blocksUntilNextHalving = HALVING_INTERVAL_BLOCKS - (nextHeight % HALVING_INTERVAL_BLOCKS);
    return { circulatingSupply, maxSupply: MAX_SUPPLY, currentBlockReward: currentReward, blocksUntilNextHalving };
  }
}
