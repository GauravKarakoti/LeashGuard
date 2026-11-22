import { useContractWrite } from "wagmi";
import { AgentVaultAbi } from "../../artifacts/AgentVault";

export function PayeeManager({ vaultAddress }: { vaultAddress: `0x${string}` }) {
  const { write } = useContractWrite({
    address: vaultAddress,
    abi: AgentVaultAbi,
    functionName: "approvePayee",
  });

  const handleApprove = (payee: string) => {
    write({ args: [payee] });
  };

  return (
    <div>
      <h3>Approved Payees</h3>
      {/* List payees from events; add approve/revoke buttons */}
    </div>
  );
}