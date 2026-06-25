import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-viem";
import "@nomicfoundation/hardhat-ignition-viem";

// Load .env if present
import "dotenv/config";

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    // Local hardhat network (default)
    hardhat: {
      chainId: 31337,
    },

    // Sepolia testnet
    sepolia: {
      url: SEPOLIA_RPC,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 11155111,
    },

    // Ritual testnet (update RPC when available)
    ritual: {
      url: process.env.RITUAL_RPC_URL || "https://rpc.ritual.net",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: parseInt(process.env.RITUAL_CHAIN_ID || "4700"),
    },
  },
};

export default config;
