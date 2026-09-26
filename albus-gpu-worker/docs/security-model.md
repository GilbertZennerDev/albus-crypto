# Security Model Summary

This is a condensed index — see `SECURITY.md` for principles and `THREAT_MODEL.md` for the full
per-threat analysis. This page exists to answer "where in the code does X happen?" quickly.

| Property | Enforced in | How |
|---|---|---|
| Commands can't be forged | `app/command_verifier.py` | Ed25519 signature over canonical bytes (`docs/api-contract.md`) |
| Commands can't be replayed | `app/replay_store.py` | Persistent, independently-unique `command_id` and `nonce` tracking |
| Commands can't target another worker | `CommandVerifier.verify` | Explicit `worker_id` equality check |
| Expired/future-dated commands rejected | `CommandVerifier.verify` | `expires_at`/`issued_at` checked against configurable clock-skew bound |
| No arbitrary code execution | `app/miner_controller.py` | `profile_id` is a dict-lookup key into a local YAML allowlist; `command_template` never touches API input |
| No shell injection | `app/nvidia.py`, `app/miner_controller.py`, `scripts/miner-wrapper` | Fixed argv lists, `shell=False` everywhere, no string interpolation |
| Local safety overrides remote state | `app/main.py::enforce_local_safety` | Runs every tick, independent of API reachability |
| Bounded blast radius from a crashing miner | `app/miner_controller.py::RestartTracker` | Max restarts per rolling time window |
| Secrets never logged | `app/logging.py::redact` | Recursive redaction by key name on every structured log line |
| Secrets never in metrics | `app/metrics.py` | Only GPU index (integer) used as a label; no tokens/wallets/UUIDs/IPs |
| Local endpoints not network-exposed | `app/config.py::_forbid_wildcard_bind`, `app/main.py` | Bind host validated to reject `0.0.0.0`/`::`; nothing published in `docker-compose.yml` |
| Container hardened | `Dockerfile`, `docker-compose.yml` | Non-root UID, read-only root FS, dropped capabilities, `no-new-privileges`, no Docker socket |

See `docs/api-contract.md` for the exact wire format and canonicalization, and
`tests/test_command_verifier.py` / `tests/test_replay_store.py` for executable proof of the
rejection behaviors listed above.
