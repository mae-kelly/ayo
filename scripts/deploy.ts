import { ethers, run, network } from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  console.log("🚀 Starting deployment process...");
  console.log(`📍 Network: ${network.name}`);
  
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  
  console.log(`👤 Deploying contracts with account: ${deployer.address}`);
  console.log(`💰 Account balance: ${ethers.formatEther(balance)} ETH`);
  
  // Check if we have enough balance for deployment
  const minBalance = ethers.parseEther("0.01");
  if (balance < minBalance) {
    throw new Error(`Insufficient balance. Need at least 0.01 ETH for deployment`);
  }
  
  // Network-specific configurations
  const networkConfigs: Record<string, any> = {
    zksync: {
      addressProvider: "0x36615Cf349d7F6344891B1e7CA7C72883F5dc049",
      balancerVault: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
      weth: "0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91",
    },
    base: {
      addressProvider: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
      balancerVault: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
      weth: "0x4200000000000000000000000000000000000006",
    },
    arbitrum: {
      addressProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
      balancerVault: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
      weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    },
    optimism: {
      addressProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
      balancerVault: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
      weth: "0x4200000000000000000000000000000000000006",
    },
    hardhat: {
      // For local testing - using zkSync addresses
      addressProvider: "0x36615Cf349d7F6344891B1e7CA7C72883F5dc049",
      balancerVault: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
      weth: "0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91",
    },
  };
  
  const config = networkConfigs[network.name];
  if (!config) {
    throw new Error(`No configuration found for network: ${network.name}`);
  }
  
  console.log("\n📋 Deployment Configuration:");
  console.log(`  Address Provider: ${config.addressProvider}`);
  console.log(`  Balancer Vault: ${config.balancerVault}`);
  console.log(`  WETH: ${config.weth}`);
  
  // Deploy FlashLoanArbitrage contract
  console.log("\n📦 Deploying FlashLoanArbitrage contract...");
  const FlashLoanArbitrage = await ethers.getContractFactory("FlashLoanArbitrage");
  const flashLoanArbitrage = await FlashLoanArbitrage.deploy(config.addressProvider);
  
  await flashLoanArbitrage.waitForDeployment();
  const flashLoanAddress = await flashLoanArbitrage.getAddress();
  console.log(`✅ FlashLoanArbitrage deployed to: ${flashLoanAddress}`);
  
  // Deploy MultiDexArbitrage contract
  console.log("\n📦 Deploying MultiDexArbitrage contract...");
  const MultiDexArbitrage = await ethers.getContractFactory("MultiDexArbitrage");
  const multiDexArbitrage = await MultiDexArbitrage.deploy(config.addressProvider);
  
  await multiDexArbitrage.waitForDeployment();
  const multiDexAddress = await multiDexArbitrage.getAddress();
  console.log(`✅ MultiDexArbitrage deployed to: ${multiDexAddress}`);
  
  // Initialize DEX routers whitelist based on network
  console.log("\n🔧 Configuring DEX routers whitelist...");
  const dexRouters = getDexRouters(network.name);
  
  for (const router of dexRouters) {
    try {
      const tx = await multiDexArbitrage.setRouterWhitelist(router.address, true);
      await tx.wait();
      console.log(`  ✅ Whitelisted ${router.name}: ${router.address}`);
    } catch (error) {
      console.log(`  ⚠️ Failed to whitelist ${router.name}: ${error}`);
    }
  }
  
  // Save deployment addresses
  const deploymentInfo = {
    network: network.name,
    chainId: network.config.chainId,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: {
      FlashLoanArbitrage: flashLoanAddress,
      MultiDexArbitrage: multiDexAddress,
    },
    configuration: config,
    dexRouters: dexRouters,
  };
  
  const deploymentsDir = path.join(__dirname, "../deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  
  const deploymentFile = path.join(deploymentsDir, `${network.name}.json`);
  fs.writeFileSync(deploymentFile, JSON.stringify(deploymentInfo, null, 2));
  console.log(`\n💾 Deployment info saved to: ${deploymentFile}`);
  
  // Verify contracts on Etherscan if not on localhost
  if (network.name !== "hardhat" && network.name !== "localhost") {
    console.log("\n🔍 Waiting for block confirmations before verification...");
    await flashLoanArbitrage.deploymentTransaction()?.wait(5);
    
    console.log("📝 Verifying contracts on Etherscan...");
    
    try {
      await run("verify:verify", {
        address: flashLoanAddress,
        constructorArguments: [config.addressProvider],
      });
      console.log(`✅ FlashLoanArbitrage verified`);
    } catch (error: any) {
      if (error.message.includes("already verified")) {
        console.log(`ℹ️ FlashLoanArbitrage already verified`);
      } else {
        console.log(`⚠️ FlashLoanArbitrage verification failed:`, error.message);
      }
    }
    
    try {
      await run("verify:verify", {
        address: multiDexAddress,
        constructorArguments: [config.addressProvider],
      });
      console.log(`✅ MultiDexArbitrage verified`);
    } catch (error: any) {
      if (error.message.includes("already verified")) {
        console.log(`ℹ️ MultiDexArbitrage already verified`);
      } else {
        console.log(`⚠️ MultiDexArbitrage verification failed:`, error.message);
      }
    }
  }
  
  // Print summary
  console.log("\n" + "=".repeat(50));
  console.log("🎉 DEPLOYMENT COMPLETE!");
  console.log("=".repeat(50));
  console.log("\n📋 Summary:");
  console.log(`  Network: ${network.name} (Chain ID: ${network.config.chainId})`);
  console.log(`  FlashLoanArbitrage: ${flashLoanAddress}`);
  console.log(`  MultiDexArbitrage: ${multiDexAddress}`);
  console.log("\n📝 Next Steps:");
  console.log("1. Update your .env file with the contract addresses:");
  console.log(`   ${network.name.toUpperCase()}_ARBITRAGE_CONTRACT=${multiDexAddress}`);
  console.log("2. Fund the bot wallet with ETH for gas");
  console.log("3. Start the bot with: npm start");
  console.log("\n⚠️ Security Reminder:");
  console.log("  - Never share your private keys");
  console.log("  - Test on testnet first");
  console.log("  - Start with small amounts");
  console.log("  - Monitor gas prices");
  console.log("\n" + "=".repeat(50));
}

function getDexRouters(networkName: string): Array<{name: string, address: string}> {
  const routers: Record<string, Array<{name: string, address: string}>> = {
    zksync: [
      { name: "SyncSwap", address: "0x2da10A1e27bF85cEdD8FFb1AbBe97e53391C0295" },
      { name: "Mute.io", address: "0x8B791913eB07C32779a16750e3868aA8495F5964" },
      { name: "SpaceFi", address: "0xbE7D1FD1f6748bbDefC4fbaCafBb11C6Fc506d1d" },
    ],
    base: [
      { name: "Aerodrome", address: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43" },
      { name: "Uniswap V3", address: "0x2626664c2603336E57B271c5C0b26F421741e481" },
      { name: "BaseSwap", address: "0x327Df1E6de05895d2B8cE32fB8AD443504386A35" },
      { name: "SushiSwap", address: "0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891" },
    ],
    arbitrum: [
      { name: "Uniswap V3", address: "0xE592427A0AEce92De3Edee1F18E0157C05861564" },
      { name: "Camelot", address: "0xc873fEcbd354f5A56E00E710B90EF4201db2448d" },
      { name: "SushiSwap", address: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506" },
    ],
    optimism: [
      { name: "Velodrome", address: "0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858" },
      { name: "Uniswap V3", address: "0xE592427A0AEce92De3Edee1F18E0157C05861564" },
    ],
    hardhat: [
      { name: "TestRouter", address: "0x0000000000000000000000000000000000000001" },
    ],
  };
  
  return routers[networkName] || [];
}

// Execute deployment
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Deployment failed!");
    console.error(error);
    process.exit(1);
  });