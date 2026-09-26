from __future__ import annotations

import base64
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app.command_verifier import CommandVerifier, canonicalize
from app.models import SCHEMA_VERSION, ReasonCode
from app.replay_store import ReplayStore

WORKER_ID = "gpu-node-lux-01"
KEY_ID = "test-key-1"
Keypair = tuple[Ed25519PrivateKey, str]


def _iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


def _make_signed(
    private_key: Ed25519PrivateKey,
    *,
    key_id: str = KEY_ID,
    worker_id: str = WORKER_ID,
    action: str = "start",
    profile_id: str | None = "demo-profile-1",
    issued_at: datetime | None = None,
    expires_at: datetime | None = None,
    command_id: str | None = None,
    nonce: str | None = None,
    schema_version: int = SCHEMA_VERSION,
) -> dict[str, object]:
    now = datetime.now(UTC)
    issued_at = issued_at or now
    expires_at = expires_at or (now + timedelta(minutes=1))
    raw: dict[str, object] = {
        "schema_version": schema_version,
        "command_id": command_id or str(uuid.uuid4()),
        "worker_id": worker_id,
        "action": action,
        "profile_id": profile_id,
        "issued_at": _iso(issued_at),
        "expires_at": _iso(expires_at),
        "nonce": nonce or uuid.uuid4().hex,
        "key_id": key_id,
    }
    signature = private_key.sign(canonicalize(raw))
    raw["signature"] = base64.b64encode(signature).decode()
    return raw


@pytest.fixture
def keypair() -> Keypair:
    private_key = Ed25519PrivateKey.generate()
    public_bytes = private_key.public_key().public_bytes_raw()
    return private_key, base64.b64encode(public_bytes).decode()


@pytest.fixture
def verifier(tmp_path: Path, keypair: Keypair) -> CommandVerifier:
    _, public_b64 = keypair
    store = ReplayStore(tmp_path / "replay.sqlite3")
    return CommandVerifier(
        own_worker_id=WORKER_ID,
        public_keys={KEY_ID: public_b64},
        replay_store=store,
        max_clock_skew_seconds=30,
        command_max_lifetime_seconds=300,
    )


def test_valid_command_accepted(verifier: CommandVerifier, keypair: Keypair) -> None:
    private_key, _ = keypair
    raw = _make_signed(private_key)
    result = verifier.verify(raw)
    assert result.ok
    assert result.reason == ReasonCode.OK
    assert result.command is not None


def test_invalid_signature_rejected(verifier: CommandVerifier, keypair: Keypair) -> None:
    private_key, _ = keypair
    raw = _make_signed(private_key)
    raw["action"] = "stop"  # tamper after signing
    result = verifier.verify(raw)
    assert not result.ok
    assert result.reason == ReasonCode.INVALID_SIGNATURE


def test_garbage_signature_rejected(verifier: CommandVerifier, keypair: Keypair) -> None:
    private_key, _ = keypair
    raw = _make_signed(private_key)
    raw["signature"] = base64.b64encode(b"not a real signature bytes!!").decode()
    result = verifier.verify(raw)
    assert not result.ok
    assert result.reason == ReasonCode.INVALID_SIGNATURE


def test_expired_command_rejected(verifier: CommandVerifier, keypair: Keypair) -> None:
    private_key, _ = keypair
    now = datetime.now(UTC)
    raw = _make_signed(
        private_key, issued_at=now - timedelta(minutes=10), expires_at=now - timedelta(minutes=5)
    )
    result = verifier.verify(raw)
    assert not result.ok
    assert result.reason == ReasonCode.COMMAND_EXPIRED


def test_future_issued_command_rejected_for_clock_skew(
    verifier: CommandVerifier, keypair: Keypair
) -> None:
    private_key, _ = keypair
    now = datetime.now(UTC)
    raw = _make_signed(
        private_key, issued_at=now + timedelta(minutes=10), expires_at=now + timedelta(minutes=11)
    )
    result = verifier.verify(raw)
    assert not result.ok
    assert result.reason == ReasonCode.CLOCK_SKEW_TOO_LARGE


def test_wrong_worker_id_rejected(verifier: CommandVerifier, keypair: Keypair) -> None:
    private_key, _ = keypair
    raw = _make_signed(private_key, worker_id="some-other-worker")
    result = verifier.verify(raw)
    assert not result.ok
    assert result.reason == ReasonCode.WRONG_WORKER_ID


def test_unknown_key_id_rejected(verifier: CommandVerifier, keypair: Keypair) -> None:
    private_key, _ = keypair
    raw = _make_signed(private_key, key_id="key-nobody-registered")
    result = verifier.verify(raw)
    assert not result.ok
    assert result.reason == ReasonCode.UNKNOWN_KEY_ID


def test_duplicate_command_rejected(verifier: CommandVerifier, keypair: Keypair) -> None:
    private_key, _ = keypair
    command_id = str(uuid.uuid4())
    first = _make_signed(private_key, command_id=command_id, nonce="nonce-aaaa")
    second = _make_signed(private_key, command_id=command_id, nonce="nonce-bbbb")
    assert verifier.verify(first).ok
    result = verifier.verify(second)
    assert not result.ok
    assert result.reason == ReasonCode.DUPLICATE_COMMAND


def test_duplicate_nonce_rejected(verifier: CommandVerifier, keypair: Keypair) -> None:
    private_key, _ = keypair
    nonce = uuid.uuid4().hex
    first = _make_signed(private_key, nonce=nonce)
    second = _make_signed(private_key, nonce=nonce)
    assert verifier.verify(first).ok
    result = verifier.verify(second)
    assert not result.ok
    assert result.reason == ReasonCode.DUPLICATE_NONCE


def test_unknown_action_rejected(verifier: CommandVerifier, keypair: Keypair) -> None:
    private_key, _ = keypair
    raw = _make_signed(private_key, action="reboot_host")
    result = verifier.verify(raw)
    assert not result.ok
    assert result.reason == ReasonCode.MALFORMED_PAYLOAD


def test_unsupported_schema_version_rejected(
    verifier: CommandVerifier, keypair: Keypair
) -> None:
    private_key, _ = keypair
    raw = _make_signed(private_key, schema_version=99)
    result = verifier.verify(raw)
    assert not result.ok
    assert result.reason == ReasonCode.UNSUPPORTED_SCHEMA_VERSION


def test_malformed_payload_rejected(verifier: CommandVerifier) -> None:
    result = verifier.verify({"schema_version": SCHEMA_VERSION, "not": "a real command"})
    assert not result.ok
    assert result.reason == ReasonCode.MALFORMED_PAYLOAD


def test_no_command_injection_via_profile_id(
    verifier: CommandVerifier, keypair: Keypair
) -> None:
    private_key, _ = keypair
    injected = "demo-profile-1; rm -rf / #"
    raw = _make_signed(private_key, profile_id=injected)
    result = verifier.verify(raw)
    # Signature/schema layer doesn't know about the profile allowlist — it just passes the
    # string through untouched (never interpolated into a shell). The allowlist check itself
    # lives in MinerController.get_profile, exercised in test_miner_controller.py.
    assert result.ok
    assert result.command is not None
    assert result.command.profile_id == injected
