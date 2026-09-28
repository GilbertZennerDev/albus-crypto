"""Structured JSON logging. Never logs secrets, Authorization headers, or raw payloads."""

from __future__ import annotations

import json
import logging
import sys
from datetime import UTC, datetime
from typing import Any

_REDACTED = "[REDACTED]"
_SENSITIVE_KEYS = {
    "authorization",
    "worker_token",
    "signature",
    "private_key",
    "wallet_address",
    "password",
    "pool_password",
    "api_master_secret",
    "seed_phrase",
}


def redact(obj: Any) -> Any:
    """Recursively redacts known-sensitive keys from a dict/list structure before logging."""
    if isinstance(obj, dict):
        return {
            k: (_REDACTED if k.lower() in _SENSITIVE_KEYS else redact(v)) for k, v in obj.items()
        }
    if isinstance(obj, list):
        return [redact(v) for v in obj]
    return obj


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.now(UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        extra = getattr(record, "context", None)
        if extra:
            payload["context"] = redact(extra)
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_logging(level: str = "INFO") -> None:
    root = logging.getLogger()
    root.setLevel(level)
    root.handlers.clear()
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root.addHandler(handler)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
