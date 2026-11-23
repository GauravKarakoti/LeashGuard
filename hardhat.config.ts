import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { defineConfig } from "hardhat/config";

const QORE_EVM_RPC_URL =
  process.env.VITE_QORE_EVM_RPC_URL ?? "https://evm-testnet.qore.host";
const MNEMONIC = process.env.OWNER_MNEMONIC ?? "";

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.24",
      },
      production: {
        version: "0.8.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    qorechainTestnet: {
      type: "http",
      url: QORE_EVM_RPC_URL,
      chainId: 9800,
      accounts: { mnemonic: MNEMONIC, path: "m/44'/60'/0'/0", initialIndex: 0 }
    },
  },
});
