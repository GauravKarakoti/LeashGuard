import {
  addressesFrom20,
  derivePqcCanonical,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { evmAccountFromPrivateKey } from "@qorechain/evm";
import { hexToBytes, toHex, type Hex } from "viem";
import { loadNativeAccount } from "./native";

/**
 * The EVM-side identity of your wallet key: the same secp256k1 key, but its
 * address is keccak256(pubkey) (0x4BB3…4cc6 / qor1fwen…). This is the account
 * a plain eth_sendRawTransaction is signed as. Built as a UnifiedAccount so the
 * SDK's EthNativeSigner can sign the Cosmos-lane messages (register key, open
 * window) the chain demands for it.
 */
export async function loadEvmIdentity(mnemonic: string) {
  const { account: native } = await loadNativeAccount(mnemonic);
  const privateKey = toHex(native.privateKey) as Hex;
  const viemAccount = evmAccountFromPrivateKey(privateKey);

  const addr = addressesFrom20(hexToBytes(viemAccount.address));
  const unified: UnifiedAccount = {
    ...addr,
    privateKey,
    publicKey: toHex(native.publicKey),
    pqc: derivePqcCanonical(addr.cosmos, mnemonic),
  };
  return { unified, viemAccount, native };
}
