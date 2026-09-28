"""httpx-based client for the central Albus API. TLS-verified, bearer-token authenticated, with
bounded retries. Never logs the Authorization header or raw payload bodies containing secrets.
"""

from __future__ import annotations

from typing import Any

import httpx

from app.logging import get_logger
from app.models import (
    CommandAck,
    HeartbeatRequest,
    HeartbeatResponse,
    RegisterRequest,
    RegisterResponse,
    TelemetryPayload,
    TelemetryResponse,
)

logger = get_logger(__name__)


class ApiError(Exception):
    pass


class AlbusApiClient:
    def __init__(
        self,
        *,
        base_url: str,
        worker_token: str,
        timeout_seconds: float = 10.0,
        retry_attempts: int = 3,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._retry_attempts = max(1, retry_attempts)
        self._client = httpx.Client(
            base_url=base_url,
            timeout=timeout_seconds,
            verify=True,  # TLS certificate verification always on
            headers={"Authorization": f"Bearer {worker_token}"},
            transport=transport,
        )

    def close(self) -> None:
        self._client.close()

    def _request(self, method: str, path: str, *, json_body: dict[str, Any] | None = None) -> httpx.Response:
        last_exc: Exception | None = None
        for attempt in range(1, self._retry_attempts + 1):
            try:
                response = self._client.request(method, path, json=json_body)
                if response.status_code >= 500:
                    raise ApiError(f"{method} {path} -> {response.status_code}")
                return response
            except (httpx.TransportError, ApiError) as exc:
                last_exc = exc
                will_retry = attempt < self._retry_attempts
                logger.warning(
                    "API request failed, will retry" if will_retry else "API request failed",
                    extra={"context": {"path": path, "attempt": attempt}},
                )
        raise ApiError(f"{method} {path} failed after {self._retry_attempts} attempts") from last_exc

    def register(self, req: RegisterRequest) -> RegisterResponse:
        resp = self._request("POST", "/workers/register", json_body=req.model_dump(mode="json"))
        if resp.status_code not in (200, 201):
            raise ApiError(f"register failed: {resp.status_code}")
        return RegisterResponse.model_validate(resp.json())

    def heartbeat(self, req: HeartbeatRequest) -> HeartbeatResponse:
        resp = self._request("POST", "/workers/heartbeat", json_body=req.model_dump(mode="json"))
        if resp.status_code != 200:
            raise ApiError(f"heartbeat failed: {resp.status_code}")
        return HeartbeatResponse.model_validate(resp.json())

    def send_telemetry(self, payload: TelemetryPayload) -> TelemetryResponse:
        resp = self._request("POST", "/workers/telemetry", json_body=payload.model_dump(mode="json"))
        if resp.status_code not in (200, 201, 202):
            raise ApiError(f"telemetry failed: {resp.status_code}")
        return TelemetryResponse.model_validate(resp.json())

    def fetch_desired_state(self, worker_id: str) -> dict[str, Any] | None:
        """Returns the raw JSON dict of a pending command (unverified — verification happens in
        CommandVerifier, which needs the exact raw field values, not a re-serialized model), or
        None if nothing is pending."""
        resp = self._request("GET", f"/workers/{worker_id}/desired-state")
        if resp.status_code == 204:
            return None
        if resp.status_code != 200:
            raise ApiError(f"desired-state fetch failed: {resp.status_code}")
        envelope = resp.json()
        if not envelope.get("has_command"):
            return None
        command = envelope.get("command")
        return command if isinstance(command, dict) else None

    def acknowledge_command(self, ack: CommandAck) -> None:
        resp = self._request("POST", "/workers/command-ack", json_body=ack.model_dump(mode="json"))
        if resp.status_code not in (200, 201, 202):
            raise ApiError(f"command ack failed: {resp.status_code}")
