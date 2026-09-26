"""Ed25519 signature verification and full validation pipeline for desired-state commands.

Canonicalization (must match the signer exactly):
  canonical_bytes = json.dumps(
      {field: raw[field] for field in SIGNED_FIELDS},   # SIGNED_FIELDS order, see models.py
      separators=(",", ":"),
      ensure_ascii=True,
  ).encode("utf-8")

`raw` is the *as-received* JSON dict (string values exactly as transmitted — issued_at/expires_at
are signed as whatever RFC3339 string the signer produced, not re-formatted after parsing) with
one exception: `signature` is never part of the signed bytes. `profile_id` is included even when
null. See docs/api-contract.md for a worked example.

Every failure returns a specific ReasonCode instead of raising, so the caller can always produce
an accurate CommandAck.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from pydantic import ValidationError

from app.logging import get_logger
from app.models import SCHEMA_VERSION, SIGNED_FIELDS, Action, DesiredStateCommand, ReasonCode
from app.replay_store import ReplayResult, ReplayStore

logger = get_logger(__name__)


@dataclass(frozen=True)
class VerificationResult:
    ok: bool
    reason: ReasonCode
    command: DesiredStateCommand | None = None


def canonicalize(raw: dict[str, object]) -> bytes:
    missing = [f for f in SIGNED_FIELDS if f not in raw]
    if missing:
        raise KeyError(f"missing signed fields: {missing}")
    ordered = {field: raw[field] for field in SIGNED_FIELDS}
    return json.dumps(ordered, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def _decode_public_key(b64_raw_key: str) -> Ed25519PublicKey:
    raw = base64.b64decode(b64_raw_key, validate=True)
    return Ed25519PublicKey.from_public_bytes(raw)


class CommandVerifier:
    def __init__(
        self,
        *,
        own_worker_id: str,
        public_keys: dict[str, str],
        replay_store: ReplayStore,
        max_clock_skew_seconds: int,
        command_max_lifetime_seconds: int,
    ) -> None:
        self._own_worker_id = own_worker_id
        self._public_keys = {kid: _decode_public_key(b64) for kid, b64 in public_keys.items()}
        self._replay_store = replay_store
        self._max_clock_skew = max_clock_skew_seconds
        self._max_lifetime = command_max_lifetime_seconds

    def verify(self, raw: dict[str, object]) -> VerificationResult:
        # 1. Cheap, precise checks before touching crypto or the replay store.
        if raw.get("schema_version") != SCHEMA_VERSION:
            return VerificationResult(False, ReasonCode.UNSUPPORTED_SCHEMA_VERSION)

        try:
            command = DesiredStateCommand.model_validate(raw)
        except ValidationError as exc:
            logger.warning("command failed schema validation", extra={"context": {"error": str(exc)}})
            return VerificationResult(False, ReasonCode.MALFORMED_PAYLOAD)

        if command.action not in Action:
            return VerificationResult(False, ReasonCode.UNKNOWN_ACTION)

        if command.action == Action.START and not command.profile_id:
            return VerificationResult(False, ReasonCode.MALFORMED_PAYLOAD)

        if command.worker_id != self._own_worker_id:
            return VerificationResult(False, ReasonCode.WRONG_WORKER_ID)

        public_key = self._public_keys.get(command.key_id)
        if public_key is None:
            return VerificationResult(False, ReasonCode.UNKNOWN_KEY_ID)

        # 2. Time validity, enforced with our own bounds regardless of what expires_at claims.
        now = datetime.now(UTC)
        if command.expires_at - command.issued_at > timedelta(seconds=self._max_lifetime):
            return VerificationResult(False, ReasonCode.MALFORMED_PAYLOAD)
        if command.issued_at - now > timedelta(seconds=self._max_clock_skew):
            return VerificationResult(False, ReasonCode.CLOCK_SKEW_TOO_LARGE)
        if now > command.expires_at:
            return VerificationResult(False, ReasonCode.COMMAND_EXPIRED)
        if now < command.issued_at - timedelta(seconds=self._max_clock_skew):
            return VerificationResult(False, ReasonCode.COMMAND_NOT_YET_VALID)

        # 3. Signature — verified last among the cheap checks, first among the expensive ones,
        #    so a malformed/expired/wrong-worker command never even reaches crypto.
        try:
            canonical = canonicalize(raw)
        except KeyError:
            return VerificationResult(False, ReasonCode.MALFORMED_PAYLOAD)

        try:
            public_key.verify(base64.b64decode(command.signature, validate=True), canonical)
        except (InvalidSignature, ValueError):
            return VerificationResult(False, ReasonCode.INVALID_SIGNATURE)

        # 4. Replay protection — only after the command has been proven authentic and fresh, so
        #    an attacker can't burn a legitimate future replay slot with a forged command.
        replay = self._replay_store.check_and_record(command.command_id, command.nonce)
        if replay == ReplayResult.DUPLICATE_COMMAND:
            return VerificationResult(False, ReasonCode.DUPLICATE_COMMAND)
        if replay == ReplayResult.DUPLICATE_NONCE:
            return VerificationResult(False, ReasonCode.DUPLICATE_NONCE)
        if replay == ReplayResult.STORE_ERROR:
            # Fail closed: an unavailable replay store must never let a command through.
            return VerificationResult(False, ReasonCode.MALFORMED_PAYLOAD)

        return VerificationResult(True, ReasonCode.OK, command)
