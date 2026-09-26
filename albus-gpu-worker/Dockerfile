# Control-plane worker image. Slim Python — no CUDA libraries are needed here since GPU access
# is only ever via the host's `nvidia-smi` binary (mounted/available through the NVIDIA Container
# Toolkit runtime), never via direct CUDA calls from this process.
FROM python:3.12-slim AS base

RUN groupadd --gid 10001 albus && \
    useradd --uid 10001 --gid albus --no-create-home --shell /usr/sbin/nologin albus

WORKDIR /app

COPY pyproject.toml /app/pyproject.toml
RUN pip install --no-cache-dir .

COPY app /app/app
COPY scripts/miner-wrapper /usr/local/bin/miner-wrapper
RUN chmod 0555 /usr/local/bin/miner-wrapper

# Config and replay-state directories exist at build time so bind mounts / volumes have a
# predictable owner; actual content is supplied at runtime (read-only config, writable /data).
RUN mkdir -p /app/config /data && chown -R albus:albus /app /data

USER albus:albus

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:9477/healthz', timeout=3).status == 200 else 1)"

ENTRYPOINT ["python", "-m", "app.main"]
