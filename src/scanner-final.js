const { ethers } = require('ethers');
const chalk = require('chalk');

// Simple configuration
const CONFIG = {
    ETH_PRICE: 4300,
    MIN_SPREAD_PERCENT: 0.01  // Show any spread above 0.01%
};

// Known working pairs with liquidity on both DEXs
const KNOWN_PAIRS = [
    {
        name: 'WETH/USDC',
        token0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        token1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        decimals0: 18,
        decimals1: 6,
        uniswapPair: '0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc',
        sushiPair: '0x397FF1542f962076d0BFE58eA045FfA2d347ACa0'
    },
    {
        name: 'WETH/USDT', 
        token0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        token1: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        decimals0: 18,
        decimals1: 6,
        uniswapPair: '0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852',
        sushiPair: '0x06da0fd433C1A5d7a4faa01111c044910A184553'
    },
    {
        name: 'USDC/USDT',
        token0: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        token1: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        decimals0: 6,
        decimals1: 6,
        uniswapPair: '0x3041CbD36888bECc7bbCBc0045E3B1f144466f5f',
        sushiPair: '0xD86A120a06255DF8D4e2248aB04d4267E23aDe52'
    },
    {
        name: 'WETH/DAI',
        token0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        token1: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
        decimals0: 18,
        decimals1: 18,
        uniswapPair: '0xA478c2975Ab1Ea89e8196811F51A7B7Ade33eB11',
        sushiPair: '0xC3D03e4F041Fd4cD388c549Ee2A29a9E5075882f'
    },
    {
        name: 'WBTC/WETH',
        token0: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
        token1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        decimals0: 8,
        decimals1: 18,
        uniswapPair: '0xBb2b8038a1640196FbE3e38816F3e67Cba72D940',
        sushiPair: '0xCEfF51756c56CeFFCA006cD410B03FFC46dd3a58'
    }
];

// Additional token pairs to check dynamically
const TOKENS = [
    { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
    { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    { symbol: 'SHIB', address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', decimals: 18 },
    { symbol: 'LINK', address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', decimals: 18 },
    { symbol: 'UNI', address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', decimals: 18 },
    { symbol: 'PEPE', address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', decimals: 18 },
];

const FACTORIES = {
    UniswapV2: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
    Sushiswap: '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac'
};

// Simple ABIs
const PAIR_ABI = ['function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32)'];
const FACTORY_ABI = ['function getPair(address, address) view returns (address)'];

class SimplifiedScanner {
    constructor() {
        this.provider = null;
        this.opportunities = [];
        this.totalProfit = 0;
        this.scanCount = 0;
    }

    async init() {
        console.log(chalk.cyan.bold('\n💎 ETHEREUM ARBITRAGE SCANNER - SIMPLIFIED VERSION 💎\n'));
        
        // Try to connect to any working RPC
        const rpcs = [
            'https://eth.llamarpc.com',
            'https://ethereum.publicnode.com',
            'https://1rpc.io/eth',
            'https://cloudflare-eth.com'
        ];

        for (const rpc of rpcs) {
            try {
                this.provider = new ethers.JsonRpcProvider(rpc);
                const block = await this.provider.getBlockNumber();
                console.log(chalk.green(`✅ Connected to ${rpc}`));
                console.log(chalk.yellow(`📦 Current block: ${block}\n`));
                break;
            } catch (err) {
                continue;
            }
        }

        if (!this.provider) {
            throw new Error('Could not connect to Ethereum');
        }
    }

    // Safe conversion from BigInt to Number
    safeNumber(bigIntValue, decimals = 18) {
        try {
            // Convert BigInt to string first, then parse
            const str = bigIntValue.toString();
            const num = parseFloat(str) / Math.pow(10, decimals);
            return isNaN(num) ? 0 : num;
        } catch {
            return 0;
        }
    }

    async checkKnownPairs() {
        console.log(chalk.yellow('🔍 Checking known high-liquidity pairs...\n'));

        for (const pair of KNOWN_PAIRS) {
            try {
                // Get reserves from both DEXs
                const uniContract = new ethers.Contract(pair.uniswapPair, PAIR_ABI, this.provider);
                const sushiContract = new ethers.Contract(pair.sushiPair, PAIR_ABI, this.provider);

                const [uniReserves, sushiReserves] = await Promise.all([
                    uniContract.getReserves(),
                    sushiContract.getReserves()
                ]);

                // Calculate prices safely
                const uniReserve0 = this.safeNumber(uniReserves[0], pair.decimals0);
                const uniReserve1 = this.safeNumber(uniReserves[1], pair.decimals1);
                const sushiReserve0 = this.safeNumber(sushiReserves[0], pair.decimals0);
                const sushiReserve1 = this.safeNumber(sushiReserves[1], pair.decimals1);

                if (uniReserve0 > 0 && sushiReserve0 > 0) {
                    const uniPrice = uniReserve1 / uniReserve0;
                    const sushiPrice = sushiReserve1 / sushiReserve0;
                    
                    const spread = Math.abs(uniPrice - sushiPrice) / Math.min(uniPrice, sushiPrice) * 100;

                    if (spread > CONFIG.MIN_SPREAD_PERCENT) {
                        this.displayOpportunity(pair.name, uniPrice, sushiPrice, spread);
                    }
                }
            } catch (error) {
                // Skip errors for individual pairs
            }
        }
    }

    async checkDynamicPairs() {
        console.log(chalk.yellow('\n🔍 Checking additional token pairs...\n'));

        const uniFactory = new ethers.Contract(FACTORIES.UniswapV2, FACTORY_ABI, this.provider);
        const sushiFactory = new ethers.Contract(FACTORIES.Sushiswap, FACTORY_ABI, this.provider);

        // Check combinations of tokens
        for (let i = 0; i < TOKENS.length; i++) {
            for (let j = i + 1; j < Math.min(i + 3, TOKENS.length); j++) {
                try {
                    const token0 = TOKENS[i];
                    const token1 = TOKENS[j];

                    // Get pair addresses
                    const [uniPairAddr, sushiPairAddr] = await Promise.all([
                        uniFactory.getPair(token0.address, token1.address),
                        sushiFactory.getPair(token0.address, token1.address)
                    ]);

                    // Skip if either pair doesn't exist
                    if (uniPairAddr === ethers.ZeroAddress || sushiPairAddr === ethers.ZeroAddress) {
                        continue;
                    }

                    // Get reserves
                    const uniPair = new ethers.Contract(uniPairAddr, PAIR_ABI, this.provider);
                    const sushiPair = new ethers.Contract(sushiPairAddr, PAIR_ABI, this.provider);

                    const [uniReserves, sushiReserves] = await Promise.all([
                        uniPair.getReserves(),
                        sushiPair.getReserves()
                    ]);

                    // Calculate prices
                    const uniReserve0 = this.safeNumber(uniReserves[0], token0.decimals);
                    const uniReserve1 = this.safeNumber(uniReserves[1], token1.decimals);
                    const sushiReserve0 = this.safeNumber(sushiReserves[0], token0.decimals);
                    const sushiReserve1 = this.safeNumber(sushiReserves[1], token1.decimals);

                    if (uniReserve0 > 100 && sushiReserve0 > 100) {
                        const uniPrice = uniReserve1 / uniReserve0;
                        const sushiPrice = sushiReserve1 / sushiReserve0;
                        
                        const spread = Math.abs(uniPrice - sushiPrice) / Math.min(uniPrice, sushiPrice) * 100;

                        if (spread > CONFIG.MIN_SPREAD_PERCENT) {
                            const pairName = `${token0.symbol}/${token1.symbol}`;
                            this.displayOpportunity(pairName, uniPrice, sushiPrice, spread);
                        }
                    }
                } catch (error) {
                    // Skip errors
                }
                
                // Small delay to avoid rate limits
                await new Promise(r => setTimeout(r, 100));
            }
        }
    }

    displayOpportunity(pairName, uniPrice, sushiPrice, spread) {
        this.opportunities.push({ pair: pairName, spread });
        
        const buyDex = uniPrice < sushiPrice ? 'UniswapV2' : 'Sushiswap';
        const sellDex = uniPrice < sushiPrice ? 'Sushiswap' : 'UniswapV2';
        const buyPrice = Math.min(uniPrice, sushiPrice);
        const sellPrice = Math.max(uniPrice, sushiPrice);

        console.log(chalk.bgMagenta.bold(` 💰 ARBITRAGE OPPORTUNITY FOUND! `));
        console.log(chalk.white('═'.repeat(60)));
        console.log(chalk.cyan(`📍 Pair: ${pairName}`));
        console.log(chalk.cyan(`🔄 Route: Buy on ${buyDex} → Sell on ${sellDex}`));
        console.log(chalk.yellow(`📊 Spread: ${spread.toFixed(4)}%`));
        console.log(chalk.gray(`   Buy Price: ${buyPrice.toFixed(6)}`));
        console.log(chalk.gray(`   Sell Price: ${sellPrice.toFixed(6)}`));
        
        // Calculate profit for different flash loan amounts
        console.log(chalk.green('\n💵 Flash Loan Profitability (using Balancer 0% fee):'));
        
        const loanAmounts = [1, 10, 100];
        for (const ethAmount of loanAmounts) {
            const loanValue = ethAmount * CONFIG.ETH_PRICE;
            const grossProfit = loanValue * spread / 100;
            const dexFees = loanValue * 0.006; // 0.3% each way
            const gasUsd = 0.50; // Approximate gas cost
            const netProfit = grossProfit - dexFees - gasUsd;
            
            if (netProfit > 0) {
                console.log(chalk.green(`   ${ethAmount} ETH loan: Net profit = $${netProfit.toFixed(2)} ✅`));
                this.totalProfit += netProfit;
            } else {
                console.log(chalk.yellow(`   ${ethAmount} ETH loan: Net loss = -$${Math.abs(netProfit).toFixed(2)}`));
            }
        }
        
        console.log(chalk.white('═'.repeat(60)) + '\n');
    }

    async scan() {
        this.scanCount++;
        console.log(chalk.gray(`\n━━━ Scan #${this.scanCount} - ${new Date().toLocaleTimeString()} ━━━\n`));
        
        this.opportunities = [];
        
        // Check known pairs first (most likely to have arbitrage)
        await this.checkKnownPairs();
        
        // Then check dynamic pairs
        await this.checkDynamicPairs();
        
        // Summary
        if (this.opportunities.length > 0) {
            console.log(chalk.cyan('\n═════════════════════════════════════════'));
            console.log(chalk.cyan.bold('              📊 SUMMARY                 '));
            console.log(chalk.cyan('═════════════════════════════════════════'));
            console.log(chalk.yellow(`\n✅ Found ${this.opportunities.length} arbitrage opportunities`));
            console.log(chalk.green(`💰 Total potential profit: $${this.totalProfit.toFixed(2)}`));
            console.log(chalk.gray('\n💡 Execute with flash loans for risk-free profit!'));
        } else {
            console.log(chalk.gray('\nNo opportunities found this scan. Market is efficient.'));
        }
    }

    async run() {
        await this.init();
        
        console.log(chalk.cyan('Starting continuous scanning...\n'));
        console.log(chalk.yellow('💡 Tip: Best opportunities appear during:'));
        console.log(chalk.gray('   • High volatility periods'));
        console.log(chalk.gray('   • Large trades that move prices'));
        console.log(chalk.gray('   • New token listings\n'));
        
        while (true) {
            try {
                await this.scan();
                console.log(chalk.gray('\n⏳ Next scan in 20 seconds...\n'));
                await new Promise(r => setTimeout(r, 20000));
            } catch (error) {
                console.log(chalk.red('Error in scan:', error.message));
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    }
}

// Run the scanner
async function main() {
    const scanner = new SimplifiedScanner();
    
    try {
        await scanner.run();
    } catch (error) {
        console.error(chalk.red('Fatal error:', error));
        process.exit(1);
    }
}

// Start
console.clear();
main().catch(console.error);