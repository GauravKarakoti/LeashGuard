import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import {
  createEvmClient,
  deployContract,
  evmAccountFromPrivateKey,
} from "@qorechain/evm";
import { deriveEvmAccount } from "@qorechain/sdk";
import { isAddress, parseEther, toHex, type Abi, type Hex } from "viem";
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
  deployedAt: string;
  abi: Abi;
}

function resolveEvmRpcUrl(): string {
  const url = process.env.VITE_QORE_EVM_RPC_URL;
  if (!url) {
    throw new Error("Missing VITE_QORE_EVM_RPC_URL in environment.");
  }
  return url;
}

async function main() {
  const ownerMnemonic = process.env.OWNER_MNEMONIC;
  if (!ownerMnemonic) {
    throw new Error("Missing OWNER_MNEMONIC in environment.");
  }

  const evmRpcUrl = resolveEvmRpcUrl();
  const client = await createEvmClient({
    endpoints: { evmRpc: evmRpcUrl },
  });

  const derivedOwnerEvm = await deriveEvmAccount(ownerMnemonic, {
    accountIndex: 0,
  });
  const ownerPrivateKeyHex = toHex(derivedOwnerEvm.privateKey) as Hex;
  const deployerAccount = evmAccountFromPrivateKey(ownerPrivateKeyHex);
  const walletClient = client.getWalletClient(deployerAccount);

  const envOwner = process.env.OWNER_EVM_ADDRESS;
  const owner = (
    envOwner && isAddress(envOwner) ? envOwner : deployerAccount.address
  ) as `0x${string}`;

  let agent: `0x${string}`;
  if (process.env.AGENT_MNEMONIC) {
    const derivedAgentEvm = await deriveEvmAccount(process.env.AGENT_MNEMONIC, {
      accountIndex: 0,
    });
    agent = derivedAgentEvm.address as `0x${string}`;
  } else {
    throw new Error(
      "Set AGENT_MNEMONIC in .env so the vault agent address is configured.",
    );
  }

  const perTxLimit = parseEther("0.5"); // 0.5 QOR
  const dailyLimit = parseEther("5"); // 5 QOR

  console.log("Deployer / Owner EVM address:", deployerAccount.address);
  console.log("Agent EVM address:", agent);

  const txHash = await deployContract(walletClient, {
    abi: vaultAbi,
    bytecode: AgentVault.bytecode as Hex,
    args: [owner, agent, perTxLimit, dailyLimit],
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