"""Strict worker finite-state machine. Local protection events always override remote desired state."""

from __future__ import annotations

from dataclasses import dataclass, field

from app.logging import get_logger
from app.models import WorkerState

logger = get_logger(__name__)

# Explicit allowlist of transitions. Anything not listed here is rejected.
_ALLOWED: dict[WorkerState, set[WorkerState]] = {
    WorkerState.OFFLINE: {WorkerState.IDLE},
    WorkerState.IDLE: {WorkerState.STARTING, WorkerState.ERROR, WorkerState.OFFLINE},
    WorkerState.STARTING: {
        WorkerState.RUNNING,
        WorkerState.ERROR,
        WorkerState.THERMAL_PROTECT,
        WorkerState.POWER_PROTECT,
        WorkerState.STOPPING,
    },
    WorkerState.RUNNING: {
        WorkerState.PAUSED,
        WorkerState.STOPPING,
        WorkerState.THERMAL_PROTECT,
        WorkerState.POWER_PROTECT,
        WorkerState.ERROR,
    },
    WorkerState.PAUSED: {
        WorkerState.RUNNING,
        WorkerState.STOPPING,
        WorkerState.THERMAL_PROTECT,
        WorkerState.POWER_PROTECT,
        WorkerState.ERROR,
    },
    WorkerState.THERMAL_PROTECT: {WorkerState.IDLE, WorkerState.STOPPING, WorkerState.ERROR},
    WorkerState.POWER_PROTECT: {WorkerState.IDLE, WorkerState.STOPPING, WorkerState.ERROR},
    WorkerState.ERROR: {WorkerState.IDLE, WorkerState.STOPPING, WorkerState.OFFLINE},
    WorkerState.STOPPING: {WorkerState.IDLE, WorkerState.OFFLINE, WorkerState.ERROR},
}


class InvalidTransition(Exception):
    def __init__(self, current: WorkerState, target: WorkerState) -> None:
        super().__init__(f"invalid transition {current} -> {target}")
        self.current = current
        self.target = target


@dataclass
class WorkerFSM:
    state: WorkerState = WorkerState.OFFLINE
    safety_flags: set[str] = field(default_factory=set)

    def can_transition(self, target: WorkerState) -> bool:
        return target in _ALLOWED.get(self.state, set())

    def transition(self, target: WorkerState, *, reason: str) -> WorkerState:
        if not self.can_transition(target):
            raise InvalidTransition(self.state, target)
        logger.info(
            "state transition",
            extra={"context": {"from": self.state.value, "to": target.value, "reason": reason}},
        )
        self.state = target
        return self.state

    def force_protection(self, target: WorkerState, *, flag: str, reason: str) -> WorkerState:
        """Local protection events (thermal/power) always take effect, overriding whatever the
        remote desired state most recently asked for — safety never depends on API availability
        or correctness."""
        self.safety_flags.add(flag)
        if self.state == target:
            return self.state
        if not self.can_transition(target):
            # Protection states are reachable from every operational state; if this ever fires
            # it means a new WorkerState was added without updating _ALLOWED.
            logger.error(
                "protection transition blocked by state table — failing closed to ERROR",
                extra={"context": {"from": self.state.value, "target": target.value}},
            )
            self.state = WorkerState.ERROR
            return self.state
        return self.transition(target, reason=reason)

    def clear_flag(self, flag: str) -> None:
        self.safety_flags.discard(flag)

    def is_operational(self) -> bool:
        return self.state in (WorkerState.RUNNING, WorkerState.PAUSED, WorkerState.STARTING)
