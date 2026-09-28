"""nvidia-smi telemetry collection. Fixed argv list only — never shell=True, never interpolated."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass

from app.logging import get_logger
from app.models import GpuReading

logger = get_logger(__name__)

_FIELDS: tuple[str, ...] = (
    "index",
    "uuid",
    "name",
    "driver_version",
    "temperature.gpu",
    "power.draw",
    "power.limit",
    "utilization.gpu",
    "utilization.memory",
    "memory.total",
    "memory.used",
    "fan.speed",
    "clocks.current.graphics",
    "clocks.current.memory",
    "pstate",
)

# Fixed, hardcoded argument list. Nothing from any external input is ever concatenated into this.
_NVIDIA_SMI_ARGV: tuple[str, ...] = (
    "nvidia-smi",
    f"--query-gpu={','.join(_FIELDS)}",
    "--format=csv,noheader,nounits",
)


class NvidiaSmiError(Exception):
    pass


def _parse_float(value: str) -> float | None:
    value = value.strip()
    if value in ("", "[N/A]", "N/A"):
        return None
    try:
        return float(value)
    except ValueError:
        return None


def parse_nvidia_smi_csv(output: str) -> list[GpuReading]:
    readings: list[GpuReading] = []
    for line_num, raw_line in enumerate(output.strip().splitlines()):
        line = raw_line.strip()
        if not line:
            continue
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != len(_FIELDS):
            logger.warning(
                "unexpected nvidia-smi CSV column count",
                extra={"context": {"line_num": line_num, "column_count": len(parts)}},
            )
            continue
        row = dict(zip(_FIELDS, parts, strict=True))
        try:
            readings.append(
                GpuReading(
                    index=int(row["index"]),
                    uuid=row["uuid"],
                    name=row["name"],
                    driver_version=row["driver_version"],
                    temperature_c=_parse_float(row["temperature.gpu"]) or 0.0,
                    power_draw_watts=_parse_float(row["power.draw"]) or 0.0,
                    power_limit_watts=_parse_float(row["power.limit"]) or 0.0,
                    utilization_gpu_percent=_parse_float(row["utilization.gpu"]) or 0.0,
                    utilization_memory_percent=_parse_float(row["utilization.memory"]) or 0.0,
                    memory_total_mib=_parse_float(row["memory.total"]) or 0.0,
                    memory_used_mib=_parse_float(row["memory.used"]) or 0.0,
                    fan_speed_percent=_parse_float(row["fan.speed"]),
                    clocks_graphics_mhz=_parse_float(row["clocks.current.graphics"]) or 0.0,
                    clocks_memory_mhz=_parse_float(row["clocks.current.memory"]) or 0.0,
                    pstate=row["pstate"],
                )
            )
        except (KeyError, ValueError) as exc:
            logger.warning("failed to parse nvidia-smi row", extra={"context": {"error": str(exc)}})
    return readings


@dataclass
class NvidiaInspector:
    timeout_seconds: float = 10.0

    def read(self) -> list[GpuReading]:
        try:
            proc = subprocess.run(  # noqa: S603 — fixed argv, shell=False, no untrusted input
                list(_NVIDIA_SMI_ARGV),
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
                shell=False,
                check=False,
            )
        except FileNotFoundError as exc:
            raise NvidiaSmiError("nvidia-smi not found on PATH") from exc
        except subprocess.TimeoutExpired as exc:
            raise NvidiaSmiError("nvidia-smi timed out") from exc

        if proc.returncode != 0:
            raise NvidiaSmiError(f"nvidia-smi exited {proc.returncode}: {proc.stderr.strip()[:500]}")

        readings = parse_nvidia_smi_csv(proc.stdout)
        if not readings:
            raise NvidiaSmiError("nvidia-smi returned no parseable GPU rows")
        return readings
