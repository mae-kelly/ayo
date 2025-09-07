// hardhat.config.ts
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-verify";
import "hardhat-gas-reporter";
import "solidity-coverage";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Get private key from environment or use a valid dummy key for local testing
// The dummy key below is valid but has no funds - DO NOT use for mainnet
const PRIVATE_KEY = process.env.PRIVATE_KEY || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// Validate private key format
if (PRIVATE_KEY.length !== 66 || !PRIVATE_KEY.startsWith("0x")) {
  console.error("ERROR: Invalid private key format in .env file!");
  console.error("Private key must be 66 characters long (0x + 64 hex characters)");
  console.error("Current length:", PRIVATE_KEY.length);
  console.error("Run this to generate a valid key:");
  console.error("node -e \"const {ethers} = require('ethers'); const w = ethers.Wallet.createRandom(); console.log('PRIVATE_KEY=' + w.privateKey);\"");
  process.exit(1);
}

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.19",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1000000, // Optimize for many runs on L2s
      },
      viaIR: true, // Enable IR-based optimization
      metadata: {
        bytecodeHash: "none", // Reduce contract size
      },
    },
  },
  networks: {
    // Local development network
    hardhat: {
      chainId: 31337,
      gasPrice: 0,
      initialBaseFeePerGas: 0,
      loggingEnabled: false,
    },
    
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    
    // zkSync Era Mainnet - HIGHEST PRIORITY (0.25% profit margins)
    zksync: {
      url: process.env.ZKSYNC_RPC_URL || "https://mainnet.era.zksync.io",
      accounts: [PRIVATE_KEY],
      chainId: 324,
      gasPrice: 100000000, // 0.1 gwei
      // zkSync specific verification
      ethNetwork: "mainnet",
      verifyURL: "https://zksync2-mainnet-explorer.zksync.io/contract_verification",
    },
    
    // Base Mainnet - HIGH PRIORITY (growth potential)
    base: {
      url: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      accounts: [PRIVATE_KEY],
      chainId: 8453,
      gasPrice: 50000000, // 0.05 gwei
    },
    
    // Arbitrum One - OPTIONAL (mature, lower margins)
    arbitrum: {
      url: process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
      accounts: [PRIVATE_KEY],
      chainId: 42161,
      gasPrice: 100000000, // 0.1 gwei
    },
    
    // Optimism Mainnet - OPTIONAL
    optimism: {
      url: process.env.OPTIMISM_RPC_URL || "https://mainnet.optimism.io",
      accounts: [PRIVATE_KEY],
      chainId: 10,
      gasPrice: 50000000, // 0.05 gwei
    },
    
    // Test Networks (optional)
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://eth-sepolia.g.alchemy.com/v2/demo",
      accounts: [PRIVATE_KEY],
      chainId: 11155111,
    },
    
    "zksync-testnet": {
      url: "https://testnet.era.zksync.dev",
      accounts: [PRIVATE_KEY],
      chainId: 280,
      ethNetwork: "goerli",
      verifyURL: "https://zksync2-testnet-explorer.zksync.dev/contract_verification",
    },
    
    "base-goerli": {
      url: "https://goerli.base.org",
      accounts: [PRIVATE_KEY],
      chainId: 84531,
    },
  },
  
  etherscan: {
    apiKey: {
      // Mainnets
      mainnet: process.env.ETHERSCAN_API_KEY || "YOUR_ETHERSCAN_API_KEY",
      arbitrumOne: process.env.ARBITRUM_ETHERSCAN_KEY || "YOUR_ARBISCAN_API_KEY",
      optimisticEthereum: process.env.OPTIMISM_ETHERSCAN_KEY || "YOUR_OPTIMISM_API_KEY",
      base: process.env.BASE_ETHERSCAN_KEY || "YOUR_BASESCAN_API_KEY",
      
      // Testnets
      sepolia: process.env.ETHERSCAN_API_KEY || "YOUR_ETHERSCAN_API_KEY",
    },
    customChains: [
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.basescan.org/api",
          browserURL: "https://basescan.org",
        },
      },
      {
        network: "zksync",
        chainId: 324,
        urls: {
          apiURL: "https://api-era.zksync.network/api",
          browserURL: "https://explorer.zksync.io",
        },
      },
    ],
  },
  
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    gasPrice: 100, // gwei
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
    excludeContracts: [],
    src: "./contracts",
    outputFile: process.env.GAS_REPORT_FILE,
    noColors: false,
  },
  
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  
  mocha: {
    timeout: 40000,
  },
  
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
    alwaysGenerateOverloads: false,
    externalArtifacts: ["externalArtifacts/*.json"],
    dontOverrideCompile: false,
  },
};

export default config;