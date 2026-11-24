import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { StargateClient } from "@cosmjs/stargate";
import {
  createClient,
  deriveEvmAccount,
  deriveUnifiedAccount,
  directSignerFromPrivateKey,
  ensurePqcRegistered,
  EthNativeSigner,
  msg,
  openEvmWindowMsg,
  qorechainRegistry,
  resolveSignBytesVersion,
  toBase,
  validateSpendingRules,
} from "@qorechain/sdk";
import {
  createEvmClient,
  deployContract,
  evmAccountFromPrivateKey,
} from "@qorechain/evm";
import { parseEther, toHex, type Abi, type Address, type Hex } from "viem";
import AgentVault from "../artifacts/contracts/AgentVault.sol/AgentVault.json";

const DEPLOYMENT_FILE = path.resolve(
  process.cwd(),
  "deployment/agent-vault.deployment.json",
);

async function fetchAccountSeq(
  restUrl: string,
  cosmosAddress: string,
): Promise<{ accountNumber: bigint; sequence: bigint }> {
  const res = await fetch(
    `${restUrl}/cosmos/auth/v1beta1/accounts/${cosmosAddress}`,
  );
  const data = (await res.json()) as {
    account?: {
      account_number?: string;
      sequence?: string;
      base_account?: { account_number?: string; sequence?: string };
    };
  };
  const baseAcc = data.account?.base_account ?? data.account;
  return {
    accountNumber: BigInt(baseAcc?.account_number ?? "0"),
    sequence: BigInt(baseAcc?.sequence ?? "0"),
  };
}

async function main() {
  const ownerMnemonic = process.env.OWNER_MNEMONIC;
  if (!ownerMnemonic) {
    throw new Error("Missing OWNER_MNEMONIC in environment.");
  }

  const agentMnemonic = process.env.AGENT_MNEMONIC;
  if (!agentMnemonic) {
    throw new Error("Missing AGENT_MNEMONIC in environment.");
  }

  const restUrl = process.env.QORE_REST_URL ?? "https://api-testnet.qore.host";
  const rpcUrl = process.env.QORE_RPC_URL ?? "https://rpc-testnet.qore.host";
  const evmRpcUrl =
    process.env.VITE_QORE_EVM_RPC_URL ?? "https://evm-testnet.qore.host";

  const client = createClient({
    network: "testnet",
    endpoints: { rest: restUrl, rpc: rpcUrl, evmRpc: evmRpcUrl },
  });

  const chainId = client.network.chainId;
  const account = await deriveUnifiedAccount(ownerMnemonic, 0);

  // Derive agent EVM address from AGENT_MNEMONIC
  const derivedAgent = await deriveEvmAccount(agentMnemonic, {
    accountIndex: 0,
  });
  const agentVaultAddress = derivedAgent.address.toLowerCase() as Address;
  console.log("Derived agent address from AGENT_MNEMONIC:", agentVaultAddress);

  const signBytesVersion = await resolveSignBytesVersion({
    chainId,
    rest: restUrl,
  });

  // 1. Ensure PQC key is registered
  const rawPrivKey = Uint8Array.from(
    Buffer.from(account.privateKey.replace(/^0x/i, ""), "hex"),
  );
  const directSigner = await directSignerFromPrivateKey(rawPrivKey, "qor");
  const txClient = await client.connectTx(directSigner, {
    pqcKeypair: account.pqc,
  });

  const pqcStatus = await ensurePqcRegistered(txClient, {
    pqcKeypair: account.pqc,
    keyType: "hybrid",
    rest: restUrl,
    chainId,
  });
  console.log("PQC status:", pqcStatus);
  txClient.disconnect();

  const signer = new EthNativeSigner(account, {
    registry: qorechainRegistry(),
    signMode: "hybrid",
    signBytesVersion,
    rest: restUrl,
  });

  const stargateClient = await StargateClient.connect(rpcUrl);

  try {
    // 2. Open an EVM window that allows contract creation (omit allowedTargets before deploy)
    const deployWindowMsg = openEvmWindowMsg({
      sender: account.cosmos,
      blocks: 3600,
      maxTxs: 50,
      maxValue: toBase("100", { exponent: 6 }),
      nativeOnly: false,
      validators: [],
      stakingValidators: [],
      ibcReceivers: [],
    });

    const seq1 = await fetchAccountSeq(restUrl, account.cosmos);
    const winRes = await signer.signAndBroadcast(stargateClient, {
      chainId,
      accountNumber: seq1.accountNumber,
      sequence: seq1.sequence,
      messages: [deployWindowMsg],
      fee: {
        amount: [{ denom: "uqor", amount: "60000" }],
        gas: "400000",
      },
      memo: "LeashGuard: open EVM window for AgentVault deployment",
    });
    console.log(
      "Deploy EVM window tx:",
      winRes.transactionHash,
      "code:",
      winRes.code,
    );

    // 3. Deploy AgentVault using the agent address derived from AGENT_MNEMONIC
    const evmClient = await createEvmClient({
      endpoints: { evmRpc: evmRpcUrl },
    });
    const derivedOwnerEvm = await deriveEvmAccount(ownerMnemonic, {
      accountIndex: 0,
    });
    const deployerAccount = evmAccountFromPrivateKey(
      toHex(derivedOwnerEvm.privateKey) as Hex,
    );
    const walletClient = evmClient.getWalletClient(deployerAccount);

    const perTxLimit = parseEther("0.5");
    const dailyLimit = parseEther("5");

    const deployTxHash = await deployContract(walletClient, {
      abi: AgentVault.abi as Abi,
      bytecode: AgentVault.bytecode as Hex,
      args: [deployerAccount.address, agentVaultAddress, perTxLimit, dailyLimit],
    });

    const receipt = await evmClient.publicClient.waitForTransactionReceipt({
      hash: deployTxHash,
    });

    if (!receipt.contractAddress) {
      throw new Error("Deployment receipt missing contractAddress");
    }

    const deployedVaultAddr = receipt.contractAddress.toLowerCase() as Address;

    fs.mkdirSync(path.dirname(DEPLOYMENT_FILE), { recursive: true });
    fs.writeFileSync(
      DEPLOYMENT_FILE,
      JSON.stringify(
        {
          network: "qorechain-diana",
          contractName: "AgentVault",
          address: deployedVaultAddr,
          txHash: deployTxHash,
          owner: deployerAccount.address,
          agent: agentVaultAddress,
          perTxLimit: perTxLimit.toString(),
          dailyLimit: dailyLimit.toString(),
          deployedAt: new Date().toISOString(),
          abi: AgentVault.abi,
        },
        null,
        2,
      ),
      "utf-8",
    );
    console.log(
      "Deployed AgentVault at:",
      deployedVaultAddr,
      "with agent:",
      agentVaultAddress,
    );

    // 4. Configure spending rules & scope EVM window to the newly deployed AgentVault
    const rules = [
      {
        id: "leashguard-default-rule",
        dailyLimit: toBase("5", { exponent: 6 }),
        perTxLimit: toBase("0.5", { exponent: 6 }),
        allowedDenoms: ["uqor"],
        enabled: true,
        allowedEvmCalls: [deployedVaultAddr],
        denomLimits: [],
      },
    ];
    validateSpendingRules(rules);

    const scopedWindowMsg = openEvmWindowMsg({
      sender: account.cosmos,
      blocks: 3600,
      maxTxs: 100,
      maxValue: toBase("50", { exponent: 6 }),
      nativeOnly: false,
      allowedTargets: [deployedVaultAddr],
      validators: [],
      stakingValidators: [],
      ibcReceivers: [],
    });

    const updateRulesMsg = msg.abstractaccount.updateSpendingRules({
      owner: account.cosmos,
      accountAddress: account.cosmos,
      rules,
    });

    const seq2 = await fetchAccountSeq(restUrl, account.cosmos);
    const aaRes = await signer.signAndBroadcast(stargateClient, {
      chainId,
      accountNumber: seq2.accountNumber,
      sequence: seq2.sequence,
      messages: [scopedWindowMsg, updateRulesMsg],
      fee: {
        amount: [{ denom: "uqor", amount: "80000" }],
        gas: "550000",
      },
      memo: "LeashGuard: scope EVM window to vault + update spending rules",
    });
    console.log(
      "Scoped window & spending rules tx:",
      aaRes.transactionHash,
      "code:",
      aaRes.code,
    );
  } finally {
    stargateClient.disconnect();
  }
}

main().catch(console.error);