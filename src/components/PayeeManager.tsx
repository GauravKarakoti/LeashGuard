import { useState } from "react";
import { isAddress, type Abi, type Address } from "viem";
import { useWatchContractEvent, useWriteContract } from "wagmi";
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
  const { writeContract, isPending } = useWriteContract();

  // Stream approvals/revocations from events
  useWatchContractEvent({
    address: vaultAddress,
    abi: vaultAbi,
    eventName: "PayeeApproved",
    onLogs: (logs) => {
      const addrs = logs
        .map((l) => (l as unknown as { args?: { payee?: Address } }).args?.payee)
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
          .map((l) => (l as unknown as { args?: { payee?: Address } }).args?.payee?.toLowerCase())
          .filter((addr): addr is string => Boolean(addr)),
      );
      if (removed.size > 0) {
        setPayees((prev) =>
          prev.filter((p) => !removed.has(p.toLowerCase())),
        );
      }
    },
  });

  const approve = (addr: Address) =>
    writeContract({
      address: vaultAddress,
      abi: vaultAbi,
      functionName: "approvePayee",
      args: [addr],
    });

  const revoke = (addr: Address) =>
    writeContract({
      address: vaultAddress,
      abi: vaultAbi,
      functionName: "revokePayee",
      args: [addr],
    });

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
      <h3 className="text-sm font-semibold">Approved payees</h3>
      <p className="mt-1 text-xs text-slate-400">
        The agent can only pay addresses in this list.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!isAddress(input)) return;
          approve(input);
          setInput("");
        }}
        className="mt-4 flex gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="0x…"
          disabled={!canEdit}
          className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!canEdit || !isAddress(input) || isPending}
          className="rounded-md bg-emerald-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-40"
        >
          Approve
        </button>
      </form>

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
              onClick={() => revoke(p)}
              disabled={!canEdit || isPending}
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