import { createEvmClient } from "@qorechain/evm";
import { parseEther } from "viem";
import { AgentVaultAbi, AgentVaultBytecode } from "../artifacts/AgentVault";

async function main() {
  const client = await createEvmClient({
    endpoints: { evmRpc: process.env.QORE_EVM_RPC_URL! },
  });

  const owner = "0x..."; // your owner EVM address
  const agent = "0x..."; // your agent EVM address
  const perTxLimit = parseEther("0.5"); // 0.5 QOR
  const dailyLimit = parseEther("5");   // 5 QOR
  const ownerPqcKeyHash = "0x...";      // hash of owner's ML-DSA-87 public key

  const hash = await client.deployContract({
    abi: AgentVaultAbi,
    bytecode: AgentVaultBytecode,
    args: [owner, agent, perTxLimit, dailyLimit, ownerPqcKeyHash],
  });

  console.log("AgentVault deployed at:", hash.contractAddress);
  // Save this address to .env as AGENT_VAULT_ADDRESS
}

main().catch(console.error);