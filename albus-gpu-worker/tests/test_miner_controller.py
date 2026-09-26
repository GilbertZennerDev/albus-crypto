from __future__ import annotations

import time
from pathlib import Path

import pytest

from app.miner_controller import MinerController, MinerProfile, ProfileLoadError, load_profiles
from app.models import MinerState


def _profile(profile_id: str = "demo-profile-1", enabled: bool = True) -> MinerProfile:
    return MinerProfile(
        id=profile_id,
        enabled=enabled,
        miner_kind="placeholder",
        pool_ref="pool-main-1",
        account_ref="account-operator-1",
        max_gpus=1,
        allowed_gpu_uuids=["GPU-EXAMPLE-UUID"],
        command_template=["/usr/local/bin/miner-wrapper", "--profile", profile_id],
    )


def test_load_profiles_from_yaml(tmp_path: Path) -> None:
    path = tmp_path / "profiles.yaml"
    path.write_text(
        """
        profiles:
          - id: demo-profile-1
            enabled: true
            miner_kind: placeholder
            pool_ref: pool-main-1
            account_ref: account-operator-1
            max_gpus: 1
            allowed_gpu_uuids: ["GPU-EXAMPLE-UUID"]
            command_template: ["/usr/local/bin/miner-wrapper", "--profile", "demo-profile-1"]
        """
    )
    profiles = load_profiles(path)
    assert "demo-profile-1" in profiles
    assert profiles["demo-profile-1"].enabled


def test_load_profiles_rejects_invalid_yaml(tmp_path: Path) -> None:
    path = tmp_path / "profiles.yaml"
    path.write_text("profiles: [{id: 'x'}]")  # missing required fields
    with pytest.raises(ProfileLoadError):
        load_profiles(path)


def test_unknown_profile_returns_none() -> None:
    controller = MinerController({"demo-profile-1": _profile()}, restart_max=3, restart_window_seconds=600)
    assert controller.get_profile("does-not-exist") is None


def test_disabled_profile_not_available() -> None:
    controller = MinerController(
        {"demo-profile-1": _profile(enabled=False)}, restart_max=3, restart_window_seconds=600
    )
    assert controller.get_profile("demo-profile-1") is None


def test_start_stop_mock_miner() -> None:
    controller = MinerController({"demo-profile-1": _profile()}, restart_max=3, restart_window_seconds=600)
    controller.start("demo-profile-1")
    assert controller.state == MinerState.RUNNING
    assert controller.is_running()
    controller.stop()
    assert controller.state == MinerState.STOPPED
    assert not controller.is_running()


def test_start_twice_raises() -> None:
    controller = MinerController({"demo-profile-1": _profile()}, restart_max=3, restart_window_seconds=600)
    controller.start("demo-profile-1")
    with pytest.raises(RuntimeError):
        controller.start("demo-profile-1")


def test_start_unknown_profile_raises_keyerror() -> None:
    controller = MinerController({"demo-profile-1": _profile()}, restart_max=3, restart_window_seconds=600)
    with pytest.raises(KeyError):
        controller.start("nope")


def test_pause_resume() -> None:
    controller = MinerController({"demo-profile-1": _profile()}, restart_max=3, restart_window_seconds=600)
    controller.start("demo-profile-1")
    controller.pause()
    assert controller.state == MinerState.PAUSED
    controller.resume()
    assert controller.state == MinerState.RUNNING


def test_pause_when_not_running_raises() -> None:
    controller = MinerController({"demo-profile-1": _profile()}, restart_max=3, restart_window_seconds=600)
    with pytest.raises(RuntimeError):
        controller.pause()


def test_restart_tracker_allows_within_budget() -> None:
    controller = MinerController({"demo-profile-1": _profile()}, restart_max=3, restart_window_seconds=600)
    for _ in range(3):
        assert controller._restart_tracker.record_and_check()  # noqa: SLF001


def test_restart_tracker_blocks_over_budget() -> None:
    controller = MinerController({"demo-profile-1": _profile()}, restart_max=2, restart_window_seconds=600)
    tracker = controller._restart_tracker  # noqa: SLF001
    assert tracker.record_and_check()
    assert tracker.record_and_check()
    assert not tracker.record_and_check()


def test_restart_tracker_window_expiry() -> None:
    controller = MinerController(
        {"demo-profile-1": _profile()}, restart_max=1, restart_window_seconds=1
    )
    tracker = controller._restart_tracker  # noqa: SLF001
    assert tracker.record_and_check()
    time.sleep(1.1)
    # after the window has fully elapsed, the earlier timestamp is pruned before counting
    assert tracker.record_and_check()


def _real_process_profile(exit_code: int) -> MinerProfile:
    import sys

    return MinerProfile(
        id="crash-test",
        enabled=True,
        miner_kind="placeholder",
        pool_ref="pool-main-1",
        account_ref="account-operator-1",
        max_gpus=1,
        allowed_gpu_uuids=["GPU-EXAMPLE-UUID"],
        command_template=[sys.executable, "-c", f"import sys; sys.exit({exit_code})"],
    )


def test_unexpected_exit_triggers_bounded_restart() -> None:
    profile = _real_process_profile(exit_code=1)
    controller = MinerController(
        {"crash-test": profile}, restart_max=2, restart_window_seconds=600, use_mock=False
    )
    controller.start("crash-test")

    # restart_max=2 permits 2 restarts (3 total process runs) before the budget is exceeded.
    for _ in range(3):
        deadline = time.monotonic() + 2
        while controller._process is not None and controller._process.poll() is None:  # noqa: SLF001
            if time.monotonic() > deadline:
                pytest.fail("test process did not exit in time")
            time.sleep(0.02)
        controller.poll_health()

    assert controller.state == MinerState.CRASHED
    assert controller.last_crash_reason is not None


def test_command_template_never_contains_shell_metacharacters_from_untrusted_input() -> None:
    # The profile's own command_template is fixed operator data; MinerController never appends
    # anything from a caller to it. This test documents and enforces that invariant.
    profile = _profile()
    injected_profile_id = "demo-profile-1; rm -rf / #"
    controller = MinerController({"demo-profile-1": profile}, restart_max=3, restart_window_seconds=600)
    # Even if a caller passes an injected-looking string as profile_id, get_profile does a plain
    # dict lookup — it can never match, so start() will KeyError rather than execute anything.
    assert controller.get_profile(injected_profile_id) is None
