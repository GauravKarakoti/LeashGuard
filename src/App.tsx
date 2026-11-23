import { useEffect, useMemo, useState } from "react";
import {
  useAccount,
  useDisconnect,
  useReadContract,
  useReadContracts,
  useSendTransaction,
  useWalletClient,
} from "wagmi";
import {
  formatEther,
  formatUnits,
  isAddress,
  parseEther,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { english, generateMnemonic, mnemonicToAccount } from "viem/accounts";
import {
  createClient,
  evmToQor,
  fromBase,
  type QoreChainClient,
} from "@qorechain/sdk";
import {
  createEvmClient,
  deployContract,
  erc20,
  type Erc20Metadata,
} from "@qorechain/evm";

import AgentVault from "../artifacts/contracts/AgentVault.sol/AgentVault.json";
import { useQoreX } from "./hooks/useQoreX";
import { PayeeManager } from "./components/PayeeManager";
import { RulesEditor } from "./components/RulesEditor";
import { PaymentFeed } from "./components/PaymentFeed";

const VAULT_ABI = AgentVault.abi as Abi;
const VAULT_BYTECODE = AgentVault.bytecode as Hex;

const REST_URL = import.meta.env.VITE_QORE_REST_URL ?? "/lcd";
const EVM_RPC_URL =
  import.meta.env.VITE_QORE_EVM_RPC_URL ?? "http://localhost:8545";
const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

interface NativeBalance {
  denom: string;
  amount: string;
}

type TokenMetaMap = Record<string, Erc20Metadata>;

interface FundingSummary {
  vaultAddress: string;
  userAddress: string;
  fundedBalanceWei: string;
  spentBalanceWei: string;
  remainingBalanceWei: string;
}

interface GeneratedBotCredentials {
  botAddress: Address;
  botQorAddress: string;
  botMnemonic: string;
}

function vaultStorageKey(ownerAddr: string): string {
  return `leashguard:vault:${ownerAddr.toLowerCase()}`;
}

function safeEvmToQor(evmAddr?: string): string {
  if (!evmAddr || !isAddress(evmAddr)) return "";
  try {
    return evmToQor(evmAddr);
  } catch {
    return "";
  }
}

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

export default function App() {
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const { connectQoreX } = useQoreX();

  const [myVaultAddress, setMyVaultAddress] = useState<Address | null>(null);

  useEffect(() => {
    if (!isConnected || !address) {
      setMyVaultAddress(null);
      return;
    }

    const normOwner = address.toLowerCase();
    const cached = window.localStorage.getItem(vaultStorageKey(normOwner));
    if (cached && isAddress(cached)) {
      setMyVaultAddress(cached as Address);
    } else {
      setMyVaultAddress(null);
    }

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `${API_BASE_URL}/api/agents?ownerAddress=${encodeURIComponent(normOwner)}`,
        );
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          agents?: Array<{ vaultAddress: string; ownerAddress: string }>;
        };
        const owned = data.agents?.find(
          (a) =>
            a.ownerAddress.toLowerCase() === normOwner &&
            isAddress(a.vaultAddress),
        );
        if (!cancelled && owned) {
          const addr = owned.vaultAddress as Address;
          window.localStorage.setItem(vaultStorageKey(normOwner), addr);
          setMyVaultAddress(addr);
        }
      } catch {
        // Keep local cache if backend is unreachable
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [address, isConnected]);

  const qoreClient: QoreChainClient = useMemo(
    () =>
      createClient({
        network: "testnet",
        endpoints: { rest: REST_URL, evmRpc: EVM_RPC_URL },
      }),
    [],
  );

  const { data: owner } = useReadContract({
    address: myVaultAddress ?? undefined,
    abi: VAULT_ABI,
    functionName: "owner",
    query: { enabled: Boolean(myVaultAddress) },
  });

  const isOwner = Boolean(
    isConnected &&
      address &&
      myVaultAddress &&
      owner &&
      address.toLowerCase() === (owner as string).toLowerCase(),
  );

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100">
      <Header
        isConnected={isConnected}
        address={address}
        isOwner={isOwner}
        networkName={qoreClient.network.name}
        chainId={qoreClient.network.chainId}
        onConnect={() => {
          void connectQoreX();
        }}
        onDisconnect={() => disconnect()}
      />

      <main className="mx-20 flex-1 space-y-6 px-4 py-8">
        <PersonalAgentDeployer
          isConnected={isConnected}
          connectedAddress={address}
          myVaultAddress={myVaultAddress}
          onVaultDeployed={(addr) => {
            if (address) {
              window.localStorage.setItem(vaultStorageKey(address), addr);
            }
            setMyVaultAddress(addr);
          }}
          apiBaseUrl={API_BASE_URL}
          evmRpcUrl={EVM_RPC_URL}
        />

        {isConnected && address && myVaultAddress && isOwner && (
          <>
            <VaultOverview vaultAddress={myVaultAddress} isOwner={isOwner} />

            <div className="grid gap-6 md:grid-cols-2">
              <RulesEditor vaultAddress={myVaultAddress} canEdit={isOwner} />
              <PayeeManager vaultAddress={myVaultAddress} canEdit={isOwner} />
            </div>

            <FundingAndInvoicesPanel
              vaultAddress={myVaultAddress}
              connectedAddress={address}
              apiBaseUrl={API_BASE_URL}
              evmRpcUrl={EVM_RPC_URL}
            />

            <PaymentFeed vaultAddress={myVaultAddress} />
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

function PersonalAgentDeployer({
  isConnected,
  connectedAddress,
  myVaultAddress,
  onVaultDeployed,
  apiBaseUrl,
  evmRpcUrl,
}: {
  isConnected: boolean;
  connectedAddress?: Address;
  myVaultAddress: Address | null;
  onVaultDeployed: (addr: Address) => void;
  apiBaseUrl: string;
  evmRpcUrl: string;
}) {
  const { data: walletClient } = useWalletClient();
  const [perTxQor, setPerTxQor] = useState("0.5");
  const [dailyQor, setDailyQor] = useState("5");
  const [generatedBot, setGeneratedBot] =
    useState<GeneratedBotCredentials | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function handleDeployPersonalVault(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setErr(null);

    if (!isConnected || !connectedAddress || !walletClient) {
      setErr("Connect QoreX first to deploy your private AgentVault.");
      return;
    }

    let txLimitWei: bigint;
    let dayLimitWei: bigint;
    try {
      txLimitWei = parseEther(perTxQor.trim() || "0.5");
      dayLimitWei = parseEther(dailyQor.trim() || "5");
      if (txLimitWei <= 0n || dayLimitWei < txLimitWei) {
        setErr(
          "Limits must be positive and daily limit must be >= per-tx limit.",
        );
        return;
      }
    } catch {
      setErr("Enter valid numeric QOR limits.");
      return;
    }

    setBusy(true);
    try {
      const randomMnemonic = generateMnemonic(english, 128);
      const randomBotAccount = mnemonicToAccount(randomMnemonic, {
        addressIndex: 0,
      });
      const botAddr = randomBotAccount.address.toLowerCase() as Address;
      const botQorAddr = safeEvmToQor(botAddr);

      const txHash = await deployContract(walletClient, {
        abi: VAULT_ABI,
        bytecode: VAULT_BYTECODE,
        args: [connectedAddress, botAddr, txLimitWei, dayLimitWei],
      });

      const evmClient = await createEvmClient({
        endpoints: { evmRpc: evmRpcUrl },
      });
      const receipt = await evmClient.publicClient.waitForTransactionReceipt({
        hash: txHash,
      });

      if (!receipt.contractAddress) {
        throw new Error("Deployment receipt missing contractAddress");
      }

      const deployedAddr = receipt.contractAddress.toLowerCase() as Address;

      const regRes = await fetch(`${apiBaseUrl}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vaultAddress: deployedAddr,
          ownerAddress: connectedAddress.toLowerCase(),
          botAddress: botAddr,
          botMnemonic: randomMnemonic,
        }),
      });

      if (!regRes.ok) {
        const regData = await regRes.json().catch(() => ({}));
        throw new Error(regData.error ?? "Failed to register vault in DB");
      }

      setGeneratedBot({
        botAddress: botAddr,
        botQorAddress: botQorAddr,
        botMnemonic: randomMnemonic,
      });
      onVaultDeployed(deployedAddr);
      setMsg(`Your private vault is live at ${deployedAddr}`);
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
      <h2 className="text-base font-semibold">Your Private Agent Vault</h2>
      <p className="text-xs text-slate-400">
        Deploy your isolated <code>AgentVault</code> and generate your own bot
        wallet (`qor1...` and `0x...`).
      </p>

      {!isConnected || !connectedAddress ? (
        <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-xs text-slate-400">
          Connect your QoreX wallet to deploy or access your personal vault.
        </div>
      ) : (
        <>
          {myVaultAddress ? (
            <div className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300">
              Your Vault: <span className="font-mono">{myVaultAddress}</span>
            </div>
          ) : (
            <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
              No personal vault found for{" "}
              <span className="font-mono">{shortAddr(connectedAddress)}</span>.
              Deploy your own vault below to unlock treasury controls.
            </div>
          )}

          {generatedBot && (
            <div className="mt-4 space-y-2 rounded-lg border border-emerald-500/40 bg-slate-950 p-4 text-xs">
              <div className="font-semibold text-emerald-400">
                Generated Bot Credentials (Save these securely)
              </div>
              <div>
                <span className="text-slate-400">Bot Native (qor1) Address: </span>
                <code className="font-mono text-emerald-300">
                  {generatedBot.botQorAddress || "—"}
                </code>
              </div>
              <div>
                <span className="text-slate-400">Bot EVM (0x) Address: </span>
                <code className="font-mono text-slate-100">
                  {generatedBot.botAddress}
                </code>
              </div>
              <div>
                <span className="text-slate-400">Bot Mnemonic: </span>
                <code className="break-all font-mono text-amber-200">
                  {generatedBot.botMnemonic}
                </code>
              </div>
            </div>
          )}

          <form
            onSubmit={handleDeployPersonalVault}
            className="mt-4 grid gap-3 sm:grid-cols-3"
          >
            <label className="block text-xs">
              <span className="text-slate-400">Owner Address (Connected)</span>
              <input
                value={connectedAddress}
                readOnly
                disabled
                className="mt-1 w-full cursor-not-allowed rounded-md border border-slate-800 bg-slate-950/70 px-3 py-2 font-mono text-xs text-slate-400"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-400">Per-tx Limit (QOR)</span>
              <input
                value={perTxQor}
                onChange={(e) => setPerTxQor(e.target.value)}
                inputMode="decimal"
                disabled={busy}
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-400">Daily Limit (QOR)</span>
              <input
                value={dailyQor}
                onChange={(e) => setDailyQor(e.target.value)}
                inputMode="decimal"
                disabled={busy}
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
              />
            </label>
            <div className="sm:col-span-3">
              <button
                type="submit"
                disabled={busy}
                className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-40"
              >
                {busy
                  ? "Deploying & Generating Bot…"
                  : myVaultAddress
                    ? "Deploy Another Personal Vault"
                    : "Deploy My Agent Vault"}
              </button>
            </div>
          </form>
        </>
      )}

      {msg && <p className="mt-3 text-xs text-emerald-400">{msg}</p>}
      {err && (
        <p role="alert" className="mt-3 text-xs text-rose-400">
          {err}
        </p>
      )}
    </section>
  );
}

function FundingAndInvoicesPanel({
  vaultAddress,
  connectedAddress,
  apiBaseUrl,
  evmRpcUrl,
}: {
  vaultAddress: Address;
  connectedAddress: Address;
  apiBaseUrl: string;
  evmRpcUrl: string;
}) {
  const { sendTransactionAsync } = useSendTransaction();

  const [directDepositQor, setDirectDepositQor] = useState("1");
  const [summary, setSummary] = useState<FundingSummary | null>(null);

  const [invoiceId, setInvoiceId] = useState("");
  const [payee, setPayee] = useState("");
  const [amountQor, setAmountQor] = useState("");

  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const normVault = vaultAddress.toLowerCase() as Address;
  const normUser = connectedAddress.toLowerCase();

  async function creditTxHashToBackend(txHash: string): Promise<void> {
    const res = await fetch(`${apiBaseUrl}/api/funding`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vaultAddress: normVault,
        userAddress: normUser,
        txHash: txHash.trim(),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error ?? "Failed to credit funding");
    }
    setSummary(data.funding as FundingSummary);
    setStatusMsg(
      `Credited ${formatEther(BigInt(data.creditedWei))} QOR to your bot balance.`,
    );
  }

  async function refreshFunding(): Promise<void> {
    setErrorMsg(null);
    setBusy(true);
    try {
      const res = await fetch(
        `${apiBaseUrl}/api/funding/${normVault}/${normUser}`,
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to load funding balance");
      }
      setSummary(data as FundingSummary);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDirectDeposit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setErrorMsg(null);
    setStatusMsg(null);

    let valueWei: bigint;
    try {
      valueWei = parseEther(directDepositQor.trim());
      if (valueWei <= 0n) {
        setErrorMsg("Deposit amount must be greater than 0.");
        return;
      }
    } catch {
      setErrorMsg("Enter a valid QOR deposit amount.");
      return;
    }

    setBusy(true);
    try {
      const sentHash = await sendTransactionAsync({
        to: normVault,
        value: valueWei,
      });

      const evmClient = await createEvmClient({
        endpoints: { evmRpc: evmRpcUrl },
      });
      await evmClient.publicClient.waitForTransactionReceipt({
        hash: sentHash,
      });

      await creditTxHashToBackend(sentHash);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateInvoice(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setErrorMsg(null);
    setStatusMsg(null);

    if (!invoiceId.trim()) {
      setErrorMsg("Enter an invoice ID.");
      return;
    }
    if (!isAddress(payee.trim())) {
      setErrorMsg("Enter a valid payee EVM address.");
      return;
    }

    let amountWeiStr: string;
    try {
      const wei = parseEther(amountQor.trim());
      if (wei <= 0n) {
        setErrorMsg("Invoice amount must be greater than 0.");
        return;
      }
      amountWeiStr = wei.toString();
    } catch {
      setErrorMsg("Invalid QOR amount.");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(`${apiBaseUrl}/api/invoices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoiceId: invoiceId.trim(),
          vaultAddress: normVault,
          userAddress: normUser,
          payee: payee.trim(),
          amountWei: amountWeiStr,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to create invoice");
      }
      setInvoiceId("");
      setPayee("");
      setAmountQor("");
      setStatusMsg(`Queued invoice ${data.invoice.invoiceId} for your bot.`);
      await refreshFunding();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Bot Funding & Invoices</h2>
          <p className="text-xs text-slate-400">
            Deposit QOR directly into vault{" "}
            <code className="font-mono text-slate-300">
              {shortAddr(vaultAddress)}
            </code>{" "}
            or credit an existing tx hash.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void refreshFunding();
          }}
          disabled={busy}
          className="rounded-md border border-slate-700 bg-slate-950/70 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500 disabled:opacity-50"
        >
          Refresh Balance
        </button>
      </div>

      {summary && (
        <div className="mt-4 grid grid-cols-3 gap-3 text-xs">
          <Stat
            label="Funded"
            value={`${formatEther(BigInt(summary.fundedBalanceWei))} QOR`}
          />
          <Stat
            label="Spent"
            value={`${formatEther(BigInt(summary.spentBalanceWei))} QOR`}
          />
          <Stat
            label="Remaining"
            value={`${formatEther(BigInt(summary.remainingBalanceWei))} QOR`}
          />
        </div>
      )}

      <div className="mt-5 grid gap-6 md:grid-cols-2">
        <div className="space-y-5">
          <form onSubmit={handleDirectDeposit} className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Direct QOR Deposit
            </h3>
            <div className="flex gap-2">
              <input
                value={directDepositQor}
                onChange={(e) => setDirectDepositQor(e.target.value)}
                inputMode="decimal"
                placeholder="Amount in QOR (e.g. 1.0)"
                disabled={busy}
                className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={busy}
                className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-40"
              >
                {busy ? "Sending…" : "Deposit QOR"}
              </button>
            </div>
          </form>
        </div>

        <form onSubmit={handleCreateInvoice} className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Submit Invoice
          </h3>
          <input
            value={invoiceId}
            onChange={(e) => setInvoiceId(e.target.value)}
            placeholder="INV-2026-001"
            disabled={busy}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-500 disabled:opacity-50"
          />
          <input
            value={payee}
            onChange={(e) => setPayee(e.target.value)}
            placeholder="0x… payee address"
            disabled={busy}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-500 disabled:opacity-50"
          />
          <input
            value={amountQor}
            onChange={(e) => setAmountQor(e.target.value)}
            inputMode="decimal"
            placeholder="0.25 (QOR)"
            disabled={busy}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md border border-emerald-500/40 bg-emerald-500/15 px-3 py-2 text-sm font-medium text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-40"
          >
            Queue Invoice
          </button>
        </form>
      </div>

      {statusMsg && (
        <p className="mt-3 text-xs text-emerald-400">{statusMsg}</p>
      )}
      {errorMsg && (
        <p role="alert" className="mt-3 text-xs text-rose-400">
          {errorMsg}
        </p>
      )}
    </section>
  );
}

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
            <span className="rounded-full bg-slate-700/40 px-3 py-1 text-xs font-medium text-slate-300 ring-1 ring-slate-600/40">
              No Vault Yet
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
    ],
    query: { refetchInterval: 8_000 },
  });

  const [, agent, perTxLimit, dailyLimit, spentToday] =
    data?.map((r) => r.result) ?? [];

  const botQor = safeEvmToQor(agent as string | undefined);

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Vault</h2>
          <p className="font-mono text-xs text-slate-400">{vaultAddress}</p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <Pill ok={isOwner} label="You are owner" />
        </div>
      </div>

      {isLoading ? (
        <Skeleton />
      ) : (
        <div className="mt-5 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <Stat
            label="Bot Agent (qor1)"
            value={botQor ?? shortAddr(agent as Address)}
            mono
          />
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

  async function resolveErc20Metadata(
    items: NativeBalance[],
  ): Promise<TokenMetaMap> {
    const erc20Addrs = items
      .filter((b) => b.denom.startsWith("erc20:"))
      .map((b) => b.denom.slice("erc20:".length).toLowerCase())
      .filter((addr, idx, arr) => arr.indexOf(addr) === idx);

    const missing = erc20Addrs.filter((addr) => !erc20MetaMap[addr]);
    if (missing.length === 0) {
      return erc20MetaMap;
    }

    const evmClient = await createEvmClient({
      endpoints: { evmRpc: evmRpcUrl },
    });

    const entries = await Promise.all(
      missing.map(async (addr) => {
        try {
          const meta = await erc20.metadata(
            evmClient.publicClient,
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
            REST endpoint:{" "}
            <code className="font-mono text-slate-300">{restUrl}</code>
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
    <footer className="mt-auto border-t border-slate-800 py-6 text-center text-xs text-slate-500">
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