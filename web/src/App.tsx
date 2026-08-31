import { useEffect, useState, type FormEvent } from "react";
import { albusApi, type Block } from "./lib/api";

type SupplyInfo = Awaited<ReturnType<typeof albusApi.supply>>;
import { createSignedTransaction } from "./lib/wallet";
import { useWallet } from "./lib/useWallet";
import { useMiner } from "./lib/useMiner";

function short(value: string, n = 10): string {
  if (value.length <= n * 2) return value;
  return `${value.slice(0, n)}…${value.slice(-n)}`;
}

/** Formats ALB amounts up to 8 decimal places (Bitcoin-style), trimming trailing zeros. */
function formatAlb(amount: number): string {
  return amount.toFixed(8).replace(/\.?0+$/, "") || "0";
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-white/50">{title}</h2>
      {children}
    </section>
  );
}

function StatusBar({ height, mempoolSize }: { height: number | null; mempoolSize: number | null }) {
  return (
    <div className="flex flex-wrap gap-4 text-sm text-white/60">
      <span>Height: <strong className="text-white">{height ?? "—"}</strong></span>
      <span>Mempool: <strong className="text-white">{mempoolSize ?? "—"}</strong></span>
    </div>
  );
}

function SupplyPanel({ supply }: { supply: SupplyInfo | null }) {
  if (!supply) return null;
  const pctMined = Math.min(100, (supply.circulatingSupply / supply.maxSupply) * 100);
  return (
    <Panel title="Supply">
      <div className="mb-2 flex items-baseline justify-between text-sm">
        <span>
          <strong className="text-lg text-white">{formatAlb(supply.circulatingSupply)}</strong>
          <span className="text-white/50"> / {supply.maxSupply.toLocaleString()} ALB mined</span>
        </span>
        <span className="text-white/50">{pctMined.toFixed(4)}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-violet-500" style={{ width: `${pctMined}%` }} />
      </div>
      <div className="mt-3 flex gap-6 text-sm text-white/60">
        <span>Block reward: <strong className="text-white">{formatAlb(supply.currentBlockReward)}</strong> ALB</span>
        <span>Next halving in <strong className="text-white">{supply.blocksUntilNextHalving.toLocaleString()}</strong> blocks</span>
      </div>
    </Panel>
  );
}

function WalletPanel({
  wallet,
  balance,
  onCreate,
  onImport,
  onClear,
  onFaucet,
  busy,
}: {
  wallet: ReturnType<typeof useWallet>["wallet"];
  balance: number | null;
  onCreate: () => void;
  onImport: (key: string) => void;
  onClear: () => void;
  onFaucet: () => void;
  busy: boolean;
}) {
  const [importKey, setImportKey] = useState("");
  const [copied, setCopied] = useState(false);

  if (!wallet) {
    return (
      <Panel title="Wallet">
        <div className="flex flex-col gap-3">
          <button
            onClick={onCreate}
            className="rounded-lg bg-violet-500 px-4 py-2 font-medium text-white hover:bg-violet-400"
          >
            Create new wallet
          </button>
          <div className="flex gap-2">
            <input
              value={importKey}
              onChange={(e) => setImportKey(e.target.value)}
              placeholder="paste private key to import"
              className="flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm"
            />
            <button
              onClick={() => importKey && onImport(importKey)}
              className="rounded-lg border border-white/20 px-3 py-2 text-sm hover:bg-white/5"
            >
              Import
            </button>
          </div>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Wallet">
      <div className="flex flex-col gap-2 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="text-white/50">Address</span>
          <button
            className="mono truncate rounded bg-black/30 px-2 py-1 text-right hover:bg-black/50"
            onClick={() => {
              navigator.clipboard.writeText(wallet.address);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
            title="click to copy"
          >
            {copied ? "copied!" : short(wallet.address, 14)}
          </button>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-white/50">Balance</span>
          <span className="text-2xl font-semibold">{balance === null ? "…" : formatAlb(balance)} <span className="text-sm text-white/50">ALB</span></span>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          disabled={busy}
          onClick={onFaucet}
          className="rounded-lg bg-emerald-500/90 px-3 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-50"
        >
          Faucet +100
        </button>
        <button onClick={onClear} className="rounded-lg border border-white/15 px-3 py-2 text-sm hover:bg-white/5">
          Log out
        </button>
      </div>
    </Panel>
  );
}

function MiningPanel({ miner }: { miner: ReturnType<typeof useMiner> }) {
  const { running, hashrate, sharesThisEpoch, start, stop } = miner;
  return (
    <Panel title="Earn ALB by lending processing power">
      <p className="mb-4 text-sm text-white/60">
        While this runs, your browser hashes proof-of-work challenges in a background worker. Verified
        shares are tallied every epoch and the block reward is split across everyone who contributed,
        proportional to shares — paid as a real signed transaction to your address.
      </p>
      <div className="flex items-center justify-between gap-4">
        <div className="flex gap-6 text-sm">
          <span>Hashrate: <strong className="text-white">{hashrate.toFixed(0)}</strong> h/s</span>
          <span>Shares this epoch: <strong className="text-white">{sharesThisEpoch}</strong></span>
        </div>
        <button
          onClick={running ? stop : start}
          className={`rounded-lg px-4 py-2 text-sm font-medium ${
            running ? "border border-white/20 hover:bg-white/5" : "bg-violet-500 text-white hover:bg-violet-400"
          }`}
        >
          {running ? "Stop mining" : "Start mining"}
        </button>
      </div>
    </Panel>
  );
}

function SendForm({
  wallet,
  onSent,
}: {
  wallet: NonNullable<ReturnType<typeof useWallet>["wallet"]>;
  onSent: () => void;
}) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus(null);
    const amt = Number(amount);
    if (!to.startsWith("albus1") || !Number.isFinite(amt) || amt <= 0) {
      setStatus("enter a valid address and amount");
      return;
    }
    setSending(true);
    try {
      const tx = createSignedTransaction(wallet, to.trim(), amt);
      await albusApi.submitTransaction(tx);
      setStatus("sent — awaiting confirmation");
      setTo("");
      setAmount("");
      onSent();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "failed to send");
    } finally {
      setSending(false);
    }
  }

  return (
    <Panel title="Send ALB">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="recipient address (albus1...)"
          className="mono rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm"
        />
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="amount"
          inputMode="decimal"
          className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm"
        />
        <button
          disabled={sending}
          className="rounded-lg bg-violet-500 px-4 py-2 font-medium text-white hover:bg-violet-400 disabled:opacity-50"
        >
          {sending ? "Signing & sending…" : "Send"}
        </button>
        {status && <p className="text-sm text-white/60">{status}</p>}
      </form>
    </Panel>
  );
}

function Explorer({ chain }: { chain: Block[] }) {
  const recent = [...chain].reverse().slice(0, 12);
  return (
    <Panel title="Explorer">
      <div className="flex flex-col gap-2">
        {recent.map((block) => (
          <details key={block.hash} className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
            <summary className="mono flex cursor-pointer items-center justify-between text-sm">
              <span>#{block.index} · {block.transactions.length} tx</span>
              <span className="text-white/40">{short(block.hash, 8)}</span>
            </summary>
            <div className="mono mt-2 space-y-1 text-xs text-white/60">
              <div>hash: {block.hash}</div>
              <div>prev: {short(block.previousHash, 12)}</div>
              <div>nonce: {block.nonce} · difficulty: {block.difficulty}</div>
              <div>{new Date(block.timestamp).toLocaleString()}</div>
            </div>
          </details>
        ))}
        {recent.length === 0 && <p className="text-sm text-white/50">No blocks yet.</p>}
      </div>
    </Panel>
  );
}

export default function App() {
  const { wallet, createWallet, importWallet, clearWallet } = useWallet();
  const [balance, setBalance] = useState<number | null>(null);
  const [chain, setChain] = useState<Block[]>([]);
  const [health, setHealth] = useState<{ height: number } | null>(null);
  const [mempoolSize, setMempoolSize] = useState<number | null>(null);
  const [supply, setSupply] = useState<SupplyInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const miner = useMiner(wallet?.address);

  async function refresh() {
    try {
      const [h, c, m, s] = await Promise.all([albusApi.health(), albusApi.chain(), albusApi.mempool(), albusApi.supply()]);
      setHealth(h);
      setChain(c.chain);
      setMempoolSize(m.length);
      setSupply(s);
      if (wallet) {
        const b = await albusApi.balance(wallet.address);
        setBalance(b.balance);
      }
    } catch {
      // API unreachable — surfaced via stale/empty state, retried on next tick
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet?.address]);

  async function handleFaucet() {
    if (!wallet) return;
    setBusy(true);
    try {
      await albusApi.faucet(wallet.address, 100);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Albus <span className="text-violet-400">ALB</span></h1>
          <p className="text-sm text-white/50">a fixed-supply proof-of-work chain, running for real</p>
        </div>
        <StatusBar height={health?.height ?? null} mempoolSize={mempoolSize} />
      </header>

      <SupplyPanel supply={supply} />

      <WalletPanel
        wallet={wallet}
        balance={balance}
        onCreate={createWallet}
        onImport={importWallet}
        onClear={clearWallet}
        onFaucet={handleFaucet}
        busy={busy}
      />

      {wallet && <MiningPanel miner={miner} />}
      {wallet && <SendForm wallet={wallet} onSent={refresh} />}

      <Explorer chain={chain} />

      <footer className="pb-4 text-center text-xs text-white/30">
        Single-node demo chain — proof-of-work, ECDSA-signed transactions, halving issuance capped at 21,000,000 ALB.
      </footer>
    </div>
  );
}
