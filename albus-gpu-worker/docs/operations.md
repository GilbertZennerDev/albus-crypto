# Operations

## Normal states and expected behavior

| State | Meaning |
|---|---|
| `OFFLINE` | Process starting, not yet registered |
| `IDLE` | Registered, no miner running, no active protection |
| `STARTING` | A `start` command was accepted, miner process launching |
| `RUNNING` | Miner actively running |
| `PAUSED` | Miner paused (via `pause` command, or after an extended API outage) |
| `THERMAL_PROTECT` | GPU temperature crossed the stop threshold — miner force-stopped |
| `POWER_PROTECT` | GPU power draw crossed the max threshold — miner force-stopped |
| `ERROR` | `nvidia-smi` unavailable, miner exceeded its restart budget, or an internal fault |
| `STOPPING` | A `stop` command is being applied |

`THERMAL_PROTECT` and `POWER_PROTECT` are entered **regardless of what the API most recently
asked for** — see `THREAT_MODEL.md`. They clear back to `IDLE` automatically once the trigger
condition is gone (temperature at/below `GPU_RESUME_TEMP_C`, power below 90% of
`GPU_MAX_POWER_WATTS`), but a **fresh, valid `start`/`resume` command is still required** to
actually resume mining — recovery from protection never auto-resumes mining on its own.

## Inspecting logs

Logs are structured JSON on stdout:

```bash
docker compose logs -f worker
docker compose logs worker | jq 'select(.level == "ERROR")'
```

Secrets (`Authorization`, `worker_token`, `signature`, wallet addresses, passwords) are always
redacted as `"[REDACTED]"` — see `app/logging.py::redact`. If you ever see a real secret in logs,
that's a bug; report it per `SECURITY.md`.

## Disabling mining locally

Without touching the central API, an operator can immediately stop mining on a given worker:

```bash
docker compose stop worker      # stops the whole worker (miner included)
# or, to keep telemetry/heartbeat running but definitely not mine:
# set every profile's `enabled: false` in profiles.yaml, then send a `refresh_config`
# (or restart the worker) — a disabled profile can never be started.
```

## How thermal protection works

Every control-loop tick (roughly once per second, see `app/main.py::_run_loop`),
`enforce_local_safety` reads current GPU telemetry and compares it against `GPU_STOP_TEMP_C` /
`GPU_MAX_POWER_WATTS`. Crossing either immediately stops the miner process and transitions to
`THERMAL_PROTECT`/`POWER_PROTECT`, independent of the API. See `THREAT_MODEL.md` for why this is
enforced locally rather than left to the API.

## Rotating a public key

1. Add the new key under a new `key_id` in `config/public-keys.json` alongside the old one (don't
   remove the old one yet).
2. Redeploy the worker (`docker compose up -d --build`) so it picks up both keys.
3. Switch the backend to sign new commands with the new key_id.
4. Once you've confirmed the worker is accepting commands signed with the new key, remove the old
   key_id from `public-keys.json` and redeploy again.

This two-phase rollout avoids a window where neither side agrees on which key is active.

## Revoking a worker token

`WORKER_TOKEN` only authenticates *which worker is talking* (heartbeat/telemetry/desired-state
fetch) — it does not itself authorize commands (see `docs/api-contract.md`). To revoke:

1. Remove/invalidate the token on the backend side so it no longer authenticates.
2. Generate a new token, put it in that worker's `.env`, and redeploy.
3. If the worker itself may be compromised (not just the token), also remove its `worker_id` from
   any profile allowlists on the backend and consider it untrusted until re-provisioned from a
   clean image.

## Incident-response checklist

1. **Identify scope**: one worker, or many? Check `/readyz` and recent telemetry for each.
2. **Contain**: `docker compose stop worker` on any worker you suspect is compromised or
   misbehaving. This is a local, immediate action — no API dependency.
3. **Preserve evidence**: `docker compose logs worker > incident-<date>.log` before restarting
   anything.
4. **Rotate secrets**: revoke and reissue that worker's `WORKER_TOKEN` (see above). If a signing
   key may be compromised, rotate it (see above) across all workers.
5. **Root-cause**: check `THREAT_MODEL.md` against what actually happened — was it a rejected
   command that should have been accepted (a false-positive bug) or an accepted command that
   shouldn't have been (a real gap)? File/fix accordingly.
6. **Recover**: redeploy from a known-good image/config, re-provision secrets, resume with an
   explicit `start` command once you've confirmed the cause is addressed.
