import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { StargateClient } from "@cosmjs/stargate";
import { ml_kem1024 } from "@noble/post-quantum/ml-kem.js";
import {
  createClient,
  KEM_ALGORITHM_ML_KEM_1024,
  msg,
  qorechainRegistry,
  signAndBroadcastHybrid,
  validateKemPublicKey,
} from "@qorechain/sdk";
import { loadNativeAccount, resolvePqcKey } from "./native";

async function main() {
  const mnemonic = process.env.OWNER_MNEMONIC!;
  const restUrl = process.env.QORE_REST_URL ?? "https://api-testnet.qore.host";
  const rpcUrl = process.env.QORE_RPC_URL ?? "https://rpc-testnet.qore.host";
  const evmRpcUrl =
    process.env.VITE_QORE_EVM_RPC_URL ?? "https://evm-testnet.qore.host";

  const client = createClient({
    network: "testnet",
    endpoints: { rest: restUrl, rpc: rpcUrl, evmRpc: evmRpcUrl },
  });

  const { account, signer } = await loadNativeAccount(mnemonic);
  console.log("Using native account:", account.address);

  // ML-KEM-1024 keypair (1568-byte public key, 3168-byte secret key)
  const kemKeys = ml_kem1024.keygen();
  validateKemPublicKey(kemKeys.publicKey, KEM_ALGORITHM_ML_KEM_1024);

  // Save the KEM secret key locally BEFORE broadcasting, so it is never lost.
  // This file holds a secret: keep it out of git.
  const keyFile = path.resolve(process.cwd(), "artifacts/qoreseal-kem.json");
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(
    keyFile,
    JSON.stringify(
      {
        address: account.address,
        algorithmId: KEM_ALGORITHM_ML_KEM_1024,
        publicKeyHex: Buffer.from(kemKeys.publicKey).toString("hex"),
        secretKeyHex: Buffer.from(kemKeys.secretKey).toString("hex"),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  const { pqcKeypair, includePqcPublicKey } = await resolvePqcKey(
    account.address,
    mnemonic,
    restUrl,
  );

  const authRes = await client.rest.get<{
    account?: {
      account_number?: string;
      sequence?: string;
      base_account?: { account_number?: string; sequence?: string };
    };
  }>(`/cosmos/auth/v1beta1/accounts/${account.address}`);
  const baseAcc = authRes.account?.base_account ?? authRes.account;
  const accountNumber = BigInt(baseAcc?.account_number ?? "0");
  const sequence = BigInt(baseAcc?.sequence ?? "0");

  const registerMsg = msg.pqc.registerKemKey({
    sender: account.address,
    algorithmId: KEM_ALGORITHM_ML_KEM_1024,
    publicKey: kemKeys.publicKey,
  });

  const stargateClient = await StargateClient.connect(rpcUrl);
  try {
    const res = await signAndBroadcastHybrid({
      registry: qorechainRegistry(),
      signer,
      pqcKeypair,
      includePqcPublicKey,
      messages: [registerMsg],
      fee: { amount: [{ denom: "uqor", amount: "60000" }], gas: "450000" },
      memo: "LeashGuard: register ML-KEM-1024 QoreSeal encryption key",
      chainId: client.network.chainId,
      accountNumber,
      sequence,
      signBytesVersion: "auto",
      rest: restUrl,
      transport: stargateClient,
    });
    console.log("Register KEM txHash:", res.transactionHash, "code:", res.code);
  } finally {
    stargateClient.disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
