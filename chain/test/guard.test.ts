import test from "node:test";
import assert from "node:assert/strict";
import { ConnLimiter, isPublicWsUrl } from "../src/guard.js";

test("Peer addresses: private and local targets are rejected (SSRF)", () => {
  for (const u of ["ws://127.0.0.1:4000/p2p", "ws://localhost/p2p", "ws://10.1.2.3/p2p", "ws://192.168.0.5/p2p", "ws://172.20.0.1/p2p", "ws://169.254.169.254/", "ws://[::1]/p2p", "ws://[fd00::1]/p2p", "ws://nas.local/p2p", "ws://0.0.0.0/p2p", "ws://100.64.0.1/p2p"]) {
    assert.equal(isPublicWsUrl(u), false, u);
  }
  for (const u of ["wss://albus.example.com/p2p", "ws://8.8.8.8:4000/p2p", "ws://172.32.0.1/p2p", "ws://[2001:db8::1]/p2p"]) {
    assert.equal(isPublicWsUrl(u), true, u);
  }
});

test("Connection limit per IP", () => {
  const l = new ConnLimiter(2);
  assert.ok(l.acquire("a") && l.acquire("a"));
  assert.equal(l.acquire("a"), false);
  assert.ok(l.acquire("b"));
  l.release("a");
  assert.ok(l.acquire("a"));
});
