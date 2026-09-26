from __future__ import annotations

from pathlib import Path

from app.replay_store import ReplayResult, ReplayStore


def test_new_command_and_nonce_accepted(tmp_path: Path) -> None:
    store = ReplayStore(tmp_path / "replay.sqlite3")
    assert store.check_and_record("cmd-1", "nonce-1") == ReplayResult.OK


def test_duplicate_command_id_rejected(tmp_path: Path) -> None:
    store = ReplayStore(tmp_path / "replay.sqlite3")
    assert store.check_and_record("cmd-1", "nonce-1") == ReplayResult.OK
    assert store.check_and_record("cmd-1", "nonce-2") == ReplayResult.DUPLICATE_COMMAND


def test_duplicate_nonce_rejected_even_with_new_command_id(tmp_path: Path) -> None:
    store = ReplayStore(tmp_path / "replay.sqlite3")
    assert store.check_and_record("cmd-1", "nonce-1") == ReplayResult.OK
    assert store.check_and_record("cmd-2", "nonce-1") == ReplayResult.DUPLICATE_NONCE


def test_survives_reopen(tmp_path: Path) -> None:
    path = tmp_path / "replay.sqlite3"
    store = ReplayStore(path)
    store.check_and_record("cmd-1", "nonce-1")
    store.close()

    reopened = ReplayStore(path)
    assert reopened.check_and_record("cmd-1", "nonce-2") == ReplayResult.DUPLICATE_COMMAND


def test_is_ready(tmp_path: Path) -> None:
    store = ReplayStore(tmp_path / "replay.sqlite3")
    assert store.is_ready()
