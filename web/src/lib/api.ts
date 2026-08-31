const API_BASE = import.meta.env.VITE_ALBUS_API_URL ?? "http://localhost:4000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `request failed: ${res.status}`);
  return body as T;
}

export interface Block {
  index: number;
  timestamp: number;
  transactions: unknown[];
  previousHash: string;
  nonce: number;
  difficulty: number;
  hash: string;
}

export const albusApi = {
  health: () => request<{ ok: boolean; name: string; symbol: string; height: number }>("/health"),
  balance: (address: string) => request<{ address: string; balance: number }>(`/balance/${address}`),
  chain: () => request<{ length: number; chain: Block[] }>("/chain"),
  mempool: () => request<{ length: number; transactions: unknown[] }>("/mempool"),
  faucet: (to: string, amount: number) =>
    request<{ ok: true; amount: number }>("/faucet", { method: "POST", body: JSON.stringify({ to, amount }) }),
  submitTransaction: (tx: unknown) =>
    request<{ ok: true }>("/transactions", { method: "POST", body: JSON.stringify(tx) }),
  miningChallenge: () => request<{ seed: string; difficulty: number }>("/mining/challenge"),
  submitShare: (address: string, nonce: string) =>
    request<{ ok: true; totalShares: number }>("/mining/submit", {
      method: "POST",
      body: JSON.stringify({ address, nonce }),
    }),
  supply: () =>
    request<{ circulatingSupply: number; maxSupply: number; currentBlockReward: number; blocksUntilNextHalving: number }>(
      "/supply",
    ),
};
