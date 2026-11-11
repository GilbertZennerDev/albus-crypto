import type { NextFunction, Request, Response } from "express";
import type { IncomingMessage } from "node:http";

export function rateLimit(readPerMin: number, writePerMin: number) {
  const windows = new Map<string, { start: number; read: number; write: number }>();
  setInterval(() => {
    const old = Date.now() - 120_000;
    for (const [ip, w] of windows) if (w.start < old) windows.delete(ip);
  }, 60_000).unref();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    let w = windows.get(req.ip ?? "?");
    if (!w || now - w.start >= 60_000) {
      w = { start: now, read: 0, write: 0 };
      windows.set(req.ip ?? "?", w);
    }
    const write = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
    if (write ? ++w.write > writePerMin : ++w.read > readPerMin) {
      res.setHeader("Retry-After", "60");
      return res.status(429).json({ error: "too many requests, please wait" });
    }
    next();
  };
}

export function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0].trim();
  return first || req.socket.remoteAddress || "?";
}

export class ConnLimiter {
  private counts = new Map<string, number>();
  constructor(private max: number) {}
  acquire(ip: string): boolean {
    const n = this.counts.get(ip) ?? 0;
    if (n >= this.max) return false;
    this.counts.set(ip, n + 1);
    return true;
  }
  release(ip: string): void {
    const n = (this.counts.get(ip) ?? 1) - 1;
    if (n <= 0) this.counts.delete(ip);
    else this.counts.set(ip, n);
  }
}

export function isPublicWsUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (host.includes(":")) return !(host === "::1" || host === "::" || /^(fc|fd|fe[89ab])/.test(host) || host.startsWith("::ffff:"));
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return true;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}
