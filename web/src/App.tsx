import { useEffect, useState, type FormEvent } from "react";
import { albusApi, type Block } from "./lib/api";

type SupplyInfo = Awaited<ReturnType<typeof albusApi.supply>>;
import { createSignedTransaction, formatUnits, parseCoins } from "./lib/wallet";
import { useWallet } from "./lib/useWallet";
import { useMiner } from "./lib/useMiner";

function short(value: string, n = 10): string {
  if (value.length <= n * 2) return value;
  return `${value.slice(0, n)}…${value.slice(-n)}`;
}

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

function Story() {
  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.03] p-6">
      <h2 className="text-3xl font-bold tracking-tight">Everyone starts at zero.</h2>
      <p className="mt-1 text-sm text-white/50">Albus is Latin for white: a clean sheet.</p>
      <p className="mt-4 text-white/70">
        Nobody got coins before launch, not even the person who built it. There is no pool and no boss. You earn ALB by
        solving the same puzzle as everyone else, and you can check every page of the ledger on your own.
      </p>
      <ul className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
        <li className="rounded-lg bg-white/[0.04] p-3">
          <strong className="block text-white">No head start</strong>
          <span className="text-white/60">Every coin comes from mining. Nothing was handed out in advance.</span>
        </li>
        <li className="rounded-lg bg-white/[0.04] p-3">
          <strong className="block text-white">Your own work</strong>
          <span className="text-white/60">You mine alone, on your own PC. No pool takes a cut.</span>
        </li>
        <li className="rounded-lg bg-white/[0.04] p-3">
          <strong className="block text-white">Check it yourself</strong>
          <span className="text-white/60">The code is open and tested. Don't trust us, run it.</span>
        </li>
      </ul>
      <p className="mt-4 text-xs text-white/40">
        Albus is an experiment to learn how money like this works. Please don't put real money into it.
      </p>
    </section>
  );
}

const INSTALL_CMD = "irm https://albus.workflowsolved.com/releases/install-albus.ps1 | iex";

function DownloadPanel() {
  const [version, setVersion] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    fetch("/releases/manifest.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((e) => setVersion(e ? JSON.parse(e.manifest).version : null))
      .catch(() => setVersion(null));
  }, []);
  const copy = () => {
    navigator.clipboard?.writeText(INSTALL_CMD).then(() => setCopied(true), () => undefined);
  };
  return (
    <section id="download" className="rounded-xl border border-violet-400/30 bg-violet-400/[0.05] p-6">
      <h2 className="text-2xl font-bold tracking-tight">Download the Albus miner</h2>
      <p className="mt-1 text-sm text-white/60">
        Windows{version ? ` · version ${version}` : ""}. It keeps itself up to date and has a small window on your own PC for your wallet and your friends list.
      </p>
      <a
        href="/releases/install-albus.ps1"
        download
        className="mt-4 inline-block rounded-lg bg-violet-500 px-5 py-2.5 font-semibold text-white hover:bg-violet-400"
      >
        Download installer (install-albus.ps1)
      </a>
      <p className="mt-4 text-sm text-white/60">Or paste this into PowerShell:</p>
      <div className="mt-1 flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-black/40 px-3 py-2 text-xs text-white/80">{INSTALL_CMD}</code>
        <button onClick={copy} className="rounded-lg bg-white/10 px-3 py-2 text-xs hover:bg-white/20">{copied ? "Copied" : "Copy"}</button>
      </div>
      <ul className="mt-4 list-disc space-y-1 pl-5 text-xs text-white/50">
        <li>You need Node.js and PowerShell 7. The installer offers to get them for you.</li>
        <li>Every update is signed by the Albus publisher and checked on your PC. Your wallet and keys never leave it.</li>
        <li>The program is not code-signed yet, so Windows may show a warning. Read the script first if you like, it is short.</li>
      </ul>
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
        <span>Difficulty: <strong className="text-white">{(supply.currentDifficulty / 16).toFixed(1)} bit</strong></span>
      </div>
    </Panel>
  );
}

function WalletPanel({
  wallet,
  balance,
  immature,
  onCreate,
  onImport,
  onClear,
}: {
  wallet: ReturnType<typeof useWallet>["wallet"];
  balance: number | null;
  immature: number;
  onCreate: () => void;
  onImport: (key: string) => void;
  onClear: () => void;
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
              type="password"
              autoComplete="off"
              data-rr-mask
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
          <span className="text-2xl font-semibold">{balance === null ? "…" : formatUnits(balance)} <span className="text-sm text-white/50">ALB</span></span>
        </div>
        {immature > 0 && <span className="text-xs text-white/40">+ {formatUnits(immature)} ALB maturing (spendable after 100 blocks)</span>}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button onClick={onClear} className="rounded-lg border border-white/15 px-3 py-2 text-sm hover:bg-white/5">
          Log out
        </button>
      </div>
    </Panel>
  );
}

function MiningPanel({ miner }: { miner: ReturnType<typeof useMiner> }) {
  const { running, hashrate, blocksFound, start, stop } = miner;
  return (
    <Panel title="Earn ALB by lending processing power">
      <p className="mb-4 text-sm text-white/60">
        Solo mining: your browser hashes the next block in a background worker. If it finds the
        block, the whole reward plus fees goes straight to your address. There is no pool and no
        faucet; the browser is slow, so blocks are rare. The native worker is much faster.
      </p>
      <div className="flex items-center justify-between gap-4">
        <div className="flex gap-6 text-sm">
          <span>Hashrate: <strong className="text-white">{hashrate.toFixed(0)}</strong> h/s</span>
          <span>Blocks found: <strong className="text-white">{blocksFound}</strong></span>
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
    const amt = parseCoins(amount);
    if (!/^albus1[0-9a-f]{40}$/.test(to.trim()) || amt === null) {
      setStatus("enter a valid address and amount (max 8 decimals)");
      return;
    }
    setSending(true);
    try {
      const [{ networkId }, acc] = await Promise.all([albusApi.info(), albusApi.account(wallet.address)]);
      const tx = createSignedTransaction(wallet, to.trim(), amt, acc.minFee, acc.nextNonce, networkId);
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
          placeholder="amount (fee is added automatically, 0.001 ALB)"
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
              <div>nonce: {block.nonce} · difficulty: {(block.difficulty / 16).toFixed(1)} bit</div>
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
  const [immature, setImmature] = useState(0);
  const [chain, setChain] = useState<Block[]>([]);
  const [health, setHealth] = useState<{ height: number } | null>(null);
  const [mempoolSize, setMempoolSize] = useState<number | null>(null);
  const [supply, setSupply] = useState<SupplyInfo | null>(null);
  const miner = useMiner(wallet?.address);

  async function refresh() {
    try {
      const [h, c, m, s] = await Promise.all([albusApi.health(), albusApi.chain(), albusApi.mempool(), albusApi.supply()]);
      setHealth(h);
      setChain(c.chain);
      setMempoolSize(m.length);
      setSupply(s);
      if (wallet) {
        const b = await albusApi.account(wallet.address);
        setBalance(b.spendable);
        setImmature(b.immature);
      }
    } catch {
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet?.address]);

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Albus <span className="text-violet-400">ALB</span></h1>
          <p className="text-sm text-white/50">a fixed-supply proof-of-work chain, running for real</p>
        </div>
        <StatusBar height={health?.height ?? null} mempoolSize={mempoolSize} />
      </header>

      <Story />

      <DownloadPanel />

      <SupplyPanel supply={supply} />

      <WalletPanel
        wallet={wallet}
        balance={balance}
        immature={immature}
        onCreate={createWallet}
        onImport={importWallet}
        onClear={clearWallet}
      />

      {wallet && <MiningPanel miner={miner} />}
      {wallet && <SendForm wallet={wallet} onSent={refresh} />}

      <Explorer chain={chain} />

      <footer className="pb-4 text-center text-xs text-white/30">
        Peer-to-peer proof-of-work chain, fair launch, solo mining, ECDSA-signed transactions, halving issuance capped at 21,000,000 ALB.
        <br />
        This page counts visits and records how pages are used (clicks and scrolling) to help me improve it.      </footer>
    </div>
  );
}
