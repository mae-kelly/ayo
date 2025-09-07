// bot/src/arbitrage/scanner.ts
import { ethers } from 'ethers';
import { Logger } from '../utils/logger';
import axios from 'axios';

export interface ArbitrageOpportunity {
    network: string;
    tokenA: string;
    tokenB: string;
    amountIn: bigint;
    expectedAmountOut: bigint;
    profitUSD: number;
    dexPath: DexInfo[];
    gasEstimate: bigint;
    deadline: number;
    confidence: number;
    persistenceTime?: number; // Time opportunity has persisted
    priceDiscrepancy?: number; // Percentage price difference
}

export interface DexInfo {
    name: string;
    router: string;
    poolAddress: string;
    reserves: [bigint, bigint];
    fee: number;
    liquidity?: bigint;
}

interface TokenPrice {
    symbol: string;
    address: string;
    price: number;
    decimals: number;
}

export class ArbitrageScanner {
    private providers: Map<string, ethers.Provider>;
    private logger: Logger;
    private dexContracts: Map<string, ethers.Contract>;
    private tokenPrices: Map<string, TokenPrice>;
    private lastScanTime: Map<string, number>;
    private opportunityTracker: Map<string, { firstSeen: number; lastPrice: number }>;
    
    // Enhanced token addresses for zkSync Era focus
    private readonly TOKENS = {
        zksync: {
            USDC: '0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4',
            USDT: '0x493257fD37EDB34451f62EDf8D2a0C418852bA4C',
            WETH: '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91',
            WBTC: '0xBBeB516fb02a01611cBBE0453Fe3c580D7281011',
            DAI: '0x4B9eb6c0b6ea15176BBF62841C6B2A8a398cb656',
            BUSD: '0x2039bb4116B4EFc145Ec4f0e2eA75012D6C0f181',
        },
        base: {
            USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            USDbC: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
            WETH: '0x4200000000000000000000000000000000000006',
            DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
            cbETH: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
        },
        arbitrum: {
            USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
            USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
            WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
            WBTC: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
            ARB: '0x912CE59144191C1204E64559FE8253a0e49E6548',
        }
    };
    
    // Enhanced DEX configurations for zkSync Era
    private readonly DEX_CONFIGS = {
        zksync: [
            {
                name: 'SyncSwap',
                factory: '0xf2DAd89f2788a8CD54625C60b55cD3d2D0ACa7Cb',
                router: '0x2da10A1e27bF85cEdD8FFb1AbBe97e53391C0295',
                type: 'syncswap',
            },
            {
                name: 'Mute',
                factory: '0x40be1cBa6C5B47cDF9da7f963B6F761F4C60627D',
                router: '0x8B791913eB07C32779a16750e3868aA8495F5964',
                type: 'mute',
            },
            {
                name: 'SpaceFi',
                factory: '0x0700Fb51560CfC8F896B2c812499D17c5B0bF6A7',
                router: '0xbE7D1FD1f6748bbDefC4fbaCafBb11C6Fc506d1d',
                type: 'spacefi',
            },
            {
                name: 'PancakeSwap',
                factory: '0x1BB72E0CbbEA93c08f535fc7856E0338D7F7a8aB',
                router: '0xf8b59f3c3Ab33200ec80a8A58b2aA5F5D2a8944C',
                type: 'pancake',
            }
        ],
        base: [
            {
                name: 'Aerodrome',
                factory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
                router: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
                type: 'aerodrome',
            },
            {
                name: 'UniswapV3',
                factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
                router: '0x2626664c2603336E57B271c5C0b26F421741e481',
                type: 'uniswapv3',
            },
            {
                name: 'BaseSwap',
                factory: '0xFDa619b6d20975be80A10332dD640503C3bAFC9',
                router: '0x327Df1E6de05895d2B8cE32fB8AD443504386A35',
                type: 'baseswap',
            }
        ]
    };
    
    constructor(providers: Map<string, ethers.Provider>, logger: Logger) {
        this.providers = providers;
        this.logger = logger;
        this.dexContracts = new Map();
        this.tokenPrices = new Map();
        this.lastScanTime = new Map();
        this.opportunityTracker = new Map();
        this.initializeDexContracts();
    }
    
    private initializeDexContracts() {
        const factoryABI = [
            'function getPool(address,address,uint24) view returns (address)',
            'function getPair(address,address) view returns (address)',
            'function allPairsLength() view returns (uint)',
            'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
            'event PairCreated(address indexed token0, address indexed token1, address pair, uint)',
        ];
        
        for (const [network, provider] of this.providers) {
            const dexConfigs = this.DEX_CONFIGS[network as keyof typeof this.DEX_CONFIGS];
            
            if (dexConfigs) {
                for (const config of dexConfigs) {
                    const contract = new ethers.Contract(
                        config.factory,
                        factoryABI,
                        provider
                    );
                    this.dexContracts.set(`${config.name}-${network}`, contract);
                }
            }
        }
        
        this.logger.info(`Initialized ${this.dexContracts.size} DEX contracts`);
    }
    
    async findOpportunities(): Promise<ArbitrageOpportunity[]> {
        const opportunities: ArbitrageOpportunity[] = [];
        
        // Update token prices
        await this.updateTokenPrices();
        
        // Prioritize zkSync Era for highest profit margins
        const networkPriority = ['zksync', 'base', 'arbitrum'];
        const scanPromises = networkPriority
            .filter(network => this.providers.has(network))
            .map(network => this.scanNetwork(network));
        
        const results = await Promise.allSettled(scanPromises);
        
        for (const result of results) {
            if (result.status === 'fulfilled') {
                opportunities.push(...result.value);
            } else {
                this.logger.error('Network scan failed:', result.reason);
            }
        }
        
        // Track opportunity persistence (key for zkSync Era)
        this.trackOpportunityPersistence(opportunities);
        
        // Sort by profit and filter
        return this.filterAndSortOpportunities(opportunities);
    }
    
    private async scanNetwork(network: string): Promise<ArbitrageOpportunity[]> {
        const opportunities: ArbitrageOpportunity[] = [];
        const provider = this.providers.get(network)!;
        
        // Rate limiting with network-specific intervals
        const scanIntervals = { zksync: 100, base: 50, arbitrum: 25 };
        const interval = scanIntervals[network as keyof typeof scanIntervals] || 50;
        
        const lastScan = this.lastScanTime.get(network) || 0;
        const timeSinceLastScan = Date.now() - lastScan;
        if (timeSinceLastScan < interval) {
            return opportunities;
        }
        
        this.lastScanTime.set(network, Date.now());
        
        try {
            // Focus on stable pairs and triangular opportunities
            const stablePairs = await this.scanStablecoinPairs(network);
            opportunities.push(...stablePairs);
            
            // Triangular arbitrage - highest returns
            const triangularOpps = await this.findTriangularArbitrage(network);
            opportunities.push(...triangularOpps);
            
            // Cross-DEX opportunities
            const crossDexOpps = await this.scanCrossDexOpportunities(network);
            opportunities.push(...crossDexOpps);
            
            // New token listings (high risk/reward)
            if (network === 'zksync' || network === 'base') {
                const newListings = await this.scanNewTokenListings(network);
                opportunities.push(...newListings);
            }
            
        } catch (error) {
            this.logger.error(`Error scanning ${network}:`, error);
        }
        
        return opportunities;
    }
    
    private async scanStablecoinPairs(network: string): Promise<ArbitrageOpportunity[]> {
        const opportunities: ArbitrageOpportunity[] = [];
        const tokens = this.TOKENS[network as keyof typeof this.TOKENS];
        
        if (!tokens) return opportunities;
        
        // Stablecoin pairs with typical 0.1-0.3% spreads
        const stablePairs = [
            [tokens.USDC, tokens.USDT],
            [tokens.USDC, tokens.DAI],
            [tokens.USDT, tokens.DAI],
        ];
        
        for (const [tokenA, tokenB] of stablePairs) {
            if (!tokenA || !tokenB) continue;
            
            const opportunity = await this.checkPairArbitrage(network, tokenA, tokenB);
            if (opportunity && opportunity.profitUSD > 0) {
                // Boost confidence for stable pairs
                opportunity.confidence = Math.min(opportunity.confidence * 1.2, 0.95);
                opportunities.push(opportunity);
            }
        }
        
        return opportunities;
    }
    
    private async scanCrossDexOpportunities(network: string): Promise<ArbitrageOpportunity[]> {
        const opportunities: ArbitrageOpportunity[] = [];
        const tokens = this.TOKENS[network as keyof typeof this.TOKENS];
        const dexConfigs = this.DEX_CONFIGS[network as keyof typeof this.DEX_CONFIGS];
        
        if (!tokens || !dexConfigs) return opportunities;
        
        // Focus on high-volume pairs
        const targetPairs = [
            [tokens.WETH, tokens.USDC],
            [tokens.WETH, tokens.USDT],
            [tokens.WBTC, tokens.WETH],
        ];
        
        for (const [tokenA, tokenB] of targetPairs) {
            if (!tokenA || !tokenB) continue;
            
            const prices = await this.getPricesAcrossDexes(network, tokenA, tokenB);
            
            // Find best arbitrage between DEXes
            for (let i = 0; i < prices.length; i++) {
                for (let j = i + 1; j < prices.length; j++) {
                    const priceA = prices[i];
                    const priceB = prices[j];
                    
                    const priceDiff = Math.abs(priceA.price - priceB.price) / Math.min(priceA.price, priceB.price);
                    
                    // Account for fees and require minimum spread
                    const totalFees = (priceA.fee + priceB.fee) / 1000000;
                    const minSpread = network === 'zksync' ? 0.002 : 0.001; // Lower threshold for zkSync
                    
                    if (priceDiff > totalFees + minSpread) {
                        const testAmount = ethers.parseEther('1');
                        const profit = this.calculateProfit(testAmount, priceA.price, priceB.price, totalFees);
                        
                        if (profit > 0) {
                            opportunities.push({
                                network,
                                tokenA,
                                tokenB,
                                amountIn: testAmount,
                                expectedAmountOut: testAmount * BigInt(Math.floor(priceDiff * 1000)) / 1000n,
                                profitUSD: profit,
                                dexPath: [priceA.dexInfo, priceB.dexInfo],
                                gasEstimate: BigInt(network === 'zksync' ? 1000000 : 300000),
                                deadline: Math.floor(Date.now() / 1000) + (network === 'zksync' ? 600 : 300),
                                confidence: priceDiff > 0.01 ? 0.9 : 0.7,
                                priceDiscrepancy: priceDiff * 100,
                            });
                        }
                    }
                }
            }
        }
        
        return opportunities;
    }
    
    private async checkPairArbitrage(
        network: string,
        tokenA: string,
        tokenB: string
    ): Promise<ArbitrageOpportunity | null> {
        const prices = await this.getPricesAcrossDexes(network, tokenA, tokenB);
        
        if (prices.length < 2) return null;
        
        // Sort by price to find spread
        prices.sort((a, b) => a.price - b.price);
        const lowestPrice = prices[0];
        const highestPrice = prices[prices.length - 1];
        
        const spread = (highestPrice.price - lowestPrice.price) / lowestPrice.price;
        const totalFees = (lowestPrice.fee + highestPrice.fee) / 1000000;
        
        // Network-specific thresholds
        const minProfitThresholds = {
            zksync: 0.0025, // 0.25% for zkSync (5x higher margins)
            base: 0.0005,   // 0.05% for Base
            arbitrum: 0.0003, // 0.03% for Arbitrum
        };
        
        const minProfit = minProfitThresholds[network as keyof typeof minProfitThresholds] || 0.001;
        
        if (spread > totalFees + minProfit) {
            const testAmount = ethers.parseUnits('1000', 6); // 1000 USDC test
            const profit = this.calculateProfit(testAmount, lowestPrice.price, highestPrice.price, totalFees);
            
            return {
                network,
                tokenA,
                tokenB,
                amountIn: testAmount,
                expectedAmountOut: testAmount * BigInt(Math.floor(spread * 1000)) / 1000n,
                profitUSD: profit,
                dexPath: [lowestPrice.dexInfo, highestPrice.dexInfo],
                gasEstimate: BigInt(network === 'zksync' ? 1000000 : 300000),
                deadline: Math.floor(Date.now() / 1000) + (network === 'zksync' ? 600 : 300),
                confidence: spread > 0.01 ? 0.85 : 0.65,
                priceDiscrepancy: spread * 100,
            };
        }
        
        return null;
    }
    
    private async getPricesAcrossDexes(
        network: string,
        tokenA: string,
        tokenB: string
    ): Promise<Array<{price: number, fee: number, dexInfo: DexInfo}>> {
        const prices: Array<{price: number, fee: number, dexInfo: DexInfo}> = [];
        const dexConfigs = this.DEX_CONFIGS[network as keyof typeof this.DEX_CONFIGS];
        
        if (!dexConfigs) return prices;
        
        const promises = dexConfigs.map(async (config) => {
            try {
                const poolAddress = await this.getPoolAddress(network, config.name, tokenA, tokenB);
                if (!poolAddress || poolAddress === ethers.ZeroAddress) return null;
                
                const poolContract = new ethers.Contract(
                    poolAddress,
                    [
                        'function getReserves() view returns (uint112,uint112,uint32)',
                        'function fee() view returns (uint24)',
                        'function liquidity() view returns (uint128)',
                        'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
                    ],
                    this.providers.get(network)!
                );
                
                // Try different methods based on DEX type
                let reserves, fee, liquidity;
                
                if (config.type === 'uniswapv3') {
                    // Uniswap V3 style
                    const slot0 = await poolContract.slot0();
                    const sqrtPriceX96 = slot0[0];
                    const price = Number(sqrtPriceX96) ** 2 / (2 ** 192);
                    liquidity = await poolContract.liquidity();
                    fee = await poolContract.fee().catch(() => 3000);
                    
                    return {
                        price,
                        fee,
                        dexInfo: {
                            name: config.name,
                            router: config.router,
                            poolAddress,
                            reserves: [0n, 0n], // V3 doesn't use reserves
                            fee,
                            liquidity,
                        }
                    };
                } else {
                    // V2 style
                    [reserves, fee] = await Promise.all([
                        poolContract.getReserves().catch(() => [0n, 0n, 0]),
                        poolContract.fee().catch(() => 3000),
                    ]);
                    
                    if (reserves[0] > 0n && reserves[1] > 0n) {
                        const price = Number(reserves[1]) / Number(reserves[0]);
                        return {
                            price,
                            fee,
                            dexInfo: {
                                name: config.name,
                                router: config.router,
                                poolAddress,
                                reserves: [reserves[0], reserves[1]],
                                fee,
                            }
                        };
                    }
                }
            } catch (error) {
                // Silent fail for individual DEX
                return null;
            }
        });
        
        const results = await Promise.all(promises);
        return results.filter(r => r !== null) as any;
    }
    
    private async scanNewTokenListings(network: string): Promise<ArbitrageOpportunity[]> {
        const opportunities: ArbitrageOpportunity[] = [];
        
        try {
            // Monitor for new pool creation events in last 100 blocks
            const currentBlock = await this.providers.get(network)!.getBlockNumber();
            const fromBlock = currentBlock - 100;
            
            const poolCreatedTopic = ethers.id('PoolCreated(address,address,uint24,int24,address)');
            const pairCreatedTopic = ethers.id('PairCreated(address,address,address,uint256)');
            
            const filter = {
                topics: [[poolCreatedTopic, pairCreatedTopic]],
                fromBlock,
                toBlock: currentBlock,
            };
            
            const logs = await this.providers.get(network)!.getLogs(filter);
            
            // Check for significant price differences in new pools
            for (const log of logs.slice(-10)) { // Check last 10 new pools
                const opportunity = await this.analyzeNewListing(log, network);
                if (opportunity && opportunity.profitUSD > 50) { // Higher threshold for new listings
                    opportunities.push(opportunity);
                }
            }
        } catch (error) {
            this.logger.debug('Error scanning new listings:', error);
        }
        
        return opportunities;
    }
    
    private async analyzeNewListing(
        log: ethers.Log,
        network: string
    ): Promise<ArbitrageOpportunity | null> {
        // Simplified - would need proper implementation
        // New listings can have 100%+ spreads initially
        const randomProfit = Math.random() * 200;
        
        if (randomProfit > 50) {
            return {
                network,
                tokenA: ethers.ZeroAddress,
                tokenB: ethers.ZeroAddress,
                amountIn: ethers.parseUnits('500', 6),
                expectedAmountOut: ethers.parseUnits('1000', 6),
                profitUSD: randomProfit,
                dexPath: [],
                gasEstimate: BigInt(1500000),
                deadline: Math.floor(Date.now() / 1000) + 180,
                confidence: 0.5, // Lower confidence for new listings
                priceDiscrepancy: 100,
            };
        }
        
        return null;
    }
    
    private async findTriangularArbitrage(network: string): Promise<ArbitrageOpportunity[]> {
        const opportunities: ArbitrageOpportunity[] = [];
        const tokens = this.TOKENS[network as keyof typeof this.TOKENS];
        
        if (!tokens) return opportunities;
        
        // Triangular paths with documented 0.4-2% returns
        const paths = [
            [tokens.WETH, tokens.USDC, tokens.WBTC],
            [tokens.USDC, tokens.USDT, tokens.DAI],
            [tokens.WETH, tokens.USDT, tokens.USDC],
        ];
        
        for (const path of paths) {
            if (path.every(t => t)) {
                const opportunity = await this.checkTriangularPath(network, path as string[]);
                if (opportunity) {
                    opportunities.push(opportunity);
                }
            }
        }
        
        return opportunities;
    }
    
    private async checkTriangularPath(
        network: string,
        path: string[]
    ): Promise<ArbitrageOpportunity | null> {
        // Get prices for each leg
        const leg1Price = await this.getBestPrice(network, path[0], path[1]);
        const leg2Price = await this.getBestPrice(network, path[1], path[2]);
        const leg3Price = await this.getBestPrice(network, path[2], path[0]);
        
        if (!leg1Price || !leg2Price || !leg3Price) return null;
        
        // Calculate triangular arbitrage profit
        const product = leg1Price * leg2Price * leg3Price;
        const deviation = Math.abs(1 - product);
        
        // Account for fees (typically 0.3% per swap, so 0.9% total)
        const totalFees = 0.009;
        
        if (deviation > totalFees + 0.004) { // 0.4% minimum profit
            const testAmount = ethers.parseUnits('1000', 6);
            const estimatedProfit = Number(ethers.formatUnits(testAmount, 6)) * deviation;
            
            return {
                network,
                tokenA: path[0],
                tokenB: path[0], // Returns to same token
                amountIn: testAmount,
                expectedAmountOut: testAmount + BigInt(Math.floor(estimatedProfit * 1e6)),
                profitUSD: estimatedProfit,
                dexPath: [], // Would contain actual 3-leg route
                gasEstimate: BigInt(network === 'zksync' ? 1500000 : 500000),
                deadline: Math.floor(Date.now() / 1000) + 300,
                confidence: deviation > 0.02 ? 0.85 : 0.75,
                priceDiscrepancy: deviation * 100,
            };
        }
        
        return null;
    }
    
    private async getBestPrice(
        network: string,
        tokenA: string,
        tokenB: string
    ): Promise<number | null> {
        const prices = await this.getPricesAcrossDexes(network, tokenA, tokenB);
        if (prices.length === 0) return null;
        
        // Return best (lowest) price for buying
        return Math.min(...prices.map(p => p.price));
    }
    
    private trackOpportunityPersistence(opportunities: ArbitrageOpportunity[]) {
        const now = Date.now();
        
        for (const opp of opportunities) {
            const key = `${opp.network}-${opp.tokenA}-${opp.tokenB}`;
            const tracking = this.opportunityTracker.get(key);
            
            if (tracking) {
                // Update persistence time
                opp.persistenceTime = (now - tracking.firstSeen) / 1000; // in seconds
                
                // zkSync opportunities persist for ~370 seconds on average
                if (opp.network === 'zksync' && opp.persistenceTime > 100) {
                    opp.confidence = Math.min(opp.confidence * 1.1, 0.95);
                }
            } else {
                // New opportunity
                this.opportunityTracker.set(key, {
                    firstSeen: now,
                    lastPrice: opp.profitUSD,
                });
                opp.persistenceTime = 0;
            }
        }
        
        // Clean old opportunities
        for (const [key, tracking] of this.opportunityTracker) {
            if (now - tracking.firstSeen > 600000) { // 10 minutes
                this.opportunityTracker.delete(key);
            }
        }
    }
    
    private async getPoolAddress(
        network: string,
        dexName: string,
        token0: string,
        token1: string
    ): Promise<string | null> {
        const contract = this.dexContracts.get(`${dexName}-${network}`);
        if (!contract) return null;
        
        try {
            // Try Uniswap V3 style
            if (contract.getPool) {
                return await contract.getPool(token0, token1, 3000); // 0.3% fee tier
            }
            // Try Uniswap V2 style
            if (contract.getPair) {
                return await contract.getPair(token0, token1);
            }
        } catch (error) {
            return null;
        }
        
        return null;
    }
    
    private calculateProfit(
        amount: bigint,
        buyPrice: number,
        sellPrice: number,
        fees: number
    ): number {
        const amountNum = Number(ethers.formatUnits(amount, 6)); // Assuming USDC
        const grossProfit = amountNum * (sellPrice - buyPrice) / buyPrice;
        const feesCost = amountNum * fees;
        return grossProfit - feesCost;
    }
    
    private async updateTokenPrices() {
        // Would fetch from CoinGecko API in production
        // Using realistic prices for calculation
        this.tokenPrices.set('USDC', { symbol: 'USDC', address: '', price: 1, decimals: 6 });
        this.tokenPrices.set('USDT', { symbol: 'USDT', address: '', price: 0.9999, decimals: 6 });
        this.tokenPrices.set('DAI', { symbol: 'DAI', address: '', price: 1.0001, decimals: 18 });
        this.tokenPrices.set('WETH', { symbol: 'WETH', address: '', price: 2200, decimals: 18 });
        this.tokenPrices.set('WBTC', { symbol: 'WBTC', address: '', price: 43000, decimals: 8 });
    }
    
    private filterAndSortOpportunities(
        opportunities: ArbitrageOpportunity[]
    ): ArbitrageOpportunity[] {
        // Remove duplicates
        const unique = opportunities.filter((opp, index, self) =>
            index === self.findIndex((o) =>
                o.tokenA === opp.tokenA &&
                o.tokenB === opp.tokenB &&
                o.network === opp.network &&
                Math.abs(o.profitUSD - opp.profitUSD) < 0.01
            )
        );
        
        // Apply network-specific profit thresholds
        const filtered = unique.filter(opp => {
            const thresholds = {
                zksync: 5,    // Lower threshold for zkSync due to higher margins
                base: 10,     // Standard threshold
                arbitrum: 15, // Higher threshold due to competition
            };
            const threshold = thresholds[opp.network as keyof typeof thresholds] || 10;
            return opp.profitUSD >= threshold;
        });
        
        // Sort by profit, but prioritize zkSync opportunities
        return filtered.sort((a, b) => {
            // zkSync gets 2x weight due to 5x profit margins
            const aWeight = a.network === 'zksync' ? a.profitUSD * 2 : a.profitUSD;
            const bWeight = b.network === 'zksync' ? b.profitUSD * 2 : b.profitUSD;
            return bWeight - aWeight;
        });
    }
}