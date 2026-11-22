import { useMemo, useRef, useState } from "react";
import { useAccount, useDisconnect, useReadContract, useReadContracts } from "wagmi";
import { formatEther, formatUnits, type Abi, type Address } from "viem";
import { createClient, fromBase, type QoreChainClient } from "@qorechain/sdk";
import { createEvmClient, erc20, type Erc20Metadata } from "@qorechain/evm";

import deployment from "../deployment/agent-vault.deployment.json";
import AgentVault from "../artifacts/contracts/AgentVault.sol/AgentVault.json";
import { useQoreX } from "./hooks/useQoreX";
import { PayeeManager } from "./components/PayeeManager";
import { RulesEditor } from "./components/RulesEditor";
import { PaymentFeed } from "./components/PaymentFeed";

// ---- Config ---------------------------------------------------------------

const VAULT_ADDRESS = (deployment.address || "") as Address;

const VAULT_ABI = (
  Array.isArray(deployment.abi) && deployment.abi.length > 0
    ? deployment.abi
    : AgentVault.abi
) as Abi;

const REST_URL = import.meta.env.VITE_QORE_REST_URL ?? "/lcd";
const EVM_RPC_URL =
  import.meta.env.VITE_QORE_EVM_RPC_URL ?? "http://localhost:8545";

const ZERO_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

interface NativeBalance {
  denom: string;
  amount: string;
}

type TokenMetaMap = Record<string, Erc20Metadata>;

function formatChainBalance(
  b: NativeBalance,
  erc20MetaMap: TokenMetaMap,
): {
  ticker: string;
  formatted: string;
} {
  if (b.denom === "uqor") {
    return {
      ticker: "QOR",
      formatted: `${fromBase(b.amount, { exponent: 6 })} QOR`,
    };
  }

  if (b.denom.startsWith("erc20:")) {
    const tokenAddr = b.denom.slice("erc20:".length);
    const meta = erc20MetaMap[tokenAddr.toLowerCase()];
    const ticker = meta?.symbol || shortAddr(tokenAddr);
    const decimals = meta?.decimals ?? 18;

    let amountStr = b.amount;
    try {
      amountStr = formatUnits(BigInt(b.amount), decimals);
    } catch {
      amountStr = b.amount;
    }

    return {
      ticker,
      formatted: `${amountStr} ${ticker}`,
    };
  }

  return {
    ticker: b.denom,
    formatted: `${b.amount} ${b.denom}`,
  };
}

// ---- App ------------------------------------------------------------------

export default function App() {
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const { connectQoreX } = useQoreX();

  const qoreClient: QoreChainClient = useMemo(
    () =>
      createClient({
        network: "testnet",
        endpoints: { rest: REST_URL, evmRpc: EVM_RPC_URL },
      }),
    [],
  );

  const { data: owner } = useReadContract({
    address: VAULT_ADDRESS,
    abi: VAULT_ABI,
    functionName: "owner",
    query: { enabled: Boolean(VAULT_ADDRESS) },
  });

  const isOwner =
    isConnected &&
    address &&
    owner &&
    address.toLowerCase() === (owner as string).toLowerCase();

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Header
        isConnected={isConnected}
        address={address}
        isOwner={Boolean(isOwner)}
        networkName={qoreClient.network.name}
        chainId={qoreClient.network.chainId}
        onConnect={() => {
          void connectQoreX();
        }}
        onDisconnect={() => disconnect()}
      />

      <main className="mx-20 space-y-6 px-4 py-8">
        {!VAULT_ADDRESS && <MissingVaultBanner />}

        {VAULT_ADDRESS && (
          <>
            <VaultOverview
              vaultAddress={VAULT_ADDRESS}
              isOwner={Boolean(isOwner)}
            />

            <div className="grid gap-6 md:grid-cols-2">
              <RulesEditor
                vaultAddress={VAULT_ADDRESS}
                canEdit={Boolean(isOwner)}
              />
              <PayeeManager
                vaultAddress={VAULT_ADDRESS}
                canEdit={Boolean(isOwner)}
              />
            </div>

            <PaymentFeed vaultAddress={VAULT_ADDRESS} />
          </>
        )}

        <ChainInspector
          client={qoreClient}
          restUrl={REST_URL}
          evmRpcUrl={EVM_RPC_URL}
        />
      </main>

      <Footer />
    </div>
  );
}

// ---- Header ---------------------------------------------------------------

function Header({
  isConnected,
  address,
  isOwner,
  networkName,
  chainId,
  onConnect,
  onDisconnect,
}: {
  isConnected: boolean;
  address?: Address;
  isOwner: boolean;
  networkName: string;
  chainId?: string;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  return (
    <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur">
      <div className="mx-20 flex items-center justify-between gap-4 px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-lg font-black text-slate-950">
            <img src="/logo.png" alt="Logo" />
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-tight">LeashGuard</h1>
            <p className="text-xs text-slate-400">
              Post-quantum leash for your AI treasury agent ·{" "}
              <span className="font-mono text-slate-300">
                {networkName} ({chainId ?? "n/a"})
              </span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {isConnected && isOwner && (
            <span className="rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-400 ring-1 ring-emerald-500/30">
              Owner
            </span>
          )}
          {isConnected && !isOwner && (
            <span className="rounded-full bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-400 ring-1 ring-amber-500/30">
              Viewer
            </span>
          )}

          {!isConnected ? (
            <button
              onClick={onConnect}
              className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-emerald-400"
            >
              Connect QoreX
            </button>
          ) : (
            <button
              onClick={onDisconnect}
              className="rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:border-slate-500"
              title={address}
            >
              {shortAddr(address)}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

// ---- Overview -------------------------------------------------------------

function VaultOverview({
  vaultAddress,
  isOwner,
}: {
  vaultAddress: Address;
  isOwner: boolean;
}) {
  const { data, isLoading } = useReadContracts({
    contracts: [
      { address: vaultAddress, abi: VAULT_ABI, functionName: "owner" },
      { address: vaultAddress, abi: VAULT_ABI, functionName: "agent" },
      { address: vaultAddress, abi: VAULT_ABI, functionName: "perTxLimit" },
      { address: vaultAddress, abi: VAULT_ABI, functionName: "dailyLimit" },
      { address: vaultAddress, abi: VAULT_ABI, functionName: "spentToday" },
      {
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: "ownerPqcKeyHash",
      },
    ],
    query: { refetchInterval: 8_000 },
  });

  const [, agent, perTxLimit, dailyLimit, spentToday, pqcHash] =
    data?.map((r) => r.result) ?? [];

  const pqcRegistered =
    typeof pqcHash === "string" && pqcHash !== ZERO_HASH;

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Vault</h2>
          <p className="font-mono text-xs text-slate-400">{vaultAddress}</p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <Pill ok={pqcRegistered} label="PQC key" />
          <Pill ok={isOwner} label="You are owner" />
        </div>
      </div>

      {isLoading ? (
        <Skeleton />
      ) : (
        <div className="mt-5 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <Stat label="Agent" value={shortAddr(agent as Address)} mono />
          <Stat
            label="Per‑tx limit"
            value={`${formatEther((perTxLimit as bigint) ?? 0n)} QOR`}
          />
          <Stat
            label="Daily limit"
            value={`${formatEther((dailyLimit as bigint) ?? 0n)} QOR`}
          />
          <Stat
            label="Spent today"
            value={`${formatEther((spentToday as bigint) ?? 0n)} QOR`}
          />
        </div>
      )}
    </section>
  );
}

// ---- Native Chain Inspector -----------------------------------------------

function ChainInspector({
  client,
  restUrl,
  evmRpcUrl,
}: {
  client: QoreChainClient;
  restUrl: string;
  evmRpcUrl: string;
}) {
  const [nativeAddress, setNativeAddress] = useState("");
  const [balances, setBalances] = useState<NativeBalance[] | null>(null);
  const [erc20MetaMap, setErc20MetaMap] = useState<TokenMetaMap>({});
  const [tokenomics, setTokenomics] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const publicClientRef = useRef<Awaited<ReturnType<typeof createEvmClient>>["publicClient"] | null>(
    null,
  );

  async function resolveErc20Metadata(items: NativeBalance[]): Promise<TokenMetaMap> {
    const erc20Addrs = items
      .filter((b) => b.denom.startsWith("erc20:"))
      .map((b) => b.denom.slice("erc20:".length).toLowerCase())
      .filter((addr, idx, arr) => arr.indexOf(addr) === idx);

    const missing = erc20Addrs.filter((addr) => !erc20MetaMap[addr]);
    if (missing.length === 0) {
      return erc20MetaMap;
    }

    if (!publicClientRef.current) {
      const evmClient = await createEvmClient({
        endpoints: { evmRpc: evmRpcUrl },
      });
      publicClientRef.current = evmClient.publicClient;
    }

    const entries = await Promise.all(
      missing.map(async (addr) => {
        try {
          const meta = await erc20.metadata(
            publicClientRef.current!,
            addr as Address,
          );
          return [addr, meta] as const;
        } catch {
          return null;
        }
      }),
    );

    const nextMap: TokenMetaMap = { ...erc20MetaMap };
    for (const pair of entries) {
      if (pair) {
        nextMap[pair[0]] = pair[1];
      }
    }

    setErc20MetaMap(nextMap);
    return nextMap;
  }

  async function loadBalance(): Promise<void> {
    setError(null);
    setBalances(null);
    if (!nativeAddress.trim()) {
      setError("Enter a qor1… address first.");
      return;
    }
    setLoading(true);
    try {
      const res = await client.rest.getAllBalances(nativeAddress.trim());
      const list = res.balances as NativeBalance[];
      await resolveErc20Metadata(list);
      setBalances(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function loadTokenomics(): Promise<void> {
    setError(null);
    setTokenomics(null);
    setLoading(true);
    try {
      const overview = await client.qor.getTokenomicsOverview();
      setTokenomics(JSON.stringify(overview, null, 2));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Native Chain Inspector</h2>
          <p className="text-xs text-slate-400">
            REST endpoint: <code className="font-mono text-slate-300">{restUrl}</code>
          </p>
        </div>
        <button
          onClick={loadTokenomics}
          disabled={loading}
          className="rounded-md border border-slate-700 bg-slate-950/70 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500 disabled:opacity-50"
        >
          Read Tokenomics Overview
        </button>
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <input
          value={nativeAddress}
          onChange={(e) => setNativeAddress(e.target.value)}
          placeholder="qor1…"
          aria-label="QoreChain native address"
          className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
        />
        <button
          onClick={loadBalance}
          disabled={loading}
          className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
        >
          {loading ? "Loading…" : "Get balance"}
        </button>
      </div>

      {balances && (
        <ul className="mt-4 space-y-1.5 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-sm">
          {balances.length === 0 && (
            <li className="text-slate-400">(no balances)</li>
          )}
          {balances.map((b) => {
            const info = formatChainBalance(b, erc20MetaMap);
            return (
              <li
                key={b.denom}
                className="flex flex-wrap items-center justify-between gap-2 font-mono text-xs"
              >
                <span className="text-slate-400" title={b.denom}>
                  {info.ticker}
                </span>
                <span className="text-emerald-400">{info.formatted}</span>
              </li>
            );
          })}
        </ul>
      )}

      {tokenomics && (
        <pre className="mt-4 overflow-x-auto rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-xs text-slate-200">
          {tokenomics}
        </pre>
      )}

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"
        >
          {error}
        </p>
      )}
    </section>
  );
}

// ---- Utilities ------------------------------------------------------------

function MissingVaultBanner() {
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
      <strong>No vault configured.</strong> Deploy <code>AgentVault</code> and reload.
    </div>
  );
}

function Pill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={
        "rounded-full px-2.5 py-1 font-medium ring-1 " +
        (ok
          ? "bg-emerald-500/10 text-emerald-400 ring-emerald-500/30"
          : "bg-slate-700/40 text-slate-400 ring-slate-600/40")
      }
    >
      {ok ? "● " : "○ "}
      {label}
    </span>
  );
}

function Stat({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">
        {label}
      </div>
      <div
        className={"mt-1 text-slate-100 " + (mono ? "font-mono text-xs" : "")}
      >
        {value}
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="mt-5 grid animate-pulse grid-cols-2 gap-4 sm:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-14 rounded-lg bg-slate-800/60" />
      ))}
    </div>
  );
}

function Footer() {
  return (
    <footer className="border-t border-slate-800 py-6 text-center text-xs text-slate-500">
      Built for{" "}
      <span className="text-slate-300">Build Before Q-Day</span> · QoreChain Diana
      testnet
    </footer>
  );
}

function shortAddr(a?: Address | string) {
  if (!a) return "";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}