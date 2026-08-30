import { useEffect, useRef, useState } from "react";
import { albusApi } from "./api";

const CHALLENGE_REFRESH_MS = 15_000;

export function useMiner(address: string | undefined) {
  const [running, setRunning] = useState(false);
  const [hashrate, setHashrate] = useState(0);
  const [sharesThisEpoch, setSharesThisEpoch] = useState(0);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => () => stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  async function refreshChallenge() {
    if (!workerRef.current || !address) return;
    const challenge = await albusApi.miningChallenge();
    setSharesThisEpoch(0);
    workerRef.current.postMessage({ type: "start", address, seed: challenge.seed, difficulty: challenge.difficulty });
  }

  async function start() {
    if (!address || workerRef.current) return;
    const worker = new Worker(new URL("./miner.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = async (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === "hashrate") setHashrate(msg.hashesPerSecond);
      if (msg.type === "share") {
        try {
          const res = await albusApi.submitShare(address, msg.nonce);
          setSharesThisEpoch(res.totalShares);
        } catch {
          // stale seed (epoch just rotated) or a duplicate — pick up the new challenge
          void refreshChallenge();
        }
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

  return { running, hashrate, sharesThisEpoch, start, stop };
}
