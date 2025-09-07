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
        this.initializeWallets();
        this.initializeContracts();
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
        // Prevent concurrent executions
        if (this.executionInProgress) {
            this.logger.warn('Execution already in progress, skipping');
            return false;
        }
        
        // Check if we've executed this recently (prevent loops)
        const oppKey = `${opportunity.network}-${opportunity.tokenA}-${opportunity.tokenB}`;
        const lastExecution = this.executionHistory.get(oppKey) || 0;
        if (Date.now() - lastExecution < 30000) { // 30 second cooldown
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
            });
            
            // Pre-execution checks
            const checks = await this.performPreExecutionChecks(opportunity);
            if (!checks.passed) {
                this.logger.warn(`Pre-execution checks failed: ${checks.reason}`);
                return false;
            }
            
            // Execute based on strategy type
            const result = await this.executeStrategy(opportunity);
            
            if (result.success) {
                this.logger.success(`✅ Arbitrage successful!`, {
                    txHash: result.txHash,
                    actualProfit: `$${result.profit?.toFixed(2)}`,
                    gasUsed: result.gasUsed,
                });
                
                await this.telegram.sendNotification(
                    '💰 Arbitrage Success!',
                    `Network: ${opportunity.network}\n` +
                    `Profit: $${result.profit?.toFixed(2)}\n` +
                    `Gas: ${result.gasUsed}\n` +
                    `TX: ${result.txHash}`
                );
                
                this.executionHistory.set(oppKey, Date.now());
                return true;
            } else {
                this.logger.error(`❌ Arbitrage failed: ${result.error}`);
                return false;
            }
            
        } catch (error) {
            this.logger.error('Execution error:', error);
            
            if (error instanceof Error) {
                await this.telegram.sendNotification(
                    '⚠️ Arbitrage Failed',
                    `Network: ${opportunity.network}\n` +
                    `Error: ${error.message}`
                );
            }
            
            return false;
        } finally {
            this.executionInProgress = false;
        }
    }
    
    private async performPreExecutionChecks(opportunity: ArbitrageOpportunity): Promise<{
        passed: boolean;
        reason?: string;
    }> {
        const wallet = this.wallets.get(opportunity.network);
        const contract = this.contracts.get(opportunity.network);
        
        if (!wallet || !contract) {
            return { passed: false, reason: 'Wallet or contract not initialized' };
        }
        
        // Check wallet balance
        const balance = await wallet.provider.getBalance(wallet.address);
        const estimatedGasCost = await this.gasManager.estimateArbitrageCost(
            opportunity.network,
            opportunity.gasEstimate
        );
        
        if (balance < estimatedGasCost * 2n) { // 2x safety margin
            return { 
                passed: false, 
                reason: `Insufficient balance: ${ethers.formatEther(balance)} ETH` 
            };
        }
        
        // Check contract ownership
        try {
            const owner = await contract.owner();
            if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
                return { passed: false, reason: 'Not contract owner' };
            }
        } catch (error) {
            return { passed: false, reason: 'Failed to verify contract ownership' };
        }
        
        // Simulate transaction
        const simulationResult = await this.simulateTransaction(opportunity);
        if (!simulationResult.success) {
            return { passed: false, reason: `Simulation failed: ${simulationResult.error}` };
        }
        
        // Check profitability after gas
        const gasCostUSD = await this.gasManager.estimateGasCostUSD(
            opportunity.network,
            opportunity.gasEstimate
        );
        
        if (opportunity.profitUSD <= gasCostUSD) {
            return { 
                passed: false, 
                reason: `Unprofitable after gas: $${opportunity.profitUSD} - $${gasCostUSD}` 
            };
        }
        
        return { passed: true };
    }
    
    private async simulateTransaction(opportunity: ArbitrageOpportunity): Promise<{
        success: boolean;
        error?: string;
    }> {
        try {
            const contract = this.contracts.get(opportunity.network)!;
            const params = this.encodeArbitrageParams(opportunity);
            
            // Simulate using eth_call
            await contract.executeArbitrage.staticCall(
                opportunity.tokenA,
                opportunity.amountIn,
                params
            );
            
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
            // Prepare transaction based on opportunity type
            const params = this.encodeArbitrageParams(opportunity);
            
            // Add deadline check
            if (opportunity.deadline < Math.floor(Date.now() / 1000)) {
                return { success: false, error: 'Opportunity expired' };
            }
            
            // Execute with appropriate gas settings for the network
            const gasLimit = await this.calculateGasLimit(opportunity);
            
            const tx = await contract.executeArbitrage(
                opportunity.tokenA,
                opportunity.amountIn,
                params,
                {
                    gasLimit,
                    gasPrice,
                    // For zkSync Era, add specific fee params
                    ...(opportunity.network === 'zksync' && {
                        customData: {
                            gasPerPubdata: 50000,
                        }
                    })
                }
            );
            
            this.logger.info(`Transaction submitted: ${tx.hash}`);
            
            // Wait for confirmation with timeout
            const receipt = await this.waitForTransactionWithTimeout(tx, 60000); // 60 second timeout
            
            if (receipt && receipt.status === 1) {
                // Parse events to get actual profit
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
                    actualProfit = Number(ethers.formatUnits(parsed?.args.profit || 0, 6)); // Assuming USDC
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
                    return { success: false, error: 'Nonce issue' };
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
        // Network-specific gas limits
        const baseGasLimits = {
            zksync: BigInt(1000000),  // zkSync uses more gas
            base: BigInt(300000),
            arbitrum: BigInt(500000),
        };
        
        const baseLimit = baseGasLimits[opportunity.network as keyof typeof baseGasLimits] 
            || BigInt(300000);
        
        // Add buffer based on DEX path complexity
        const pathMultiplier = BigInt(opportunity.dexPath.length || 1);
        const gasLimit = baseLimit * pathMultiplier;
        
        // Add 20% safety buffer
        return gasLimit * 120n / 100n;
    }
    
    private encodeArbitrageParams(opportunity: ArbitrageOpportunity): string {
        const abiCoder = new ethers.AbiCoder();
        
        // Encode based on opportunity structure
        if (opportunity.dexPath.length > 1) {
            // Multi-DEX arbitrage
            return abiCoder.encode(
                ['address', 'address', 'uint128', 'uint128', 'address[]', 'bytes'],
                [
                    opportunity.tokenA,
                    opportunity.tokenB,
                    opportunity.amountIn,
                    opportunity.expectedAmountOut,
                    opportunity.dexPath.map(d => d.router),
                    '0x' // Additional calldata if needed
                ]
            );
        } else {
            // Simple arbitrage
            return abiCoder.encode(
                ['address', 'address', 'uint128', 'uint128', 'address[]', 'bytes'],
                [
                    opportunity.tokenA,
                    opportunity.tokenB,
                    opportunity.amountIn,
                    opportunity.expectedAmountOut,
                    [opportunity.dexPath[0]?.router || ethers.ZeroAddress],
                    '0x'
                ]
            );
        }
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
}