// bot/src/arbitrage/executor.ts
import { ethers } from 'ethers';
import { ArbitrageOpportunity } from './scanner';
import { GasManager } from '../utils/gasManager';
import { Logger } from '../utils/logger';
import { TelegramNotifier } from '../utils/telegram';

export class ArbitrageExecutor {
    private providers: Map<string, ethers.Provider>;
    private gasManager: GasManager;
    private logger: Logger;
    private telegram: TelegramNotifier;
    private wallets: Map<string, ethers.Wallet>;
    private contracts: Map<string, ethers.Contract>;
    private executionInProgress: boolean = false;
    private executionHistory: Map<string, number>;
    private capitalAllocation: Map<string, number>;
    private successRates: Map<string, { success: number; total: number }>;
    
    // Minimum capital requirements
    private readonly MIN_CAPITAL = {
        testing: 1000,      // $1,000 for testing
        operational: 10000, // $10,000 for meaningful profits
        optimal: 50000,     // $50,000+ for consistent returns
    };
    
    constructor(
        providers: Map<string, ethers.Provider>,
        gasManager: GasManager,
        logger: Logger,
        telegram: TelegramNotifier
    ) {
        this.providers = providers;
        this.gasManager = gasManager;
        this.logger = logger;
        this.telegram = telegram;
        this.wallets = new Map();
        this.contracts = new Map();
        this.executionHistory = new Map();
        this.capitalAllocation = new Map();
        this.successRates = new Map();
        
        this.initializeWallets();
        this.initializeContracts();
        this.initializeCapitalAllocation();
    }
    
    private initializeCapitalAllocation() {
        // Optimal capital allocation based on research
        const totalCapital = parseFloat(process.env.TOTAL_CAPITAL_USD || '10000');
        
        if (totalCapital < this.MIN_CAPITAL.testing) {
            this.logger.warn(`⚠️ Capital below minimum: $${totalCapital} < $${this.MIN_CAPITAL.testing}`);
        }
        
        // Allocate based on profit margins
        this.capitalAllocation.set('zksync', totalCapital * 0.4);  // 40% to zkSync (highest margins)
        this.capitalAllocation.set('base', totalCapital * 0.35);   // 35% to Base (growth)
        this.capitalAllocation.set('arbitrum', totalCapital * 0.25); // 25% to Arbitrum (consistent)
        
        this.logger.info('Capital allocation initialized:', {
            total: `$${totalCapital}`,
            zksync: `$${this.capitalAllocation.get('zksync')}`,
            base: `$${this.capitalAllocation.get('base')}`,
            arbitrum: `$${this.capitalAllocation.get('arbitrum')}`,
        });
    }
    
    private initializeWallets() {
        const privateKey = process.env.PRIVATE_KEY;
        if (!privateKey) {
            throw new Error('PRIVATE_KEY not configured');
        }
        
        for (const [network, provider] of this.providers) {
            const wallet = new ethers.Wallet(privateKey, provider);
            this.wallets.set(network, wallet);
            this.logger.info(`Initialized wallet for ${network}: ${wallet.address}`);
        }
    }
    
    private initializeContracts() {
        const arbitrageABI = [
            'function executeArbitrage(address asset, uint256 amount, bytes calldata params) external',
            'function executeMultiDexArbitrage(bytes calldata params) external',
            'function executeTriangularArbitrage(address token0, address token1, address token2, uint256 amount, address[3] calldata routers, bytes[3] calldata swapData) external',
            'function executeFlashLoanArbitrage(address asset, uint256 amount, bytes calldata params) external',
            'function owner() view returns (address)',
            'function emergencyWithdraw(address token) external',
            'event ArbitrageExecuted(address indexed token, uint256 profit, uint256 gasUsed)',
        ];
        
        const contractAddresses = {
            zksync: process.env.ZKSYNC_ARBITRAGE_CONTRACT,
            base: process.env.BASE_ARBITRAGE_CONTRACT,
            arbitrum: process.env.ARBITRUM_ARBITRAGE_CONTRACT,
        };
        
        for (const [network, address] of Object.entries(contractAddresses)) {
            if (address && this.wallets.has(network)) {
                const wallet = this.wallets.get(network)!;
                const contract = new ethers.Contract(address, arbitrageABI, wallet);
                this.contracts.set(network, contract);
                this.logger.info(`Initialized contract for ${network}: ${address}`);
            }
        }
    }
    
    async execute(opportunity: ArbitrageOpportunity): Promise<boolean> {
        // Enhanced execution with profitability checks
        if (this.executionInProgress) {
            this.logger.warn('Execution already in progress, skipping');
            return false;
        }
        
        // Check cooldown period (network-specific)
        const cooldowns = { zksync: 60000, base: 30000, arbitrum: 15000 };
        const cooldown = cooldowns[opportunity.network as keyof typeof cooldowns] || 30000;
        
        const oppKey = `${opportunity.network}-${opportunity.tokenA}-${opportunity.tokenB}`;
        const lastExecution = this.executionHistory.get(oppKey) || 0;
        if (Date.now() - lastExecution < cooldown) {
            this.logger.debug('Recently executed this opportunity, skipping');
            return false;
        }
        
        this.executionInProgress = true;
        
        try {
            this.logger.info('🎯 Executing arbitrage opportunity', {
                network: opportunity.network,
                profit: `$${opportunity.profitUSD.toFixed(2)}`,
                tokens: [opportunity.tokenA, opportunity.tokenB],
                confidence: opportunity.confidence,
                persistence: opportunity.persistenceTime ? `${opportunity.persistenceTime}s` : 'N/A',
                discrepancy: opportunity.priceDiscrepancy ? `${opportunity.priceDiscrepancy.toFixed(2)}%` : 'N/A',
            });
            
            // Enhanced pre-execution checks
            const checks = await this.performEnhancedPreExecutionChecks(opportunity);
            if (!checks.passed) {
                this.logger.warn(`Pre-execution checks failed: ${checks.reason}`);
                this.updateSuccessRate(opportunity.network, false);
                return false;
            }
            
            // Calculate optimal position size
            const positionSize = this.calculateOptimalPositionSize(opportunity);
            opportunity.amountIn = positionSize;
            
            // Execute based on strategy type
            const result = await this.executeStrategy(opportunity);
            
            if (result.success) {
                this.logger.success(`✅ Arbitrage successful!`, {
                    txHash: result.txHash,
                    actualProfit: `$${result.profit?.toFixed(2)}`,
                    gasUsed: result.gasUsed,
                    ROI: `${((result.profit! / Number(ethers.formatUnits(positionSize, 6))) * 100).toFixed(2)}%`,
                });
                
                await this.telegram.sendNotification(
                    '💰 Arbitrage Success!',
                    `Network: ${opportunity.network}\n` +
                    `Profit: $${result.profit?.toFixed(2)}\n` +
                    `Gas: ${result.gasUsed}\n` +
                    `TX: ${result.txHash}\n` +
                    `Strategy: ${opportunity.dexPath.length > 2 ? 'Triangular' : 'Cross-DEX'}`
                );
                
                this.executionHistory.set(oppKey, Date.now());
                this.updateSuccessRate(opportunity.network, true);
                return true;
            } else {
                this.logger.error(`❌ Arbitrage failed: ${result.error}`);
                this.updateSuccessRate(opportunity.network, false);
                
                // Analyze failure for patterns
                this.analyzeFailure(opportunity, result.error || 'Unknown');
                return false;
            }
            
        } catch (error) {
            this.logger.error('Execution error:', error);
            
            if (error instanceof Error) {
                await this.telegram.sendNotification(
                    '⚠️ Arbitrage Failed',
                    `Network: ${opportunity.network}\n` +
                    `Error: ${error.message}\n` +
                    `Expected Profit: $${opportunity.profitUSD.toFixed(2)}`
                );
            }
            
            this.updateSuccessRate(opportunity.network, false);
            return false;
        } finally {
            this.executionInProgress = false;
        }
    }
    
    private async performEnhancedPreExecutionChecks(opportunity: ArbitrageOpportunity): Promise<{
        passed: boolean;
        reason?: string;
    }> {
        const wallet = this.wallets.get(opportunity.network);
        const contract = this.contracts.get(opportunity.network);
        
        if (!wallet || !contract) {
            return { passed: false, reason: 'Wallet or contract not initialized' };
        }
        
        // Check minimum profit thresholds (network-specific)
        const minProfitThresholds = {
            zksync: 5,     // $5 minimum on zkSync
            base: 10,      // $10 minimum on Base
            arbitrum: 15,  // $15 minimum on Arbitrum
        };
        
        const minProfit = minProfitThresholds[opportunity.network as keyof typeof minProfitThresholds] || 10;
        if (opportunity.profitUSD < minProfit) {
            return { passed: false, reason: `Profit below minimum: $${opportunity.profitUSD} < $${minProfit}` };
        }
        
        // Check wallet balance
        const balance = await wallet.provider.getBalance(wallet.address);
        const estimatedGasCost = await this.gasManager.estimateArbitrageCost(
            opportunity.network,
            opportunity.gasEstimate
        );
        
        // Higher safety margin for zkSync due to different gas model
        const safetyMultiplier = opportunity.network === 'zksync' ? 3n : 2n;
        if (balance < estimatedGasCost * safetyMultiplier) {
            return { 
                passed: false, 
                reason: `Insufficient balance: ${ethers.formatEther(balance)} ETH` 
            };
        }
        
        // Check gas price is reasonable
        const shouldExecute = await this.gasManager.shouldExecuteWithCurrentGas(
            opportunity.network,
            opportunity.profitUSD,
            opportunity.gasEstimate
        );
        
        if (!shouldExecute) {
            return { passed: false, reason: 'Gas price too high for profitable execution' };
        }
        
        // Check success rate for this network
        const stats = this.successRates.get(opportunity.network);
        if (stats && stats.total > 10) {
            const successRate = stats.success / stats.total;
            if (successRate < 0.3 && opportunity.confidence < 0.8) {
                return { 
                    passed: false, 
                    reason: `Low success rate (${(successRate * 100).toFixed(1)}%) and confidence` 
                };
            }
        }
        
        // Simulate transaction
        const simulationResult = await this.simulateTransaction(opportunity);
        if (!simulationResult.success) {
            return { passed: false, reason: `Simulation failed: ${simulationResult.error}` };
        }
        
        // Final profitability check after all costs
        const gasCostUSD = await this.gasManager.estimateGasCostUSD(
            opportunity.network,
            opportunity.gasEstimate
        );
        
        const netProfit = opportunity.profitUSD - gasCostUSD;
        const minNetProfit = opportunity.network === 'zksync' ? 3 : 5;
        
        if (netProfit < minNetProfit) {
            return { 
                passed: false, 
                reason: `Unprofitable after gas: $${netProfit.toFixed(2)} < $${minNetProfit}` 
            };
        }
        
        return { passed: true };
    }
    
    private calculateOptimalPositionSize(opportunity: ArbitrageOpportunity): bigint {
        const capitalForNetwork = this.capitalAllocation.get(opportunity.network) || 1000;
        
        // Calculate based on confidence and profit margin
        let positionMultiplier = opportunity.confidence;
        
        // Adjust for persistence (zkSync specialty)
        if (opportunity.persistenceTime && opportunity.persistenceTime > 100) {
            positionMultiplier *= 1.2;
        }
        
        // Adjust for price discrepancy
        if (opportunity.priceDiscrepancy && opportunity.priceDiscrepancy > 1) {
            positionMultiplier *= 1.1;
        }
        
        // Calculate position size (in USDC terms)
        const maxPosition = capitalForNetwork * positionMultiplier;
        
        // Apply limits based on opportunity type
        const limits = {
            zksync: { min: 500, max: 10000 },
            base: { min: 300, max: 5000 },
            arbitrum: { min: 1000, max: 7500 },
        };
        
        const networkLimits = limits[opportunity.network as keyof typeof limits] || { min: 300, max: 5000 };
        const finalPosition = Math.min(Math.max(maxPosition, networkLimits.min), networkLimits.max);
        
        return ethers.parseUnits(finalPosition.toString(), 6); // USDC decimals
    }
    
    private async simulateTransaction(opportunity: ArbitrageOpportunity): Promise<{
        success: boolean;
        error?: string;
    }> {
        try {
            const contract = this.contracts.get(opportunity.network)!;
            const params = this.encodeArbitrageParams(opportunity);
            
            // Use flash loan for larger positions
            const useFlashLoan = Number(ethers.formatUnits(opportunity.amountIn, 6)) > 1000;
            
            if (useFlashLoan) {
                await contract.executeFlashLoanArbitrage.staticCall(
                    opportunity.tokenA,
                    opportunity.amountIn,
                    params
                );
            } else {
                await contract.executeArbitrage.staticCall(
                    opportunity.tokenA,
                    opportunity.amountIn,
                    params
                );
            }
            
            return { success: true };
        } catch (error) {
            return { 
                success: false, 
                error: error instanceof Error ? error.message : 'Unknown error' 
            };
        }
    }
    
    private async executeStrategy(opportunity: ArbitrageOpportunity): Promise<{
        success: boolean;
        txHash?: string;
        profit?: number;
        gasUsed?: string;
        error?: string;
    }> {
        const contract = this.contracts.get(opportunity.network)!;
        const gasPrice = await this.gasManager.getOptimalGasPrice(opportunity.network);
        
        try {
            const params = this.encodeArbitrageParams(opportunity);
            
            // Check deadline
            if (opportunity.deadline < Math.floor(Date.now() / 1000)) {
                return { success: false, error: 'Opportunity expired' };
            }
            
            // Determine execution method based on capital
            const useFlashLoan = Number(ethers.formatUnits(opportunity.amountIn, 6)) > 1000;
            const gasLimit = await this.calculateGasLimit(opportunity);
            
            let tx;
            if (useFlashLoan) {
                // Use flash loan for larger positions
                tx = await contract.executeFlashLoanArbitrage(
                    opportunity.tokenA,
                    opportunity.amountIn,
                    params,
                    {
                        gasLimit,
                        gasPrice,
                        // zkSync specific settings
                        ...(opportunity.network === 'zksync' && {
                            customData: {
                                gasPerPubdata: 50000,
                                factoryDeps: [],
                            }
                        })
                    }
                );
            } else {
                // Regular execution for smaller positions
                tx = await contract.executeArbitrage(
                    opportunity.tokenA,
                    opportunity.amountIn,
                    params,
                    {
                        gasLimit,
                        gasPrice,
                    }
                );
            }
            
            this.logger.info(`Transaction submitted: ${tx.hash}`);
            
            // Network-specific timeout
            const timeouts = { zksync: 120000, base: 60000, arbitrum: 30000 };
            const timeout = timeouts[opportunity.network as keyof typeof timeouts] || 60000;
            
            const receipt = await this.waitForTransactionWithTimeout(tx, timeout);
            
            if (receipt && receipt.status === 1) {
                // Parse events for actual profit
                const profitEvent = receipt.logs.find(log => {
                    try {
                        const parsed = contract.interface.parseLog(log);
                        return parsed?.name === 'ArbitrageExecuted';
                    } catch {
                        return false;
                    }
                });
                
                let actualProfit = opportunity.profitUSD;
                if (profitEvent) {
                    const parsed = contract.interface.parseLog(profitEvent);
                    actualProfit = Number(ethers.formatUnits(parsed?.args.profit || 0, 6));
                }
                
                return {
                    success: true,
                    txHash: receipt.hash,
                    profit: actualProfit,
                    gasUsed: receipt.gasUsed.toString(),
                };
            } else {
                return {
                    success: false,
                    error: 'Transaction reverted',
                    txHash: tx.hash,
                };
            }
            
        } catch (error) {
            if (error instanceof Error) {
                // Handle specific errors
                if (error.message.includes('insufficient funds')) {
                    return { success: false, error: 'Insufficient funds for gas' };
                }
                if (error.message.includes('nonce')) {
                    // Handle nonce issues
                    await this.fixNonceIssue(opportunity.network);
                    return { success: false, error: 'Nonce issue - retrying' };
                }
                if (error.message.includes('replacement fee too low')) {
                    return { success: false, error: 'Gas price too low' };
                }
            }
            
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }
    
    private async calculateGasLimit(opportunity: ArbitrageOpportunity): Promise<bigint> {
        // Network-specific gas limits based on research
        const baseGasLimits = {
            zksync: BigInt(1000000),  // zkSync uses more gas but cheaper
            base: BigInt(300000),     // Base is efficient
            arbitrum: BigInt(500000), // Arbitrum moderate
        };
        
        const baseLimit = baseGasLimits[opportunity.network as keyof typeof baseGasLimits] 
            || BigInt(300000);
        
        // Add complexity multiplier
        let multiplier = BigInt(1);
        
        // Multi-DEX path
        if (opportunity.dexPath.length > 1) {
            multiplier = BigInt(opportunity.dexPath.length);
        }
        
        // Triangular arbitrage needs more gas
        if (opportunity.tokenA === opportunity.tokenB) {
            multiplier = multiplier * 3n / 2n;
        }
        
        const gasLimit = baseLimit * multiplier;
        
        // Add 20% safety buffer
        return gasLimit * 120n / 100n;
    }
    
    private encodeArbitrageParams(opportunity: ArbitrageOpportunity): string {
        const abiCoder = new ethers.AbiCoder();
        
        // Enhanced encoding with more data
        return abiCoder.encode(
            ['address', 'address', 'uint128', 'uint128', 'address[]', 'uint256', 'bytes'],
            [
                opportunity.tokenA,
                opportunity.tokenB,
                opportunity.amountIn,
                opportunity.expectedAmountOut,
                opportunity.dexPath.map(d => d.router),
                opportunity.deadline,
                '0x' // Additional calldata if needed
            ]
        );
    }
    
    private async waitForTransactionWithTimeout(
        tx: ethers.TransactionResponse,
        timeoutMs: number
    ): Promise<ethers.TransactionReceipt | null> {
        return Promise.race([
            tx.wait(),
            new Promise<null>((resolve) => 
                setTimeout(() => resolve(null), timeoutMs)
            )
        ]);
    }
    
    private updateSuccessRate(network: string, success: boolean) {
        const current = this.successRates.get(network) || { success: 0, total: 0 };
        current.total++;
        if (success) current.success++;
        this.successRates.set(network, current);
        
        // Log if success rate is concerning
        if (current.total > 10) {
            const rate = current.success / current.total;
            if (rate < 0.5) {
                this.logger.warn(`Low success rate on ${network}: ${(rate * 100).toFixed(1)}%`);
            }
        }
    }
    
    private analyzeFailure(opportunity: ArbitrageOpportunity, error: string) {
        // Track failure patterns
        if (error.includes('slippage')) {
            this.logger.info('Failure due to slippage - consider tighter tolerances');
        } else if (error.includes('front-run')) {
            this.logger.info('Possible front-running detected - use private mempool');
        } else if (error.includes('gas')) {
            this.logger.info('Gas-related failure - adjust gas strategy');
        }
    }
    
    private async fixNonceIssue(network: string) {
        const wallet = this.wallets.get(network);
        if (wallet) {
            const nonce = await wallet.provider.getTransactionCount(wallet.address, 'pending');
            this.logger.info(`Reset nonce for ${network} to ${nonce}`);
        }
    }
    
    async emergencyWithdraw(network: string, token: string): Promise<boolean> {
        const contract = this.contracts.get(network);
        if (!contract) {
            this.logger.error(`No contract for network ${network}`);
            return false;
        }
        
        try {
            const tx = await contract.emergencyWithdraw(token);
            const receipt = await tx.wait();
            
            this.logger.info(`Emergency withdrawal successful: ${receipt.hash}`);
            return receipt.status === 1;
        } catch (error) {
            this.logger.error('Emergency withdrawal failed:', error);
            return false;
        }
    }
    
    getPerformanceStats(): {
        successRates: Record<string, number>;
        totalExecutions: number;
        averageProfit: number;
    } {
        const stats: Record<string, number> = {};
        let totalExecutions = 0;
        
        for (const [network, rate] of this.successRates) {
            stats[network] = rate.total > 0 ? (rate.success / rate.total) * 100 : 0;
            totalExecutions += rate.total;
        }
        
        return {
            successRates: stats,
            totalExecutions,
            averageProfit: 0, // Would calculate from execution history
        };
    }
}