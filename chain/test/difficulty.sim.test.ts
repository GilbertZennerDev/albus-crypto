import test from "node:test";
import assert from "node:assert/strict";
import { nextDifficulty, type HeaderNode } from "../src/blockchain.js";
import { MAINNET_PARAMS as P } from "../src/params.js";
import { SUB } from "../src/difficulty.js";

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Run {
  tip: HeaderNode;
  times: number[];
  diffs: number[];
}

function simulate(seed: number, until: number, hashrate: (tMs: number) => number, stamp: (real: number, parent: number) => number = (r) => r): Run {
  const rand = rng(seed);
  let node: HeaderNode = { block: { index: 0, timestamp: 0, difficulty: 0 }, parent: null, anchor: 0 };
  let real = 0;
  const times: number[] = [];
  const diffs: number[] = [];
  while (real < until) {
    const d = nextDifficulty(P, node);
    const mean = (2 ** (d / SUB) / hashrate(real)) * 1000;
    const dt = Math.max(1, -Math.log(1 - rand()) * mean);
    real += dt;
    const ts = Math.max(node.block.timestamp + 1, Math.round(stamp(real, node.block.timestamp)));
    times.push(ts - node.block.timestamp);
    diffs.push(d);
    const index = node.block.index + 1;
    node = { block: { index, timestamp: ts, difficulty: d }, parent: node, anchor: index === 1 ? ts : node.anchor };
  }
  return { tip: node, times, diffs };
}

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GH = 1e9;

test("Long run: block time stays near 60 s, difficulty stays in range", () => {
  const r = simulate(1, 3 * DAY, () => 5 * GH);
  const tail = r.times.slice(-1000);
  const m = mean(tail) / 1000;
  assert.ok(m > 50 && m < 72, `mittlere Blockzeit ${m.toFixed(1)} s`);
  const tailD = r.diffs.slice(-1000);
  assert.ok(Math.max(...tailD) - Math.min(...tailD) < 24, `Schwankung ${Math.max(...tailD) - Math.min(...tailD)} Stufen`);
  assert.ok(Math.max(...r.diffs) <= P.maxDifficulty && Math.min(...r.diffs) >= P.minDifficulty);
});

test("Hashrate x10 and x1000: chain returns to 60 s quickly", () => {
  for (const f of [10, 1000]) {
    const r = simulate(2, 2 * DAY, (t) => (t < DAY ? 1 * GH : f * GH));
    const jumpAt = r.times.reduce((acc, x, i) => (acc.t < DAY ? { t: acc.t + x, i } : acc), { t: 0, i: 0 }).i;
    const after = r.times.slice(jumpAt);
    let t = 0;
    let k = 0;
    while (k < after.length && mean(after.slice(k, k + 30)) < 45_000) t += after[k++];
    assert.ok(k < after.length, `x${f}: nie erholt`);
    assert.ok(t < 3 * HOUR, `x${f}: recovery took ${(t / HOUR).toFixed(2)} h`);
    const tail = mean(after.slice(-500)) / 1000;
    assert.ok(tail > 48 && tail < 75, `x${f}: Endwert ${tail.toFixed(1)} s`);
  }
});

test("Hashrate drops to 1/100: chain does not stall", () => {
  const r = simulate(3, 3 * DAY, (t) => (t < DAY ? 50 * GH : 0.5 * GH));
  let t = 0;
  let k = 0;
  const start = r.times.reduce((acc, x, i) => (acc.t < DAY ? { t: acc.t + x, i } : acc), { t: 0, i: 0 }).i;
  const after = r.times.slice(start);
  while (k < after.length && mean(after.slice(k, k + 10)) > 100_000) t += after[k++];
  assert.ok(k < after.length, "nie erholt");
  assert.ok(t < 12 * HOUR, `recovery took ${(t / HOUR).toFixed(1)} h`);
});

test("Timestamp liars: difficulty stays bounded, steps stay small", () => {
  const early = simulate(4, 6 * HOUR, () => 5 * GH, (_r, parent) => parent + 1);
  assert.ok(Math.max(...early.diffs) <= P.maxDifficulty);
  const late = simulate(5, 6 * HOUR, () => 5 * GH, (r) => r + P.maxFutureMs);
  assert.ok(Math.min(...late.diffs) >= P.minDifficulty);
});

test("Issuance after 30 days is close to 10 ALB per minute", () => {
  const r = simulate(6, 30 * DAY, () => 5 * GH);
  const coins = r.tip.block.index * (P.initialReward / 1e8);
  const expected = 30 * 1440 * 10;
  assert.ok(coins > expected * 0.9 && coins < expected * 1.1, `${coins} ALB nach 30 Tagen (erwartet ca. ${expected})`);
});

test("On/off miner (x50 for 3 h, off for 3 h): average block time stays tolerable, no stall", () => {
  const onOff = (t: number) => (Math.floor(t / (3 * HOUR)) % 2 === 0 ? 50 * GH : 1 * GH);
  const r = simulate(7, 4 * DAY, onOff);
  const skip = r.times.reduce((acc, x, i) => (acc.t < DAY ? { t: acc.t + x, i } : acc), { t: 0, i: 0 }).i;
  const after = r.times.slice(skip);
  const m = mean(after) / 1000;
  const worst = Math.max(...after) / 1000;
  console.log(`Ein/Aus: mittlere Blockzeit ${m.toFixed(1)} s, longest gap ${(worst / 60).toFixed(1)} min`);
  assert.ok(m < 120, `mittlere Blockzeit ${m.toFixed(1)} s`);
  assert.ok(worst < 6 * 3600, `longest gap ${(worst / 60).toFixed(1)} min`);
});
