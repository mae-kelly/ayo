// bot/src/index.ts
import { ethers } from 'ethers';
import { config } from 'dotenv';
import { ArbitrageScanner } from './arbitrage/scanner';
import { ArbitrageExecutor } from './arbitrage/executor';
import { GasManager } from './utils/gasManager';
import { Logger } from './utils/logger';
import { TelegramNotifier } from './utils/telegram';
import networks from '../config/networks.json';

config();

class L2ArbitrageBot {
    private scanner: ArbitrageScanner;
    private executor: ArbitrageExecutor;
    private gasManager: GasManager;
    private logger: Logger;
    private telegram: TelegramNotifier;
    private providers: Map<string, ethers.Provider>;
    private isRunning: boolean = false;
    private scanInterval: NodeJS.Timeout | null = null;
    private performanceMonitor: NodeJS.Timeout | null = null;
    private totalCapital: number;
    private profitTarget: number;
    private dailyProfit: number = 0;
    private dailyProfitReset: Date;
    
    constructor() {
        this.logger = new Logger();
        this.telegram = new TelegramNotifier(
            process.env.TELEGRAM_BOT_TOKEN || '',
            process.env.TELEGRAM_CHAT_ID || ''
        );
        this.providers = new Map();
        this.totalCapital = parseFloat(process.env.TOTAL_CAPITAL_USD || '10000');
        this.profitTarget = this.totalCapital * 0.15; // 15% monthly target
        this.dailyProfitReset = new Date();
        
        this.validateCapitalRequirements();
        this.initializeProviders();
        this.gasManager = new GasManager(this.providers, this.logger);
        this.scanner = new ArbitrageScanner(this.providers, this.logger);
        this.executor = new ArbitrageExecutor(
            this.providers, 
            this.gasManager, 
            this.logger,
            this.telegram
        );
    }
    
    private validateCapitalRequirements() {
        // Based on research: $10,000 minimum for meaningful profits
        const MIN_CAPITAL = 10000;
        const OPTIMAL_CAPITAL = 50000;
        
        if (this.totalCapital < MIN_CAPITAL) {
            this.logger.warn(`⚠️ CAPITAL WARNING: $${this.totalCapital} is below minimum recommended ($${MIN_CAPITAL})`);
            this.logger.warn('Expected returns will be limited. Consider:');
            this.logger.warn('- Increasing capital to $10,000+ for meaningful profits');
            this.logger.warn('- Using flash loans to leverage positions');
            this.logger.warn('- Focusing only on highest-margin opportunities');
        } else if (this.totalCapital < OPTIMAL_CAPITAL) {
            this.logger.info(`Capital: $${this.totalCapital} (Operational level)`);
            this.logger.info(`Target monthly return: 10-15% ($${(this.totalCapital * 0.1).toFixed(0)}-$${(this.totalCapital * 0.15).toFixed(0)})`);
        } else {
            this.logger.success(`Capital: $${this.totalCapital} (Optimal level)`);
            this.logger.success(`Target monthly return: 15-25% ($${(this.totalCapital * 0.15).toFixed(0)}-$${(this.totalCapital * 0.25).toFixed(0)})`);
        }
    }
    
    private initializeProviders() {
        try {
            // Priority order based on profit margins from research
            
            // 1. zkSync Era - HIGHEST PRIORITY (0.25% margins, 5x higher than others)
            if (process.env.ENABLE_ZKSYNC !== 'false') {
                const zkSyncProvider = new ethers.JsonRpcProvider(
                    process.env.ZKSYNC_RPC_URL || 
                    process.env.CHAINNODES_ZKSYNC_URL || // Use Chainnodes (20M free requests)
                    'https://mainnet.era.zksync.io'
                );
                this.providers.set('zksync', zkSyncProvider);
                this.logger.success('✅ zkSync Era connected (Highest profit margins: 0.25%)');
            }
            
            // 2. Base - Growth opportunity
            if (process.env.ENABLE_BASE !== 'false') {
                const baseProvider = new ethers.JsonRpcProvider(
                    process.env.BASE_RPC_URL || 
                    process.env.ALCHEMY_BASE_URL || // Use Alchemy (3.8M free compute units)
                    'https://mainnet.base.org'
                );
                this.providers.set('base', baseProvider);
                this.logger.info('✅ Base connected (High growth, 56x user increase)');
            }
            
            // 3. Arbitrum - Optional (mature, lower margins)
            if (process.env.ENABLE_ARBITRUM === 'true') {
                const arbitrumProvider = new ethers.JsonRpcProvider(
                    process.env.ARBITRUM_RPC_URL || 
                    process.env.INFURA_ARB_URL || // Use Infura backup
                    'https://arb1.arbitrum.io/rpc'
                );
                this.providers.set('arbitrum', arbitrumProvider);
                this.logger.info('✅ Arbitrum connected (Mature ecosystem, 0.03% margins)');
            }
            
            if (this.providers.size === 0) {
                throw new Error('No networks enabled! Enable at least zkSync or Base.');
            }
            
            this.logger.info(`Initialized ${this.providers.size} network providers`);
            
        } catch (error) {
            this.logger.error('Failed to initialize providers:', error);
            throw error;
        }
    }
    
    async start() {
        if (this.isRunning) {
            this.logger.warn('Bot is already running');
            return;
        }
        
        this.logger.info('🚀 L2 Flash Loan Arbitrage Bot Starting...');
        this.logger.info('📊 Configuration:');
        this.logger.info(`  - Networks: ${Array.from(this.providers.keys()).join(', ')}`);
        this.logger.info(`  - Capital: $${this.totalCapital}`);
        this.logger.info(`  - Monthly Target: $${this.profitTarget.toFixed(2)} (${((this.profitTarget/this.totalCapital)*100).toFixed(1)}%)`);
        
        // Send startup notification
        await this.telegram.sendNotification(
            '🚀 L2 Arbitrage Bot Started',
            `Networks: ${Array.from(this.providers.keys()).join(', ')}\n` +
            `Capital: $${this.totalCapital}\n` +
            `Target: $${this.profitTarget.toFixed(2)}/month`
        );
        
        // Validate configuration
        await this.validateConfiguration();
        
        // Start monitoring for opportunities
        this.isRunning = true;
        await this.startScanning();
        
        // Start performance monitoring
        this.startPerformanceMonitoring();
        
        // Setup graceful shutdown
        this.setupShutdownHandlers();
    }
    
    private async validateConfiguration() {
        this.logger.info('Validating configuration...');
        
        // Check wallet balance on each network
        const privateKey = process.env.PRIVATE_KEY;
        if (!privateKey) {
            throw new Error('PRIVATE_KEY not configured');
        }
        
        for (const [network, provider] of this.providers) {
            const wallet = new ethers.Wallet(privateKey, provider);
            const balance = await provider.getBalance(wallet.address);
            
            const balanceETH = parseFloat(ethers.formatEther(balance));
            const ethPrice = await this.gasManager.getETHPrice();
            const balanceUSD = balanceETH * ethPrice;
            
            this.logger.info(`${network} balance: ${balanceETH.toFixed(4)} ETH ($${balanceUSD.toFixed(2)})`);
            
            // Warn if balance is low
            const minBalanceUSD = network === 'zksync' ? 20 : 50; // Lower for zkSync
            if (balanceUSD < minBalanceUSD) {
                this.logger.warn(`⚠️ Low balance on ${network}: $${balanceUSD.toFixed(2)} < $${minBalanceUSD}`);
            }
        }
        
        // Check contract deployments
        const contracts = {
            zksync: process.env.ZKSYNC_ARBITRAGE_CONTRACT,
            base: process.env.BASE_ARBITRAGE_CONTRACT,
            arbitrum: process.env.ARBITRUM_ARBITRAGE_CONTRACT,
        };
        
        for (const [network, address] of Object.entries(contracts)) {
            if (this.providers.has(network) && address) {
                const provider = this.providers.get(network)!;
                const code = await provider.getCode(address);
                
                if (code === '0x') {
                    this.logger.warn(`⚠️ No contract at ${address} on ${network}`);
                } else {
                    this.logger.success(`✅ Contract verified on ${network}`);
                }
            }
        }
        
        // Check RPC endpoints performance
        for (const [network, provider] of this.providers) {
            const start = Date.now();
            await provider.getBlockNumber();
            const latency = Date.now() - start;
            
            if (latency > 1000) {
                this.logger.warn(`⚠️ High RPC latency on ${network}: ${latency}ms`);
            } else {
                this.logger.info(`${network} RPC latency: ${latency}ms`);
            }
        }
    }
    
    private async startScanning() {
        // Network-specific scan intervals based on opportunity persistence
        const SCAN_INTERVALS = {
            zksync: 100,     // 100ms for zkSync (370s opportunity window)
            base: 50,        // 50ms for Base (7min opportunity window)  
            arbitrum: 25,    // 25ms for Arbitrum (fast blocks)
        };
        
        const primaryNetwork = this.providers.has('zksync') ? 'zksync' : 'base';
        const scanInterval = SCAN_INTERVALS[primaryNetwork as keyof typeof SCAN_INTERVALS] || 100;
        
        this.logger.info(`Starting scanner with ${scanInterval}ms interval (optimized for ${primaryNetwork})`);
        
        const MIN_PROFIT_USD = this.totalCapital < 10000 ? 5 : 10; // Lower threshold if low capital
        this.logger.info(`Minimum profit threshold: $${MIN_PROFIT_USD}`);
        
        // Initial scan
        await this.performScan();
        
        // Set up interval scanning
        this.scanInterval = setInterval(async () => {
            if (this.isRunning) {
                await this.performScan();
            }
        }, scanInterval);
    }
    
    private async performScan() {
        try {
            // Scan for arbitrage opportunities
            const opportunities = await this.scanner.findOpportunities();
            
            if (opportunities.length > 0) {
                this.logger.debug(`Found ${opportunities.length} raw opportunities`);
                
                // Filter by capital-adjusted thresholds
                const minProfit = this.totalCapital < 10000 ? 5 : 10;
                const profitable = opportunities.filter(opp => {
                    // Adjust threshold by network
                    const networkMultiplier = opp.network === 'zksync' ? 0.5 : 1;
                    return opp.profitUSD > (minProfit * networkMultiplier);
                });
                
                if (profitable.length > 0) {
                    this.logger.info(`💰 ${profitable.length} profitable opportunities found`);
                    
                    // Execute best opportunity
                    const best = profitable[0];
                    this.logger.info(`Best opportunity: $${best.profitUSD.toFixed(2)} on ${best.network}`);
                    
                    // Check daily profit cap (risk management)
                    const dailyLimit = this.totalCapital * 0.02; // 2% daily limit
                    if (this.dailyProfit < dailyLimit) {
                        const success = await this.executor.execute(best);
                        
                        if (success) {
                            this.dailyProfit += best.profitUSD;
                            this.logger.success(`Daily profit: $${this.dailyProfit.toFixed(2)} / $${dailyLimit.toFixed(2)}`);
                        }
                    } else {
                        this.logger.info('Daily profit limit reached, waiting for reset');
                    }
                }
            }
        } catch (error) {
            this.logger.error('Scan error:', error);
            
            // Handle rate limiting
            if (error instanceof Error && error.message.includes('rate limit')) {
                this.logger.warn('Rate limited, backing off...');
                await this.delay(5000);
            }
        }
    }
    
    private startPerformanceMonitoring() {
        // Monitor performance every minute
        this.performanceMonitor = setInterval(async () => {
            const stats = this.executor.getPerformanceStats();
            const gasMetrics = {
                zksync: this.gasManager.getGasMetrics('zksync'),
                base: this.gasManager.getGasMetrics('base'),
                arbitrum: this.gasManager.getGasMetrics('arbitrum'),
            };
            
            // Log performance summary
            this.logger.info('📊 Performance Update:');
            for (const [network, rate] of Object.entries(stats.successRates)) {
                if (rate > 0) {
                    this.logger.info(`  ${network}: ${rate.toFixed(1)}% success rate`);
                }
            }
            this.logger.info(`  Total executions: ${stats.totalExecutions}`);
            this.logger.info(`  Daily profit: $${this.dailyProfit.toFixed(2)}`);
            
            // Check if daily reset is needed
            const now = new Date();
            if (now.getDate() !== this.dailyProfitReset.getDate()) {
                this.dailyProfit = 0;
                this.dailyProfitReset = now;
                this.logger.info('Daily profit counter reset');
            }
            
            // Send alerts if performance is poor
            for (const [network, rate] of Object.entries(stats.successRates)) {
                if (rate > 0 && rate < 50) {
                    await this.telegram.sendNotification(
                        '⚠️ Low Success Rate',
                        `${network}: ${rate.toFixed(1)}% success rate\nConsider adjusting strategy`
                    );
                }
            }
            
        }, 60000); // Every minute
    }
    
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    private setupShutdownHandlers() {
        const shutdown = async (signal: string) => {
            this.logger.info(`Received ${signal}, shutting down gracefully...`);
            
            this.isRunning = false;
            
            if (this.scanInterval) {
                clearInterval(this.scanInterval);
            }
            
            if (this.performanceMonitor) {
                clearInterval(this.performanceMonitor);
            }
            
            // Send final report
            const stats = this.executor.getPerformanceStats();
            await this.telegram.sendNotification(
                '🛑 Bot Shutdown',
                `Signal: ${signal}\n` +
                `Total executions: ${stats.totalExecutions}\n` +
                `Daily profit: $${this.dailyProfit.toFixed(2)}`
            );
            
            // Log final statistics
            const finalStats = await this.logger.getStatistics();
            this.logger.info('Final Statistics:', finalStats);
            
            process.exit(0);
        };
        
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('uncaughtException', (error) => {
            this.logger.error('Uncaught exception:', error);
            shutdown('uncaughtException');
        });
        process.on('unhandledRejection', (reason, promise) => {
            this.logger.error('Unhandled rejection at:', promise, 'reason:', reason);
            // Don't shutdown on unhandled rejection, just log
        });
    }
    
    async stop() {
        this.isRunning = false;
        if (this.scanInterval) {
            clearInterval(this.scanInterval);
        }
        if (this.performanceMonitor) {
            clearInterval(this.performanceMonitor);
        }
        this.logger.info('Bot stopped');
    }
}

// Main execution
async function main() {
    const bot = new L2ArbitrageBot();
    
    try {
        await bot.start();
    } catch (error) {
        console.error('Failed to start bot:', error);
        process.exit(1);
    }
}

// Start the bot
if (require.main === module) {
    main().catch(console.error);
}

export { L2ArbitrageBot };