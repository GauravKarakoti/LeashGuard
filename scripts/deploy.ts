import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import {
  createEvmClient,
  deployContract,
  evmAccountFromPrivateKey,
} from "@qorechain/evm";
import { parseEther, type Abi, type Hex } from "viem";
import AgentVault from "../artifacts/contracts/AgentVault.sol/AgentVault.json";

const DEPLOYMENT_FILE = path.resolve(
  process.cwd(),
  "deployment/agent-vault.deployment.json",
);

const vaultAbi = AgentVault.abi as Abi;

export interface AgentVaultDeployment {
  network: string;
  contractName: string;
  address: `0x${string}`;
  txHash: `0x${string}`;
  owner: `0x${string}`;
  agent: `0x${string}`;
  perTxLimit: string;
  dailyLimit: string;
  ownerPqcKeyHash: `0x${string}`;
  deployedAt: string;
  abi: Abi;
}

async function main() {
  const deployerPrivateKey = process.env.DEPLOYER_PRIVATE_KEY as Hex;
  if (!deployerPrivateKey) {
    throw new Error("Missing DEPLOYER_PRIVATE_KEY in environment.");
  }

  const client = await createEvmClient({
    endpoints: { evmRpc: process.env.VITE_QORE_EVM_RPC_URL! },
  });

  const deployerAccount = evmAccountFromPrivateKey(deployerPrivateKey);
  const walletClient = client.getWalletClient(deployerAccount);

  const owner = (process.env.OWNER_EVM_ADDRESS ?? "0x...") as `0x${string}`;
  const agent = (process.env.AGENT_EVM_ADDRESS ?? "0x...") as `0x${string}`;
  const perTxLimit = parseEther("0.5"); // 0.5 QOR
  const dailyLimit = parseEther("5"); // 5 QOR
  const ownerPqcKeyHash = (process.env.OWNER_PQC_KEY_HASH ??
    "0x...") as `0x${string}`;

  const txHash = await deployContract(walletClient, {
    abi: vaultAbi,
    bytecode: AgentVault.bytecode as Hex,
    args: [owner, agent, perTxLimit, dailyLimit, ownerPqcKeyHash],
  });

  const receipt = await client.publicClient.waitForTransactionReceipt({
    hash: txHash,
  });

  const vaultAddress = receipt.contractAddress;
  if (!vaultAddress) {
    throw new Error(
      `Deployment receipt for ${txHash} did not include a contractAddress.`,
    );
  }

  console.log("AgentVault deployed at:", vaultAddress);

  const deploymentRecord: AgentVaultDeployment = {
    network: "qorechain-diana",
    contractName: "AgentVault",
    address: vaultAddress,
    txHash,
    owner,
    agent,
    perTxLimit: perTxLimit.toString(),
    dailyLimit: dailyLimit.toString(),
    ownerPqcKeyHash,
    deployedAt: new Date().toISOString(),
    abi: vaultAbi,
  };

  fs.mkdirSync(path.dirname(DEPLOYMENT_FILE), { recursive: true });
  fs.writeFileSync(
    DEPLOYMENT_FILE,
    JSON.stringify(deploymentRecord, null, 2),
    "utf-8",
  );

  console.log("Saved deployment artifact to:", DEPLOYMENT_FILE);
}

main().catch(console.error);