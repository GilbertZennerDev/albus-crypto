"""Prometheus metrics. No worker tokens, wallet data, credentials, full GPU UUIDs, IPs, or user
identifiers are ever used as label values — GPU index (a small integer) is the only per-GPU label.
"""

from __future__ import annotations

from prometheus_client import CollectorRegistry, Counter, Gauge

registry = CollectorRegistry()

worker_state = Gauge(
    "albus_worker_state",
    "Current worker state (1 for the active state, 0 for all others)",
    ["state"],
    registry=registry,
)
gpu_temperature_celsius = Gauge(
    "albus_gpu_temperature_celsius", "GPU temperature", ["gpu_index"], registry=registry
)
gpu_power_watts = Gauge("albus_gpu_power_watts", "GPU power draw", ["gpu_index"], registry=registry)
gpu_utilization_percent = Gauge(
    "albus_gpu_utilization_percent", "GPU compute utilization", ["gpu_index"], registry=registry
)
gpu_memory_used_mib = Gauge(
    "albus_gpu_memory_used_mib", "GPU memory used", ["gpu_index"], registry=registry
)
miner_hashrate = Gauge("albus_miner_hashrate", "Current miner hashrate", registry=registry)
miner_accepted_shares_total = Counter(
    "albus_miner_accepted_shares_total", "Accepted shares", registry=registry
)
miner_rejected_shares_total = Counter(
    "albus_miner_rejected_shares_total", "Rejected shares", registry=registry
)
api_heartbeat_success_total = Counter(
    "albus_api_heartbeat_success_total", "Successful heartbeats", registry=registry
)
api_heartbeat_failure_total = Counter(
    "albus_api_heartbeat_failure_total", "Failed heartbeats", registry=registry
)
command_accepted_total = Counter(
    "albus_command_accepted_total", "Accepted desired-state commands", registry=registry
)
command_rejected_total = Counter(
    "albus_command_rejected_total", "Rejected desired-state commands", ["reason_code"], registry=registry
)
miner_restarts_total = Counter("albus_miner_restarts_total", "Miner restart attempts", registry=registry)
last_successful_api_contact_timestamp = Gauge(
    "albus_last_successful_api_contact_timestamp",
    "Unix timestamp of the last successful API contact",
    registry=registry,
)


def set_worker_state(all_states: list[str], active: str) -> None:
    for s in all_states:
        worker_state.labels(state=s).set(1.0 if s == active else 0.0)


_prev_accepted = 0
_prev_rejected = 0


def observe_miner_stats(hashrate: float | None, accepted: int, rejected: int) -> None:
    global _prev_accepted, _prev_rejected
    miner_hashrate.set(hashrate or 0.0)
    if accepted > _prev_accepted:
        miner_accepted_shares_total.inc(accepted - _prev_accepted)
    if rejected > _prev_rejected:
        miner_rejected_shares_total.inc(rejected - _prev_rejected)
    _prev_accepted, _prev_rejected = accepted, rejected
