"""SQLite-backed replay protection for command IDs and nonces. Fails closed on any DB error.

command_id and nonce are tracked as two independently-unique columns (not a composite key) so a
reused command_id and a reused nonce are each detected on their own, as required by the threat
model — an attacker who replays an old (command_id, nonce) pair, or who reuses a nonce with a
new command_id, or a command_id with a new nonce, is rejected in every case.
"""

from __future__ import annotations

import sqlite3
import time
from enum import Enum, auto
from pathlib import Path


class ReplayResult(Enum):
    OK = auto()
    DUPLICATE_COMMAND = auto()
    DUPLICATE_NONCE = auto()
    STORE_ERROR = auto()


class ReplayStore:
    def __init__(self, path: Path, retention_seconds: int = 3600) -> None:
        self._path = path
        self._retention_seconds = retention_seconds
        path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS seen_command_ids (
                command_id TEXT PRIMARY KEY,
                seen_at REAL NOT NULL
            )
            """
        )
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS seen_nonces (
                nonce TEXT PRIMARY KEY,
                seen_at REAL NOT NULL
            )
            """
        )
        self._conn.commit()

    def is_ready(self) -> bool:
        try:
            self._conn.execute("SELECT 1")
            return True
        except sqlite3.Error:
            return False

    def _prune(self) -> None:
        cutoff = time.time() - self._retention_seconds
        self._conn.execute("DELETE FROM seen_command_ids WHERE seen_at < ?", (cutoff,))
        self._conn.execute("DELETE FROM seen_nonces WHERE seen_at < ?", (cutoff,))

    def check_and_record(self, command_id: str, nonce: str) -> ReplayResult:
        """Atomically checks and records both command_id and nonce. Both must be new for this to
        succeed — checked before either is inserted, so a duplicate on either axis leaves the
        store unchanged (no partial record of a rejected command)."""
        try:
            self._prune()
            cur = self._conn.execute(
                "SELECT 1 FROM seen_command_ids WHERE command_id = ?", (command_id,)
            )
            if cur.fetchone() is not None:
                return ReplayResult.DUPLICATE_COMMAND
            cur = self._conn.execute("SELECT 1 FROM seen_nonces WHERE nonce = ?", (nonce,))
            if cur.fetchone() is not None:
                return ReplayResult.DUPLICATE_NONCE

            now = time.time()
            self._conn.execute(
                "INSERT INTO seen_command_ids (command_id, seen_at) VALUES (?, ?)",
                (command_id, now),
            )
            self._conn.execute("INSERT INTO seen_nonces (nonce, seen_at) VALUES (?, ?)", (nonce, now))
            self._conn.commit()
            return ReplayResult.OK
        except sqlite3.Error:
            # Fail closed: an unreadable/unwritable store must never be treated as "allow".
            return ReplayResult.STORE_ERROR

    def close(self) -> None:
        self._conn.close()
