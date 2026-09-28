# Threat Model

## Scope

This worker runs on operator-owned hardware and talks to one central API
(`https://albus.workflowsolved.com/api`). It never runs on visitor hardware, never accepts
arbitrary code, and only executes a fixed, narrow command set against a locally allowlisted
miner profile.

## Threats from malicious website users

**Website visitors have no path to this worker at all.** They interact only with the central
API/dashboard, which exposes logical worker identities and status data — never a worker's
address, token, or any direct control surface. A malicious visitor cannot:

- Cause the worker to execute code, since the worker never accepts a wallet address, pool URL,
  command line, or file path from the API — only a `profile_id` string checked against a local
  allowlist (`app/miner_controller.py::MinerController.get_profile`).
- Trigger browser-side mining, since there is none — this worker is the only thing that ever
  touches a GPU, and it is not reachable from a browser.

**Mitigation**: architectural separation. There is no code path from "website visitor input" to
"worker action" that doesn't pass through the central API's own authorization and the worker's
independent signature/allowlist checks.

**Remaining risk**: if the central API's authorization for *which logical user can request what*
is itself broken, a user could cause a legitimate `start` command to be issued for a worker they
shouldn't control. That's a central-API-side authorization concern, out of scope for this
repository, but the worker's own checks (profile allowlist, thermal/power limits, signature
validity) still bound the damage to "mines using an operator-approved profile," never arbitrary
code execution.

## Threats from a compromised API/backend

This is the primary threat this worker's security layer is designed against — every design
principle in `SECURITY.md` exists specifically so that a fully compromised or malicious API
**cannot**:

- **Run arbitrary code**: commands only ever carry an `action` (from a five-value enum) and a
  `profile_id` (checked against a local allowlist) — there is no field for a shell command, file
  path, or executable.
- **Choose an arbitrary pool, wallet, or miner binary**: those are only ever read from the
  operator's own `profiles.yaml`, mounted read-only, never touched by anything from the API.
- **Forge a command**: every command must carry a valid Ed25519 signature over a canonical byte
  representation (`app/command_verifier.py::canonicalize`), verified against a public key the
  operator provisioned locally (`config/public-keys.json`) — a compromised API without the
  corresponding private key cannot produce a valid signature.
- **Override thermal/power protection**: `enforce_local_safety` runs every control-loop tick
  independent of anything the API says, and a `start`/`resume` request is rejected outright while
  a thermal/power flag is active (see `Worker._try_apply` in `app/main.py`).
- **Force unlimited mining**: `MinerController`'s restart budget (`miner_max_restarts` per
  `miner_restart_window_seconds`) bounds how much a repeatedly-crashing or repeatedly-restarted
  miner process can do before requiring a fresh, independently-verified command.

**Remaining risk**: a compromised API can still issue *valid-looking, correctly signed* damaging
commands if it also somehow obtained the Ed25519 private key (a key-compromise scenario, not an
API-compromise scenario) — mitigated by key rotation support (`docs/operations.md`) and by the
fact that even a maximally malicious signed command can only `start`/`stop`/`pause`/`resume` an
already-vetted, operator-defined profile, never anything unbounded.

## Replay attacks

Every command carries a `command_id` and a `nonce`, both persisted in a local SQLite store
(`app/replay_store.py`) the instant a command passes signature/schema/time validation. A captured
command — even one that is still within its (short, max-5-minute) validity window — cannot be
replayed: the second attempt fails on `DUPLICATE_COMMAND` or `DUPLICATE_NONCE` before it can be
applied.

**Mitigation**: persistent (survives worker restarts, not just in-memory) tracking of both IDs
independently, so a nonce reused across two different command_ids, or a command_id reused with a
different nonce, is caught either way.

**Remaining risk**: replay protection is per-worker (SQLite is local to each worker's own
`/data` volume) — this is correct, since each worker has its own worker_id and the API cannot
address a command at another worker without failing `WRONG_WORKER_ID`.

## Command tampering

Any single-byte modification to a signed field changes the canonical byte representation, which
invalidates the Ed25519 signature — verified in `CommandVerifier.verify` before the command is
ever inspected for its action/profile. A man-in-the-middle without the private key cannot produce
a valid signature for a tampered command; TLS additionally protects the transport itself.

## Secrets exposure

- `WORKER_TOKEN` is only ever sent as a bearer `Authorization` header over TLS, and is redacted
  from all structured logs (`app/logging.py::redact`).
- The Ed25519 **private** signing key is never present in this repository or on the worker at
  all — only the **public** verification key is mounted (read-only) into the worker. Signing
  happens on the operator's/backend's side.
- Prometheus metrics never carry a worker token, wallet address, full GPU UUID, IP address, or
  user identifier as a label value (`app/metrics.py`).

## Container escape attempts

Mitigated via defense in depth, not any single control: non-root UID (10001), `read_only: true`
root filesystem with `tmpfs` for the only writable paths needed, all Linux capabilities dropped,
`no-new-privileges`, no Docker socket mount, no privileged mode, no host networking. See
`docker-compose.yml`.

**Remaining risk**: a kernel-level container-escape vulnerability is outside what any
application-layer or Compose-level hardening can fully prevent — keep the host kernel and Docker
Engine patched.

## Mining process crashes

Handled explicitly by `MinerController.poll_health` and a bounded restart policy
(`RestartTracker`): up to `miner_max_restarts` restarts within `miner_restart_window_seconds`,
after which the miner enters `CRASHED` and requires a fresh valid command (or operator
intervention) rather than restart-looping indefinitely.

## Overheating and hardware damage

`enforce_local_safety` stops the miner and forces `THERMAL_PROTECT`/`POWER_PROTECT` the instant a
reading crosses the configured threshold — independent of API reachability. The worker never
touches GPU power limits, overclocks, or fan curves itself (see `README.md`); an operator wanting
a hard hardware-level cap should set one via `nvidia-smi -pl` themselves.

**Remaining risk**: `enforce_local_safety` depends on `nvidia-smi` succeeding and returning
current data; if `nvidia-smi` itself is compromised or returns stale/false-low readings, this
protection is only as good as its data source. This worker does not attempt to independently
verify GPU telemetry through a second channel.

## Network outages

If the API is unreachable past `heartbeat_failure_grace_seconds` (default 5 minutes), the worker
stops mining and moves to `PAUSED` (or `ERROR` if `PAUSED` isn't reachable from the current state)
rather than continuing to mine unsupervised indefinitely — see
`Worker.enforce_api_reachability`.
