import { useState } from "react";
import { formatEther, type Abi, type Address } from "viem";
import { useWatchContractEvent } from "wagmi";
import AgentVault from "../../artifacts/contracts/AgentVault.sol/AgentVault.json";

const vaultAbi = AgentVault.abi as Abi;

type Bill = {
  payee: Address;
  amount: bigint;
  invoiceId: string;
  txHash: string;
  blockNumber: bigint;
};

export function PaymentFeed({ vaultAddress }: { vaultAddress: Address }) {
  const [bills, setBills] = useState<Bill[]>([]);

  useWatchContractEvent({
    address: vaultAddress,
    abi: vaultAbi,
    eventName: "BillPaid",
    onLogs: (logs) => {
      const parsed = logs
        .map((l) => {
          const args = (
            l as unknown as {
              args?: {
                payee?: Address;
                amount?: bigint;
                invoiceId?: string;
              };
            }
          ).args;

          if (
            !args?.payee ||
            args.amount === undefined ||
            !args.invoiceId
          ) {
            return null;
          }

          return {
            payee: args.payee,
            amount: args.amount,
            invoiceId: args.invoiceId,
            txHash: l.transactionHash ?? "",
            blockNumber: l.blockNumber ?? 0n,
          };
        })
        .filter((b): b is Bill => b !== null);

      if (parsed.length > 0) {
        setBills((prev) => [...parsed, ...prev].slice(0, 50));
      }
    },
  });

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
      <h3 className="text-sm font-semibold">Payment feed</h3>
      <p className="mt-1 text-xs text-slate-400">
        Live <code>BillPaid</code> events from the agent.
      </p>

      <ul className="mt-4 divide-y divide-slate-800">
        {bills.length === 0 && (
          <li className="py-4 text-xs text-slate-500">
            Waiting for the agent to pay its first bill…
          </li>
        )}
        {bills.map((b, i) => (
          <li
            key={`${b.txHash}-${i}`}
            className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs"
          >
            <span className="font-mono text-slate-300">
              {b.payee.slice(0, 8)}…{b.payee.slice(-6)}
            </span>
            <span className="text-emerald-400">
              {formatEther(b.amount)} QOR
            </span>
            <span className="text-slate-500">
              inv {b.invoiceId.slice(0, 10)}…
            </span>
            <a
              href={`https://testnet.qore.host/tx/${b.txHash}`}
              target="_blank"
              rel="noreferrer"
              className="text-slate-400 underline hover:text-slate-200"
            >
              tx
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}