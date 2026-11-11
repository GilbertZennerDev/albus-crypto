import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KEEP_DAYS = 90;
const MAX_PER_DAY = 5000;

interface Day {
  nets: string[];
  peak: number;
}

export function truncateIp(ip: string): string {
  const v4 = ip.replace(/^::ffff:/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return v4.split(".").slice(0, 3).join(".") + ".0/24";
  const groups = ip.split(":").slice(0, 3).join(":");
  return `${groups}::/48`;
}

export class PeerStats {
  private days = new Map<string, Day>();
  private file: string | null;
  private dirty = false;

  constructor(dataDir: string | null, private now: () => number = Date.now) {
    this.file = dataDir ? join(dataDir, "peer-stats.json") : null;
    if (this.file && existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Day>;
        for (const [d, v] of Object.entries(raw)) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Array.isArray(v?.nets)) this.days.set(d, { nets: v.nets.slice(0, MAX_PER_DAY), peak: Number(v.peak) || 0 });
      } catch {
      }
    }
  }

  private today(): Day {
    const key = new Date(this.now()).toISOString().slice(0, 10);
    let day = this.days.get(key);
    if (!day) {
      day = { nets: [], peak: 0 };
      this.days.set(key, day);
      for (const old of [...this.days.keys()].sort().slice(0, -KEEP_DAYS)) this.days.delete(old);
    }
    return day;
  }

  seen(ip: string | undefined, concurrent: number): void {
    const day = this.today();
    if (concurrent > day.peak) {
      day.peak = concurrent;
      this.dirty = true;
    }
    if (!ip) return;
    const net = truncateIp(ip);
    if (day.nets.length < MAX_PER_DAY && !day.nets.includes(net)) {
      day.nets.push(net);
      this.dirty = true;
    }
  }

  summary(): { date: string; networks: number; peak: number }[] {
    return [...this.days.entries()].sort().map(([date, d]) => ({ date, networks: d.nets.length, peak: d.peak }));
  }

  save(): void {
    if (!this.file || !this.dirty) return;
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.days)));
    this.dirty = false;
  }
}
