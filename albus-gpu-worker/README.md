# albus-gpu-worker

A local control-plane worker for NVIDIA GPU mining, built for the Albus project
(https://albus.workflowsolved.com).

**This runs only on hardware the operator physically controls.** It is not browser mining, it is
not cryptojacking, and it never touches a website visitor's device. Visitors interact only with a
web dashboard showing logical worker identities and authorized status/earning data supplied by the
central Albus API — they never get access to Docker, a shell, a GPU device, or a miner's command
line. See `THREAT_MODEL.md` for the full breakdown.

## What this is (and isn't)

- **Is**: a Dockerized service an operator runs on their own NVIDIA GPU machine, which registers
  itself with the Albus API, reports telemetry, and executes a small, fixed set of signed,
  verified commands (`start` / `stop` / `pause` / `resume` / `refresh_config`) against a locally
  allowlisted miner profile.
- **Isn't**: a way for the website or its users to run arbitrary code, choose arbitrary miners,
  supply arbitrary pool URLs or wallet addresses, or reach the host filesystem, Docker socket, or
  GPU device files directly.

## Development mode (mock miner)

By default, and in every test in this repository, `MinerController` is wired up with
`use_mock=True`. No real miner binary is bundled or downloaded — starting a profile just runs an
in-process simulator (`app/miner_stats.py::MockMinerStatsSource`) that produces plausible
hashrate/share numbers so the full lifecycle (start/stop/pause/resume, telemetry, restart-on-crash
handling) can be exercised end to end without real mining hardware, a real pool, or a real wallet.

```bash
python -m venv .venv
source .venv/bin/activate  # or .venv\Scripts\activate on Windows
pip install -e ".[dev]"
cp .env.example .env               # fill in WORKER_ID / WORKER_TOKEN
cp profiles.example.yaml profiles.yaml
cp config/public-keys.example.json config/public-keys.json
DEV_MODE=true python -m app.main
```

With `DEV_MODE=true`, a missing `nvidia-smi` (e.g. developing on a machine with no NVIDIA GPU) is
tolerated for `/readyz` purposes — telemetry will simply report zero GPUs rather than blocking
startup. In production (`DEV_MODE=false`, the default), a missing/failing `nvidia-smi` moves the
worker to `ERROR` — see `docs/operations.md`.

## Integrating a real miner

This repository intentionally ships **no real miner binary**. To integrate one:

1. Install your chosen miner binary on the host (or bake it into a separate, locked-down sidecar
   image — see the commented-out `miner` service in `docker-compose.yml`).
2. Edit `scripts/miner-wrapper` to `exec` that binary with a **fixed** argument list built only
   from the matching profile's own fields in `profiles.yaml` (pool host/port, account reference,
   etc.) — never from anything passed into the wrapper beyond `--profile <id>`, and never from
   anything the central API sends.
3. Add a real profile entry to `profiles.yaml` with `enabled: true` and your `command_template`.
4. In `app/main.py`, change `MinerController(..., use_mock=True, ...)` to `use_mock=False` and
   wire a real `MinerStatsSource` (see the `Protocol` in `app/miner_stats.py`) against whatever
   local, loopback-only stats interface your miner exposes.
5. Apply the network allowlist limitation documented in `docker-compose.yml`'s commented sidecar
   section — enforce which pool hostnames/ports the miner can reach at the host/network layer.

## NVIDIA host prerequisites

- An NVIDIA GPU with a working driver (`nvidia-smi` works on the host).
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
  installed and configured for Docker, so `docker-compose.yml`'s `deploy.resources.reservations.devices`
  GPU reservation actually grants the container GPU access.

## Docker deployment

```bash
cp .env.example .env
cp profiles.example.yaml profiles.yaml
cp config/public-keys.example.json config/public-keys.json
# Edit all three with real values before proceeding.
docker compose up -d --build
```

See `docs/deployment.md` for details, and `docs/operations.md` for day-to-day operation.

## Configuration reference

Every setting is an environment variable — see `.env.example` for the full list with defaults and
comments. Nothing has a hardcoded secret; `WORKER_TOKEN` and the signing keys are always supplied
at deploy time.

## Tests and lint

```bash
pytest
ruff check .
mypy app
docker compose up --build   # optional end-to-end smoke test
```

## Operational safety

- Thermal and power protection are enforced **locally**, every control-loop tick, regardless of
  whether the central API is reachable, correct, or compromised — see `app/main.py`'s
  `enforce_local_safety`.
- The worker never changes GPU overclock, voltage, fan curves, driver settings, or host power
  limits. If you want a hardware power cap, set it yourself via `nvidia-smi -pl <watts>` (a
  privileged, operator-run, one-time host command) — this worker only reads telemetry and reacts
  to it.
- See `docs/operations.md` for thermal-protection behavior, log inspection, key rotation, and an
  incident-response checklist.
