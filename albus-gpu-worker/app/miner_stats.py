"""Interface for reading current miner statistics. The mock implementation simulates a real one.

An operator integrating a real miner implements MinerStatsSource against whatever local,
loopback-only stats interface that miner exposes (e.g. an XMRig-style HTTP API on 127.0.0.1) and
wires it into MinerController in place of MockMinerStatsSource. This file never talks to the
network beyond localhost, and never trusts values it can't verify come from the local miner
process this worker itself started.
"""

from __future__ import annotations

import random
import time
from dataclasses import dataclass
from typing import Protocol

from app.models import MinerStats


class MinerStatsSource(Protocol):
    def read(self) -> MinerStats: ...

    def reset(self) -> None: ...


@dataclass
class MockMinerStatsSource:
    """Development/test stand-in. Produces plausible-looking simulated hashrate and share
    counts that increase while the mock miner is "running". Never touches real hardware or a
    real pool — see README.md's operator-integration note for real-miner wiring."""

    _started_at: float | None = None
    _accepted: int = 0
    _rejected: int = 0
    _seed: int = 0

    def start(self) -> None:
        self._started_at = time.monotonic()
        self._seed = random.randint(1, 1_000_000)  # noqa: S311 — simulated demo data, not security-sensitive

    def stop(self) -> None:
        self._started_at = None

    def reset(self) -> None:
        self._accepted = 0
        self._rejected = 0

    def read(self) -> MinerStats:
        if self._started_at is None:
            return MinerStats(hashrate=None, accepted_shares=self._accepted, rejected_shares=self._rejected)
        elapsed = time.monotonic() - self._started_at
        rng = random.Random(self._seed)  # noqa: S311 — simulated demo data, not security-sensitive
        hashrate = 50_000_000.0 + rng.uniform(-2_000_000, 2_000_000)
        # Deterministic-ish growth so repeated reads within a test are monotonic.
        self._accepted = int(elapsed * 3.7)
        self._rejected = int(elapsed * 0.1)
        return MinerStats(hashrate=hashrate, accepted_shares=self._accepted, rejected_shares=self._rejected)
