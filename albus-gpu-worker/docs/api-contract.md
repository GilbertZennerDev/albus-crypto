# API Contract — `/api/v1`

Base URL is configurable via `ALBUS_API_BASE_URL` (default
`https://albus.workflowsolved.com/api/v1`). All requests over TLS. All requests carry
`Authorization: Bearer <worker_token>`.

This contract is what the **worker** expects from the central API — the API side of this contract
is not implemented in this repository; implement it against these exact schemas.

## Authentication model

Each worker has a unique, long, random `WORKER_TOKEN` provisioned out-of-band by the operator
(e.g. generated when the worker is registered in the Albus backend's admin panel) and supplied to
the worker via `.env`. The token authenticates *which worker* is talking, for heartbeat/telemetry/
desired-state-fetch/ack. It does **not** authorize commands — that's the Ed25519 signature's job,
verified independently of the bearer token, so a leaked token alone cannot forge a command.

Alternative: a per-worker mTLS client certificate can be used in place of (or in addition to) the
bearer token at the transport layer; the application-level contract below is unchanged either way.

## Endpoints

### `POST /workers/register`

```json
{
  "worker_id": "gpu-node-lux-01",
  "hostname": "worker-hostname",
  "software_version": "0.1.0",
  "capabilities": {
    "gpu_count": 1,
    "gpu_uuids": ["GPU-EXAMPLE-UUID"],
    "nvidia_driver_version": "550.54.15",
    "supported_profile_ids": ["demo-profile-1"]
  }
}
```

Response `200`/`201`:

```json
{ "worker_id": "gpu-node-lux-01", "accepted": true, "server_time": "2026-09-01T12:00:00Z" }
```

### `POST /workers/heartbeat`

```json
{
  "worker_id": "gpu-node-lux-01",
  "timestamp": "2026-09-01T12:00:05Z",
  "worker_state": "RUNNING",
  "uptime_seconds": 3600.5
}
```

Response `200`:

```json
{ "server_time": "2026-09-01T12:00:05Z", "has_pending_command": false }
```

### `POST /workers/telemetry`

```json
{
  "worker_id": "gpu-node-lux-01",
  "timestamp": "2026-09-01T12:00:30Z",
  "worker_state": "RUNNING",
  "miner_state": "RUNNING",
  "gpus": [
    {
      "index": 0,
      "uuid": "GPU-EXAMPLE-UUID",
      "name": "NVIDIA GeForce RTX 4070",
      "driver_version": "550.54.15",
      "temperature_c": 62.0,
      "power_draw_watts": 180.5,
      "power_limit_watts": 285.0,
      "utilization_gpu_percent": 97.0,
      "utilization_memory_percent": 40.0,
      "memory_total_mib": 12288.0,
      "memory_used_mib": 4096.0,
      "fan_speed_percent": 55.0,
      "clocks_graphics_mhz": 2520.0,
      "clocks_memory_mhz": 10501.0,
      "pstate": "P2"
    }
  ],
  "miner_stats": { "hashrate": 52000000.0, "accepted_shares": 4210, "rejected_shares": 12 },
  "uptime_seconds": 3600.5,
  "last_command_id": "b1f8...",
  "software_version": "0.1.0",
  "profile_id": "demo-profile-1",
  "safety_flags": []
}
```

Response `200`/`201`/`202`: `{ "accepted": true, "server_time": "..." }`

### `GET /workers/{worker_id}/desired-state`

Either `204 No Content` (nothing pending) or `200` with:

```json
{
  "has_command": true,
  "command": {
    "schema_version": 1,
    "command_id": "b1f8c2d4-9e0a-4f3b-8c1d-2a6e7f9b0c3d",
    "worker_id": "gpu-node-lux-01",
    "action": "start",
    "profile_id": "demo-profile-1",
    "issued_at": "2026-09-01T12:00:00Z",
    "expires_at": "2026-09-01T12:05:00Z",
    "nonce": "8f3a1c7e9b2d4f6a",
    "key_id": "main-2026-01",
    "signature": "base64-ed25519-signature"
  }
}
```

### `POST /workers/command-ack`

```json
{
  "command_id": "b1f8c2d4-9e0a-4f3b-8c1d-2a6e7f9b0c3d",
  "worker_id": "gpu-node-lux-01",
  "accepted": false,
  "worker_state": "THERMAL_PROTECT",
  "reason_code": "GPU_TEMPERATURE_TOO_HIGH",
  "message": "GPU temperature is 81C, above the 80C stop limit.",
  "timestamp": "2026-09-01T12:00:05Z"
}
```

## Signature canonicalization

The signed fields, **in this exact order**, are:

```
schema_version, command_id, worker_id, action, profile_id, issued_at, expires_at, nonce, key_id
```

`signature` is never part of the signed bytes. Canonical bytes are produced as:

```python
import json
ordered = {field: raw[field] for field in SIGNED_FIELDS}  # exact order above
canonical_bytes = json.dumps(ordered, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
```

Where `raw` is the exact JSON object about to be transmitted — string values (including
`issued_at`/`expires_at`) are signed exactly as-written, not re-formatted after parsing. The
signer computes `signature = base64(Ed25519.sign(private_key, canonical_bytes))` and includes it
as the `signature` field. The worker recomputes the same canonical bytes from the raw JSON it
received and verifies with the public key matching `key_id`.

`profile_id` is included in the signed set even when `null` (e.g. for `stop`), so an attacker
cannot swap in a different profile_id without invalidating the signature.

See `app/command_verifier.py::canonicalize` for the reference implementation and
`tests/test_command_verifier.py` for worked, signature-verified examples.

## Reason / error codes

| Code | Meaning |
|---|---|
| `OK` | Command accepted and applied |
| `INVALID_SIGNATURE` | Signature did not verify against the named key |
| `UNKNOWN_KEY_ID` | `key_id` not in this worker's local public-key set |
| `COMMAND_EXPIRED` | `expires_at` is in the past |
| `COMMAND_NOT_YET_VALID` | `issued_at` is implausibly in the future given clock-skew tolerance |
| `CLOCK_SKEW_TOO_LARGE` | `issued_at` exceeds the configured max clock skew from local time |
| `WRONG_WORKER_ID` | Command's `worker_id` doesn't match this worker |
| `DUPLICATE_COMMAND` | `command_id` already processed |
| `DUPLICATE_NONCE` | `nonce` already processed (even under a different `command_id`) |
| `MALFORMED_PAYLOAD` | Schema validation failed, or a required field was missing/invalid |
| `UNSUPPORTED_SCHEMA_VERSION` | `schema_version` not supported by this worker build |
| `UNKNOWN_ACTION` | Not one of `start`/`stop`/`pause`/`resume`/`refresh_config` |
| `UNKNOWN_PROFILE` | `profile_id` not present (or disabled) in local `profiles.yaml` |
| `GPU_NOT_DETECTED` | `nvidia-smi` unavailable/failed |
| `GPU_TEMPERATURE_TOO_HIGH` / `GPU_POWER_TOO_HIGH` | A `start` was rejected on entry conditions |
| `THERMAL_PROTECTION_ACTIVE` / `POWER_PROTECTION_ACTIVE` | A local protection flag overrode the request |
| `MINER_ALREADY_RUNNING` / `MINER_NOT_RUNNING` | Lifecycle precondition not met |
| `INVALID_STATE_TRANSITION` | Requested action doesn't apply from the current state |

## Idempotency / replay strategy

`command_id` + `nonce` are both tracked independently in a local, persistent store
(`app/replay_store.py`) the moment a command passes verification — see `THREAT_MODEL.md`'s
"Replay attacks" section. A `command-ack` itself is not idempotency-protected on the worker side;
the API should tolerate receiving the same ack more than once (e.g. after a retried POST).
