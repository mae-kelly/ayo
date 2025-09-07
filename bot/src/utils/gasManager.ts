import { ethers } from 'ethers';
import { Logger } from './logger';

interface GasPrice {
    standard: bigint;
    fast: bigint;
    instant: bigint;
}

interface GasMetrics {
    averageGasPrice: bigint;
    averageGasUsed: bigint;
    successRate: number;
}

export class GasManager {
    private providers: Map<string, ethers.Provider>;
    private logger: Logger;
    private gasPriceHistory: Map<string, bigint[]>;
    private gasMetrics: Map<string, GasMetrics>;
    private maxGasPrice: bigint;
    
    constructor(providers: Map<string, ethers.Provider>, logger: Logger) {
        this.providers = providers;
        this.logger = logger;
        this.gasPriceHistory = new Map();
        this.gasMetrics = new Map();
        
        // Maximum gas price from environment or default
        const maxGasPriceGwei = process.env.MAX_GAS_PRICE_GWEI || '10';
        this.maxGasPrice = ethers.parseUnits(maxGasPriceGwei, 'gwei');
        
        // Start monitoring gas prices
        this.startGasMonitoring();
    }
    
    private startGasMonitoring() {
        // Monitor gas prices every 5 seconds
        setInterval(async () => {
            for (const [network, provider] of this.providers) {
                try {
                    const feeData = await provider.getFeeData();
                    if (feeData.gasPrice) {
                        this.updateGasPriceHistory(network, feeData.gasPrice);
                    }
                } catch (error) {
                    this.logger.debug(`Failed to fetch gas price for ${network}`);
                }
            }
        }, 5000);
    }
    
    private updateGasPriceHistory(network: string, gasPrice: bigint) {
        const history = this.gasPriceHistory.get(network) || [];
        history.push(gasPrice);
        
        // Keep last 100 prices
        if (history.length > 100) {
            history.shift();
        }
        
        this.gasPriceHistory.set(network, history);
    }
    
    async getOptimalGasPrice(network: string): Promise<bigint> {
        const provider = this.providers.get(network);
        if (!provider) {
            throw new Error(`No provider for network ${network}`);
        }
        
        try {
            const feeData = await provider.getFeeData();
            
            // Network-specific gas optimization
            let gasPrice: bigint;
            
            switch (network) {
                case 'zksync':
                    // zkSync Era uses different gas model
                    gasPrice = await this.getZkSyncGasPrice(provider);
                    break;
                    
                case 'base':
                    // Base uses EIP-1559
                    gasPrice = await this.getBaseGasPrice(provider, feeData);
                    break;
                    
                case 'arbitrum':
                    // Arbitrum has unique gas pricing
                    gasPrice = await this.getArbitrumGasPrice(provider, feeData);
                    break;
                    
                default:
                    gasPrice = feeData.gasPrice || BigInt(1000000000); // 1 gwei fallback
            }
            
            // Apply maximum gas price cap
            if (gasPrice > this.maxGasPrice) {
                this.logger.warn(`Gas price ${ethers.formatUnits(gasPrice, 'gwei')} gwei exceeds max, using cap`);
                return this.maxGasPrice;
            }
            
            return gasPrice;
            
        } catch (error) {
            this.logger.error(`Error getting gas price for ${network}:`, error);
            
            // Use historical average as fallback
            return this.getHistoricalAverageGasPrice(network);
        }
    }
    
    private async getZkSyncGasPrice(provider: ethers.Provider): Promise<bigint> {
        try {
            // zkSync specific gas price calculation
            const gasPrice = await provider.send('eth_gasPrice', []);
            return BigInt(gasPrice);
        } catch {
            // Fallback for zkSync Era
            return BigInt(100000000); // 0.1 gwei
        }
    }
    
    private async getBaseGasPrice(
        provider: ethers.Provider,
        feeData: ethers.FeeData
    ): Promise<bigint> {
        // Base uses EIP-1559 with priority fee
        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
            // Use EIP-1559 pricing
            return feeData.maxFeePerGas + feeData.maxPriorityFeePerGas;
        }
        
        // Fallback to legacy gas price
        return feeData.gasPrice || BigInt(50000000); // 0.05 gwei
    }
    
    private async getArbitrumGasPrice(
        provider: ethers.Provider,
        feeData: ethers.FeeData
    ): Promise<bigint> {
        try {
            // Arbitrum has L1 and L2 gas components
            const l2GasPrice = feeData.gasPrice || BigInt(100000000); // 0.1 gwei
            
            // Get L1 base fee for calldata posting
            const l1BaseFee = await provider.send('eth_gasPrice', []);
            
            // Arbitrum formula: L2 gas price + (L1 base fee * compression factor)
            const compressionFactor = 10n; // Simplified, actual is dynamic
            const totalGasPrice = l2GasPrice + (BigInt(l1BaseFee) / compressionFactor);
            
            return totalGasPrice;
        } catch {
            return feeData.gasPrice || BigInt(100000000);
        }
    }
    
    private getHistoricalAverageGasPrice(network: string): bigint {
        const history = this.gasPriceHistory.get(network);
        
        if (!history || history.length === 0) {
            // Default gas prices by network
            const defaults: Record<string, bigint> = {
                zksync: BigInt(100000000),   // 0.1 gwei
                base: BigInt(50000000),      // 0.05 gwei
                arbitrum: BigInt(100000000), // 0.1 gwei
            };
            return defaults[network] || BigInt(1000000000);
        }
        
        // Calculate average from history
        const sum = history.reduce((acc, price) => acc + price, 0n);
        return sum / BigInt(history.length);
    }
    
    async estimateArbitrageCost(
        network: string,
        gasLimit: bigint
    ): Promise<bigint> {
        const gasPrice = await this.getOptimalGasPrice(network);
        return gasPrice * gasLimit;
    }
    
    async estimateGasCostUSD(
        network: string,
        gasLimit: bigint
    ): Promise<number> {
        const gasCost = await this.estimateArbitrageCost(network, gasLimit);
        const ethPrice = await this.getETHPrice();
        
        // Convert gas cost to USD
        const gasCostETH = Number(ethers.formatEther(gasCost));
        return gasCostETH * ethPrice;
    }
    
    private async getETHPrice(): Promise<number> {
        // In production, fetch from price oracle
        // For now, using a mock price
        return 2000; // $2000 per ETH
    }
    
    async shouldExecuteWithCurrentGas(
        network: string,
        expectedProfit: number,
        gasLimit: bigint
    ): Promise<boolean> {
        const gasCostUSD = await this.estimateGasCostUSD(network, gasLimit);
        const profitAfterGas = expectedProfit - gasCostUSD;
        
        // Require at least 20% profit margin after gas
        const minProfitMargin = expectedProfit * 0.2;
        
        if (profitAfterGas < minProfitMargin) {
            this.logger.warn(`Insufficient profit after gas: ${profitAfterGas.toFixed(2)}`);
            return false;
        }
        
        return true;
    }
    
    getGasMetrics(network: string): GasMetrics | undefined {
        return this.gasMetrics.get(network);
    }
    
    updateGasMetrics(
        network: string,
        gasUsed: bigint,
        gasPrice: bigint,
        success: boolean
    ) {
        const current = this.gasMetrics.get(network) || {
            averageGasPrice: 0n,
            averageGasUsed: 0n,
            successRate: 0,
        };
        
        // Update rolling averages
        const alpha = 0.9; // Smoothing factor
        
        current.averageGasPrice = BigInt(
            Math.floor(Number(current.averageGasPrice) * alpha + Number(gasPrice) * (1 - alpha))
        );
        
        current.averageGasUsed = BigInt(
            Math.floor(Number(current.averageGasUsed) * alpha + Number(gasUsed) * (1 - alpha))
        );
        
        current.successRate = current.successRate * alpha + (success ? 1 : 0) * (1 - alpha);
        
        this.gasMetrics.set(network, current);
    }
    
    async waitForGasPrice(network: string, targetGwei: number): Promise<void> {
        const targetPrice = ethers.parseUnits(targetGwei.toString(), 'gwei');
        
        while (true) {
            const currentPrice = await this.getOptimalGasPrice(network);
            
            if (currentPrice <= targetPrice) {
                return;
            }
            
            this.logger.debug(
                `Waiting for gas price to drop. Current: ${ethers.formatUnits(currentPrice, 'gwei')} gwei, Target: ${targetGwei} gwei`
            );
            
            // Wait 5 seconds before checking again
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    
    getRecommendedGasSettings(network: string): {
        gasLimit: bigint;
        maxFeePerGas?: bigint;
        maxPriorityFeePerGas?: bigint;
        gasPrice?: bigint;
    } {
        const metrics = this.gasMetrics.get(network);
        
        // Base recommendations
        const settings: any = {
            gasLimit: metrics?.averageGasUsed || BigInt(300000),
        };
        
        // Network-specific settings
        switch (network) {
            case 'base':
                // EIP-1559 settings for Base
                settings.maxFeePerGas = BigInt(1000000000); // 1 gwei
                settings.maxPriorityFeePerGas = BigInt(10000000); // 0.01 gwei
                break;
                
            case 'zksync':
                // zkSync specific settings
                settings.gasPrice = BigInt(100000000); // 0.1 gwei
                settings.gasLimit = BigInt(1000000); // Higher limit for zkSync
                break;
                
            case 'arbitrum':
                // Arbitrum settings
                settings.gasPrice = BigInt(100000000); // 0.1 gwei
                settings.gasLimit = BigInt(500000);
                break;
                
            default:
                settings.gasPrice = metrics?.averageGasPrice || BigInt(1000000000);
        }
        
        return settings;
    }
}