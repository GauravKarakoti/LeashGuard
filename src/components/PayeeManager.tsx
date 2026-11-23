import { useState } from "react";
import { isAddress, type Abi, type Address } from "viem";
import {
  useWaitForTransactionReceipt,
  useWatchContractEvent,
  useWriteContract,
} from "wagmi";
import AgentVault from "../../artifacts/contracts/AgentVault.sol/AgentVault.json";

const vaultAbi = AgentVault.abi as Abi;

export function PayeeManager({
  vaultAddress,
  canEdit,
}: {
  vaultAddress: Address;
  canEdit: boolean;
}) {
  const [payees, setPayees] = useState<Address[]>([]);
  const [input, setInput] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const {
    writeContract,
    data: txHash,
    isPending,
    error: writeError,
  } = useWriteContract();

  const { isLoading: isMining, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  // Stream approvals/revocations from events
  useWatchContractEvent({
    address: vaultAddress,
    abi: vaultAbi,
    eventName: "PayeeApproved",
    onLogs: (logs) => {
      const addrs = logs
        .map(
          (l) => (l as unknown as { args?: { payee?: Address } }).args?.payee,
        )
        .filter((addr): addr is Address => Boolean(addr));
      if (addrs.length > 0) {
        setPayees((prev) => Array.from(new Set([...prev, ...addrs])));
      }
    },
  });

  useWatchContractEvent({
    address: vaultAddress,
    abi: vaultAbi,
    eventName: "PayeeRevoked",
    onLogs: (logs) => {
      const removed = new Set(
        logs
          .map((l) =>
            (l as unknown as { args?: { payee?: Address } }).args?.payee?.toLowerCase(),
          )
          .filter((addr): addr is string => Boolean(addr)),
      );
      if (removed.size > 0) {
        setPayees((prev) =>
          prev.filter((p) => !removed.has(p.toLowerCase())),
        );
      }
    },
  });

  const trimmed = input.trim();
  const isValidPayee = isAddress(trimmed);
  const busy = isPending || isMining;

  const approve = (addr: Address) => {
    setValidationError(null);
    writeContract({
      address: vaultAddress,
      abi: vaultAbi,
      functionName: "approvePayee",
      args: [addr],
    });
  };

  const revoke = (addr: Address) => {
    setValidationError(null);
    writeContract({
      address: vaultAddress,
      abi: vaultAbi,
      functionName: "revokePayee",
      args: [addr],
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    if (!canEdit) {
      setValidationError("Connect with the vault owner account to approve payees.");
      return;
    }

    if (!isValidPayee) {
      setValidationError("Enter a valid 0x EVM address.");
      return;
    }

    const normalized = trimmed as Address;
    approve(normalized);
    setInput("");
  };

  const displayError =
    validationError ?? (writeError ? writeError.message.split("\n")[0] : null);

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
      <h3 className="text-sm font-semibold">Approved payees</h3>
      <p className="mt-1 text-xs text-slate-400">
        The agent can only pay addresses in this list.
      </p>

      <form onSubmit={handleSubmit} className="mt-4 flex gap-2">
        <input
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            if (validationError) setValidationError(null);
          }}
          placeholder="0x…"
          disabled={!canEdit || busy}
          className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!canEdit || !isValidPayee || busy}
          className="rounded-md bg-emerald-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-40"
        >
          {busy ? "Signing…" : "Approve"}
        </button>
      </form>

      {!canEdit && (
        <p className="mt-2 text-xs text-slate-500">
          Connect QoreX with the owner account to approve or revoke payees.
        </p>
      )}
      {isSuccess && (
        <p className="mt-2 text-xs text-emerald-400">
          Payee transaction confirmed on chain.
        </p>
      )}
      {displayError && (
        <p role="alert" className="mt-2 text-xs text-rose-400">
          {displayError}
        </p>
      )}

      <ul className="mt-4 space-y-1 text-xs">
        {payees.length === 0 && (
          <li className="text-slate-500">No payees yet.</li>
        )}
        {payees.map((p) => (
          <li
            key={p}
            className="flex items-center justify-between rounded border border-slate-800 bg-slate-950/50 px-2 py-1.5"
          >
            <span className="font-mono text-slate-300">{p}</span>
            <button
              type="button"
              onClick={() => revoke(p)}
              disabled={!canEdit || busy}
              className="text-rose-400 hover:text-rose-300 disabled:opacity-40"
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}