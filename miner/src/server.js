import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";
import { MinerController } from "./miner-controller.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

export function startControlServer(port, defaults) {
  const controller = new MinerController();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    try {
      if (req.method === "GET" && url.pathname === "/api/defaults") {
        return sendJson(res, 200, { api: defaults.api, workers: cpus().length });
      }
      if (req.method === "GET" && url.pathname === "/api/status") {
        return sendJson(res, 200, controller.getStatus());
      }
      if (req.method === "POST" && url.pathname === "/api/start") {
        const body = await readBody(req);
        controller.start({ api: defaults.api, ...body });
        return sendJson(res, 200, controller.getStatus());
      }
      if (req.method === "POST" && url.pathname === "/api/stop") {
        controller.stop();
        return sendJson(res, 200, controller.getStatus());
      }

      // Static UI files.
      const relPath = url.pathname === "/" ? "/index.html" : url.pathname;
      const filePath = path.join(PUBLIC_DIR, relPath);
      if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        return res.end("forbidden");
      }
      const data = await readFile(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream" });
      res.end(data);
    } catch (err) {
      if (err.code === "ENOENT") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("not found");
      }
      sendJson(res, 400, { error: err.message });
    }
  });

  server.listen(port, () => {
    console.log(`Albus miner control UI: http://localhost:${port}`);
  });

  const shutdown = () => {
    controller.stop();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { server, controller };
}
