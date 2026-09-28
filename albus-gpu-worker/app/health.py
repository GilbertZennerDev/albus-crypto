"""Local-only health/readiness/metrics endpoints. Bound to 127.0.0.1 exclusively — see main.py.
Returns no secrets, tokens, or raw payloads.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from fastapi import FastAPI, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from app.metrics import registry
from app.models import WorkerState
from app.replay_store import ReplayStore


class ReadinessSource(Protocol):
    def config_loaded(self) -> bool: ...
    def nvidia_supported_or_dev_mode(self) -> bool: ...
    def state_machine_initialized(self) -> bool: ...
    def current_state(self) -> WorkerState: ...


@dataclass
class HealthContext:
    replay_store: ReplayStore
    readiness: ReadinessSource


def create_health_app(ctx: HealthContext) -> FastAPI:
    app = FastAPI(title="albus-gpu-worker local control endpoints", docs_url=None, redoc_url=None)

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "alive"}

    @app.get("/readyz")
    def readyz(response: Response) -> dict[str, object]:
        checks = {
            "config_loaded": ctx.readiness.config_loaded(),
            "replay_store_accessible": ctx.replay_store.is_ready(),
            "nvidia_ready": ctx.readiness.nvidia_supported_or_dev_mode(),
            "state_machine_initialized": ctx.readiness.state_machine_initialized(),
        }
        ready = all(checks.values())
        response.status_code = 200 if ready else 503
        return {"ready": ready, "checks": checks, "worker_state": ctx.readiness.current_state().value}

    @app.get("/metrics")
    def metrics() -> Response:
        return Response(content=generate_latest(registry), media_type=CONTENT_TYPE_LATEST)

    return app
