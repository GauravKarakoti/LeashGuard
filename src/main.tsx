import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, http } from "wagmi";
import { defineChain } from "viem";
import { qorechainTestnet } from "@qorechain/evm";

import App from "./App";
import './index.css'

const queryClient = new QueryClient();

const evmRpcUrl =
  import.meta.env.VITE_QORE_EVM_RPC_URL ?? qorechainTestnet.rpcUrls.default.http[0];

const qoreTestnetChain = defineChain({
  id: qorechainTestnet.id,
  name: qorechainTestnet.name,
  nativeCurrency: qorechainTestnet.nativeCurrency,
  rpcUrls: {
    default: {
      http: [evmRpcUrl],
      webSocket: qorechainTestnet.rpcUrls.default.webSocket,
    },
  },
  blockExplorers: qorechainTestnet.blockExplorers,
  testnet: true,
});

const wagmiConfig = createConfig({
  chains: [qoreTestnetChain],
  transports: {
    [qoreTestnetChain.id]: http(evmRpcUrl),
  },
});

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element #root not found");
}

createRoot(container).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);