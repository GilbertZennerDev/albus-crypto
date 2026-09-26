from __future__ import annotations

import subprocess
from unittest.mock import patch

import pytest

from app.nvidia import NvidiaInspector, NvidiaSmiError, parse_nvidia_smi_csv

_SAMPLE_ROW = (
    "0, GPU-1234abcd-0000-0000-0000-000000000000, NVIDIA GeForce RTX 4070, 550.54.15, "
    "62, 180.5, 285.0, 45, 20, 12288, 4096, 55, 2520, 10501, P2"
)


def test_parses_valid_csv_row() -> None:
    readings = parse_nvidia_smi_csv(_SAMPLE_ROW + "\n")
    assert len(readings) == 1
    r = readings[0]
    assert r.index == 0
    assert r.name == "NVIDIA GeForce RTX 4070"
    assert r.temperature_c == 62.0
    assert r.power_draw_watts == 180.5
    assert r.pstate == "P2"


def test_parses_multiple_rows() -> None:
    output = f"{_SAMPLE_ROW}\n{_SAMPLE_ROW}\n"
    readings = parse_nvidia_smi_csv(output)
    assert len(readings) == 2


def test_handles_na_fan_speed() -> None:
    row = _SAMPLE_ROW.replace(", 55,", ", [N/A],")
    readings = parse_nvidia_smi_csv(row + "\n")
    assert readings[0].fan_speed_percent is None


def test_ignores_malformed_row_with_wrong_column_count() -> None:
    readings = parse_nvidia_smi_csv("only,three,columns\n")
    assert readings == []


def test_ignores_blank_lines() -> None:
    readings = parse_nvidia_smi_csv(f"\n\n{_SAMPLE_ROW}\n\n")
    assert len(readings) == 1


def test_inspector_raises_on_missing_binary() -> None:
    inspector = NvidiaInspector()
    with patch("app.nvidia.subprocess.run", side_effect=FileNotFoundError()):
        with pytest.raises(NvidiaSmiError, match="not found"):
            inspector.read()


def test_inspector_raises_on_timeout() -> None:
    inspector = NvidiaInspector()
    timeout_exc = subprocess.TimeoutExpired(cmd="nvidia-smi", timeout=10)
    with patch("app.nvidia.subprocess.run", side_effect=timeout_exc):
        with pytest.raises(NvidiaSmiError, match="timed out"):
            inspector.read()


def test_inspector_raises_on_nonzero_exit() -> None:
    inspector = NvidiaInspector()
    fake = subprocess.CompletedProcess(
        args=["nvidia-smi"], returncode=1, stdout="", stderr="no devices found"
    )
    with patch("app.nvidia.subprocess.run", return_value=fake):
        with pytest.raises(NvidiaSmiError, match="exited 1"):
            inspector.read()


def test_inspector_raises_when_no_rows_parse() -> None:
    inspector = NvidiaInspector()
    fake = subprocess.CompletedProcess(args=["nvidia-smi"], returncode=0, stdout="", stderr="")
    with patch("app.nvidia.subprocess.run", return_value=fake):
        with pytest.raises(NvidiaSmiError, match="no parseable"):
            inspector.read()


def test_never_uses_shell() -> None:
    inspector = NvidiaInspector()
    fake = subprocess.CompletedProcess(args=["nvidia-smi"], returncode=0, stdout=_SAMPLE_ROW, stderr="")
    with patch("app.nvidia.subprocess.run", return_value=fake) as mock_run:
        inspector.read()
        _, kwargs = mock_run.call_args
        assert kwargs["shell"] is False
