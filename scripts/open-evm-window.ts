import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import {
  createClient,
  deriveNativeAccount,
  derivePqcCanonical,
  directSignerFromPrivateKey,
  openEvmWindowMsg,
  qorToEvm,
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
  const mnemonic = process.env.OWNER_MNEMONIC;
  if (!mnemonic) throw new Error("Missing OWNER_MNEMONIC in environment.");
  if (!process.env.VITE_QORE_REST_URL) {
    throw new Error("Missing VITE_QORE_REST_URL in environment.");
  }

  const restUrl = process.env.QORE_REST_PROXY_TARGET || process.env.VITE_QORE_REST_URL;
  if (!restUrl || restUrl.startsWith("/")) {
    throw new Error("Set QORE_REST_PROXY_TARGET to the full REST URL in .env.");
  }

  const client = createClient({
    network: "testnet",
    endpoints: {
      rest: restUrl,
      rpc: process.env.QORE_RPC_URL,
      evmRpc: process.env.VITE_QORE_EVM_RPC_URL,
    },
  });

  const ownerAccount = await deriveNativeAccount(mnemonic);
  const evm = await deriveEvmAccount(mnemonic, { accountIndex: 0 });
  const sender = evmToQor(evm.address);
  const pqcKeypair = derivePqcCanonical(sender, mnemonic);
  const signer = await directSignerFromPrivateKey(toHex(evm.privateKey), client.network.bech32.account);

  const txClient = await client.connectTx(signer, {
    pqcKeypair,
  });

  const windowMsg = openEvmWindowMsg({
    sender: ownerAccount.address,
    blocks: 200n,
    maxTxs: 10n,
    maxValue: "10000000", // 10 QOR in uqor
  });

  const result = await txClient.signAndBroadcast([windowMsg], "auto");
  console.log("Opened EVM window:", result);

  console.log("Window sender:", ownerAccount.address, "->", qorToEvm(ownerAccount.address));
  console.dir(result.events?.find((e) => e.type === "pqc_evm_window_opened"), { depth: 5 });
}

openEvmWindow().catch(console.error);