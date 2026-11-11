import test from "node:test";
import assert from "node:assert/strict";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function selfishShare(alpha: number, gamma: number, blocks: number, seed = 7): number {
  const rnd = rng(seed);
  let lead = 0;
  let tie = false;
  let mine = 0;
  let others = 0;
  for (let i = 0; i < blocks; i++) {
    const attackerFinds = rnd() < alpha;
    if (tie) {
      if (attackerFinds) mine += 2;
      else if (rnd() < gamma) { mine += 1; others += 1; }
      else others += 2;
      tie = false;
      lead = 0;
    } else if (attackerFinds) {
      lead++;
    } else if (lead === 0) {
      others++;
    } else if (lead === 1) {
      tie = true;
    } else if (lead === 2) {
      mine += 2;
      lead = 0;
    } else {
      mine += 1;
      lead--;
    }
  }
  return mine / Math.max(1, mine + others);
}

test("Selfish Mining: mit unter einem Drittel der Rechenleistung lohnt sich der Trick nicht", () => {
  for (const alpha of [0.1, 0.2, 0.3]) {
    const share = selfishShare(alpha, 0, 400_000);
    console.log(`alpha ${alpha}, gamma 0: Angreifer bekommt ${(share * 100).toFixed(1)} % der Belohnung (fair: ${alpha * 100} %)`);
    assert.ok(share < alpha, `bei ${alpha} lohnt es sich unerwartet: ${share}`);
  }
});

test("Selfish Mining: das bekannte Limit, ab etwa einem Drittel (bei gamma 0,5 ab einem Viertel) lohnt es sich", () => {
  const fair = 0.4;
  const share = selfishShare(fair, 0.5, 400_000);
  console.log(`alpha 0.4, gamma 0.5: Angreifer bekommt ${(share * 100).toFixed(1)} % (fair: 40 %)`);
  assert.ok(share > fair);
  const quarter = selfishShare(0.25, 0.5, 400_000);
  console.log(`alpha 0.25, gamma 0.5: ${(quarter * 100).toFixed(1)} % (fair: 25 %)`);
  assert.ok(quarter > 0.25 * 0.95 && quarter < 0.3);
});
