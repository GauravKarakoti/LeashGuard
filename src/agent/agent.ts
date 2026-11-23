import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { db } from "../../prisma/db";
import { decryptMnemonic } from "../server/index";
import { createClient, deriveEvmAccount } from "@qorechain/sdk";
import {
  createEvmClient,
  evmAccountFromPrivateKey,
  type EvmClient,
} from "@qorechain/evm";
import { parseEther, isAddress, toHex, type Abi, type Hex } from "viem";
import AgentVault from "../../artifacts/contracts/AgentVault.sol/AgentVault.json";

const DEPLOYMENT_FILE = path.resolve(
  process.cwd(),
  "deployment/agent-vault.deployment.json",
);

const InvoiceStatus = {
  PENDING: "PENDING",
  PAID: "PAID",
  FAILED: "FAILED",
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
} as const;

export interface ApiInvoice {
  invoiceId: string;
  vaultAddress: string;
  botAddress?: string | null;
  userAddress: string;
  payee: string;
  amountQor?: string;
  amountWei?: string;
}

export function loadVaultDeployment() {
  let fileData: { address?: string; abi?: Abi } = {};
  if (fs.existsSync(DEPLOYMENT_FILE)) {
    fileData = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf-8"));
  }
  const address = fileData.address as `0x${string}` | undefined;

  if (!address) {
    throw new Error(
      "Vault address not found. Run deploy script or set AGENT_VAULT_ADDRESS.",
    );
  }

  return {
    address,
    abi: (fileData.abi && fileData.abi.length > 0
      ? fileData.abi
      : AgentVault.abi) as Abi,
  };
}

function getVaultAbi(): Abi {
  const { abi } = loadVaultDeployment();
  return abi;
}

function parseInvoiceAmountWei(inv: ApiInvoice): bigint {
  if (inv.amountWei !== undefined && inv.amountWei !== "") {
    return BigInt(inv.amountWei);
  }
  if (inv.amountQor !== undefined && inv.amountQor !== "") {
    return parseEther(inv.amountQor);
  }
  throw new Error(`Invoice ${inv.invoiceId} is missing amountQor or amountWei.`);
}

async function fetchPendingInvoicesFromApi(): Promise<ApiInvoice[]> {
  const apiUrl = process.env.VITE_API_BASE_URL;
  if (!apiUrl) {
    throw new Error("Missing VITE_API_BASE_URL.");
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (process.env.INVOICES_API_KEY) {
    headers.Authorization = `Bearer ${process.env.INVOICES_API_KEY}`;
  }

  const res = await fetch(`${apiUrl}/api/invoices/pending`, { headers });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch invoices from ${apiUrl}: ${res.status} ${res.statusText}`,
    );
  }

  const payload = (await res.json()) as
    | ApiInvoice[]
    | { invoices?: ApiInvoice[] };
  return Array.isArray(payload) ? payload : (payload.invoices ?? []);
}

async function getMnemonicForVault(
  vaultAddress: string,
): Promise<string | undefined> {
  const normVault = vaultAddress.toLowerCase();
  const botRecord = await db.orm.public.AgentBot
    .where({ vaultAddress: normVault })
    .first();

  if (botRecord?.encryptedMnemonic) {
    return decryptMnemonic(botRecord.encryptedMnemonic);
  }

  return process.env.AGENT_MNEMONIC;
}

async function processInvoices() {
  const evmRpcUrl = process.env.VITE_QORE_EVM_RPC_URL;
  if (!evmRpcUrl) {
    throw new Error("Missing VITE_QORE_EVM_RPC_URL in .env.");
  }

  createClient({
    network: "testnet",
    endpoints: {
      rest: process.env.QORE_REST_URL,
      rpc: process.env.QORE_RPC_URL,
      evmRpc: evmRpcUrl,
    },
  });

  const evmClient: EvmClient = await createEvmClient({
    endpoints: { evmRpc: evmRpcUrl },
  });

  const vaultAbi = getVaultAbi();
  const apiInvoices = await fetchPendingInvoicesFromApi();

  const signerCache = new Map<
    string,
    {
      agentAccount: ReturnType<typeof evmAccountFromPrivateKey>;
      walletClient: ReturnType<EvmClient["getWalletClient"]>;
    }
  >();

  for (const rawInv of apiInvoices) {
    const normVault = rawInv.vaultAddress.toLowerCase() as `0x${string}`;
    const normUser = rawInv.userAddress.toLowerCase();
    const amountWei = parseInvoiceAmountWei(rawInv);

    let invoice = await db.orm.public.Invoice
      .where({ invoiceId: rawInv.invoiceId })
      .first();

    if (!invoice) {
      invoice = await db.orm.public.Invoice.create({
        invoiceId: rawInv.invoiceId,
        vaultAddress: normVault,
        userAddress: normUser,
        payee: rawInv.payee,
        amountWei: amountWei.toString(),
        status: InvoiceStatus.PENDING,
        txHash: null,
        errorReason: null,
        paidAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    if (invoice.status === InvoiceStatus.PAID) {
      continue;
    }

    if (!isAddress(normVault) || !isAddress(invoice.payee)) {
      await db.orm.public.Invoice.where({ id: invoice.id }).update({
        status: InvoiceStatus.FAILED,
        errorReason: `Invalid vault or payee address: vault=${normVault}, payee=${invoice.payee}`,
        updatedAt: new Date(),
      });
      continue;
    }

    const mnemonic = await getMnemonicForVault(normVault);
    if (!mnemonic) {
      await db.orm.public.Invoice.where({ id: invoice.id }).update({
        status: InvoiceStatus.FAILED,
        errorReason: `No bot mnemonic stored in DB for vault ${normVault}`,
        updatedAt: new Date(),
      });
      continue;
    }

    let signerEntry = signerCache.get(normVault);
    if (!signerEntry) {
      const derivedEvm = await deriveEvmAccount(mnemonic);
      const privateKeyHex = toHex(derivedEvm.privateKey) as Hex;
      const agentAccount = evmAccountFromPrivateKey(privateKeyHex);
      const walletClient = evmClient.getWalletClient(agentAccount);
      signerEntry = { agentAccount, walletClient };
      signerCache.set(normVault, signerEntry);
    }

    if (
      rawInv.botAddress &&
      signerEntry.agentAccount.address.toLowerCase() !==
        rawInv.botAddress.toLowerCase()
    ) {
      await db.orm.public.Invoice.where({ id: invoice.id }).update({
        status: InvoiceStatus.FAILED,
        errorReason: `Configured signer ${signerEntry.agentAccount.address} does not match vault bot ${rawInv.botAddress}`,
        updatedAt: new Date(),
      });
      continue;
    }

    const funding = await db.orm.public.UserFunding
      .where({ vaultAddress: normVault, userAddress: normUser })
      .first();

    const funded = BigInt(funding?.fundedBalanceWei ?? "0");
    const spent = BigInt(funding?.spentBalanceWei ?? "0");
    const available = funded - spent;

    if (available < amountWei) {
      await db.orm.public.Invoice.where({ id: invoice.id }).update({
        status: InvoiceStatus.INSUFFICIENT_FUNDS,
        errorReason: `Insufficient user balance: available=${available.toString()} wei, required=${amountWei.toString()} wei`,
        updatedAt: new Date(),
      });
      console.warn(
        `Skipping invoice ${invoice.invoiceId} on vault ${normVault} for ${normUser}: insufficient funded balance.`,
      );
      continue;
    }

    try {
      const { request } = await evmClient.publicClient.simulateContract({
        address: normVault,
        abi: vaultAbi,
        functionName: "payBill",
        args: [invoice.payee as `0x${string}`, amountWei, invoice.invoiceId],
        account: signerEntry.agentAccount,
      });

      const txHash = await signerEntry.walletClient.writeContract(request);
      await evmClient.publicClient.waitForTransactionReceipt({ hash: txHash });

      await db.orm.public.UserFunding
        .where({ vaultAddress: normVault, userAddress: normUser })
        .update({
          spentBalanceWei: (spent + amountWei).toString(),
          updatedAt: new Date(),
        });

      await db.orm.public.Invoice.where({ id: invoice.id }).update({
        status: InvoiceStatus.PAID,
        txHash,
        errorReason: null,
        paidAt: new Date(),
        updatedAt: new Date(),
      });

      console.log(
        `Paid invoice ${invoice.invoiceId} on vault ${normVault} (${normUser} -> ${invoice.payee}), tx: ${txHash}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.orm.public.Invoice.where({ id: invoice.id }).update({
        status: InvoiceStatus.FAILED,
        errorReason: message.slice(0, 500),
        updatedAt: new Date(),
      });
      console.error(`Failed invoice ${invoice.invoiceId}:`, message);
    }
  }
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  processInvoices().catch(console.error);
}