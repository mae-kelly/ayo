// scripts/get-wallet-address.ts
import { ethers } from 'ethers';
import { config } from 'dotenv';

config();

async function main() {
  console.log('🔑 Bot Wallet Information\n');
  console.log('=' .repeat(50));
  
  const privateKey = process.env.PRIVATE_KEY;
  
  if (!privateKey || privateKey === '0x0000000000000000000000000000000000000000000000000000000000000000') {
    console.log('⚠️  WARNING: Private key not configured!');
    console.log('\nTo set up your bot wallet:');
    console.log('1. Create a NEW wallet (never use your main wallet)');
    console.log('2. Copy the private key');
    console.log('3. Add it to your .env file:');
    console.log('   PRIVATE_KEY=your_private_key_here\n');
    
    // Generate a new wallet for demonstration
    const newWallet = ethers.Wallet.createRandom();
    console.log('📝 Here\'s a newly generated wallet you can use:');
    console.log(`   Address: ${newWallet.address}`);
    console.log(`   Private Key: ${newWallet.privateKey}`);
    console.log('\n⚠️  Save this private key securely if you use it!');
    
    return;
  }
  
  try {
    const wallet = new ethers.Wallet(privateKey);
    
    console.log('✅ Wallet configured successfully!\n');
    console.log(`📍 Address: ${wallet.address}`);
    console.log(`🔗 Etherscan: https://etherscan.io/address/${wallet.address}`);
    console.log('\n📊 Network addresses:');
    console.log(`   zkSync Era: https://explorer.zksync.io/address/${wallet.address}`);
    console.log(`   Base: https://basescan.org/address/${wallet.address}`);
    console.log(`   Arbitrum: https://arbiscan.io/address/${wallet.address}`);
    
    console.log('\n💰 Fund this wallet with:');
    console.log('   • zkSync Era: 0.01 ETH minimum (~$20-30)');
    console.log('   • Base: 0.02 ETH minimum (~$40-60)');
    console.log('   • USDC: Your trading capital ($10,000+ recommended)');
    
    console.log('\n📋 Next steps:');
    console.log('1. Send ETH to the address above for gas');
    console.log('2. Send USDC for trading capital');
    console.log('3. Deploy contracts: npm run deploy:zksync');
    console.log('4. Start bot: npm start');
    
  } catch (error) {
    console.error('❌ Error with private key:', error);
    console.log('\nMake sure your private key:');
    console.log('• Starts with 0x');
    console.log('• Is 64 characters long (after 0x)');
    console.log('• Contains only hexadecimal characters (0-9, a-f)');
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });