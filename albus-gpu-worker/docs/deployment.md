# Deployment

## Prerequisites

- Linux host with an NVIDIA GPU and a working driver (`nvidia-smi` runs successfully on the host).
- Docker Engine and Docker Compose v2.
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
  installed and configured (`nvidia-ctk runtime configure --runtime=docker` followed by a Docker
  restart, per NVIDIA's docs).

Verify GPU access works before deploying this worker:

```bash
docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi
```

## Steps

1. Clone this repository onto the GPU host.
2. `cp .env.example .env` and fill in `WORKER_ID` (unique per worker) and `WORKER_TOKEN` (a long
   random value provisioned by the operator/backend for this specific worker — never reused
   across workers).
3. `cp profiles.example.yaml profiles.yaml` and edit to match your real GPU UUID(s) — get them
   via `nvidia-smi --query-gpu=uuid --format=csv,noheader` on the host. Leave `enabled: false` on
   any profile you haven't validated the wrapper/miner for yet.
4. `cp config/public-keys.example.json config/public-keys.json` and replace the example key with
   the real Ed25519 public key(s) the backend signs commands with. Never put a private key here.
5. `docker compose up -d --build`
6. Check health: `docker compose exec worker python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:9477/readyz').read())"`
   (the endpoint is bound to the container's own loopback, so it isn't reachable from the host
   network directly — this is by design, see `SECURITY.md`).
7. Check logs: `docker compose logs -f worker`

## Upgrading

```bash
git pull
docker compose up -d --build
```

The replay-protection database and any worker-local state live in the `worker_data` named volume
and survive a rebuild/redeploy.

## Rolling back

```bash
git checkout <previous-tag-or-commit>
docker compose up -d --build
```

## GPU host notes

- This worker never modifies driver settings, power limits, clocks, or fan curves. If you want a
  hardware power cap as an extra safety margin beyond this worker's own software threshold, set
  it yourself on the host: `sudo nvidia-smi -pl <watts>` (persists until reboot; add to a systemd
  unit or `/etc/rc.local` if you want it to survive one).
- Running multiple workers on one host (multi-GPU) is supported by scoping each worker's
  `profiles.yaml` `allowed_gpu_uuids` to a disjoint set of GPU UUIDs and giving each its own
  `WORKER_ID`/`WORKER_TOKEN`/Compose project — this repository's default Compose file assumes one
  worker per host reserving all visible GPUs; adjust `deploy.resources.reservations.devices` if
  you need to pin a specific GPU index instead.
