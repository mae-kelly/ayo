import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-verify";
import "hardhat-gas-reporter";
import "solidity-coverage";
import * as dotenv from "dotenv";

dotenv.config();

// Ensure required environment variables are set
const PRIVATE_KEY = process.env.PRIVATE_KEY || "0x0000000000000000000000000000000000000000000000000000000000000000";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.19",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1000000, // Optimize for many runs on L2s
      },
      viaIR: true, // Enable IR-based optimization for better gas efficiency
      metadata: {
        bytecodeHash: "none", // Reduce contract size
      },
    },
  },
  networks: {
    // Local development network
    hardhat: {
      forking: {
        url: process.env.FORK_URL || process.env.ZKSYNC_RPC_URL || "https://mainnet.era.zksync.io",
        blockNumber: process.env.FORK_BLOCK ? parseInt(process.env.FORK_BLOCK) : undefined,
      },
      chainId: 31337,
      gasPrice: 0,
      initialBaseFeePerGas: 0,
      loggingEnabled: false,
    },
    
    // zkSync Era Mainnet
    zksync: {
      url: process.env.ZKSYNC_RPC_URL || "https://mainnet.era.zksync.io",
      accounts: [PRIVATE_KEY],
      chainId: 324,
      gasPrice: 100000000, // 0.1 gwei
      // zkSync specific settings
      ethNetwork: "mainnet",
      verifyURL: "https://zksync2-mainnet-explorer.zksync.io/contract_verification",
    },
    
    // Base Mainnet
    base: {
      url: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      accounts: [PRIVATE_KEY],
      chainId: 8453,
      gasPrice: 50000000, // 0.05 gwei
    },
    
    // Arbitrum One
    arbitrum: {
      url: process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
      accounts: [PRIVATE_KEY],
      chainId: 42161,
      gasPrice: 100000000, // 0.1 gwei
    },
    
    // Optimism Mainnet
    optimism: {
      url: process.env.OPTIMISM_RPC_URL || "https://mainnet.optimism.io",
      accounts: [PRIVATE_KEY],
      chainId: 10,
      gasPrice: 50000000, // 0.05 gwei
    },
    
    // Test Networks
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.dev",
      accounts: [PRIVATE_KEY],
      chainId: 11155111,
    },
    
    goerli: {
      url: process.env.GOERLI_RPC_URL || "https://goerli.infura.io/v3/YOUR_INFURA_KEY",
      accounts: [PRIVATE_KEY],
      chainId: 5,
    },
  },
  
  etherscan: {
    apiKey: {
      // Mainnets
      mainnet: process.env.ETHERSCAN_API_KEY || "",
      arbitrumOne: process.env.ARBITRUM_ETHERSCAN_KEY || "",
      optimisticEthereum: process.env.OPTIMISM_ETHERSCAN_KEY || "",
      base: process.env.BASE_ETHERSCAN_KEY || "",
      
      // Testnets
      sepolia: process.env.ETHERSCAN_API_KEY || "",
      goerli: process.env.ETHERSCAN_API_KEY || "",
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
}

export default config;