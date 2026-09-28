"""Pydantic v2 models for every payload crossing a trust boundary. Every API input is hostile."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

SCHEMA_VERSION = 1

# --- Enums -------------------------------------------------------------------


class WorkerState(StrEnum):
    OFFLINE = "OFFLINE"
    IDLE = "IDLE"
    STARTING = "STARTING"
    RUNNING = "RUNNING"
    PAUSED = "PAUSED"
    THERMAL_PROTECT = "THERMAL_PROTECT"
    POWER_PROTECT = "POWER_PROTECT"
    ERROR = "ERROR"
    STOPPING = "STOPPING"


class MinerState(StrEnum):
    STOPPED = "STOPPED"
    STARTING = "STARTING"
    RUNNING = "RUNNING"
    PAUSED = "PAUSED"
    STOPPING = "STOPPING"
    CRASHED = "CRASHED"


class Action(StrEnum):
    START = "start"
    STOP = "stop"
    PAUSE = "pause"
    RESUME = "resume"
    REFRESH_CONFIG = "refresh_config"


class ReasonCode(StrEnum):
    OK = "OK"
    INVALID_SIGNATURE = "INVALID_SIGNATURE"
    UNKNOWN_KEY_ID = "UNKNOWN_KEY_ID"
    COMMAND_EXPIRED = "COMMAND_EXPIRED"
    COMMAND_NOT_YET_VALID = "COMMAND_NOT_YET_VALID"
    CLOCK_SKEW_TOO_LARGE = "CLOCK_SKEW_TOO_LARGE"
    WRONG_WORKER_ID = "WRONG_WORKER_ID"
    DUPLICATE_COMMAND = "DUPLICATE_COMMAND"
    DUPLICATE_NONCE = "DUPLICATE_NONCE"
    MALFORMED_PAYLOAD = "MALFORMED_PAYLOAD"
    UNSUPPORTED_SCHEMA_VERSION = "UNSUPPORTED_SCHEMA_VERSION"
    UNKNOWN_ACTION = "UNKNOWN_ACTION"
    UNKNOWN_PROFILE = "UNKNOWN_PROFILE"
    PROFILE_DISABLED = "PROFILE_DISABLED"
    GPU_NOT_DETECTED = "GPU_NOT_DETECTED"
    GPU_TEMPERATURE_TOO_HIGH = "GPU_TEMPERATURE_TOO_HIGH"
    GPU_POWER_TOO_HIGH = "GPU_POWER_TOO_HIGH"
    THERMAL_PROTECTION_ACTIVE = "THERMAL_PROTECTION_ACTIVE"
    POWER_PROTECTION_ACTIVE = "POWER_PROTECTION_ACTIVE"
    MINER_ALREADY_RUNNING = "MINER_ALREADY_RUNNING"
    MINER_NOT_RUNNING = "MINER_NOT_RUNNING"
    INVALID_STATE_TRANSITION = "INVALID_STATE_TRANSITION"
    WORKER_NOT_REGISTERED = "WORKER_NOT_REGISTERED"


# --- Registration --------------------------------------------------------------


class WorkerCapabilities(BaseModel):
    model_config = ConfigDict(extra="forbid")

    gpu_count: int = Field(ge=0)
    gpu_uuids: list[str]
    nvidia_driver_version: str | None = None
    supported_profile_ids: list[str]


class RegisterRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    worker_id: str = Field(min_length=1, max_length=128)
    hostname: str = Field(min_length=1, max_length=255)
    software_version: str
    capabilities: WorkerCapabilities


class RegisterResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    worker_id: str
    accepted: bool
    server_time: datetime


# --- Heartbeat -----------------------------------------------------------------


class HeartbeatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    worker_id: str
    timestamp: datetime
    worker_state: WorkerState
    uptime_seconds: float = Field(ge=0)


class HeartbeatResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    server_time: datetime
    has_pending_command: bool = False


# --- Telemetry -------------------------------------------------------------------


class GpuReading(BaseModel):
    model_config = ConfigDict(extra="forbid")

    index: int
    uuid: str
    name: str
    driver_version: str
    temperature_c: float
    power_draw_watts: float
    power_limit_watts: float
    utilization_gpu_percent: float
    utilization_memory_percent: float
    memory_total_mib: float
    memory_used_mib: float
    fan_speed_percent: float | None
    clocks_graphics_mhz: float
    clocks_memory_mhz: float
    pstate: str


class MinerStats(BaseModel):
    model_config = ConfigDict(extra="forbid")

    hashrate: float | None = None
    accepted_shares: int = 0
    rejected_shares: int = 0


class TelemetryPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    worker_id: str
    timestamp: datetime
    worker_state: WorkerState
    miner_state: MinerState
    gpus: list[GpuReading]
    miner_stats: MinerStats
    uptime_seconds: float = Field(ge=0)
    last_command_id: str | None = None
    software_version: str
    profile_id: str | None = None
    safety_flags: list[str] = Field(default_factory=list)


class TelemetryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    accepted: bool
    server_time: datetime


# --- Desired state (signed command) ---------------------------------------------

#: Fields included in the canonical signed payload, in this exact order.
#: `signature` itself is never part of the signed bytes.
SIGNED_FIELDS: tuple[str, ...] = (
    "schema_version",
    "command_id",
    "worker_id",
    "action",
    "profile_id",
    "issued_at",
    "expires_at",
    "nonce",
    "key_id",
)


class DesiredStateCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1]
    command_id: str = Field(min_length=1, max_length=128)
    worker_id: str = Field(min_length=1, max_length=128)
    action: Action
    profile_id: str | None = Field(default=None, max_length=128)
    issued_at: datetime
    expires_at: datetime
    nonce: str = Field(min_length=8, max_length=256)
    key_id: str = Field(min_length=1, max_length=128)
    signature: str = Field(min_length=1)

    # Cross-field checks (e.g. action == start requires profile_id) happen in
    # command_verifier.py, where a precise ReasonCode can be reported back to
    # the API instead of a generic schema-validation failure.


class DesiredStateEnvelope(BaseModel):
    """What GET /desired-state returns: either nothing pending, or one command."""

    model_config = ConfigDict(extra="forbid")

    has_command: bool
    command: DesiredStateCommand | None = None


class CommandAck(BaseModel):
    model_config = ConfigDict(extra="forbid")

    command_id: str
    worker_id: str
    accepted: bool
    worker_state: WorkerState
    reason_code: ReasonCode
    message: str
    timestamp: datetime
