import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PeerStats, truncateIp } from "../src/peer-stats.js";

test("Adressen werden gekürzt: IPv4 auf /24, IPv6 auf /48", () => {
  assert.equal(truncateIp("203.0.113.77"), "203.0.113.0/24");
  assert.equal(truncateIp("::ffff:203.0.113.77"), "203.0.113.0/24");
  assert.equal(truncateIp("2001:db8:abcd:1234::1"), "2001:db8:abcd::/48");
});

test("Zähler: gleiche Netze zählen einmal, Tage getrennt, nur gekürzte Daten auf der Platte", () => {
  const dir = mkdtempSync(join(tmpdir(), "peerstats-"));
  let t = Date.parse("2026-11-11T10:00:00Z");
  const s = new PeerStats(dir, () => t);
  s.seen("203.0.113.5", 1);
  s.seen("203.0.113.99", 3);
  s.seen("198.51.100.1", 2);
  t += 86_400_000;
  s.seen("203.0.113.5", 1);
  assert.deepEqual(s.summary(), [
    { date: "2026-11-11", networks: 2, peak: 3 },
    { date: "2026-11-12", networks: 1, peak: 1 },
  ]);
  s.save();
  const raw = readFileSync(join(dir, "peer-stats.json"), "utf8");
  assert.ok(!raw.includes("203.0.113.5") && !raw.includes("203.0.113.99"), "volle Adresse gespeichert");
  assert.deepEqual(new PeerStats(dir, () => t).summary(), s.summary());
});
