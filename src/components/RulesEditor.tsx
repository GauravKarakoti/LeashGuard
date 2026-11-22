import { useState } from "react";
import { formatEther, parseEther, type Abi, type Address } from "viem";
import {
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import AgentVault from "../../artifacts/contracts/AgentVault.sol/AgentVault.json";

const vaultAbi = AgentVault.abi as Abi;

export function RulesEditor({
  vaultAddress,
  canEdit,
}: {
  vaultAddress: Address;
  canEdit: boolean;
}) {
  const { data: perTx } = useReadContract({
    address: vaultAddress,
    abi: vaultAbi,
    functionName: "perTxLimit",
  });
  const { data: daily } = useReadContract({
    address: vaultAddress,
    abi: vaultAbi,
    functionName: "dailyLimit",
  });

  const [perTxInput, setPerTxInput] = useState("");
  const [dailyInput, setDailyInput] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);

  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isMining, isSuccess } = useWaitForTransactionReceipt({
    hash,
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setParseError(null);
    if (!canEdit) return;

    try {
      const nextPerTx = parseEther((perTxInput || "0").trim());
      const nextDaily = parseEther((dailyInput || "0").trim());

      writeContract({
        address: vaultAddress,
        abi: vaultAbi,
        functionName: "updateRules",
        args: [nextPerTx, nextDaily],
      });
    } catch (err) {
      setParseError(
        err instanceof Error ? err.message : "Invalid limit amount",
      );
    }
  };

  const displayError =
    parseError ?? (error ? error.message.split("\n")[0] : null);

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
      <h3 className="text-sm font-semibold">Spending rules</h3>
      <p className="mt-1 text-xs text-slate-400">
        Changing rules requires your ML‑DSA‑87 signature — QoreX adds it
        automatically.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <div>
          <div className="text-slate-500">Current per‑tx</div>
          <div className="text-slate-200">
            {perTx != null ? `${formatEther(perTx as bigint)} QOR` : "—"}
          </div>
        </div>
        <div>
          <div className="text-slate-500">Current daily</div>
          <div className="text-slate-200">
            {daily != null ? `${formatEther(daily as bigint)} QOR` : "—"}
          </div>
        </div>
      </div>

      <form onSubmit={submit} className="mt-4 space-y-3">
        <label className="block text-xs">
          <span className="text-slate-400">New per‑tx limit (QOR)</span>
          <input
            value={perTxInput}
            onChange={(e) => setPerTxInput(e.target.value)}
            inputMode="decimal"
            placeholder="0.5"
            disabled={!canEdit}
            className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm disabled:opacity-50"
          />
        </label>
        <label className="block text-xs">
          <span className="text-slate-400">New daily limit (QOR)</span>
          <input
            value={dailyInput}
            onChange={(e) => setDailyInput(e.target.value)}
            inputMode="decimal"
            placeholder="5"
            disabled={!canEdit}
            className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm disabled:opacity-50"
          />
        </label>

        <button
          type="submit"
          disabled={!canEdit || isPending || isMining}
          className="w-full rounded-md bg-emerald-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-40"
        >
          {isPending || isMining ? "Signing…" : "Update rules"}
        </button>

        {isSuccess && (
          <p className="text-xs text-emerald-400">Rules updated on chain.</p>
        )}
        {displayError && (
          <p className="text-xs text-rose-400">{displayError}</p>
        )}
        {!canEdit && (
          <p className="text-xs text-slate-500">
            Connect QoreX with the owner account to edit.
          </p>
        )}
      </form>
    </section>
  );
}