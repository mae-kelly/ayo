import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  console.log("🚀 Starting deployment process...");
  console.log(`📍 Network: ${network.name}`);
  
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  
  console.log(`👤 Deploying with account: ${deployer.address}`);
  console.log(`💰 Account balance: ${ethers.formatEther(balance)} ETH`);
  
  const minBalance = ethers.parseEther("0.01");
  if (balance < minBalance) {
    throw new Error(`Insufficient balance. Need at least 0.01 ETH for deployment`);
  }
  
  const networkConfigs: Record<string, any> = {
    zksync: {
      addressProvider: "0x36615Cf349d7F6344891B1e7CA7C72883F5dc049",
      name: "zkSync Era",
    },
    base: {
      addressProvider: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
      name: "Base",
    },
    arbitrum: {
      addressProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
      name: "Arbitrum",
    },
  };
  
  const config = networkConfigs[network.name] || networkConfigs.zksync;
  
  console.log(`\n📋 Deploying to ${config.name}`);
  console.log(`Address Provider: ${config.addressProvider}`);
  
  console.log("\n📦 Deploying FlashLoanArbitrage contract...");
  const FlashLoanArbitrage = await ethers.getContractFactory("FlashLoanArbitrage");
  const flashLoanArbitrage = await FlashLoanArbitrage.deploy(config.addressProvider);
  
  await flashLoanArbitrage.waitForDeployment();
  const contractAddress = await flashLoanArbitrage.getAddress();
  
  console.log(`✅ FlashLoanArbitrage deployed to: ${contractAddress}`);
  
  const deploymentsDir = path.join(__dirname, "../deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  
  const deploymentFile = path.join(deploymentsDir, `${network.name}.json`);
  fs.writeFileSync(deploymentFile, JSON.stringify({
    network: network.name,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: {
      FlashLoanArbitrage: contractAddress,
    },
  }, null, 2));
  
  console.log("\n" + "=".repeat(50));
  console.log("🎉 DEPLOYMENT COMPLETE!");
  console.log("=".repeat(50));
  console.log(`\nUpdate your .env file:`);
  console.log(`${network.name.toUpperCase()}_ARBITRAGE_CONTRACT=${contractAddress}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Deployment failed!");
    console.error(error);
    process.exit(1);
  });