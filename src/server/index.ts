import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import { db } from "../../prisma/db";
import { createEvmClient, type EvmClient } from "@qorechain/evm";
import { isAddress, parseEther, type Hex } from "viem";
import { loadVaultDeployment } from "../agent/agent";

const app = express();
app.use(express.json());

const PORT = Number(process.env.API_PORT ?? 3001);
const API_KEY = process.env.INVOICES_API_KEY;
const { address: AGENT_VAULT_ADDRESS } = loadVaultDeployment();

const InvoiceStatus = {
  PENDING: "PENDING",
  PAID: "PAID",
  FAILED: "FAILED",
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
} as const;

let evmClientPromise: Promise<EvmClient> | null = null;

function getEvmClient(): Promise<EvmClient> {
  if (!evmClientPromise) {
    const evmRpcUrl = process.env.VITE_QORE_EVM_RPC_URL;
    if (!evmRpcUrl) {
      throw new Error(
        "Missing VITE_QORE_EVM_RPC_URL in environment.",
      );
    }
    evmClientPromise = createEvmClient({
      endpoints: { evmRpc: evmRpcUrl },
    });
  }
  return evmClientPromise;
}

function requireApiKey(req: Request, res: Response, next: NextFunction) {
  if (!API_KEY) return next();
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${API_KEY}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

function parseAmountWei(input: { amountWei?: string; amountQor?: string }): bigint {
  if (input.amountWei !== undefined && input.amountWei !== "") {
    const val = BigInt(input.amountWei);
    if (val <= 0n) throw new Error("amountWei must be greater than 0");
    return val;
  }
  if (input.amountQor !== undefined && input.amountQor !== "") {
    const val = parseEther(input.amountQor);
    if (val <= 0n) throw new Error("amountQor must be greater than 0");
    return val;
  }
  throw new Error("Provide either amountQor or amountWei");
}

// Execute a @prisma/orm-postgres Collection query cleanly across versions
async function execCollection<T>(collection: unknown): Promise<T[]> {
  const c = collection as {
    all?: () => Promise<T[]>;
    run?: () => Promise<T[]>;
    [Symbol.asyncIterator]?: () => AsyncIterator<T>;
  };

  if (typeof c.all === "function") {
    return c.all();
  }
  if (typeof c.run === "function") {
    return c.run();
  }
  if (typeof c[Symbol.asyncIterator] === "function") {
    const items: T[] = [];
    for await (const row of collection as AsyncIterable<T>) {
      items.push(row);
    }
    return items;
  }
  throw new Error("Unsupported @prisma/orm-postgres Collection execution method");
}

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// Agent fetches pending/retryable invoices from this URL
app.get(
  "/api/invoices/pending",
  requireApiKey,
  async (_req: Request, res: Response) => {
    try {
      const pendingRows = await execCollection<{
        invoiceId: string;
        userAddress: string;
        payee: string;
        amountWei: string;
        status: string;
      }>(db.orm.public.Invoice.where({ status: InvoiceStatus.PENDING }));

      const insufficientRows = await execCollection<{
        invoiceId: string;
        userAddress: string;
        payee: string;
        amountWei: string;
        status: string;
      }>(
        db.orm.public.Invoice.where({
          status: InvoiceStatus.INSUFFICIENT_FUNDS,
        }),
      );

      const invoices = [...pendingRows, ...insufficientRows].map((inv) => ({
        invoiceId: inv.invoiceId,
        userAddress: inv.userAddress,
        payee: inv.payee,
        amountWei: inv.amountWei,
      }));

      res.json({ invoices });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

// Create a real invoice
app.post("/api/invoices", async (req: Request, res: Response) => {
  try {
    const { invoiceId, userAddress, payee, amountQor, amountWei } = req.body as {
      invoiceId?: string;
      userAddress?: string;
      payee?: string;
      amountQor?: string;
      amountWei?: string;
    };

    if (!invoiceId || !userAddress || !payee) {
      res.status(400).json({
        error: "invoiceId, userAddress, and payee are required",
      });
      return;
    }

    if (!isAddress(userAddress) || !isAddress(payee)) {
      res.status(400).json({
        error: "userAddress and payee must be valid EVM addresses",
      });
      return;
    }

    const parsedAmountWei = parseAmountWei({ amountQor, amountWei });
    const normalizedUser = userAddress.toLowerCase();
    const normalizedPayee = payee as `0x${string}`;

    const existing = await db.orm.public.Invoice
      .where({ invoiceId })
      .first();

    if (existing) {
      res.status(409).json({ error: "Invoice already exists", invoice: existing });
      return;
    }

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

    const created = await db.orm.public.Invoice.create({
      invoiceId,
      userAddress: normalizedUser,
      payee: normalizedPayee,
      amountWei: parsedAmountWei.toString(),
      status: InvoiceStatus.PENDING,
      txHash: null,
      errorReason: null,
      paidAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    res.status(201).json({ invoice: created });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// Verify on-chain deposit tx and credit user's fundedBalanceWei persistently
app.post("/api/funding", async (req: Request, res: Response) => {
  try {
    const { userAddress, txHash } = req.body as {
      userAddress?: string;
      txHash?: string;
    };

    if (!userAddress || !isAddress(userAddress)) {
      res.status(400).json({ error: "Valid userAddress is required" });
      return;
    }

    if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      res.status(400).json({ error: "Valid 0x transaction hash is required" });
      return;
    }

    const normalizedTx = txHash.toLowerCase() as Hex;

    // Persistent replay check against FundingDeposit table
    const existingDeposit = await db.orm.public.FundingDeposit
      .where({ txHash: normalizedTx })
      .first();

    if (existingDeposit) {
      res.status(409).json({
        error: "Funding transaction already credited",
        deposit: existingDeposit,
      });
      return;
    }

    const evmClient = await getEvmClient();
    const receipt = await evmClient.publicClient.getTransactionReceipt({
      hash: normalizedTx,
    });

    if (receipt.status !== "success") {
      res.status(400).json({ error: "On-chain transaction did not succeed" });
      return;
    }

    const tx = await evmClient.publicClient.getTransaction({
      hash: normalizedTx,
    });

    const normalizedUser = userAddress.toLowerCase();
    if (tx.from.toLowerCase() !== normalizedUser) {
      res.status(400).json({
        error: "Transaction sender does not match userAddress",
      });
      return;
    }

    if (
      AGENT_VAULT_ADDRESS &&
      tx.to?.toLowerCase() !== AGENT_VAULT_ADDRESS
    ) {
      res.status(400).json({
        error: "Transaction recipient does not match AgentVault address",
      });
      return;
    }

    const creditedWei = tx.value;
    if (creditedWei <= 0n) {
      res.status(400).json({ error: "Transaction value must be greater than 0" });
      return;
    }

    let funding = await db.orm.public.UserFunding
      .where({ userAddress: normalizedUser })
      .first();

    if (!funding) {
      funding = await db.orm.public.UserFunding.create({
        userAddress: normalizedUser,
        fundedBalanceWei: creditedWei.toString(),
        spentBalanceWei: "0",
        updatedAt: new Date(),
      });
    } else {
      const nextFunded = BigInt(funding.fundedBalanceWei) + creditedWei;
      funding = await db.orm.public.UserFunding
        .where({ userAddress: normalizedUser })
        .update({
          fundedBalanceWei: nextFunded.toString(),
          updatedAt: new Date(),
        });
    }

    const deposit = await db.orm.public.FundingDeposit.create({
      txHash: normalizedTx,
      userAddress: normalizedUser,
      amountWei: creditedWei.toString(),
      createdAt: new Date(),
    });

    const remainingWei =
      BigInt(funding!.fundedBalanceWei) - BigInt(funding!.spentBalanceWei);

    res.status(200).json({
      creditedWei: creditedWei.toString(),
      txHash: normalizedTx,
      deposit,
      funding: {
        userAddress: funding!.userAddress,
        fundedBalanceWei: funding!.fundedBalanceWei,
        spentBalanceWei: funding!.spentBalanceWei,
        remainingBalanceWei: remainingWei.toString(),
      },
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// Check a user's funded, spent, and remaining balance
app.get("/api/funding/:userAddress", async (req: Request, res: Response) => {
  try {
    const rawAddr = req.params.userAddress;
    if (!isAddress(rawAddr as string)) {
      res.status(400).json({ error: "Invalid userAddress" });
      return;
    }

    const normalizedUser = (rawAddr as string).toLowerCase();
    const funding = await db.orm.public.UserFunding
      .where({ userAddress: normalizedUser })
      .first();

    const funded = BigInt(funding?.fundedBalanceWei ?? "0");
    const spent = BigInt(funding?.spentBalanceWei ?? "0");
    const remaining = funded - spent;

    res.json({
      userAddress: normalizedUser,
      fundedBalanceWei: funded.toString(),
      spentBalanceWei: spent.toString(),
      remainingBalanceWei: remaining.toString(),
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.listen(PORT, () => {
  console.log(`Invoice API server listening on http://localhost:${PORT}`);
});