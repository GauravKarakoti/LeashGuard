import "dotenv/config";
import crypto from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { db } from "../../prisma/db";
import { createEvmClient, type EvmClient } from "@qorechain/evm";
import { isAddress, parseEther, type Hex } from "viem";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors())

const PORT = Number(process.env.API_PORT ?? 3001);
const API_KEY = process.env.INVOICES_API_KEY;
const ENCRYPTION_SECRET = process.env.BOT_KEY_ENCRYPTION_SECRET;

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
      throw new Error("Missing VITE_QORE_EVM_RPC_URL in environment.");
    }
    evmClientPromise = createEvmClient({
      endpoints: { evmRpc: evmRpcUrl },
    });
  }
  return evmClientPromise;
}

function getCipherKey(): Buffer {
  if (!ENCRYPTION_SECRET) {
    throw new Error("Missing BOT_KEY_ENCRYPTION_SECRET in environment.");
  }
  return crypto.createHash("sha256").update(ENCRYPTION_SECRET).digest();
}

export function encryptMnemonic(plainText: string): string {
  const key = getCipherKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptMnemonic(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted mnemonic format");
  }
  const [ivHex, tagHex, dataHex] = parts;
  const key = getCipherKey();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
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

async function execCollection<T>(collection: unknown): Promise<T[]> {
  const c = collection as {
    all?: () => Promise<T[]>;
    run?: () => Promise<T[]>;
    [Symbol.asyncIterator]?: () => AsyncIterator<T>;
  };

  if (typeof c.all === "function") return c.all();
  if (typeof c.run === "function") return c.run();
  if (typeof c[Symbol.asyncIterator] === "function") {
    const items: T[] = [];
    for await (const row of collection as AsyncIterable<T>) {
      items.push(row);
    }
    return items;
  }
  throw new Error("Unsupported @prisma/orm-postgres Collection execution method");
}

async function ensureUserFunding(vaultAddress: string, userAddress: string) {
  let funding = await db.orm.public.UserFunding
    .where({ vaultAddress, userAddress })
    .first();

  if (!funding) {
    funding = await db.orm.public.UserFunding.create({
      vaultAddress,
      userAddress,
      fundedBalanceWei: "0",
      spentBalanceWei: "0",
      updatedAt: new Date(),
    });
  }
  return funding;
}

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// Register or update a user's deployed vault + bot address + encrypted bot mnemonic in DB
app.post("/api/agents", async (req: Request, res: Response) => {
  try {
    const { vaultAddress, ownerAddress, botAddress, botMnemonic } = req.body as {
      vaultAddress?: string;
      ownerAddress?: string;
      botAddress?: string;
      botMnemonic?: string;
    };

    if (
      !vaultAddress ||
      !ownerAddress ||
      !botAddress ||
      !isAddress(vaultAddress) ||
      !isAddress(ownerAddress) ||
      !isAddress(botAddress)
    ) {
      res.status(400).json({
        error: "Valid vaultAddress, ownerAddress, and botAddress are required",
      });
      return;
    }

    const normVault = vaultAddress.toLowerCase();
    const normOwner = ownerAddress.toLowerCase();
    const normBot = botAddress.toLowerCase();

    const encryptedMnemonic = botMnemonic?.trim()
      ? encryptMnemonic(botMnemonic.trim())
      : undefined;

    const existing = await db.orm.public.AgentBot
      .where({ vaultAddress: normVault })
      .first();

    const agentRecord = existing
      ? await db.orm.public.AgentBot.where({ vaultAddress: normVault }).update({
          ownerAddress: normOwner,
          botAddress: normBot,
          ...(encryptedMnemonic ? { encryptedMnemonic } : {}),
          updatedAt: new Date(),
        })
      : await db.orm.public.AgentBot.create({
          vaultAddress: normVault,
          ownerAddress: normOwner,
          botAddress: normBot,
          encryptedMnemonic: encryptedMnemonic ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });

    await ensureUserFunding(normVault, normOwner);

    res.status(200).json({
      agent: agentRecord
        ? {
            id: agentRecord.id,
            vaultAddress: agentRecord.vaultAddress,
            ownerAddress: agentRecord.ownerAddress,
            botAddress: agentRecord.botAddress,
            hasStoredMnemonic: Boolean(agentRecord.encryptedMnemonic),
            createdAt: agentRecord.createdAt,
            updatedAt: agentRecord.updatedAt,
          }
        : null,
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// Fetch vaults owned by a specific ownerAddress only (mutually exclusive per user)
app.get("/api/agents", async (req: Request, res: Response) => {
  try {
    const rawOwner = req.query.ownerAddress;
    if (typeof rawOwner !== "string" || !isAddress(rawOwner)) {
      res.status(400).json({
        error: "Valid ownerAddress query parameter is required",
      });
      return;
    }

    const normOwner = rawOwner.toLowerCase();
    const agents = await execCollection<{
      id: string;
      vaultAddress: string;
      ownerAddress: string;
      botAddress: string;
      encryptedMnemonic: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>(db.orm.public.AgentBot.where({ ownerAddress: normOwner }));

    res.json({
      agents: agents.map((a) => ({
        id: a.id,
        vaultAddress: a.vaultAddress,
        ownerAddress: a.ownerAddress,
        botAddress: a.botAddress,
        hasStoredMnemonic: Boolean(a.encryptedMnemonic),
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      })),
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// Agent fetches pending/retryable invoices across user vaults
app.get(
  "/api/invoices/pending",
  requireApiKey,
  async (_req: Request, res: Response) => {
    try {
      const pendingRows = await execCollection<{
        invoiceId: string;
        vaultAddress: string;
        userAddress: string;
        payee: string;
        amountWei: string;
        status: string;
      }>(db.orm.public.Invoice.where({ status: InvoiceStatus.PENDING }));

      const insufficientRows = await execCollection<{
        invoiceId: string;
        vaultAddress: string;
        userAddress: string;
        payee: string;
        amountWei: string;
        status: string;
      }>(
        db.orm.public.Invoice.where({
          status: InvoiceStatus.INSUFFICIENT_FUNDS,
        }),
      );

      const agents = await execCollection<{
        vaultAddress: string;
        botAddress: string;
      }>(db.orm.public.AgentBot);

      const botByVault = new Map(
        agents.map((a) => [a.vaultAddress.toLowerCase(), a.botAddress]),
      );

      const invoices = [...pendingRows, ...insufficientRows].map((inv) => ({
        invoiceId: inv.invoiceId,
        vaultAddress: inv.vaultAddress,
        botAddress: botByVault.get(inv.vaultAddress.toLowerCase()) ?? null,
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

// Create a real invoice for a user's vault
app.post("/api/invoices", async (req: Request, res: Response) => {
  try {
    const { invoiceId, vaultAddress, userAddress, payee, amountQor, amountWei } =
      req.body as {
        invoiceId?: string;
        vaultAddress?: string;
        userAddress?: string;
        payee?: string;
        amountQor?: string;
        amountWei?: string;
      };

    if (!invoiceId || !vaultAddress || !userAddress || !payee) {
      res.status(400).json({
        error: "invoiceId, vaultAddress, userAddress, and payee are required",
      });
      return;
    }

    if (
      !isAddress(vaultAddress) ||
      !isAddress(userAddress) ||
      !isAddress(payee)
    ) {
      res.status(400).json({
        error: "vaultAddress, userAddress, and payee must be valid EVM addresses",
      });
      return;
    }

    const parsedAmountWei = parseAmountWei({ amountQor, amountWei });
    const normVault = vaultAddress.toLowerCase();
    const normUser = userAddress.toLowerCase();
    const normPayee = payee as `0x${string}`;

    const existing = await db.orm.public.Invoice
      .where({ invoiceId })
      .first();

    if (existing) {
      res.status(409).json({ error: "Invoice already exists", invoice: existing });
      return;
    }

    const agentBot = await db.orm.public.AgentBot
      .where({ vaultAddress: normVault })
      .first();

    if (!agentBot) {
      res.status(404).json({
        error: "Vault not registered. Register the user's agent/vault first.",
      });
      return;
    }

    await ensureUserFunding(normVault, normUser);

    const created = await db.orm.public.Invoice.create({
      invoiceId,
      vaultAddress: normVault,
      userAddress: normUser,
      payee: normPayee,
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

// Verify on-chain deposit tx into user's vault/bot and credit their balance
app.post("/api/funding", async (req: Request, res: Response) => {
  try {
    const { vaultAddress, userAddress, txHash } = req.body as {
      vaultAddress?: string;
      userAddress?: string;
      txHash?: string;
    };

    if (!vaultAddress || !isAddress(vaultAddress)) {
      res.status(400).json({ error: "Valid vaultAddress is required" });
      return;
    }

    if (!userAddress || !isAddress(userAddress)) {
      res.status(400).json({ error: "Valid userAddress is required" });
      return;
    }

    if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      res.status(400).json({ error: "Valid 0x transaction hash is required" });
      return;
    }

    const normalizedTx = txHash.toLowerCase() as Hex;
    const normVault = vaultAddress.toLowerCase();
    const normUser = userAddress.toLowerCase();

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

    const agentBot = await db.orm.public.AgentBot
      .where({ vaultAddress: normVault })
      .first();

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

    if (tx.from.toLowerCase() !== normUser) {
      res.status(400).json({
        error: "Transaction sender does not match userAddress",
      });
      return;
    }

    const allowedRecipients = new Set<string>([normVault]);
    if (agentBot?.botAddress) {
      allowedRecipients.add(agentBot.botAddress.toLowerCase());
    }

    if (!tx.to || !allowedRecipients.has(tx.to.toLowerCase())) {
      res.status(400).json({
        error:
          "Transaction recipient must match the user's AgentVault or bot address",
      });
      return;
    }

    const creditedWei = tx.value;
    if (creditedWei <= 0n) {
      res.status(400).json({ error: "Transaction value must be greater than 0" });
      return;
    }

    const currentFunding = await ensureUserFunding(normVault, normUser);
    const nextFunded = BigInt(currentFunding.fundedBalanceWei) + creditedWei;

    const updatedFunding = await db.orm.public.UserFunding
      .where({ vaultAddress: normVault, userAddress: normUser })
      .update({
        fundedBalanceWei: nextFunded.toString(),
        updatedAt: new Date(),
      });

    if (!updatedFunding) {
      res.status(500).json({ error: "Failed to update user funding balance" });
      return;
    }

    const deposit = await db.orm.public.FundingDeposit.create({
      txHash: normalizedTx,
      vaultAddress: normVault,
      userAddress: normUser,
      amountWei: creditedWei.toString(),
      createdAt: new Date(),
    });

    const remainingWei =
      BigInt(updatedFunding.fundedBalanceWei) -
      BigInt(updatedFunding.spentBalanceWei);

    res.status(200).json({
      creditedWei: creditedWei.toString(),
      txHash: normalizedTx,
      deposit,
      funding: {
        vaultAddress: updatedFunding.vaultAddress,
        userAddress: updatedFunding.userAddress,
        fundedBalanceWei: updatedFunding.fundedBalanceWei,
        spentBalanceWei: updatedFunding.spentBalanceWei,
        remainingBalanceWei: remainingWei.toString(),
      },
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// Check a user's funded, spent, and remaining balance for a vault
app.get(
  "/api/funding/:vaultAddress/:userAddress",
  async (req: Request, res: Response) => {
    try {
      const rawVault = req.params.vaultAddress as string;
      const rawUser = req.params.userAddress as string;

      if (!isAddress(rawVault) || !isAddress(rawUser)) {
        res.status(400).json({ error: "Invalid vaultAddress or userAddress" });
        return;
      }

      const normVault = rawVault.toLowerCase();
      const normUser = rawUser.toLowerCase();

      const funding = await db.orm.public.UserFunding
        .where({ vaultAddress: normVault, userAddress: normUser })
        .first();

      const funded = BigInt(funding?.fundedBalanceWei ?? "0");
      const spent = BigInt(funding?.spentBalanceWei ?? "0");
      const remaining = funded - spent;

      res.json({
        vaultAddress: normVault,
        userAddress: normUser,
        fundedBalanceWei: funded.toString(),
        spentBalanceWei: spent.toString(),
        remainingBalanceWei: remaining.toString(),
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

app.listen(PORT, () => {
  console.log(`Invoice API server listening on http://localhost:${PORT}`);
});