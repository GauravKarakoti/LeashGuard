import { createClient, deriveNativeAccount } from "@qorechain/sdk";
import { signHybrid } from "@qorechain/qoresign";
import { createEvmClient } from "@qorechain/evm";
import { AgentVaultAbi } from "../../artifacts/AgentVault";
import invoices from "../invoices.json"; // mock invoice list

const client = createClient({
  network: "testnet",
  endpoints: {
    rest: process.env.QORE_REST_URL,
    evmRpc: process.env.QORE_EVM_RPC_URL,
  },
});

const evmClient = await createEvmClient({
  endpoints: { evmRpc: process.env.QORE_EVM_RPC_URL! },
});

// Derive the agent's account from mnemonic
const agentAccount = await deriveNativeAccount(process.env.AGENT_MNEMONIC!);

async function processInvoices() {
  for (const invoice of invoices) {
    const { payee, amount, invoiceId } = invoice;

    // 1. Simulate the payBill call
    const { request } = await evmClient.simulateContract({
      address: process.env.AGENT_VAULT_ADDRESS as `0x${string}`,
      abi: AgentVaultAbi,
      functionName: "payBill",
      args: [payee, BigInt(amount), invoiceId],
      account: agentAccount.address,
    });

    // 2. If simulation succeeds, sign hybridly and broadcast
    const signedTx = await signHybrid({
      chainId: "qorechain-diana",
      accountNumber: agentAccount.accountNumber,
      bodyBytes: request.data,       // simplified; actual bytes from tx builder
      authInfoBytes: request.authInfo,
      classicalKey: agentAccount.classicalKey,
      pqKey: agentAccount.pqKey,
    });

    const txHash = await evmClient.sendRawTransaction({
      serializedTransaction: signedTx.txBytes,
    });

    console.log(`Paid invoice ${invoiceId} to ${payee}, tx: ${txHash}`);
  }
}

processInvoices().catch(console.error);