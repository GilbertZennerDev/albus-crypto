# Security

## Reporting

This is operator-run infrastructure for a single project. If you find a vulnerability, report it
privately to the operator rather than opening a public issue, and allow time for a fix before any
public disclosure.

## Design principles this codebase follows

- **Every external input is hostile.** All API responses (registration ack, heartbeat response,
  desired-state commands) are validated with Pydantic models before use; `extra="forbid"` on every
  model rejects unexpected fields rather than silently ignoring them.
- **Allowlist, never denylist.** Miner profiles, actions, and pool/account references all come
  from a local, operator-controlled file (`profiles.yaml`) — the API can reference a profile ID,
  never define one.
- **No shell.** Every subprocess invocation (`nvidia-smi`, the miner wrapper) uses a fixed argv
  list with `shell=False`. Nothing external is ever string-interpolated into a command.
- **Fail closed.** Any signature, timestamp, schema, or replay-store failure rejects the command.
  An unreadable replay-store is treated as "reject", never "allow" — see `app/replay_store.py`.
- **Local protection overrides remote state.** Thermal/power limits are enforced independent of
  API reachability or correctness — see `app/state_machine.py::force_protection` and
  `app/main.py::enforce_local_safety`.
- **No secrets in source or images.** `WORKER_TOKEN`, the Ed25519 public keys, and any real
  `profiles.yaml` are supplied at deploy time via `.env` and read-only mounts, never committed.
- **Least privilege containers.** Non-root UID, `read_only: true`, dropped capabilities,
  `no-new-privileges`, no Docker socket, no privileged mode — see `docker-compose.yml`.

See `THREAT_MODEL.md` for the full threat analysis and `docs/api-contract.md` for the exact
signature/canonicalization scheme.
