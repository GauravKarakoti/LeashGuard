import "dotenv/config";
import {
  createEvmClient,
  deployContract,
  evmAccountFromPrivateKey,
} from "@qorechain/evm";
import { type Abi, type Hex, formatEther, toHex } from "viem";
import PqcKeyChecker from "../artifacts/contracts/PqcKeyChecker.sol/PqcKeyChecker.json";
import { loadNativeAccount } from "./native";

async function main() {
  const mnemonic = process.env.OWNER_MNEMONIC!;
  const evmRpcUrl =
    process.env.VITE_QORE_EVM_RPC_URL ?? "https://evm-testnet.qore.host";

  // Same secp256k1 key as qor1qnaxe49…, used as an EVM key.
  const { account: native } = await loadNativeAccount(mnemonic);
  const account = evmAccountFromPrivateKey(toHex(native.privateKey) as Hex);

  const evmClient = await createEvmClient({ endpoints: { evmRpc: evmRpcUrl } });

  // NOTE: this 0x address is keccak256(pubkey) and is NOT the 0x form of
  // qor1qnaxe49… (that one is ripemd160(sha256(pubkey))), so it is a separate
  // balance that has to hold gas.
  const balance = await evmClient.publicClient.getBalance({ address: account.address });
  console.log("Deployer (EVM):", account.address, "balance:", formatEther(balance));
  if (balance === 0n) {
    throw new Error(
      `EVM account ${account.address} has no gas. Fund it first (faucet or a transfer from ${native.address}).`,
    );
  }

  const walletClient = evmClient.getWalletClient(account);
  const txHash = await deployContract(walletClient, {
    abi: PqcKeyChecker.abi as Abi,
    bytecode: PqcKeyChecker.bytecode as Hex,
    args: [],
  });

  const receipt = await evmClient.publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log("Deployment txHash (0x):", txHash);
  console.log("Contract address:", receipt.contractAddress);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
