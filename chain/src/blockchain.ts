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
const BLOCK_REWARD = 25;
const DIFFICULTY = Number(process.env.MINING_DIFFICULTY ?? 4);
const MAX_TX_PER_BLOCK = Number(process.env.MAX_TX_PER_BLOCK ?? 50);

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

    let rewardTxs: Transaction[];
    if (totalShares > 0) {
      let distributed = 0;
      rewardTxs = contributors.map(([address, count], i) => {
        const isLast = i === contributors.length - 1;
        const amount = isLast ? BLOCK_REWARD - distributed : Math.floor((BLOCK_REWARD * count) / totalShares);
        distributed += amount;
        return createCoinbaseTransaction(address, amount);
      }).filter((tx) => tx.amount > 0);
      if (rewardTxs.length === 0) rewardTxs = [createCoinbaseTransaction(fallbackAddress, BLOCK_REWARD)];
    } else {
      rewardTxs = [createCoinbaseTransaction(fallbackAddress, BLOCK_REWARD)];
    }

    const transactions = [...rewardTxs, ...toMine];
    const previous = this.getLatestBlock();
    const block = mineBlock(previous.index + 1, transactions, previous.hash, DIFFICULTY);
    if (!isBlockHashValid(block)) throw new Error("mined block failed self-validation");
    this.chain.push(block);
    this.persist();
    return block;
  }
}
