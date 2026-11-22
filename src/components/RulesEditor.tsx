import { useContractWrite } from "wagmi";
import { AgentVaultAbi } from "../../artifacts/AgentVault";

export function RulesEditor({ vaultAddress }: { vaultAddress: `0x${string}` }) {
  const { write: updateRules } = useContractWrite({
    address: vaultAddress,
    abi: AgentVaultAbi,
    functionName: "updateRules",
  });

  const handleUpdate = (perTx: bigint, daily: bigint) => {
    // This transaction must be hybrid-signed by the owner.
    // QoreX handles the PQC layer automatically when connected.
    updateRules({ args: [perTx, daily] });
  };

  return (
    <div>
      <h3>Spending Rules</h3>
      {/* Input fields for perTxLimit and dailyLimit */}
    </div>
  );
}