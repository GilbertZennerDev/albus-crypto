import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

export interface ConsensusParams {
  initialReward: number;
  halvingInterval: number;
  initialDifficulty: number;
  minDifficulty: number;
  maxDifficulty: number;
  targetBlockTimeMs: number;
  retargetTauMs: number;
  medianTimeBlocks: number;
  maxTxPerBlock: number;
  maxBlockBytes: number;
  minFeeUnits: number;
  coinbaseMaturity: number;
  maxFutureMs: number;
  referralBps?: number;
}

export const CHECKPOINTS: Record<number, string> = {};

export const MAX_REFERRAL_BPS = 5000;
export const UNITS_PER_COIN = 100_000_000;

export const MAINNET_PARAMS: ConsensusParams = {
  initialReward: 10 * UNITS_PER_COIN,
  halvingInterval: 1_050_000,
  initialDifficulty: 256,
  minDifficulty: 64,
  maxDifficulty: 1024,
  targetBlockTimeMs: 60_000,
  retargetTauMs: 1_800_000,
  medianTimeBlocks: 11,
  maxTxPerBlock: 500,
  maxBlockBytes: 1_000_000,
  minFeeUnits: 100_000,
  coinbaseMaturity: 100,
  maxFutureMs: 2 * 60 * 1000,
};

export const MAX_SUPPLY_COINS = (MAINNET_PARAMS.initialReward / UNITS_PER_COIN) * MAINNET_PARAMS.halvingInterval * 2;
export const GENESIS_TIMESTAMP = Date.UTC(2026, 10, 5);
export const GENESIS_MESSAGE = "Albus v3 genesis 2026-11-05 fair launch no premine, ruleset 4 (binary preimages)";

export function paramsFromEnv(env: NodeJS.ProcessEnv = process.env): ConsensusParams {
  const p = { ...MAINNET_PARAMS };
  if (env.INITIAL_DIFFICULTY) p.initialDifficulty = Number(env.INITIAL_DIFFICULTY);
  if (env.TARGET_BLOCK_TIME_MS) p.targetBlockTimeMs = Number(env.TARGET_BLOCK_TIME_MS);
  if (env.RETARGET_TAU_MS) p.retargetTauMs = Number(env.RETARGET_TAU_MS);
  if (env.HALVING_INTERVAL_BLOCKS) p.halvingInterval = Number(env.HALVING_INTERVAL_BLOCKS);
  const bps = Number(env.REFERRAL_BPS);
  if (Number.isInteger(bps) && bps > 0 && bps <= MAX_REFERRAL_BPS) p.referralBps = bps;
  return p;
}

export function networkIdOf(p: ConsensusParams, genesisHash: string): string {
  const text = JSON.stringify(Object.entries(p).sort(([a], [b]) => a.localeCompare(b))) + "|" + genesisHash;
  return bytesToHex(sha256(utf8ToBytes(text))).slice(0, 16);
}

export function rewardUnits(p: ConsensusParams, height: number): number {
  const halvings = Math.floor(height / p.halvingInterval);
  if (halvings >= 53) return 0;
  return Math.floor(p.initialReward / 2 ** halvings);
}

export function toCoins(units: number): number {
  return units / UNITS_PER_COIN;
}

export function parseCoins(text: string): number | null {
  const m = /^(\d{1,10})(?:\.(\d{1,8}))?$/.exec(text.trim());
  if (!m) return null;
  const u = Number(m[1]) * UNITS_PER_COIN + Number((m[2] ?? "").padEnd(8, "0"));
  return Number.isSafeInteger(u) && u > 0 ? u : null;
}

export function isUnits(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= MAX_SUPPLY_COINS * UNITS_PER_COIN;
}
