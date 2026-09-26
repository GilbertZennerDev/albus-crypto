"""Assembles a TelemetryPayload from the current GPU readings, miner state, and safety flags."""

from __future__ import annotations

from datetime import UTC, datetime

from app.models import GpuReading, MinerState, MinerStats, TelemetryPayload, WorkerState


def build_telemetry(
    *,
    worker_id: str,
    worker_state: WorkerState,
    miner_state: MinerState,
    gpus: list[GpuReading],
    miner_stats: MinerStats,
    uptime_seconds: float,
    last_command_id: str | None,
    software_version: str,
    profile_id: str | None,
    safety_flags: list[str],
) -> TelemetryPayload:
    return TelemetryPayload(
        worker_id=worker_id,
        timestamp=datetime.now(UTC),
        worker_state=worker_state,
        miner_state=miner_state,
        gpus=gpus,
        miner_stats=miner_stats,
        uptime_seconds=uptime_seconds,
        last_command_id=last_command_id,
        software_version=software_version,
        profile_id=profile_id,
        safety_flags=safety_flags,
    )
