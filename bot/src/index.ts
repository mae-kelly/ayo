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
    
    constructor() {
        this.logger = new Logger();
        this.telegram = new TelegramNotifier(
            process.env.TELEGRAM_BOT_TOKEN || '',
            process.env.TELEGRAM_CHAT_ID || ''
        );
        this.providers = new Map();
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
    
    private initializeProviders() {
        try {
            // Initialize providers for zkSync Era
            const zkSyncProvider = new ethers.JsonRpcProvider(
                process.env.ZKSYNC_RPC_URL || 'https://mainnet.era.zksync.io'
            );
            
            // Initialize Base provider
            const baseProvider = new ethers.JsonRpcProvider(
                process.env.BASE_RPC_URL || 'https://mainnet.base.org'
            );
            
            // Initialize Arbitrum provider (optional)
            if (process.env.ENABLE_ARBITRUM === 'true') {
                const arbitrumProvider = new ethers.JsonRpcProvider(
                    process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc'
                );
                this.providers.set('arbitrum', arbitrumProvider);
            }
            
            this.providers.set('zksync', zkSyncProvider);
            this.providers.set('base', baseProvider);
            
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
        
        this.logger.info('🚀 L2 Arbitrage Bot Starting...');
        this.logger.info(`Networks: ${Array.from(this.providers.keys()).join(', ')}`);
        
        // Send startup notification
        await this.telegram.sendNotification(
            '🚀 L2 Arbitrage Bot Started',
            `Monitoring networks: ${Array.from(this.providers.keys()).join(', ')}`
        );
        
        // Validate configuration
        await this.validateConfiguration();
        
        // Start monitoring for opportunities
        this.isRunning = true;
        await this.startScanning();
        
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
            
            this.logger.info(`${network} wallet balance: ${ethers.formatEther(balance)} ETH`);
            
            if (balance === 0n) {
                this.logger.warn(`Warning: Zero balance on ${network}`);
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
                    this.logger.warn(`Warning: No contract deployed at ${address} on ${network}`);
                } else {
                    this.logger.info(`✓ Contract verified on ${network}`);
                }
            }
        }
    }
    
    private async startScanning() {
        const SCAN_INTERVAL = parseInt(process.env.SCAN_INTERVAL_MS || '100');
        const MIN_PROFIT_USD = parseFloat(process.env.MIN_PROFIT_USD || '10');
        
        this.logger.info(`Starting scanner with ${SCAN_INTERVAL}ms interval`);
        this.logger.info(`Minimum profit threshold: $${MIN_PROFIT_USD}`);
        
        // Initial scan
        await this.performScan();
        
        // Set up interval scanning
        this.scanInterval = setInterval(async () => {
            if (this.isRunning) {
                await this.performScan();
            }
        }, SCAN_INTERVAL);
    }
    
    private async performScan() {
        try {
            // Scan for arbitrage opportunities
            const opportunities = await this.scanner.findOpportunities();
            
            if (opportunities.length > 0) {
                this.logger.info(`Found ${opportunities.length} opportunities`);
                
                // Filter by minimum profit
                const minProfit = parseFloat(process.env.MIN_PROFIT_USD || '10');
                const profitable = opportunities.filter(opp => opp.profitUSD > minProfit);
                
                if (profitable.length > 0) {
                    this.logger.info(`${profitable.length} opportunities meet profit threshold`);
                    
                    // Sort by profit (highest first)
                    profitable.sort((a, b) => b.profitUSD - a.profitUSD);
                    
                    // Execute the best opportunity
                    const best = profitable[0];
                    this.logger.info(`Executing best opportunity: $${best.profitUSD.toFixed(2)} profit`);
                    
                    const success = await this.executor.execute(best);
                    
                    if (success) {
                        await this.telegram.sendNotification(
                            '💰 Arbitrage Executed Successfully!',
                            `Network: ${best.network}\nProfit: $${best.profitUSD.toFixed(2)}`
                        );
                    }
                }
            }
        } catch (error) {
            this.logger.error('Scan error:', error);
            
            // Don't crash the bot on scan errors
            if (error instanceof Error && error.message.includes('rate limit')) {
                this.logger.warn('Rate limited, backing off...');
                await this.delay(5000);
            }
        }
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
            
            await this.telegram.sendNotification(
                '🛑 Bot Shutdown',
                `Bot stopped: ${signal}`
            );
            
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
            shutdown('unhandledRejection');
        });
    }
    
    async stop() {
        this.isRunning = false;
        if (this.scanInterval) {
            clearInterval(this.scanInterval);
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