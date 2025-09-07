
const { ethers } = require('ethers');
require('dotenv').config();

console.log('\n🔑 Wallet Generator for L2 Arbitrage Bot\n');
console.log('='.repeat(60));

const existingKey = process.env.PRIVATE_KEY;
if (existingKey && existingKey !== '0x0000000000000000000000000000000000000000000000000000000000000001') {
    try {
        const existing = new ethers.Wallet(existingKey);
        console.log('✅ You already have a wallet configured:');
        console.log(`   Address: ${existing.address}\n`);
    } catch (e) {
        console.log('❌ Invalid private key in .env file');
    }
}

const wallet = ethers.Wallet.createRandom();

console.log('\n🆕 NEW WALLET GENERATED:');
console.log('='.repeat(60));
console.log(`Address: ${wallet.address}`);
console.log(`Private Key: ${wallet.privateKey}`);
console.log('='.repeat(60));

console.log('\n⚠️  IMPORTANT:');
console.log('   1. Save this private key securely');
console.log('   2. Add it to your .env file');
console.log('   3. Send ETH to the address for gas');
console.log('   4. This is a NEW wallet for the bot only\n');