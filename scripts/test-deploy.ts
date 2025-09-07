import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  
  // Deploy a simple test contract
  const TestContract = await ethers.getContractFactory("SimpleArbitrage");
  const contract = await TestContract.deploy();
  await contract.waitForDeployment();
  
  console.log("Deployed to:", await contract.getAddress());
}

main().catch(console.error);