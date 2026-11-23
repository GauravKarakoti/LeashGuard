import "dotenv/config";
import { StargateClient } from "@cosmjs/stargate";
import {
  buildRegisterPqcKeyMsg,
  closeEvmWindowMsg,
  createClient,
  EthNativeSigner,
  fetchEvmWindow,
  fetchPqcStatus,
  openEvmWindowMsg,
  qorechainRegistry,
  resolveSignBytesVersion,
  signProofOfPossession,
} from "@qorechain/sdk";
import { createEvmClient, deployContract } from "@qorechain/evm";
import { type Abi, type Hex, formatEther, hexToBytes } from "viem";
import PqcKeyChecker from "../artifacts/contracts/PqcKeyChecker.sol/PqcKeyChecker.json";
import { loadEvmIdentity } from "./evm-account";

// Bounds for the EVM authorisation window (value + max fees it may spend), in uqor.
const WINDOW_MAX_UQOR = process.env.WINDOW_MAX_UQOR ?? "1000000"; // 1 QOR
const WINDOW_BLOCKS = Number(process.env.WINDOW_BLOCKS ?? "300");

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
  const chainId = client.network.chainId;
  const { unified, viemAccount } = await loadEvmIdentity(mnemonic);
  const sender = unified.cosmos;

  const evmClient = await createEvmClient({ endpoints: { evmRpc: evmRpcUrl } });
  const balance = await evmClient.publicClient.getBalance({ address: viemAccount.address });
  console.log(`Deployer ${viemAccount.address} (${sender}) balance: ${formatEther(balance)}`);
  if (balance === 0n) {
    throw new Error("No gas on the EVM deployer. Run scripts/fund-evm.ts first.");
  }

  const signBytesVersion = await resolveSignBytesVersion({ chainId, rest: restUrl });
  const stargate = await StargateClient.connect(rpcUrl);

  // Sign + broadcast one Cosmos-lane tx as the EVM identity (fresh sequence each time).
  async function cosmosTx(
    mode: "classical" | "hybrid",
    messages: Parameters<EthNativeSigner["signAndBroadcast"]>[1]["messages"],
    gas: string,
    feeUqor: string,
    memo: string,
  ) {
    const signer = new EthNativeSigner(unified, {
      registry: qorechainRegistry(),
      signMode: mode,
      signBytesVersion,
      rest: restUrl,
    });
    const authRes = await client.rest.get<{
      account?: {
        account_number?: string;
        sequence?: string;
        base_account?: { account_number?: string; sequence?: string };
      };
    }>(`/cosmos/auth/v1beta1/accounts/${sender}`);
    const base = authRes.account?.base_account ?? authRes.account;
    const res = await signer.signAndBroadcast(stargate, {
      chainId,
      accountNumber: BigInt(base?.account_number ?? "0"),
      sequence: BigInt(base?.sequence ?? "0"),
      messages,
      fee: { amount: [{ denom: "uqor", amount: feeUqor }], gas },
      memo,
    });
    console.log(`  ${memo}: txHash ${res.transactionHash} code ${res.code}`);
    if (res.code !== 0) throw new Error(`${memo} failed with code ${res.code}`);
    return res;
  }

  let windowOpened = false;
  try {
    // 1. A registered PQC key for the EVM account (bootstrap tx is classical-signed).
    const status = await fetchPqcStatus({ rest: restUrl, address: sender });
    if (status.registered) {
      console.log("PQC key already registered for", sender);
    } else {
      console.log("Registering PQC key for", sender, "...");
      const proofOfPossession = signProofOfPossession({
        chainId,
        account: sender,
        keypair: unified.pqc,
      });
      const registerMsg = buildRegisterPqcKeyMsg(sender, {
        pqcKeypair: unified.pqc,
        ecdsaPubkey: hexToBytes(unified.publicKey as Hex),
        keyType: "hybrid",
        proofOfPossession,
      });
      await cosmosTx("classical", [registerMsg], "700000", "140000", "register PQC key");
    }

    // 2. Open a bounded authorisation window (needs the PQC key, so hybrid-signed).
    console.log(`Opening EVM window (${WINDOW_BLOCKS} blocks, 1 tx, max ${WINDOW_MAX_UQOR} uqor)...`);
    await cosmosTx(
      "hybrid",
      [
        openEvmWindowMsg({
          sender,
          blocks: WINDOW_BLOCKS,
          maxTxs: 1,
          maxValue: WINDOW_MAX_UQOR,
        }),
      ],
      "600000",
      "120000",
      "open EVM window",
    );
    windowOpened = true;

    // 3. The standard EVM deployment (opening the window advanced the nonce; viem re-reads it).
    const walletClient = evmClient.getWalletClient(viemAccount);
    const txHash = await deployContract(walletClient, {
      abi: PqcKeyChecker.abi as Abi,
      bytecode: PqcKeyChecker.bytecode as Hex,
      args: [],
    });
    console.log("Deployment txHash (0x):", txHash);
    const receipt = await evmClient.publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log("Status:", receipt.status, "Contract address:", receipt.contractAddress);
  } finally {
    // 4. Always revoke the window so the classical key cannot keep spending.
    if (windowOpened) {
      try {
        const w = await fetchEvmWindow({ rest: restUrl, address: sender });
        if ((w as { found?: boolean }).found !== false) {
          await cosmosTx("hybrid", [closeEvmWindowMsg(sender)], "500000", "100000", "close EVM window");
        }
      } catch (e) {
        console.error("Could not close the window automatically:", e instanceof Error ? e.message : e);
      }
    }
    stargate.disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
