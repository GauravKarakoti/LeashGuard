import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { db } from "../../prisma/db";
import { createClient, deriveEvmAccount } from "@qorechain/sdk";
import { createEvmClient, evmAccountFromPrivateKey } from "@qorechain/evm";
import { parseEther, isAddress, toHex, type Abi, type Hex } from "viem";
import AgentVault from "../../artifacts/contracts/AgentVault.sol/AgentVault.json";
import { pathToFileURL } from "node:url";

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
  const address = (fileData.address) as `0x${string}` | undefined;

  if (!address) {
    throw new Error(
      "Vault address not found. Run deploy script.",
    );
  }

  return {
    address,
    abi: (fileData.abi && fileData.abi.length > 0
      ? fileData.abi
      : AgentVault.abi) as Abi,
  };
}

function parseInvoiceAmountWei(inv: ApiInvoice): bigint {
  if (inv.amountWei !== undefined) {
    return BigInt(inv.amountWei);
  }
  if (inv.amountQor !== undefined) {
    return parseEther(inv.amountQor);
  }
  throw new Error(`Invoice ${inv.invoiceId} is missing amountQor or amountWei.`);
}

async function fetchPendingInvoicesFromApi(): Promise<ApiInvoice[]> {
  const apiUrl = process.env.INVOICES_API_URL;
  if (!apiUrl) {
    throw new Error(
      "Missing INVOICES_API_URL (e.g. http://localhost:3000/api/invoices/pending).",
    );
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

async function processInvoices() {
  const mnemonic = process.env.AGENT_MNEMONIC;
  if (!mnemonic) {
    throw new Error("Missing AGENT_MNEMONIC in .env.");
  }

  const { address: vaultAddress, abi: vaultAbi } = loadVaultDeployment();

  createClient({
    network: "testnet",
    endpoints: {
      rest: process.env.VITE_QORE_REST_URL,
      rpc: process.env.QORE_RPC_URL,
      evmRpc: process.env.VITE_QORE_EVM_RPC_URL,
    },
  });

  const evmRpcUrl = process.env.VITE_QORE_EVM_RPC_URL;
  if (!evmRpcUrl) {
    throw new Error(
      "Missing VITE_QORE_EVM_RPC_URL in .env.",
    );
  }
  const evmClient = await createEvmClient({
    endpoints: { evmRpc: evmRpcUrl },
  });

  const derivedEvm = await deriveEvmAccount(mnemonic);
  const privateKeyHex = toHex(derivedEvm.privateKey) as Hex;
  const agentAccount = evmAccountFromPrivateKey(privateKeyHex);
  const walletClient = evmClient.getWalletClient(agentAccount);

  const apiInvoices = await fetchPendingInvoicesFromApi();

  for (const rawInv of apiInvoices) {
    const normalizedUser = rawInv.userAddress.toLowerCase();
    const amountWei = parseInvoiceAmountWei(rawInv);

    // Ensure UserFunding row exists so foreign key constraints are satisfied
    let funding = await db.orm.public.UserFunding
      .where({ userAddress: normalizedUser })
      .first();

    if (!funding) {
      funding = await db.orm.public.UserFunding.create({
        userAddress: normalizedUser,
        fundedBalanceWei: "0",
        spentBalanceWei: "0",
        updatedAt: new Date(),
      });
    }

    // Find or create the Invoice record
    let invoice = await db.orm.public.Invoice
      .where({ invoiceId: rawInv.invoiceId })
      .first();

    if (!invoice) {
      invoice = await db.orm.public.Invoice.create({
        invoiceId: rawInv.invoiceId,
        userAddress: normalizedUser,
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

    if (!isAddress(invoice.payee)) {
      await db.orm.public.Invoice
        .where({ id: invoice.id })
        .update({
          status: InvoiceStatus.FAILED,
          errorReason: `Invalid payee address: ${invoice.payee}`,
          updatedAt: new Date(),
        });
      continue;
    }

    // Re-read latest per-user balance before spending
    const latestFunding = await db.orm.public.UserFunding
      .where({ userAddress: normalizedUser })
      .first();

    const funded = BigInt(latestFunding?.fundedBalanceWei ?? "0");
    const spent = BigInt(latestFunding?.spentBalanceWei ?? "0");
    const available = funded - spent;

    if (available < amountWei) {
      await db.orm.public.Invoice
        .where({ id: invoice.id })
        .update({
          status: InvoiceStatus.INSUFFICIENT_FUNDS,
          errorReason: `Insufficient user balance: available=${available.toString()} wei, required=${amountWei.toString()} wei`,
          updatedAt: new Date(),
        });
      console.warn(
        `Skipping invoice ${invoice.invoiceId} for ${normalizedUser}: insufficient funded balance.`,
      );
      continue;
    }

    try {
      // 1. Simulate payBill on-chain
      const { request } = await evmClient.publicClient.simulateContract({
        address: vaultAddress,
        abi: vaultAbi,
        functionName: "payBill",
        args: [invoice.payee as `0x${string}`, amountWei, invoice.invoiceId],
        account: agentAccount,
      });

      // 2. Broadcast and wait for receipt
      const txHash = await walletClient.writeContract(request);
      await evmClient.publicClient.waitForTransactionReceipt({ hash: txHash });

      // 3. Update user's spent balance and mark invoice PAID
      await db.orm.public.UserFunding
        .where({ userAddress: normalizedUser })
        .update({
          spentBalanceWei: (spent + amountWei).toString(),
          updatedAt: new Date(),
        });

      await db.orm.public.Invoice
        .where({ id: invoice.id })
        .update({
          status: InvoiceStatus.PAID,
          txHash,
          errorReason: null,
          paidAt: new Date(),
          updatedAt: new Date(),
        });

      console.log(
        `Paid invoice ${invoice.invoiceId} for ${normalizedUser} -> ${invoice.payee}, tx: ${txHash}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.orm.public.Invoice
        .where({ id: invoice.id })
        .update({
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