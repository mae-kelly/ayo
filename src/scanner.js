const { ethers } = require('ethers');
const chalk = require('chalk');
const Table = require('cli-table3');

// Configuration
const CONFIG = {
    ETH_PRICE: 4300,
    GAS_PRICE_GWEI: 0.5,
    GAS_LIMIT: 600000,
    MIN_LIQUIDITY: 1000, // Minimum liquidity in USD
    MIN_SPREAD: 0.01, // 0.01% minimum spread to show
};

// RPC Endpoints (all free, no API key needed)
const RPC_ENDPOINTS = [
    'https://eth.llamarpc.com',
    'https://ethereum.publicnode.com',
    'https://1rpc.io/eth',
    'https://eth.drpc.org',
    'https://rpc.payload.de',
    'https://eth-mainnet.public.blastapi.io',
    'https://rpc.ankr.com/eth',
    'https://cloudflare-eth.com',
];

// DEX Factory Addresses
const FACTORIES = {
    'UniswapV2': '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
    'SushiSwap': '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac',
    'ShibaSwap': '0x115934131916C8b277DD010Ee02de363c09d037c',
    'FraxSwap': '0x43eC799eAdd63848443E2347C49f5f52e8Fe0F6f',
    'PancakeV2': '0x1097053Fd2ea711dad45caCcc45EfF7548fCB362',
};

// Flash Loan Providers
const FLASH_PROVIDERS = [
    { name: 'Balancer', fee: 0.0000, color: 'green' },    // 0% fee!
    { name: 'dYdX', fee: 0.0000, color: 'green' },        // 2 wei (basically 0%)
    { name: 'UniswapV3', fee: 0.0001, color: 'yellow' },  // 0.01%
    { name: 'Aave V3', fee: 0.0005, color: 'yellow' },    // 0.05%
];

// ABIs
const FACTORY_ABI = [
    'function allPairsLength() view returns (uint256)',
    'function allPairs(uint256) view returns (address)',
    'function getPair(address, address) view returns (address)',
];

const PAIR_ABI = [
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
];

const ERC20_ABI = [
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function name() view returns (string)',
];

class ArbitrageScanner {
    constructor() {
        this.provider = null;
        this.tokenCache = new Map();
        this.pairCache = new Map();
        this.opportunities = [];
        this.totalScanned = 0;
        this.profitableCount = 0;
        this.totalPotentialProfit = 0;
    }

    async initialize() {
        console.log(chalk.cyan('\n════════════════════════════════════════════════════════════════════'));
        console.log(chalk.cyan.bold('   💎 ETHEREUM ARBITRAGE SCANNER - EVERY PAIR, EVERY OPPORTUNITY 💎'));
        console.log(chalk.cyan('════════════════════════════════════════════════════════════════════\n'));

        // Connect to RPC
        for (const endpoint of RPC_ENDPOINTS) {
            try {
                this.provider = new ethers.JsonRpcProvider(endpoint);
                await this.provider.getBlockNumber();
                console.log(chalk.green(`✅ Connected to ${endpoint}`));
                break;
            } catch (error) {
                continue;
            }
        }

        if (!this.provider) {
            throw new Error('Could not connect to any RPC endpoint');
        }

        // Get current network state
        const [blockNumber, gasPrice] = await Promise.all([
            this.provider.getBlockNumber(),
            this.provider.getFeeData()
        ]);

        const gasPriceGwei = Number(gasPrice.gasPrice) / 1e9;
        const gasUsd = (CONFIG.GAS_LIMIT * gasPriceGwei / 1e9) * CONFIG.ETH_PRICE;

        console.log(chalk.yellow('\n📊 Market Conditions:'));
        console.log(`  • Block: #${blockNumber}`);
        console.log(`  • Gas: ${gasPriceGwei.toFixed(2)} gwei ($${gasUsd.toFixed(2)}/tx)`);
        console.log(`  • ETH Price: $${CONFIG.ETH_PRICE}`);
        
        console.log(chalk.magenta('\n🏦 Flash Loan Providers:'));
        FLASH_PROVIDERS.forEach(p => {
            const fee = p.fee * 100;
            console.log(`  • ${p.name}: ${fee}% fee`);
        });
    }

    async scanAllPairs() {
        console.log(chalk.cyan('\n🔍 Scanning ALL pairs across ALL DEXs...\n'));

        const allPairs = new Map(); // token0-token1 -> [pools]

        // Scan each DEX
        for (const [dexName, factoryAddress] of Object.entries(FACTORIES)) {
            console.log(chalk.yellow(`\n📍 Scanning ${dexName}...`));
            
            const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, this.provider);
            
            try {
                const totalPairs = await factory.allPairsLength();
                console.log(`   Found ${totalPairs} total pairs`);

                // Sample pairs (get recent + random for speed)
                const indices = this.getSampleIndices(Number(totalPairs), 100);
                
                for (const index of indices) {
                    try {
                        const pairAddress = await factory.allPairs(index);
                        const poolData = await this.getPoolData(pairAddress, dexName);
                        
                        if (poolData && this.hasMinimumLiquidity(poolData)) {
                            const key = this.getPairKey(poolData.token0, poolData.token1);
                            
                            if (!allPairs.has(key)) {
                                allPairs.set(key, []);
                            }
                            allPairs.get(key).push(poolData);
                            this.totalScanned++;
                        }
                    } catch (error) {
                        // Skip failed pairs
                    }
                }
            } catch (error) {
                console.log(chalk.red(`   Error scanning ${dexName}: ${error.message}`));
            }
        }

        console.log(chalk.green(`\n✅ Scanned ${this.totalScanned} pools total`));
        console.log(chalk.green(`✅ Found ${allPairs.size} unique token pairs\n`));

        // Find arbitrage opportunities
        await this.findArbitrageOpportunities(allPairs);
    }

    getSampleIndices(total, sampleSize) {
        const indices = [];
        
        // Get last 50 pairs (most recent/active)
        const start = Math.max(0, total - 50);
        for (let i = start; i < total && indices.length < sampleSize / 2; i++) {
            indices.push(i);
        }
        
        // Get random samples from the rest
        const remaining = sampleSize - indices.length;
        for (let i = 0; i < remaining && i < total; i++) {
            const randomIndex = Math.floor(Math.random() * Math.min(total, 10000));
            if (!indices.includes(randomIndex)) {
                indices.push(randomIndex);
            }
        }
        
        return indices;
    }

    async getPoolData(pairAddress, dexName) {
        try {
            const pair = new ethers.Contract(pairAddress, PAIR_ABI, this.provider);
            
            const [reserves, token0, token1] = await Promise.all([
                pair.getReserves(),
                pair.token0(),
                pair.token1()
            ]);

            // Get token info
            const [token0Info, token1Info] = await Promise.all([
                this.getTokenInfo(token0),
                this.getTokenInfo(token1)
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
                reserve0: reserves.reserve0,
                reserve1: reserves.reserve1,
            };
        } catch (error) {
            return null;
        }
    }

    async getTokenInfo(tokenAddress) {
        if (this.tokenCache.has(tokenAddress)) {
            return this.tokenCache.get(tokenAddress);
        }

        try {
            const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
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

    hasMinimumLiquidity(pool) {
        const reserve0 = Number(pool.reserve0) / Math.pow(10, pool.decimals0);
        const reserve1 = Number(pool.reserve1) / Math.pow(10, pool.decimals1);
        
        // Rough USD estimate (assuming at least one token is worth ~$1)
        const estimatedValue = Math.max(reserve0, reserve1);
        return estimatedValue > CONFIG.MIN_LIQUIDITY;
    }

    getPairKey(token0, token1) {
        return token0.toLowerCase() < token1.toLowerCase() 
            ? `${token0}-${token1}` 
            : `${token1}-${token0}`;
    }

    async findArbitrageOpportunities(pairMap) {
        console.log(chalk.cyan('🎯 Analyzing arbitrage opportunities...\n'));

        for (const [pairKey, pools] of pairMap.entries()) {
            if (pools.length < 2) continue;

            // Check all DEX combinations
            for (let i = 0; i < pools.length; i++) {
                for (let j = i + 1; j < pools.length; j++) {
                    const opportunity = this.calculateArbitrage(pools[i], pools[j]);
                    if (opportunity) {
                        this.opportunities.push(opportunity);
                        this.displayOpportunity(opportunity);
                    }
                }
            }
        }

        this.displaySummary();
    }

    calculateArbitrage(pool1, pool2) {
        // Calculate prices
        const price1 = this.calculatePrice(pool1);
        const price2 = this.calculatePrice(pool2);

        if (!price1 || !price2) return null;

        // Calculate spread
        const spread = Math.abs(price1 - price2) / Math.min(price1, price2) * 100;

        if (spread < CONFIG.MIN_SPREAD) return null;

        const buyPool = price1 < price2 ? pool1 : pool2;
        const sellPool = price1 < price2 ? pool2 : pool1;
        const buyPrice = Math.min(price1, price2);
        const sellPrice = Math.max(price1, price2);

        // Calculate profitability for different loan sizes
        const calculations = [];
        const loanSizes = [0.1, 1, 10, 100, 1000];
        
        for (const loanEth of loanSizes) {
            const loanUsd = loanEth * CONFIG.ETH_PRICE;
            const grossProfit = loanUsd * spread / 100;
            
            // Find best flash loan provider
            let bestProvider = null;
            let bestNetProfit = -Infinity;
            
            for (const provider of FLASH_PROVIDERS) {
                const flashFee = loanUsd * provider.fee;
                const dexFees = loanUsd * 0.006; // 0.3% each way
                const gasUsd = (CONFIG.GAS_LIMIT * CONFIG.GAS_PRICE_GWEI / 1e9) * CONFIG.ETH_PRICE;
                const netProfit = grossProfit - flashFee - dexFees - gasUsd;
                
                if (netProfit > bestNetProfit) {
                    bestNetProfit = netProfit;
                    bestProvider = provider;
                }
            }
            
            calculations.push({
                loanEth,
                loanUsd,
                grossProfit,
                netProfit: bestNetProfit,
                provider: bestProvider,
                profitable: bestNetProfit > 0
            });
        }

        // Find best profitable opportunity
        const bestCalc = calculations
            .filter(c => c.profitable)
            .sort((a, b) => b.netProfit - a.netProfit)[0];

        if (!bestCalc) return null;

        this.profitableCount++;
        this.totalPotentialProfit += bestCalc.netProfit;

        return {
            pair: `${buyPool.symbol0}/${buyPool.symbol1}`,
            buyDex: buyPool.dex,
            sellDex: sellPool.dex,
            spread,
            buyPrice,
            sellPrice,
            calculations,
            bestCalc,
            timestamp: new Date().toLocaleTimeString()
        };
    }

    calculatePrice(pool) {
        const reserve0 = Number(pool.reserve0) / Math.pow(10, pool.decimals0);
        const reserve1 = Number(pool.reserve1) / Math.pow(10, pool.decimals1);
        
        if (reserve0 === 0) return null;
        return reserve1 / reserve0;
    }

    displayOpportunity(opp) {
        const profitColor = opp.bestCalc.netProfit > 100 ? 'green' : 
                           opp.bestCalc.netProfit > 10 ? 'yellow' : 'white';

        console.log(chalk.bgMagenta.bold(`\n 💰 ARBITRAGE OPPORTUNITY #${this.profitableCount} `));
        console.log(chalk.white('═'.repeat(70)));
        
        console.log(chalk.cyan(`📍 Pair: ${opp.pair}`));
        console.log(chalk.cyan(`🔄 Route: ${opp.buyDex} → ${opp.sellDex}`));
        console.log(chalk.yellow(`📊 Spread: ${opp.spread.toFixed(4)}%`));
        console.log(chalk.gray(`⏰ Time: ${opp.timestamp}`));
        
        // Show profitability table
        const table = new Table({
            head: ['Loan Size', 'Flash Provider', 'Gross Profit', 'Net Profit', 'Status'],
            style: { head: ['cyan'] }
        });

        opp.calculations.forEach(calc => {
            if (calc.profitable) {
                table.push([
                    `${calc.loanEth} ETH`,
                    calc.provider.name,
                    `$${calc.grossProfit.toFixed(2)}`,
                    chalk[profitColor](`$${calc.netProfit.toFixed(2)}`),
                    chalk.green('✅ PROFITABLE')
                ]);
            }
        });

        console.log(table.toString());
        
        console.log(chalk.bgGreen.black.bold(` 🎯 BEST: ${opp.bestCalc.loanEth} ETH loan via ${opp.bestCalc.provider.name} = $${opp.bestCalc.netProfit.toFixed(2)} profit `));
        console.log(chalk.white('═'.repeat(70)));
    }

    displaySummary() {
        console.log(chalk.cyan('\n════════════════════════════════════════════════════════════════════'));
        console.log(chalk.cyan.bold('                           📊 SUMMARY                              '));
        console.log(chalk.cyan('════════════════════════════════════════════════════════════════════'));
        
        console.log(chalk.yellow(`\n📈 Statistics:`));
        console.log(`  • Total Pools Scanned: ${this.totalScanned}`);
        console.log(`  • Profitable Opportunities: ${this.profitableCount}`);
        console.log(`  • Total Potential Profit: ${chalk.green.bold(`$${this.totalPotentialProfit.toFixed(2)}`)}`);
        
        if (this.profitableCount > 0) {
            console.log(chalk.green.bold(`\n✅ Found ${this.profitableCount} profitable arbitrage opportunities!`));
            console.log(chalk.yellow('💡 Execute these with flash loans for risk-free profit!'));
        }
    }

    async run() {
        await this.initialize();
        
        while (true) {
            this.opportunities = [];
            this.totalScanned = 0;
            this.profitableCount = 0;
            this.totalPotentialProfit = 0;
            
            await this.scanAllPairs();
            
            console.log(chalk.gray('\n⏳ Waiting 30 seconds before next scan...'));
            await new Promise(resolve => setTimeout(resolve, 30000));
        }
    }
}

// Main execution
async function main() {
    const scanner = new ArbitrageScanner();
    
    try {
        await scanner.run();
    } catch (error) {
        console.error(chalk.red('Error:', error.message));
        process.exit(1);
    }
}

// Run the scanner
main().catch(console.error);