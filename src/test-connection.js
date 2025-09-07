const { ethers } = require('ethers');
const chalk = require('chalk');

async function testConnection() {
    console.log(chalk.cyan.bold('\n🔌 Testing RPC Connections...\n'));
    
    const endpoints = [
        'https://eth.llamarpc.com',
        'https://ethereum.publicnode.com',
        'https://1rpc.io/eth',
        'https://eth.drpc.org',
        'https://rpc.payload.de',
        'https://eth-mainnet.public.blastapi.io',
        'https://rpc.ankr.com/eth',
        'https://cloudflare-eth.com',
    ];
    
    let working = 0;
    
    for (const endpoint of endpoints) {
        process.stdout.write(`Testing ${endpoint}... `);
        
        try {
            const provider = new ethers.JsonRpcProvider(endpoint);
            const start = Date.now();
            const block = await provider.getBlockNumber();
            const latency = Date.now() - start;
            
            console.log(chalk.green(`✅ Block #${block} (${latency}ms)`));
            working++;
        } catch (error) {
            console.log(chalk.red(`❌ Failed`));
        }
    }
    
    console.log(chalk.yellow(`\n✅ ${working}/${endpoints.length} endpoints working`));
    
    if (working > 0) {
        console.log(chalk.green('\n✨ Ready to scan for arbitrage opportunities!'));
        console.log(chalk.cyan('Run: npm start'));
    }
}

testConnection().catch(console.error);