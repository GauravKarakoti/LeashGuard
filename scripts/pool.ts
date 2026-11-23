import "dotenv/config";
import { StargateClient } from "@cosmjs/stargate";
import {
  createClient,
  deriveNativeAccount,
  derivePqcCanonical,
  derivePqcLegacy,
  directSignerFromPrivateKey,
  fetchPqcStatus,
  msg,
  pqcStatusPublicKey,
  qorechainRegistry,
  signAndBroadcastHybrid,
  toBase,
  type PqcKeypair,
} from "@qorechain/sdk";

const TARGET_QOR_ADDRESS = (
  process.env.QORE_SENDER_ADDRESS ?? "qor1qnaxe49mthxw2ftj4xrzy9ll5r2f09g4nejf7c"
).toLowerCase();

const eq = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

interface PoolInfo {
  id: string;
  token_a?: string;
  token_b?: string;
  tokenA?: string;
  tokenB?: string;
}

async function main() {
  const mnemonic = process.env.OWNER_MNEMONIC;
  if (!mnemonic) {
    throw new Error("Missing OWNER_MNEMONIC in environment.");
  }

  const restUrl = process.env.QORE_REST_URL ?? "https://api-testnet.qore.host";
  const rpcUrl = process.env.QORE_RPC_URL ?? "https://rpc-testnet.qore.host";
  const evmRpcUrl =
    process.env.VITE_QORE_EVM_RPC_URL ?? "https://evm-testnet.qore.host";

  const client = createClient({
    network: "testnet",
    endpoints: { rest: restUrl, rpc: rpcUrl, evmRpc: evmRpcUrl },
  });

  // Native derivation path m/44'/118'/0'/0/0
  const account = await deriveNativeAccount(mnemonic, { accountIndex: 0 });
  if (account.address.toLowerCase() !== TARGET_QOR_ADDRESS) {
    throw new Error(
      `Derived ${account.address}, expected ${TARGET_QOR_ADDRESS}`,
    );
  }
  console.log("Matched native account:", account.address);

  const signer = await directSignerFromPrivateKey(account.privateKey, "qor");

  // Resolve PQC keypair (canonical vs legacy) and whether auto-registration is needed
  const status = await fetchPqcStatus({ rest: restUrl, address: account.address });
  const candidates: Array<{ name: string; kp: PqcKeypair }> = [
    { name: "canonical", kp: derivePqcCanonical(account.address, mnemonic) },
    { name: "legacy", kp: derivePqcLegacy(mnemonic) },
  ];

  let pqcKeypair: PqcKeypair;
  let includePqcPublicKey = false;

  if (status.registered) {
    const onChain = pqcStatusPublicKey(status);
    const match = onChain && candidates.find((c) => eq(c.kp.publicKey, onChain));
    if (!match) {
      throw new Error(
        "A PQC key is registered for this account, but it matches neither the canonical nor the legacy derivation from your mnemonic.",
      );
    }
    console.log(`Registered PQC key matches the ${match.name} derivation.`);
    pqcKeypair = match.kp;
  } else {
    console.log(
      "No PQC key registered yet; embedding the canonical key in this tx for auto-registration.",
    );
    pqcKeypair = candidates[0].kp;
    includePqcPublicKey = true;
  }

  // Pick an AMM pool (optionally pinned via QORE_POOL_ID)
  const poolsRes = await client.rest.get<{ pools?: PoolInfo[] }>(
    "/qorechain/amm/v1/pools",
  );
  const pools = poolsRes.pools ?? [];
  const pool = process.env.QORE_POOL_ID
    ? pools.find((p) => String(p.id) === String(process.env.QORE_POOL_ID))
    : pools[0];

  if (!pool) {
    throw new Error("No matching AMM pool found on testnet");
  }

  const denomIn = process.env.QORE_SWAP_DENOM_IN ?? pool.token_a ?? pool.tokenA ?? "uqor";
  const tokenB = pool.token_b ?? pool.tokenB ?? "uqor";
  const tokenA = pool.token_a ?? pool.tokenA ?? "uqor";
  const denomOut = denomIn === tokenA ? tokenB : tokenA;

  // Balance check
  const balRes = await client.rest.getBalance(account.address, denomIn);
  const currentAmt = BigInt(balRes.balance?.amount ?? "0");
  const requestedAmt = BigInt(
    process.env.QORE_SWAP_AMOUNT_UQOR ?? toBase("0.01", { exponent: 6 }),
  );

  if (currentAmt < requestedAmt) {
    throw new Error(
      `${account.address} has ${currentAmt} ${denomIn}, needs at least ${requestedAmt}.`,
    );
  }

  // Account number + sequence
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

  const swapMsg = msg.amm.swapExactIn({
    sender: account.address,
    poolId: String(pool.id),
    tokenIn: { denom: denomIn, amount: requestedAmt.toString() },
    denomOut,
    minOut: "1",
  });

  const stargateClient = await StargateClient.connect(rpcUrl);
  try {
    const result = await signAndBroadcastHybrid({
      registry: qorechainRegistry(),
      signer,
      pqcKeypair,
      includePqcPublicKey,
      messages: [swapMsg],
      fee: { amount: [{ denom: "uqor", amount: "50000" }], gas: "350000" },
      memo: "LeashGuard: swap from specified QoreX account",
      chainId: client.network.chainId,
      accountNumber,
      sequence,
      signBytesVersion: "auto",
      rest: restUrl,
      transport: stargateClient,
    });
    console.log("Swap txHash:", result.transactionHash, "code:", result.code);
  } finally {
    stargateClient.disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});