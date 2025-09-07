const { ethers } = require('ethers');
const chalk = require('chalk');

// Fast monitoring of specific high-volume pairs
const HIGH_VOLUME_PAIRS = [
    { token0: 'WETH', token1: 'USDC', address0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', address1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
    { token0: 'WETH', token1: 'USDT', address0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', address1: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
    { token0: 'WETH', token1: 'DAI', address0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', address1: '0x6B175474E89094C44Da98b954EedeAC495271d0F' },
    { token0: 'WBTC', token1: 'WETH', address0: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', address1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
    { token0: 'USDC', token1: 'USDT', address0: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', address1: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
];

const DEXES = {
    'UniswapV2': '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
    'SushiSwap': '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac',
};

const FACTORY_ABI = ['function getPair(address, address) view returns (address)'];
const PAIR_ABI = ['function getReserves() view returns (uint112, uint112, uint32)'];

class FastMonitor {
    constructor() {
        this.provider = null;
        this.opportunities = [];
    }

    async initialize() {
        console.log(chalk.cyan.bold('\n🚀 FAST ARBITRAGE MONITOR - HIGH VOLUME PAIRS\n'));
        
        // Quick connect to fastest RPC
        const rpcs = [
            'https://eth.llamarpc.com',
            'https://ethereum.publicnode.com',
            'https://1rpc.io/eth'
        ];
        
        for (const rpc of rpcs) {
            try {
                this.provider = new ethers.JsonRpcProvider(rpc);
                await this.provider.getBlockNumber();
                console.log(chalk.green(`✅ Connected to ${rpc}`));
                break;
            } catch {}
        }
    }

    async monitorPairs() {
        console.log(chalk.yellow('\n📊 Monitoring high-volume pairs...\n'));
        
        for (const pairInfo of HIGH_VOLUME_PAIRS) {
            const pools = [];
            
            // Get pair addresses from each DEX
            for (const [dexName, factoryAddr] of Object.entries(DEXES)) {
                const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, this.provider);
                
                try {
                    const pairAddr = await factory.getPair(pairInfo.address0, pairInfo.address1);
                    if (pairAddr !== ethers.ZeroAddress) {
                        const pair = new ethers.Contract(pairAddr, PAIR_ABI, this.provider);
                        const reserves = await pair.getReserves();
                        
                        pools.push({
                            dex: dexName,
                            pair: `${pairInfo.token0}/${pairInfo.token1}`,
                            reserve0: Number(reserves[0]),
                            reserve1: Number(reserves[1]),
                            price: Number(reserves[1]) / Number(reserves[0])
                        });
                    }
                } catch {}
            }
            
            // Check for arbitrage
            if (pools.length >= 2) {
                const spread = Math.abs(pools[0].price - pools[1].price) / Math.min(pools[0].price, pools[1].price) * 100;
                
                if (spread > 0.1) {
                    const buyDex = pools[0].price < pools[1].price ? pools[0].dex : pools[1].dex;
                    const sellDex = pools[0].price < pools[1].price ? pools[1].dex : pools[0].dex;
                    
                    // Quick profit calculation
                    const loanUsd = 10000; // $10k flash loan
                    const grossProfit = loanUsd * spread / 100;
                    const fees = loanUsd * 0.006; // DEX fees
                    const gas = 0.5; // Gas estimate
                    const netProfit = grossProfit - fees - gas;
                    
                    if (netProfit > 0) {
                        console.log(chalk.bgGreen.black(` 💰 OPPORTUNITY: ${pools[0].pair} `));
                        console.log(chalk.white(`  Buy ${buyDex} → Sell ${sellDex}`));
                        console.log(chalk.yellow(`  Spread: ${spread.toFixed(3)}%`));
                        console.log(chalk.green(`  Net Profit (10k loan): $${netProfit.toFixed(2)}\n`));
                        this.opportunities.push({ pair: pools[0].pair, profit: netProfit });
                    }
                }
            }
        }
        
        if (this.opportunities.length > 0) {
            const totalProfit = this.opportunities.reduce((sum, o) => sum + o.profit, 0);
            console.log(chalk.cyan(`\n📈 Found ${this.opportunities.length} opportunities`));
            console.log(chalk.green(`💰 Total potential profit: $${totalProfit.toFixed(2)}`));
        } else {
            console.log(chalk.gray('No opportunities in this cycle'));
        }
    }

    async run() {
        await this.initialize();
        
        let cycle = 0;
        while (true) {
            cycle++;
            console.log(chalk.gray(`\n--- Scan #${cycle} - ${new Date().toLocaleTimeString()} ---`));
            
            this.opportunities = [];
            await this.monitorPairs();
            
            await new Promise(resolve => setTimeout(resolve, 5000)); // Check every 5 seconds
        }
    }
}

// Run monitor
new FastMonitor().run().catch(console.error);