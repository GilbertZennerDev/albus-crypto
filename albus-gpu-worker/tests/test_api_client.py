from __future__ import annotations

from datetime import UTC, datetime

import httpx
import pytest

from app.api_client import AlbusApiClient, ApiError
from app.models import HeartbeatRequest, WorkerState


def _client_with_transport(transport: httpx.MockTransport) -> AlbusApiClient:
    return AlbusApiClient(
        base_url="https://albus.example.test/api/v1",
        worker_token="test-token",  # noqa: S106 — test fixture value, not a real credential
        timeout_seconds=1.0,
        retry_attempts=3,
        transport=transport,
    )


def test_heartbeat_success() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer test-token"
        return httpx.Response(200, json={"server_time": "2026-01-01T00:00:00Z", "has_pending_command": False})

    client = _client_with_transport(httpx.MockTransport(handler))
    resp = client.heartbeat(
        HeartbeatRequest(
            worker_id="gpu-node-lux-01",
            timestamp=datetime.now(UTC),
            worker_state=WorkerState.IDLE,
            uptime_seconds=10.0,
        )
    )
    assert resp.has_pending_command is False


def test_retries_on_server_error_then_succeeds() -> None:
    attempts = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["count"] += 1
        if attempts["count"] < 3:
            return httpx.Response(500)
        return httpx.Response(200, json={"server_time": "2026-01-01T00:00:00Z", "has_pending_command": False})

    client = _client_with_transport(httpx.MockTransport(handler))
    resp = client.heartbeat(
        HeartbeatRequest(
            worker_id="gpu-node-lux-01",
            timestamp=datetime.now(UTC),
            worker_state=WorkerState.IDLE,
            uptime_seconds=10.0,
        )
    )
    assert attempts["count"] == 3
    assert resp.has_pending_command is False


def test_gives_up_after_max_retries() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500)

    client = _client_with_transport(httpx.MockTransport(handler))
    with pytest.raises(ApiError):
        client.heartbeat(
            HeartbeatRequest(
                worker_id="gpu-node-lux-01",
                timestamp=datetime.now(UTC),
                worker_state=WorkerState.IDLE,
                uptime_seconds=10.0,
            )
        )


def test_transport_error_raises_api_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    client = _client_with_transport(httpx.MockTransport(handler))
    with pytest.raises(ApiError):
        client.heartbeat(
            HeartbeatRequest(
                worker_id="gpu-node-lux-01",
                timestamp=datetime.now(UTC),
                worker_state=WorkerState.IDLE,
                uptime_seconds=10.0,
            )
        )


def test_fetch_desired_state_no_command_returns_none() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"has_command": False, "command": None})

    client = _client_with_transport(httpx.MockTransport(handler))
    assert client.fetch_desired_state("gpu-node-lux-01") is None


def test_fetch_desired_state_204_returns_none() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(204)

    client = _client_with_transport(httpx.MockTransport(handler))
    assert client.fetch_desired_state("gpu-node-lux-01") is None


def test_fetch_desired_state_returns_raw_command_dict() -> None:
    command = {"schema_version": 1, "command_id": "abc", "action": "start"}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"has_command": True, "command": command})

    client = _client_with_transport(httpx.MockTransport(handler))
    result = client.fetch_desired_state("gpu-node-lux-01")
    assert result == command


def test_never_sends_worker_token_in_body() -> None:
    seen_bodies = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_bodies.append(request.content)
        return httpx.Response(200, json={"server_time": "2026-01-01T00:00:00Z", "has_pending_command": False})

    client = _client_with_transport(httpx.MockTransport(handler))
    client.heartbeat(
        HeartbeatRequest(
            worker_id="gpu-node-lux-01",
            timestamp=datetime.now(UTC),
            worker_state=WorkerState.IDLE,
            uptime_seconds=10.0,
        )
    )
    assert all(b"test-token" not in body for body in seen_bodies)
