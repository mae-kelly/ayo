const { ethers } = require('ethers');
const chalk = require('chalk');
const Table = require('cli-table3');

// Configuration
const CONFIG = {
    ETH_PRICE: 4300,
    GAS_PRICE_GWEI: 0.5,
    GAS_LIMIT: 600000,
    MIN_LIQUIDITY: 100, // Lower minimum to find more opportunities
    MIN_SPREAD: 0.001, // Show even tiny spreads (0.001%)
};

// RPC Endpoints with rate limit handling
class RateLimitedProvider {
    constructor() {
        this.endpoints = [
            'https://eth.llamarpc.com',
            'https://ethereum.publicnode.com',
            'https://1rpc.io/eth',
            'https://eth.drpc.org',
            'https://rpc.payload.de',
        ];
        this.currentIndex = 0;
        this.providers = [];
    }

    async initialize() {
        for (const endpoint of this.endpoints) {
            try {
                const provider = new ethers.JsonRpcProvider(endpoint);
                await provider.getBlockNumber();
                this.providers.push(provider);
                console.log(chalk.green(`✅ Connected to ${endpoint}`));
            } catch (error) {
                console.log(chalk.yellow(`⚠️  Skipped ${endpoint}`));
            }
        }
        
        if (this.providers.length === 0) {
            throw new Error('No working providers found');
        }
    }

    getProvider() {
        const provider = this.providers[this.currentIndex];
        this.currentIndex = (this.currentIndex + 1) % this.providers.length;
        return provider;
    }

    async safeCall(fn) {
        let lastError;
        for (let i = 0; i < this.providers.length; i++) {
            try {
                const provider = this.getProvider();
                return await fn(provider);
            } catch (error) {
                lastError = error;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        throw lastError;
    }
}

// DEX Factory Addresses - Focus on working ones
const FACTORIES = {
    'UniswapV2': '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
    'SushiSwap': '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac',
};

// High-activity tokens for better success rate
const TOP_TOKENS = [
    { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
    { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
    { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
    { symbol: 'DAI', address: '0x6B175474E89094C44Da98b954EedeAC495271d0F' },
    { symbol: 'WBTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' },
    { symbol: 'SHIB', address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE' },
    { symbol: 'LINK', address: '0x514910771AF9Ca656af840dff83E8264EcF986CA' },
    { symbol: 'UNI', address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984' },
    { symbol: 'PEPE', address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933' },
    { symbol: 'MATIC', address: '0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0' },
];

// ABIs
const FACTORY_ABI = [
    'function getPair(address, address) view returns (address)',
    'function allPairs(uint256) view returns (address)',
    'function allPairsLength() view returns (uint256)',
];

const PAIR_ABI = [
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
];

const ERC20_ABI = [
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
];

class ImprovedArbitrageScanner {
    constructor() {
        this.provider = new RateLimitedProvider();
        this.tokenCache = new Map();
        this.foundPairs = new Map();
        this.opportunities = [];
        this.stats = {
            scanned: 0,
            profitable: 0,
            totalProfit: 0
        };
    }

    async initialize() {
        console.log(chalk.cyan('\n════════════════════════════════════════════════════════════════════'));
        console.log(chalk.cyan.bold('   💎 ARBITRAGE SCANNER V2 - WORKING VERSION 💎'));
        console.log(chalk.cyan('════════════════════════════════════════════════════════════════════\n'));

        await this.provider.initialize();

        const firstProvider = this.provider.getProvider();
        const [blockNumber, feeData] = await Promise.all([
            firstProvider.getBlockNumber(),
            firstProvider.getFeeData()
        ]);

        const gasPriceGwei = Number(feeData.gasPrice) / 1e9;
        const gasUsd = (CONFIG.GAS_LIMIT * gasPriceGwei / 1e9) * CONFIG.ETH_PRICE;

        console.log(chalk.yellow('📊 Market Conditions:'));
        console.log(`  • Block: #${blockNumber}`);
        console.log(`  • Gas: ${gasPriceGwei.toFixed(2)} gwei ($${gasUsd.toFixed(2)}/tx)`);
        console.log(`  • ETH Price: $${CONFIG.ETH_PRICE}\n`);
    }

    async scanPairs() {
        console.log(chalk.cyan('🔍 Scanning for arbitrage opportunities...\n'));

        // Method 1: Check known token pairs across DEXs
        await this.scanKnownTokenPairs();
        
        // Method 2: Scan recent pairs from factories
        await this.scanRecentPairs();
        
        // Display results
        this.displayResults();
    }

    async scanKnownTokenPairs() {
        console.log(chalk.yellow('📍 Checking high-volume token pairs...\n'));

        for (let i = 0; i < TOP_TOKENS.length; i++) {
            for (let j = i + 1; j < TOP_TOKENS.length; j++) {
                const token0 = TOP_TOKENS[i];
                const token1 = TOP_TOKENS[j];
                
                // Get pair addresses from each DEX
                const pools = [];
                
                for (const [dexName, factoryAddress] of Object.entries(FACTORIES)) {
                    try {
                        const pairAddress = await this.getPairAddress(
                            factoryAddress,
                            token0.address,
                            token1.address
                        );
                        
                        if (pairAddress && pairAddress !== ethers.ZeroAddress) {
                            const poolData = await this.getPoolData(pairAddress, dexName);
                            if (poolData) {
                                poolData.symbol0 = token0.symbol;
                                poolData.symbol1 = token1.symbol;
                                pools.push(poolData);
                            }
                        }
                    } catch (error) {
                        // Skip errors
                    }
                }
                
                // Check for arbitrage if we have pools on multiple DEXs
                if (pools.length >= 2) {
                    this.checkArbitrage(pools);
                }
                
                // Small delay to avoid rate limits
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
    }

    async scanRecentPairs() {
        console.log(chalk.yellow('\n📍 Scanning recent pairs from DEXs...\n'));

        for (const [dexName, factoryAddress] of Object.entries(FACTORIES)) {
            try {
                await this.provider.safeCall(async (provider) => {
                    const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);
                    const totalPairs = await factory.allPairsLength();
                    
                    console.log(`  ${dexName}: ${totalPairs} total pairs`);
                    
                    // Get last 20 pairs (most recent/active)
                    const start = Math.max(0, Number(totalPairs) - 20);
                    
                    for (let i = start; i < Math.min(start + 20, Number(totalPairs)); i++) {
                        try {
                            const pairAddress = await factory.allPairs(i);
                            const poolData = await this.getPoolData(pairAddress, dexName);
                            
                            if (poolData) {
                                const pairKey = this.getPairKey(poolData.token0, poolData.token1);
                                
                                if (!this.foundPairs.has(pairKey)) {
                                    this.foundPairs.set(pairKey, []);
                                }
                                this.foundPairs.get(pairKey).push(poolData);
                                this.stats.scanned++;
                            }
                        } catch (error) {
                            // Skip individual pair errors
                        }
                        
                        // Rate limit protection
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                });
            } catch (error) {
                console.log(chalk.red(`  Error scanning ${dexName}`));
            }
        }

        // Check all found pairs for arbitrage
        for (const [pairKey, pools] of this.foundPairs.entries()) {
            if (pools.length >= 2) {
                this.checkArbitrage(pools);
            }
        }
    }

    async getPairAddress(factoryAddress, token0, token1) {
        return await this.provider.safeCall(async (provider) => {
            const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);
            return await factory.getPair(token0, token1);
        });
    }

    async getPoolData(pairAddress, dexName) {
        try {
            return await this.provider.safeCall(async (provider) => {
                const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider);
                
                const [reserves, token0, token1] = await Promise.all([
                    pair.getReserves(),
                    pair.token0(),
                    pair.token1()
                ]);

                // Get token info
                const [token0Info, token1Info] = await Promise.all([
                    this.getTokenInfo(token0, provider),
                    this.getTokenInfo(token1, provider)
                ]);

                return {
                    dex: dexName,
                    address: pairAddress,
                    token0,
                    token1,
                    symbol0: token0Info.symbol,
                    symbol1: token1Info.symbol,
                    decimals0: token0Info.decimals,
                    decimals1: token1Info.decimals,
                    reserve0: reserves[0],
                    reserve1: reserves[1],
                };
            });
        } catch (error) {
            return null;
        }
    }

    async getTokenInfo(tokenAddress, provider) {
        if (this.tokenCache.has(tokenAddress)) {
            return this.tokenCache.get(tokenAddress);
        }

        try {
            const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
            const [symbol, decimals] = await Promise.all([
                token.symbol().catch(() => 'UNKNOWN'),
                token.decimals().catch(() => 18)
            ]);

            const info = { symbol, decimals };
            this.tokenCache.set(tokenAddress, info);
            return info;
        } catch (error) {
            const info = { symbol: 'UNKNOWN', decimals: 18 };
            this.tokenCache.set(tokenAddress, info);
            return info;
        }
    }

    getPairKey(token0, token1) {
        return token0.toLowerCase() < token1.toLowerCase() 
            ? `${token0}-${token1}` 
            : `${token1}-${token0}`;
    }

    checkArbitrage(pools) {
        // Calculate prices for each pool
        const pricesData = pools.map(pool => {
            const reserve0 = Number(pool.reserve0) / Math.pow(10, pool.decimals0);
            const reserve1 = Number(pool.reserve1) / Math.pow(10, pool.decimals1);
            
            return {
                pool,
                price: reserve0 > 0 ? reserve1 / reserve0 : 0,
                reserve0,
                reserve1
            };
        }).filter(p => p.price > 0);

        // Find best arbitrage opportunity
        for (let i = 0; i < pricesData.length; i++) {
            for (let j = i + 1; j < pricesData.length; j++) {
                const pool1 = pricesData[i];
                const pool2 = pricesData[j];
                
                const spread = Math.abs(pool1.price - pool2.price) / Math.min(pool1.price, pool2.price) * 100;
                
                if (spread >= CONFIG.MIN_SPREAD) {
                    const buyPool = pool1.price < pool2.price ? pool1 : pool2;
                    const sellPool = pool1.price < pool2.price ? pool2 : pool1;
                    
                    // Calculate profitability
                    const opportunity = this.calculateProfit(buyPool, sellPool, spread);
                    
                    if (opportunity) {
                        this.opportunities.push(opportunity);
                        this.displayOpportunity(opportunity);
                    }
                }
            }
        }
    }

    calculateProfit(buyPool, sellPool, spread) {
        const results = [];
        const loanAmounts = [0.1, 1, 10, 100];
        
        for (const loanEth of loanAmounts) {
            const loanUsd = loanEth * CONFIG.ETH_PRICE;
            const grossProfit = loanUsd * spread / 100;
            
            // Use Balancer (0% fee)
            const flashFee = 0;
            const dexFees = loanUsd * 0.006; // 0.3% each way
            const gasUsd = (CONFIG.GAS_LIMIT * CONFIG.GAS_PRICE_GWEI / 1e9) * CONFIG.ETH_PRICE;
            const netProfit = grossProfit - flashFee - dexFees - gasUsd;
            
            if (netProfit > 0) {
                results.push({
                    loanEth,
                    loanUsd,
                    grossProfit,
                    netProfit,
                    profitable: true
                });
            }
        }
        
        if (results.length === 0) return null;
        
        const bestResult = results.sort((a, b) => b.netProfit - a.netProfit)[0];
        
        this.stats.profitable++;
        this.stats.totalProfit += bestResult.netProfit;
        
        return {
            pair: `${buyPool.pool.symbol0}/${buyPool.pool.symbol1}`,
            buyDex: buyPool.pool.dex,
            sellDex: sellPool.pool.dex,
            buyPrice: buyPool.price,
            sellPrice: sellPool.price,
            spread,
            bestResult,
            allResults: results,
            timestamp: new Date().toLocaleTimeString()
        };
    }

    displayOpportunity(opp) {
        console.log(chalk.bgMagenta.bold(`\n 💰 ARBITRAGE OPPORTUNITY #${this.stats.profitable} `));
        console.log(chalk.white('═'.repeat(70)));
        
        console.log(chalk.cyan(`📍 Pair: ${opp.pair}`));
        console.log(chalk.cyan(`🔄 Route: ${opp.buyDex} → ${opp.sellDex}`));
        console.log(chalk.yellow(`📊 Spread: ${opp.spread.toFixed(4)}%`));
        console.log(chalk.gray(`⏰ Time: ${opp.timestamp}`));
        
        const table = new Table({
            head: ['Loan Size', 'Gross Profit', 'Net Profit', 'Status'],
            style: { head: ['cyan'] }
        });

        opp.allResults.forEach(result => {
            table.push([
                `${result.loanEth} ETH`,
                `$${result.grossProfit.toFixed(2)}`,
                chalk.green(`$${result.netProfit.toFixed(2)}`),
                chalk.green('✅ PROFITABLE')
            ]);
        });

        console.log(table.toString());
        console.log(chalk.bgGreen.black.bold(` 🎯 BEST: ${opp.bestResult.loanEth} ETH = $${opp.bestResult.netProfit.toFixed(2)} profit (Balancer 0% fee) `));
    }

    displayResults() {
        console.log(chalk.cyan('\n════════════════════════════════════════════════════════════════════'));
        console.log(chalk.cyan.bold('                           📊 RESULTS                              '));
        console.log(chalk.cyan('════════════════════════════════════════════════════════════════════'));
        
        console.log(chalk.yellow(`\n📈 Statistics:`));
        console.log(`  • Pairs Scanned: ${this.stats.scanned}`);
        console.log(`  • Profitable Opportunities: ${this.stats.profitable}`);
        console.log(`  • Total Potential Profit: ${chalk.green.bold(`$${this.stats.totalProfit.toFixed(2)}`)}`);
        
        if (this.stats.profitable === 0) {
            console.log(chalk.yellow('\n💡 No opportunities found this scan. This is normal during stable market conditions.'));
            console.log(chalk.gray('   The scanner will continue checking every 30 seconds...'));
        } else {
            console.log(chalk.green.bold(`\n✅ Found ${this.stats.profitable} profitable arbitrage opportunities!`));
        }
    }

    async run() {
        await this.initialize();
        
        while (true) {
            this.opportunities = [];
            this.foundPairs.clear();
            this.stats = { scanned: 0, profitable: 0, totalProfit: 0 };
            
            await this.scanPairs();
            
            console.log(chalk.gray('\n⏳ Next scan in 30 seconds...\n'));
            await new Promise(resolve => setTimeout(resolve, 30000));
        }
    }
}

// Run the scanner
async function main() {
    const scanner = new ImprovedArbitrageScanner();
    
    try {
        await scanner.run();
    } catch (error) {
        console.error(chalk.red('Fatal error:', error.message));
        process.exit(1);
    }
}

main().catch(console.error);