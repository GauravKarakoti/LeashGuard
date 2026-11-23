import "dotenv/config";
import { StargateClient } from "@cosmjs/stargate";
import {
  CHAIN_UPGRADE_V3_2_3,
  createClient,
  deriveUnifiedAccount,
  ensurePqcRegistered,
  EthNativeSigner,
  isUpgradeApplied,
  msg,
  openEvmWindowMsg,
  qorechainRegistry,
  resolveSignBytesVersion,
  signProofOfPossession,
  toBase,
  validateSpendingRules,
} from "@qorechain/sdk";

async function main() {
  const mnemonic = process.env.OWNER_MNEMONIC!;
  const restUrl = process.env.QORE_REST_URL ?? "https://api-testnet.qore.host";
  const rpcUrl = process.env.QORE_RPC_URL ?? "https://rpc-testnet.qore.host";
  const evmRpcUrl =
    process.env.VITE_QORE_EVM_RPC_URL ?? "https://evm-testnet.qore.host";
  const vaultAddress = process.env.AGENT_VAULT_ADDRESS;

  const client = createClient({
    network: "testnet",
    endpoints: { rest: restUrl, rpc: rpcUrl, evmRpc: evmRpcUrl },
  });

  const chainId = client.network.chainId;
  const account = await deriveUnifiedAccount(mnemonic, 0);
  const signBytesVersion = await resolveSignBytesVersion({
    chainId,
    rest: restUrl,
  });

  const signer = new EthNativeSigner(account, {
    registry: qorechainRegistry(),
    signMode: "hybrid",
    signBytesVersion,
    rest: restUrl,
  });

  const stargateClient = await StargateClient.connect(rpcUrl);

  try {
    // 1. Register PQC key with proof of possession when v3.2.3+ is applied
    const v323Applied = await isUpgradeApplied({
      rest: restUrl,
      upgrade: CHAIN_UPGRADE_V3_2_3,
    });

    const pop = v323Applied
      ? signProofOfPossession({
          chainId,
          account: account.cosmos,
          keypair: account.pqc,
        })
      : undefined;

    const pqcStatus = await ensurePqcRegistered(signer as never, {
      pqcKeypair: account.pqc,
      keyType: "hybrid",
      rest: restUrl,
      chainId,
      ...(pop ? { proofOfPossession: pop } : {}),
    });
    console.log("PQC status:", pqcStatus);

    // 2. Open a scoped EVM window (blocks: 1..17280, maxTxs: 1..1000, maxValue in uqor)
    const windowMsg = openEvmWindowMsg({
      sender: account.cosmos,
      blocks: 3600,
      maxTxs: 100,
      maxValue: toBase("10", { exponent: 6 }),
      nativeOnly: false,
      ...(vaultAddress ? { allowedTargets: [vaultAddress] } : {}),
      validators: [],
      stakingValidators: [],
      ibcReceivers: [],
    });

    const authRes = await client.rest.get<{
      account?: {
        account_number?: string;
        sequence?: string;
        base_account?: { account_number?: string; sequence?: string };
      };
    }>(`/cosmos/auth/v1beta1/accounts/${account.cosmos}`);
    const baseAcc = authRes.account?.base_account ?? authRes.account;
    const accountNumber = BigInt(baseAcc?.account_number ?? "0");
    let sequence = BigInt(baseAcc?.sequence ?? "0");

    const winRes = await signer.signAndBroadcast(stargateClient, {
      chainId,
      accountNumber,
      sequence,
      messages: [windowMsg],
      fee: {
        amount: [{ denom: "uqor", amount: "60000" }],
        gas: "400000",
      },
      memo: "LeashGuard: open scoped PQC EVM window",
    });
    console.log("Scoped EVM window tx:", winRes.transactionHash, "code:", winRes.code);
    sequence += 1n;

    // 3. Smart account & spending rules
    const rules = [
      {
        id: "leashguard-default-rule",
        dailyLimit: toBase("5", { exponent: 6 }),
        perTxLimit: toBase("0.5", { exponent: 6 }),
        allowedDenoms: ["uqor"],
        enabled: true,
        allowedEvmCalls: vaultAddress ? [vaultAddress] : [],
        denomLimits: [],
      },
    ];
    validateSpendingRules(rules);

    const createSmartAccMsg = msg.abstractaccount.createAbstractAccount({
      owner: account.cosmos,
      accountType: "smart",
    });

    const updateRulesMsg = msg.abstractaccount.updateSpendingRules({
      owner: account.cosmos,
      accountAddress: account.cosmos,
      rules,
    });

    const aaRes = await signer.signAndBroadcast(stargateClient, {
      chainId,
      accountNumber,
      sequence,
      messages: [createSmartAccMsg, updateRulesMsg],
      fee: {
        amount: [{ denom: "uqor", amount: "80000" }],
        gas: "550000",
      },
      memo: "LeashGuard: smart account + spending rules",
    });
    console.log("Smart account & rules tx:", aaRes.transactionHash, "code:", aaRes.code);
  } finally {
    stargateClient.disconnect();
  }
}

main().catch(console.error);