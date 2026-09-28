"""Typed configuration loaded from environment variables / .env. No secrets have defaults."""

from __future__ import annotations

from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Identity
    worker_id: str
    worker_token: str
    software_version: str = "0.1.0"

    # Central API
    albus_api_base_url: str = "https://albus.workflowsolved.com/api/v1"
    api_timeout_seconds: float = 10.0
    api_retry_attempts: int = 3

    # Signature verification
    public_keys_path: Path = Path("/app/config/public-keys.json")
    max_clock_skew_seconds: int = 30
    command_max_lifetime_seconds: int = 300

    # Profiles
    profiles_path: Path = Path("/app/config/profiles.yaml")

    # Replay protection
    replay_store_path: Path = Path("/data/replay-store.sqlite3")
    replay_retention_seconds: int = 3600

    # Intervals
    telemetry_interval_seconds: int = 30
    desired_state_poll_interval_seconds: int = 15
    heartbeat_failure_grace_seconds: int = 300

    # Thermal / power policy
    gpu_warning_temp_c: float = 75.0
    gpu_stop_temp_c: float = 80.0
    gpu_resume_temp_c: float = 65.0
    gpu_max_power_watts: float = 300.0

    # Restart policy
    miner_max_restarts: int = 3
    miner_restart_window_seconds: int = 600

    # Local control endpoints
    local_bind_host: str = "127.0.0.1"
    local_bind_port: int = 9477

    # Development
    dev_mode: bool = False

    @field_validator("albus_api_base_url")
    @classmethod
    def _require_https_unless_dev(cls, v: str) -> str:
        if not v.startswith("https://") and "localhost" not in v and "127.0.0.1" not in v:
            raise ValueError("albus_api_base_url must use https:// (except localhost for dev)")
        return v.rstrip("/")

    @field_validator("local_bind_host")
    @classmethod
    def _forbid_wildcard_bind(cls, v: str) -> str:
        if v in ("0.0.0.0", "::"):  # noqa: S104 — this validator exists specifically to forbid it
            raise ValueError("local_bind_host must never be a wildcard address; bind to 127.0.0.1 only")
        return v


def load_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]  # required fields are supplied via env/.env at runtime
