import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import {
  createClient,
  deriveNativeAccount,
  derivePqcCanonical,
  directSignerFromPrivateKey,
  openEvmWindowMsg,
} from "@qorechain/sdk";

const DEPLOYMENT_FILE = path.resolve(
  process.cwd(),
  "deployment/agent-vault.deployment.json",
);

function getVaultAddress(): string {
  if (fs.existsSync(DEPLOYMENT_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf-8")) as {
      address?: string;
    };
    if (parsed.address) return parsed.address;
  }
  throw new Error(
    "Missing deployment/agent-vault.deployment.json",
  );
}

async function openEvmWindow() {
  const vaultAddress = getVaultAddress();
  const mnemonic = process.env.OWNER_MNEMONIC;
  if (!mnemonic) {
    throw new Error("Missing OWNER_MNEMONIC in environment.");
  }

  const client = createClient({
    network: "testnet",
    endpoints: {
      rest: process.env.VITE_QORE_REST_URL,
      rpc: process.env.QORE_RPC_URL,
      evmRpc: process.env.VITE_QORE_EVM_RPC_URL,
    },
  });

  const ownerAccount = await deriveNativeAccount(mnemonic);
  const pqcKeypair = derivePqcCanonical(ownerAccount.address, mnemonic);
  const signer = await directSignerFromPrivateKey(
    ownerAccount.privateKey,
    client.network.bech32.account,
  );

  const txClient = await client.connectTx(signer, {
    pqcKeypair,
  });

  // Open a window: 100 blocks, max 5 txs, max 10 QOR total (10_000_000 uqor)
  const windowMsg = openEvmWindowMsg({
    sender: ownerAccount.address,
    blocks: 100n,
    maxTxs: 5n,
    maxValue: "10000000",
    allowedTargets: [vaultAddress],
  });

  const result = await txClient.signAndBroadcast([windowMsg], "auto");
  console.log("Opened EVM window:", result);
}

openEvmWindow().catch(console.error);