"""Entry point: wires config, security, telemetry, and the miner lifecycle into one control loop.

Local protection (thermal/power) is checked every tick and always overrides whatever the most
recent remote desired-state command asked for — this holds even if the central API is completely
unreachable or actively compromised.
"""

from __future__ import annotations

import asyncio
import json
import socket
import threading
import time
from datetime import UTC, datetime

import uvicorn

from app.api_client import AlbusApiClient, ApiError
from app.command_verifier import CommandVerifier
from app.config import Settings, load_settings
from app.health import HealthContext, create_health_app
from app.logging import configure_logging, get_logger, redact
from app.metrics import (
    api_heartbeat_failure_total,
    api_heartbeat_success_total,
    command_accepted_total,
    command_rejected_total,
    gpu_memory_used_mib,
    gpu_power_watts,
    gpu_temperature_celsius,
    gpu_utilization_percent,
    last_successful_api_contact_timestamp,
    miner_restarts_total,
    observe_miner_stats,
    set_worker_state,
)
from app.miner_controller import MinerController, load_profiles
from app.models import (
    Action,
    CommandAck,
    HeartbeatRequest,
    ReasonCode,
    RegisterRequest,
    WorkerCapabilities,
    WorkerState,
)
from app.nvidia import NvidiaInspector, NvidiaSmiError
from app.replay_store import ReplayStore
from app.state_machine import WorkerFSM
from app.telemetry import build_telemetry

logger = get_logger(__name__)

_ALL_WORKER_STATES = [s.value for s in WorkerState]
_THERMAL_FLAG = "THERMAL_PROTECTION"
_POWER_FLAG = "POWER_PROTECTION"
_API_UNREACHABLE_FLAG = "API_UNREACHABLE"


class Worker:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.fsm = WorkerFSM()
        self.started_at = time.monotonic()
        self.last_command_id: str | None = None
        self._config_loaded = False
        self._nvidia_ok_or_dev = False
        self._last_api_success_monotonic: float | None = None

        public_keys = json.loads(settings.public_keys_path.read_text(encoding="utf-8"))
        public_keys = {k: v for k, v in public_keys.items() if not k.startswith("_")}
        profiles = load_profiles(settings.profiles_path)
        self._config_loaded = True

        self.replay_store = ReplayStore(settings.replay_store_path, settings.replay_retention_seconds)
        self.verifier = CommandVerifier(
            own_worker_id=settings.worker_id,
            public_keys=public_keys,
            replay_store=self.replay_store,
            max_clock_skew_seconds=settings.max_clock_skew_seconds,
            command_max_lifetime_seconds=settings.command_max_lifetime_seconds,
        )
        self.miner = MinerController(
            profiles,
            restart_max=settings.miner_max_restarts,
            restart_window_seconds=settings.miner_restart_window_seconds,
            use_mock=True,  # only mode wired up by default — see README "Integrating a real miner"
        )
        self.nvidia = NvidiaInspector()
        self.api = AlbusApiClient(
            base_url=settings.albus_api_base_url,
            worker_token=settings.worker_token,
            timeout_seconds=settings.api_timeout_seconds,
            retry_attempts=settings.api_retry_attempts,
        )

    # --- readiness (used by /readyz) ---
    def config_loaded(self) -> bool:
        return self._config_loaded

    def nvidia_supported_or_dev_mode(self) -> bool:
        return self._nvidia_ok_or_dev

    def state_machine_initialized(self) -> bool:
        return self.fsm.state is not None

    def current_state(self) -> WorkerState:
        return self.fsm.state

    # --- lifecycle ---
    def register(self) -> None:
        try:
            gpus = self.nvidia.read()
            gpu_uuids = [g.uuid for g in gpus]
            driver_version = gpus[0].driver_version if gpus else None
            self._nvidia_ok_or_dev = True
        except NvidiaSmiError as exc:
            logger.warning("nvidia-smi unavailable at registration", extra={"context": {"error": str(exc)}})
            gpu_uuids = []
            driver_version = None
            self._nvidia_ok_or_dev = self.settings.dev_mode

        req = RegisterRequest(
            worker_id=self.settings.worker_id,
            hostname=socket.gethostname(),
            software_version=self.settings.software_version,
            capabilities=WorkerCapabilities(
                gpu_count=len(gpu_uuids),
                gpu_uuids=gpu_uuids,
                nvidia_driver_version=driver_version,
                supported_profile_ids=list(self.miner._profiles.keys()),  # noqa: SLF001
            ),
        )
        try:
            self.api.register(req)
            self._mark_api_success()
            self.fsm.transition(WorkerState.IDLE, reason="registered")
        except ApiError as exc:
            logger.error("registration failed", extra={"context": {"error": str(exc)}})

    def _mark_api_success(self) -> None:
        self._last_api_success_monotonic = time.monotonic()
        last_successful_api_contact_timestamp.set(time.time())
        self.fsm.clear_flag(_API_UNREACHABLE_FLAG)

    # --- safety: always evaluated, always wins over remote desired state ---
    def enforce_local_safety(self) -> None:
        try:
            gpus = self.nvidia.read()
        except NvidiaSmiError as exc:
            if not self.settings.dev_mode:
                logger.error("nvidia-smi failed during safety check", extra={"context": {"error": str(exc)}})
                self.fsm.force_protection(WorkerState.ERROR, flag="NVIDIA_UNAVAILABLE", reason=str(exc))
            return

        for g in gpus:
            gpu_temperature_celsius.labels(gpu_index=str(g.index)).set(g.temperature_c)
            gpu_power_watts.labels(gpu_index=str(g.index)).set(g.power_draw_watts)
            gpu_utilization_percent.labels(gpu_index=str(g.index)).set(g.utilization_gpu_percent)
            gpu_memory_used_mib.labels(gpu_index=str(g.index)).set(g.memory_used_mib)

        max_temp = max((g.temperature_c for g in gpus), default=0.0)
        max_power = max((g.power_draw_watts for g in gpus), default=0.0)

        if max_temp >= self.settings.gpu_stop_temp_c:
            if self.miner.is_running():
                self.miner.stop()
            self.fsm.force_protection(
                WorkerState.THERMAL_PROTECT,
                flag=_THERMAL_FLAG,
                reason=f"GPU temperature {max_temp}C >= stop threshold {self.settings.gpu_stop_temp_c}C",
            )
            return
        if max_temp <= self.settings.gpu_resume_temp_c:
            self.fsm.clear_flag(_THERMAL_FLAG)

        if max_power >= self.settings.gpu_max_power_watts:
            if self.miner.is_running():
                self.miner.stop()
            self.fsm.force_protection(
                WorkerState.POWER_PROTECT,
                flag=_POWER_FLAG,
                reason=f"GPU power {max_power}W >= max {self.settings.gpu_max_power_watts}W",
            )
            return
        if max_power < self.settings.gpu_max_power_watts * 0.9:
            self.fsm.clear_flag(_POWER_FLAG)

        # Recover out of a protection state once the trigger has cleared and nothing else is
        # holding it — a fresh explicit command is still required to actually resume mining.
        if (
            self.fsm.state in (WorkerState.THERMAL_PROTECT, WorkerState.POWER_PROTECT)
            and _THERMAL_FLAG not in self.fsm.safety_flags
            and _POWER_FLAG not in self.fsm.safety_flags
        ):
            self.fsm.transition(WorkerState.IDLE, reason="protection cleared, awaiting new command")

    def enforce_api_reachability(self) -> None:
        if self._last_api_success_monotonic is None:
            return
        unreachable_for = time.monotonic() - self._last_api_success_monotonic
        if unreachable_for >= self.settings.heartbeat_failure_grace_seconds:
            if self.miner.is_running():
                self.miner.stop()
            self.fsm.safety_flags.add(_API_UNREACHABLE_FLAG)
            if self.fsm.can_transition(WorkerState.PAUSED) or self.fsm.state == WorkerState.PAUSED:
                if self.fsm.state != WorkerState.PAUSED:
                    self.fsm.transition(WorkerState.PAUSED, reason="API unreachable past grace period")
            else:
                self.fsm.force_protection(
                    WorkerState.ERROR, flag=_API_UNREACHABLE_FLAG, reason="API unreachable"
                )

    # --- command handling ---
    def apply_command(self, raw: dict[str, object]) -> CommandAck:
        result = self.verifier.verify(raw)
        now = datetime.now(UTC)
        worker_id = str(raw.get("worker_id", self.settings.worker_id))
        command_id = str(raw.get("command_id", "unknown"))

        if not result.ok or result.command is None:
            command_rejected_total.labels(reason_code=result.reason.value).inc()
            return CommandAck(
                command_id=command_id,
                worker_id=worker_id,
                accepted=False,
                worker_state=self.fsm.state,
                reason_code=result.reason,
                message=f"command rejected: {result.reason.value}",
                timestamp=now,
            )

        command = result.command
        reason = self._try_apply(command.action, command.profile_id)
        if reason != ReasonCode.OK:
            command_rejected_total.labels(reason_code=reason.value).inc()
            return CommandAck(
                command_id=command.command_id,
                worker_id=command.worker_id,
                accepted=False,
                worker_state=self.fsm.state,
                reason_code=reason,
                message=f"command rejected: {reason.value}",
                timestamp=now,
            )

        command_accepted_total.inc()
        self.last_command_id = command.command_id
        return CommandAck(
            command_id=command.command_id,
            worker_id=command.worker_id,
            accepted=True,
            worker_state=self.fsm.state,
            reason_code=ReasonCode.OK,
            message="command applied",
            timestamp=now,
        )

    def _try_apply(self, action: Action, profile_id: str | None) -> ReasonCode:
        # Local protection always wins, regardless of what the API is asking for.
        if _THERMAL_FLAG in self.fsm.safety_flags and action in (Action.START, Action.RESUME):
            return ReasonCode.THERMAL_PROTECTION_ACTIVE
        if _POWER_FLAG in self.fsm.safety_flags and action in (Action.START, Action.RESUME):
            return ReasonCode.POWER_PROTECTION_ACTIVE

        if action == Action.START:
            return self._try_start(profile_id)
        if action == Action.STOP:
            if not self.miner.is_running():
                return ReasonCode.MINER_NOT_RUNNING
            self.miner.stop()
            self.fsm.transition(WorkerState.IDLE, reason="stop command")
            return ReasonCode.OK
        if action == Action.PAUSE:
            if self.miner.state.value != "RUNNING":
                return ReasonCode.MINER_NOT_RUNNING
            self.miner.pause()
            self.fsm.transition(WorkerState.PAUSED, reason="pause command")
            return ReasonCode.OK
        if action == Action.RESUME:
            if self.miner.state.value != "PAUSED":
                return ReasonCode.INVALID_STATE_TRANSITION
            self.miner.resume()
            self.fsm.transition(WorkerState.RUNNING, reason="resume command")
            return ReasonCode.OK
        if action == Action.REFRESH_CONFIG:
            try:
                self.miner._profiles = load_profiles(self.settings.profiles_path)  # noqa: SLF001
                return ReasonCode.OK
            except Exception:  # noqa: BLE001
                return ReasonCode.MALFORMED_PAYLOAD
        return ReasonCode.UNKNOWN_ACTION

    def _try_start(self, profile_id: str | None) -> ReasonCode:
        if not self._nvidia_ok_or_dev:
            return ReasonCode.GPU_NOT_DETECTED
        if self.miner.is_running():
            return ReasonCode.MINER_ALREADY_RUNNING
        if profile_id is None:
            return ReasonCode.MALFORMED_PAYLOAD
        profile = self.miner.get_profile(profile_id)
        if profile is None:
            return ReasonCode.UNKNOWN_PROFILE

        try:
            gpus = self.nvidia.read()
            max_temp = max((g.temperature_c for g in gpus), default=0.0)
            max_power = max((g.power_draw_watts for g in gpus), default=0.0)
        except NvidiaSmiError:
            return ReasonCode.GPU_NOT_DETECTED
        if max_temp >= self.settings.gpu_stop_temp_c:
            return ReasonCode.GPU_TEMPERATURE_TOO_HIGH
        if max_power >= self.settings.gpu_max_power_watts:
            return ReasonCode.GPU_POWER_TOO_HIGH

        try:
            self.fsm.transition(WorkerState.STARTING, reason="start command")
            self.miner.start(profile_id)
            self.fsm.transition(WorkerState.RUNNING, reason="miner started")
        except Exception as exc:  # noqa: BLE001
            logger.error("start failed", extra={"context": {"error": str(exc)}})
            self.fsm.transition(WorkerState.ERROR, reason="start failed")
            return ReasonCode.INVALID_STATE_TRANSITION
        return ReasonCode.OK

    # --- periodic ticks ---
    def send_heartbeat(self) -> None:
        try:
            self.api.heartbeat(
                HeartbeatRequest(
                    worker_id=self.settings.worker_id,
                    timestamp=datetime.now(UTC),
                    worker_state=self.fsm.state,
                    uptime_seconds=time.monotonic() - self.started_at,
                )
            )
            api_heartbeat_success_total.inc()
            self._mark_api_success()
        except ApiError as exc:
            api_heartbeat_failure_total.inc()
            logger.warning("heartbeat failed", extra={"context": {"error": str(exc)}})

    def send_telemetry(self) -> None:
        try:
            gpus = self.nvidia.read()
        except NvidiaSmiError:
            gpus = []
        stats = self.miner.read_stats()
        observe_miner_stats(stats.hashrate, stats.accepted_shares, stats.rejected_shares)
        set_worker_state(_ALL_WORKER_STATES, self.fsm.state.value)

        payload = build_telemetry(
            worker_id=self.settings.worker_id,
            worker_state=self.fsm.state,
            miner_state=self.miner.state,
            gpus=gpus,
            miner_stats=stats,
            uptime_seconds=time.monotonic() - self.started_at,
            last_command_id=self.last_command_id,
            software_version=self.settings.software_version,
            profile_id=self.miner.active_profile_id,
            safety_flags=sorted(self.fsm.safety_flags),
        )
        try:
            self.api.send_telemetry(payload)
            self._mark_api_success()
        except ApiError as exc:
            logger.warning("telemetry send failed", extra={"context": {"error": str(exc)}})

    def poll_and_apply_command(self) -> None:
        try:
            raw = self.api.fetch_desired_state(self.settings.worker_id)
            self._mark_api_success()
        except ApiError as exc:
            logger.warning("desired-state fetch failed", extra={"context": {"error": str(exc)}})
            return
        if raw is None:
            return
        logger.info("desired-state command received", extra={"context": redact(raw)})
        ack = self.apply_command(raw)
        try:
            self.api.acknowledge_command(ack)
        except ApiError as exc:
            logger.warning("command ack failed", extra={"context": {"error": str(exc)}})

    def tick_miner_health(self) -> None:
        before = self.miner.state
        self.miner.poll_health()
        if self.miner.state.value == "CRASHED" and before != self.miner.state:
            miner_restarts_total.inc()
            self.fsm.force_protection(
                WorkerState.ERROR, flag="MINER_CRASHED", reason=self.miner.last_crash_reason or ""
            )


async def _run_loop(worker: Worker) -> None:
    settings = worker.settings
    worker.register()

    last_heartbeat = 0.0
    last_telemetry = 0.0
    last_poll = 0.0

    while True:
        now = time.monotonic()
        worker.tick_miner_health()
        worker.enforce_local_safety()
        worker.enforce_api_reachability()

        if now - last_heartbeat >= 5:
            worker.send_heartbeat()
            last_heartbeat = now
        if now - last_telemetry >= settings.telemetry_interval_seconds:
            worker.send_telemetry()
            last_telemetry = now
        if now - last_poll >= settings.desired_state_poll_interval_seconds:
            worker.poll_and_apply_command()
            last_poll = now

        await asyncio.sleep(1)


def _run_health_server(worker: Worker, settings: Settings) -> None:
    app = create_health_app(HealthContext(replay_store=worker.replay_store, readiness=worker))
    uvicorn.run(app, host=settings.local_bind_host, port=settings.local_bind_port, log_level="warning")


def main() -> None:
    settings = load_settings()
    configure_logging()
    worker = Worker(settings)

    health_thread = threading.Thread(target=_run_health_server, args=(worker, settings), daemon=True)
    health_thread.start()

    try:
        asyncio.run(_run_loop(worker))
    except KeyboardInterrupt:
        logger.info("shutting down", extra={"context": {}})
        if worker.miner.is_running():
            worker.miner.stop()
        worker.replay_store.close()
        worker.api.close()


if __name__ == "__main__":
    main()
