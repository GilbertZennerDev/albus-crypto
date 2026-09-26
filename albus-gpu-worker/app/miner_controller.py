"""Allowlisted miner lifecycle management. The API can select a profile_id; it can never supply
or modify a command, pool endpoint, wallet reference, or flag — those only ever come from the
operator's own profiles.yaml on local disk.
"""

from __future__ import annotations

import os
import signal
import subprocess
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.logging import get_logger
from app.miner_stats import MinerStatsSource, MockMinerStatsSource
from app.models import MinerState, MinerStats

logger = get_logger(__name__)


class MinerProfile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=128)
    enabled: bool
    miner_kind: str
    pool_ref: str
    account_ref: str
    max_gpus: int = Field(ge=1)
    allowed_gpu_uuids: list[str]
    command_template: list[str] = Field(min_length=1)


class ProfilesFile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    profiles: list[MinerProfile]


class ProfileLoadError(Exception):
    pass


def load_profiles(path: Path) -> dict[str, MinerProfile]:
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise ProfileLoadError(f"could not read profiles file: {exc}") from exc
    try:
        parsed = ProfilesFile.model_validate(raw)
    except ValidationError as exc:
        raise ProfileLoadError(f"invalid profiles file: {exc}") from exc
    return {p.id: p for p in parsed.profiles}


class RestartLimitExceeded(Exception):
    pass


@dataclass
class RestartTracker:
    max_restarts: int
    window_seconds: int
    _timestamps: deque[float] = field(default_factory=deque)

    def record_and_check(self) -> bool:
        """Records a restart now and returns True if still within the allowed budget."""
        now = time.monotonic()
        self._timestamps.append(now)
        cutoff = now - self.window_seconds
        while self._timestamps and self._timestamps[0] < cutoff:
            self._timestamps.popleft()
        return len(self._timestamps) <= self.max_restarts

    def reset(self) -> None:
        self._timestamps.clear()


class MinerController:
    """Owns exactly one miner lifecycle at a time. `use_mock=True` (the default, and the only
    mode this repository ships wired up) never spawns a real process — see README.md for how an
    operator enables a real miner deliberately."""

    def __init__(
        self,
        profiles: dict[str, MinerProfile],
        *,
        restart_max: int,
        restart_window_seconds: int,
        use_mock: bool = True,
        stats_source: MinerStatsSource | None = None,
    ) -> None:
        self._profiles = profiles
        self._use_mock = use_mock
        self._stats_source: MinerStatsSource = stats_source or MockMinerStatsSource()
        self._restart_tracker = RestartTracker(restart_max, restart_window_seconds)
        self.state = MinerState.STOPPED
        self.active_profile_id: str | None = None
        self._process: subprocess.Popen[bytes] | None = None
        self.last_crash_reason: str | None = None

    def get_profile(self, profile_id: str) -> MinerProfile | None:
        profile = self._profiles.get(profile_id)
        if profile is None or not profile.enabled:
            return None
        return profile

    def is_running(self) -> bool:
        return self.state in (MinerState.RUNNING, MinerState.STARTING, MinerState.PAUSED)

    def start(self, profile_id: str) -> None:
        if self.is_running():
            raise RuntimeError("miner already running")
        profile = self.get_profile(profile_id)
        if profile is None:
            raise KeyError(profile_id)

        self.state = MinerState.STARTING
        self.active_profile_id = profile_id
        if self._use_mock:
            assert isinstance(self._stats_source, MockMinerStatsSource)
            self._stats_source.start()
        else:
            # command_template comes only from this operator-owned profile — never from
            # anything the API sent — and is passed as an argv list, never through a shell.
            self._process = subprocess.Popen(  # noqa: S603 — fixed argv from local allowlist only
                list(profile.command_template),
                shell=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        self.state = MinerState.RUNNING
        logger.info("miner started", extra={"context": {"profile_id": profile_id}})

    def stop(self) -> None:
        if self.state == MinerState.STOPPED:
            return
        self.state = MinerState.STOPPING
        if self._use_mock:
            assert isinstance(self._stats_source, MockMinerStatsSource)
            self._stats_source.stop()
        elif self._process is not None:
            self._process.terminate()
            try:
                self._process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait(timeout=5)
            self._process = None
        self.state = MinerState.STOPPED
        self.active_profile_id = None
        self._restart_tracker.reset()
        logger.info("miner stopped", extra={"context": {}})

    def pause(self) -> None:
        if self.state != MinerState.RUNNING:
            raise RuntimeError("miner is not running")
        if not self._use_mock and self._process is not None:
            # SIGSTOP/SIGCONT are POSIX-only (this worker is a Linux container image, see
            # Dockerfile) — not present in typeshed's Windows signal stubs, hence the ignores.
            os.kill(self._process.pid, signal.SIGSTOP)  # type: ignore[attr-defined]
        self.state = MinerState.PAUSED
        logger.info("miner paused", extra={"context": {}})

    def resume(self) -> None:
        if self.state != MinerState.PAUSED:
            raise RuntimeError("miner is not paused")
        if not self._use_mock and self._process is not None:
            os.kill(self._process.pid, signal.SIGCONT)  # type: ignore[attr-defined]
        self.state = MinerState.RUNNING
        logger.info("miner resumed", extra={"context": {}})

    def poll_health(self) -> None:
        """Detects an unexpectedly exited real miner process and applies the bounded restart
        policy. No-op in mock mode (the mock never crashes on its own)."""
        active_states = (MinerState.RUNNING, MinerState.PAUSED)
        if self._use_mock or self._process is None or self.state not in active_states:
            return
        exit_code = self._process.poll()
        if exit_code is None:
            return  # still running

        self.last_crash_reason = f"miner process exited unexpectedly with code {exit_code}"
        self._process = None
        logger.error("miner crashed", extra={"context": {"exit_code": exit_code}})

        if self._restart_tracker.record_and_check() and self.active_profile_id is not None:
            profile_id = self.active_profile_id
            self.state = MinerState.STOPPED
            try:
                self.start(profile_id)
            except (KeyError, RuntimeError) as exc:
                self.state = MinerState.CRASHED
                logger.error("miner restart failed", extra={"context": {"error": str(exc)}})
        else:
            self.state = MinerState.CRASHED
            logger.error(
                "miner exceeded restart budget — requires a new valid command or operator action",
                extra={"context": {}},
            )

    def read_stats(self) -> MinerStats:
        return self._stats_source.read()
