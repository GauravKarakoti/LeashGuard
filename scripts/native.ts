import {
  deriveNativeAccount,
  derivePqcCanonical,
  derivePqcLegacy,
  directSignerFromPrivateKey,
  fetchPqcStatus,
  pqcStatusPublicKey,
  type PqcKeypair,
} from "@qorechain/sdk";

/** Your wallet: derived on the native path m/44'/118'/0'/0/0. */
export const TARGET_QOR_ADDRESS = "qor1qnaxe49mthxw2ftj4xrzy9ll5r2f09g4nejf7c";

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export async function loadNativeAccount(mnemonic: string) {
  const account = await deriveNativeAccount(mnemonic, { accountIndex: 0 });
  if (account.address !== TARGET_QOR_ADDRESS) {
    throw new Error(
      `Derived ${account.address}, expected ${TARGET_QOR_ADDRESS}. Check OWNER_MNEMONIC.`,
    );
  }
  const signer = await directSignerFromPrivateKey(account.privateKey, "qor");
  return { account, signer };
}

/**
 * Finds the PQC keypair that matches what is registered on-chain.
 * If nothing is registered, returns the canonical key with
 * includePqcPublicKey=true so the chain auto-registers it on first use.
 */
export async function resolvePqcKey(
  address: string,
  mnemonic: string,
  rest: string,
): Promise<{ pqcKeypair: PqcKeypair; includePqcPublicKey: boolean }> {
  const candidates = [
    { name: "canonical", kp: derivePqcCanonical(address, mnemonic) },
    { name: "legacy", kp: derivePqcLegacy(mnemonic) },
  ];
  const status = await fetchPqcStatus({ rest, address });

  if (!status.registered) {
    console.log("No PQC key registered; embedding canonical key for auto-registration.");
    return { pqcKeypair: candidates[0].kp, includePqcPublicKey: true };
  }
  const onChain = pqcStatusPublicKey(status);
  const match = onChain && candidates.find((c) => same(c.kp.publicKey, onChain));
  if (!match) {
    throw new Error(
      "A PQC key is registered for this account but matches neither the canonical nor legacy derivation from your mnemonic.",
    );
  }
  console.log(`Registered PQC key matches the ${match.name} derivation.`);
  return { pqcKeypair: match.kp, includePqcPublicKey: false };
}
