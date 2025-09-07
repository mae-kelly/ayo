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
}

export interface DexInfo {
    name: string;
    router: string;
    poolAddress: string;
    reserves: [bigint, bigint];
    fee: number;
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
    
    // Common token addresses on L2s
    private readonly TOKENS = {
        zksync: {
            USDC: '0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4',
            USDT: '0x493257fD37EDB34451f62EDf8D2a0C418852bA4C',
            WETH: '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91',
            WBTC: '0xBBeB516fb02a01611cBBE0453Fe3c580D7281011',
        },
        base: {
            USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            USDbC: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
            WETH: '0x4200000000000000000000000000000000000006',
            DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
        },
        arbitrum: {
            USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
            USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
            WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
            WBTC: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
        }
    };
    
    // DEX configurations
    private readonly DEX_CONFIGS = {
        zksync: [
            {
                name: 'SyncSwap',
                factory: '0xf2DAd89f2788a8CD54625C60b55cD3d2D0ACa7Cb',
                router: '0x2da10A1e27bF85cEdD8FFb1AbBe97e53391C0295',
            },
            {
                name: 'Mute',
                factory: '0x40be1cBa6C5B47cDF9da7f963B6F761F4C60627D',
                router: '0x8B791913eB07C32779a16750e3868aA8495F5964',
            }
        ],
        base: [
            {
                name: 'Aerodrome',
                factory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
                router: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
            },
            {
                name: 'UniswapV3',
                factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
                router: '0x2626664c2603336E57B271c5C0b26F421741e481',
            },
            {
                name: 'BaseSwap',
                factory: '0xFDa619b6d20975be80A10332dD640503C3bAFC9',
                router: '0x327Df1E6de05895d2B8cE32fB8AD443504386A35',
            }
        ]
    };
    
    constructor(providers: Map<string, ethers.Provider>, logger: Logger) {
        this.providers = providers;
        this.logger = logger;
        this.dexContracts = new Map();
        this.tokenPrices = new Map();
        this.lastScanTime = new Map();
        this.initializeDexContracts();
    }
    
    private initializeDexContracts() {
        const factoryABI = [
            'function getPool(address,address,uint24) view returns (address)',
            'function getPair(address,address) view returns (address)',
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
        
        // Scan multiple networks in parallel
        const scanPromises = Array.from(this.providers.keys()).map(network => 
            this.scanNetwork(network)
        );
        
        const results = await Promise.allSettled(scanPromises);
        
        for (const result of results) {
            if (result.status === 'fulfilled') {
                opportunities.push(...result.value);
            } else {
                this.logger.error('Network scan failed:', result.reason);
            }
        }
        
        // Sort by profit and filter duplicates
        return this.filterAndSortOpportunities(opportunities);
    }
    
    private async scanNetwork(network: string): Promise<ArbitrageOpportunity[]> {
        const opportunities: ArbitrageOpportunity[] = [];
        const provider = this.providers.get(network)!;
        
        // Rate limiting check
        const lastScan = this.lastScanTime.get(network) || 0;
        const timeSinceLastScan = Date.now() - lastScan;
        if (timeSinceLastScan < 50) {
            return opportunities; // Skip if scanned too recently
        }
        
        this.lastScanTime.set(network, Date.now());
        
        try {
            // Get recent blocks for scanning
            const currentBlock = await provider.getBlockNumber();
            const fromBlock = currentBlock - 2; // Last 2 blocks
            
            // Scan for swap events
            const swapTopic = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
            
            const filter = {
                topics: [swapTopic],
                fromBlock,
                toBlock: currentBlock,
            };
            
            const logs = await provider.getLogs(filter);
            
            // Analyze each swap for arbitrage potential
            for (const log of logs) {
                const opportunity = await this.analyzeSwapEvent(log, network);
                if (opportunity && opportunity.profitUSD > 0) {
                    opportunities.push(opportunity);
                }
            }
            
            // Also check for triangular arbitrage opportunities
            const triangularOpps = await this.findTriangularArbitrage(network);
            opportunities.push(...triangularOpps);
            
        } catch (error) {
            this.logger.error(`Error scanning ${network}:`, error);
        }
        
        return opportunities;
    }
    
    private async analyzeSwapEvent(
        log: ethers.Log,
        network: string
    ): Promise<ArbitrageOpportunity | null> {
        try {
            const iface = new ethers.Interface([
                'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)'
            ]);
            
            const parsed = iface.parseLog(log);
            if (!parsed) return null;
            
            const { amount0, amount1, sqrtPriceX96 } = parsed.args;
            
            // Get pool details
            const poolAddress = log.address;
            const poolContract = new ethers.Contract(
                poolAddress,
                [
                    'function token0() view returns (address)',
                    'function token1() view returns (address)',
                    'function fee() view returns (uint24)',
                    'function liquidity() view returns (uint128)',
                ],
                this.providers.get(network)!
            );
            
            const [token0, token1, fee] = await Promise.all([
                poolContract.token0(),
                poolContract.token1(),
                poolContract.fee(),
            ]);
            
            // Calculate price from sqrtPriceX96
            const price = Number(sqrtPriceX96) ** 2 / (2 ** 192);
            
            // Check for arbitrage opportunity across other DEXs
            const opportunity = await this.checkCrossExchangeArbitrage(
                network,
                token0,
                token1,
                price,
                fee
            );
            
            return opportunity;
            
        } catch (error) {
            this.logger.debug('Failed to analyze swap event:', error);
            return null;
        }
    }
    
    private async checkCrossExchangeArbitrage(
        network: string,
        token0: string,
        token1: string,
        currentPrice: number,
        fee: number
    ): Promise<ArbitrageOpportunity | null> {
        // Get prices from other DEXs
        const otherPrices = await this.getPricesFromOtherDexs(network, token0, token1);
        
        // Find best arbitrage opportunity
        let bestOpportunity: ArbitrageOpportunity | null = null;
        let maxProfit = 0;
        
        for (const dexPrice of otherPrices) {
            const priceDiff = Math.abs(currentPrice - dexPrice.price) / currentPrice;
            
            // Account for fees (0.3% typical)
            const totalFees = (fee / 1000000) + (dexPrice.fee / 1000000);
            
            if (priceDiff > totalFees + 0.001) { // 0.1% minimum profit
                const testAmount = ethers.parseEther('1'); // Test with 1 ETH
                const profit = this.calculateProfit(
                    testAmount,
                    currentPrice,
                    dexPrice.price,
                    totalFees
                );
                
                if (profit > maxProfit) {
                    maxProfit = profit;
                    bestOpportunity = {
                        network,
                        tokenA: token0,
                        tokenB: token1,
                        amountIn: testAmount,
                        expectedAmountOut: testAmount * BigInt(Math.floor(priceDiff * 1000)) / 1000n,
                        profitUSD: profit,
                        dexPath: [dexPrice.dexInfo],
                        gasEstimate: BigInt(200000), // Estimated gas
                        deadline: Math.floor(Date.now() / 1000) + 300, // 5 minutes
                        confidence: priceDiff > 0.01 ? 0.9 : 0.7,
                    };
                }
            }
        }
        
        return bestOpportunity;
    }
    
    private async getPricesFromOtherDexs(
        network: string,
        token0: string,
        token1: string
    ): Promise<Array<{price: number, fee: number, dexInfo: DexInfo}>> {
        const prices: Array<{price: number, fee: number, dexInfo: DexInfo}> = [];
        const dexConfigs = this.DEX_CONFIGS[network as keyof typeof this.DEX_CONFIGS];
        
        if (!dexConfigs) return prices;
        
        for (const config of dexConfigs) {
            try {
                const poolAddress = await this.getPoolAddress(network, config.name, token0, token1);
                if (!poolAddress || poolAddress === ethers.ZeroAddress) continue;
                
                const poolContract = new ethers.Contract(
                    poolAddress,
                    [
                        'function getReserves() view returns (uint112,uint112,uint32)',
                        'function fee() view returns (uint24)',
                    ],
                    this.providers.get(network)!
                );
                
                const [reserves, fee] = await Promise.all([
                    poolContract.getReserves().catch(() => [0n, 0n, 0]),
                    poolContract.fee().catch(() => 3000), // Default 0.3%
                ]);
                
                if (reserves[0] > 0n && reserves[1] > 0n) {
                    const price = Number(reserves[1]) / Number(reserves[0]);
                    prices.push({
                        price,
                        fee,
                        dexInfo: {
                            name: config.name,
                            router: config.router,
                            poolAddress,
                            reserves: [reserves[0], reserves[1]],
                            fee,
                        }
                    });
                }
            } catch (error) {
                // Continue with next DEX
            }
        }
        
        return prices;
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
    
    private async findTriangularArbitrage(network: string): Promise<ArbitrageOpportunity[]> {
        const opportunities: ArbitrageOpportunity[] = [];
        const tokens = this.TOKENS[network as keyof typeof this.TOKENS];
        
        if (!tokens) return opportunities;
        
        // Check common triangular paths
        const paths = [
            [tokens.USDC, tokens.WETH, tokens.USDT],
            [tokens.WETH, tokens.USDC, tokens.USDT],
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
        // Simplified triangular arbitrage check
        // In production, this would calculate exact amounts through each leg
        
        const testAmount = ethers.parseUnits('1000', 6); // 1000 USDC
        
        // Estimate profit (simplified)
        const estimatedProfit = Math.random() * 50; // Random for testing
        
        if (estimatedProfit > 10) {
            return {
                network,
                tokenA: path[0],
                tokenB: path[path.length - 1],
                amountIn: testAmount,
                expectedAmountOut: testAmount + BigInt(Math.floor(estimatedProfit * 1e6)),
                profitUSD: estimatedProfit,
                dexPath: [], // Would contain actual DEX route
                gasEstimate: BigInt(300000),
                deadline: Math.floor(Date.now() / 1000) + 300,
                confidence: 0.8,
            };
        }
        
        return null;
    }
    
    private calculateProfit(
        amount: bigint,
        price1: number,
        price2: number,
        fees: number
    ): number {
        const amountNum = Number(ethers.formatEther(amount));
        const grossProfit = amountNum * Math.abs(price1 - price2);
        const feesCost = amountNum * fees;
        return grossProfit - feesCost;
    }
    
    private async updateTokenPrices() {
        // In production, this would fetch from CoinGecko or similar
        // For now, using mock prices
        this.tokenPrices.set('USDC', { symbol: 'USDC', address: '', price: 1, decimals: 6 });
        this.tokenPrices.set('USDT', { symbol: 'USDT', address: '', price: 1, decimals: 6 });
        this.tokenPrices.set('WETH', { symbol: 'WETH', address: '', price: 2000, decimals: 18 });
        this.tokenPrices.set('WBTC', { symbol: 'WBTC', address: '', price: 40000, decimals: 8 });
    }
    
    private filterAndSortOpportunities(
        opportunities: ArbitrageOpportunity[]
    ): ArbitrageOpportunity[] {
        // Remove duplicates
        const unique = opportunities.filter((opp, index, self) =>
            index === self.findIndex((o) =>
                o.tokenA === opp.tokenA &&
                o.tokenB === opp.tokenB &&
                o.network === opp.network
            )
        );
        
        // Sort by profit (highest first)
        return unique.sort((a, b) => b.profitUSD - a.profitUSD);
    }
}