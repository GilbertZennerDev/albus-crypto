import { useEffect, useRef, useState } from "react";
import { albusApi } from "./api";

const CHALLENGE_REFRESH_MS = 15_000;

export function useMiner(address: string | undefined) {
  const [running, setRunning] = useState(false);
  const [hashrate, setHashrate] = useState(0);
  const [blocksFound, setBlocksFound] = useState(0);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => () => stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  async function refreshChallenge() {
    if (!workerRef.current || !address) return;
    const challenge = await albusApi.miningChallenge(address);
    workerRef.current.postMessage({ type: "start", address, seed: challenge.seed, target: challenge.target });
  }

  async function start() {
    if (!address || workerRef.current) return;
    const worker = new Worker(new URL("./miner.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = async (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === "hashrate") setHashrate(msg.hashesPerSecond);
      if (msg.type === "share") {
        try {
          await albusApi.submitBlock(address, msg.nonce);
          setBlocksFound((n) => n + 1);
        } catch {
        }
        void refreshChallenge();
      }
    };
    workerRef.current = worker;
    setRunning(true);
    await refreshChallenge();
  }

  function stop() {
    workerRef.current?.postMessage({ type: "stop" });
    workerRef.current?.terminate();
    workerRef.current = null;
    setRunning(false);
    setHashrate(0);
  }

  useEffect(() => {
    if (!running) return;
    const id = setInterval(refreshChallenge, CHALLENGE_REFRESH_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, address]);

  return { running, hashrate, blocksFound, start, stop };
}
