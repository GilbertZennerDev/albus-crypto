from __future__ import annotations

import pytest

from app.models import WorkerState
from app.state_machine import InvalidTransition, WorkerFSM


def test_initial_state_is_offline() -> None:
    fsm = WorkerFSM()
    assert fsm.state == WorkerState.OFFLINE


def test_valid_transition_sequence() -> None:
    fsm = WorkerFSM()
    fsm.transition(WorkerState.IDLE, reason="registered")
    fsm.transition(WorkerState.STARTING, reason="start command")
    fsm.transition(WorkerState.RUNNING, reason="miner started")
    assert fsm.state == WorkerState.RUNNING


def test_invalid_transition_raises() -> None:
    fsm = WorkerFSM()
    with pytest.raises(InvalidTransition):
        fsm.transition(WorkerState.RUNNING, reason="skip states")
    assert fsm.state == WorkerState.OFFLINE  # unchanged after a rejected transition


def test_thermal_protection_overrides_running() -> None:
    fsm = WorkerFSM()
    fsm.transition(WorkerState.IDLE, reason="registered")
    fsm.transition(WorkerState.STARTING, reason="start")
    fsm.transition(WorkerState.RUNNING, reason="started")
    fsm.force_protection(WorkerState.THERMAL_PROTECT, flag="THERMAL_PROTECTION", reason="too hot")
    assert fsm.state == WorkerState.THERMAL_PROTECT
    assert "THERMAL_PROTECTION" in fsm.safety_flags


def test_power_protection_from_paused() -> None:
    fsm = WorkerFSM()
    fsm.transition(WorkerState.IDLE, reason="registered")
    fsm.transition(WorkerState.STARTING, reason="start")
    fsm.transition(WorkerState.RUNNING, reason="started")
    fsm.transition(WorkerState.PAUSED, reason="pause command")
    fsm.force_protection(WorkerState.POWER_PROTECT, flag="POWER_PROTECTION", reason="too much power")
    assert fsm.state == WorkerState.POWER_PROTECT


def test_clear_flag() -> None:
    fsm = WorkerFSM()
    fsm.safety_flags.add("THERMAL_PROTECTION")
    fsm.clear_flag("THERMAL_PROTECTION")
    assert "THERMAL_PROTECTION" not in fsm.safety_flags


def test_is_operational() -> None:
    fsm = WorkerFSM()
    assert not fsm.is_operational()
    fsm.transition(WorkerState.IDLE, reason="registered")
    fsm.transition(WorkerState.STARTING, reason="start")
    assert fsm.is_operational()
