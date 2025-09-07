use anyhow::Result;
use chrono::Local;
use ethers::types::U256;
use log::{error, info, warn};
use std::sync::Arc;
use tokio::time::{sleep, Duration};

use crate::config::Config;
use crate::dex::DexManager;
use crate::flashloan::FlashLoanManager;
use crate::gas::GasEstimator;
use crate::models::{ArbitrageOpportunity, DexPool};
use crate::providers::MultiProvider;
use crate::utils::format_opportunity;

pub struct ArbitrageScanner {
    config: Arc<Config>,
    provider: Arc<MultiProvider>,
    dex_manager: DexManager,
    flash_loan_manager: FlashLoanManager,
    gas_estimator: GasEstimator,
}

impl ArbitrageScanner {
    pub async fn new(config: Arc<Config>, provider: Arc<MultiProvider>) -> Result<Self> {
        let dex_manager = DexManager::new(provider.clone()).await?;
        let flash_loan_manager = FlashLoanManager::new(
            provider.clone(),
            config.aave_v3_pool,
            config.balancer_vault,
        );
        let gas_estimator = GasEstimator::new(provider.clone()).await?;

        Ok(Self {
            config,
            provider,
            dex_manager,
            flash_loan_manager,
            gas_estimator,
        })
    }

    pub async fn run(&self) -> Result<()> {
        let mut iteration = 0u64;
        println!("Scanner loop starting...");

        loop {
            iteration += 1;
            
            if iteration == 1 {
                println!("First scan cycle starting...");
            }
            
            match self.scan_cycle(iteration).await {
                Ok(opportunities) => {
                    if !opportunities.is_empty() {
                        self.display_opportunities(&opportunities);
                    } else if iteration % 10 == 0 {
                        println!("Scan #{}: No arbitrage opportunities found (this is normal)", iteration);
                    }
                }
                Err(e) => {
                    error!("Scan cycle error: {}", e);
                    eprintln!("Error in scan cycle: {}", e);
                    // Continue scanning even if there's an error
                }
            }

            sleep(Duration::from_millis(self.config.scan_interval_ms)).await;
        }
    }

    async fn scan_cycle(&self, iteration: u64) -> Result<Vec<ArbitrageOpportunity>> {
        // Update gas price periodically
        if iteration % 10 == 0 {
            if let Ok(gas_price) = self.gas_estimator.get_current_gas_price().await {
                info!("Current gas price: {:.2} gwei", gas_price.total_gwei);
                
                if gas_price.total_gwei > self.config.max_gas_price_gwei as f64 {
                    warn!(
                        "Gas price too high: {:.2} gwei > {} gwei",
                        gas_price.total_gwei, self.config.max_gas_price_gwei
                    );
                }
            }
        }

        // Get current block
        let block_number = self.provider.get_block_number().await?;
        
        if iteration % 20 == 0 {
            info!("Scanning block #{}", block_number);
        }

        // Fetch all DEX pools
        let pools = self.dex_manager.get_all_pools().await?;
        
        if pools.is_empty() {
            warn!("No pools found");
            return Ok(Vec::new());
        }

        // Find arbitrage opportunities with flash loans
        let raw_opportunities = self.find_flash_loan_arbitrage(&pools);
        
        // Filter and calculate profitability
        let mut profitable_opportunities = Vec::new();
        
        for (buy_pool, sell_pool, borrow_amount, expected_profit) in raw_opportunities {
            if let Ok(opportunity) = self
                .calculate_flash_loan_opportunity(
                    buy_pool,
                    sell_pool,
                    borrow_amount,
                    expected_profit,
                    block_number,
                )
                .await
            {
                if opportunity.net_profit_usd >= self.config.min_profit_usd {
                    profitable_opportunities.push(opportunity);
                }
            }
        }

        Ok(profitable_opportunities)
    }

    fn find_flash_loan_arbitrage(&self, pools: &[DexPool]) -> Vec<(DexPool, DexPool, U256, U256)> {
        let mut opportunities = Vec::new();
        let mut pairs_checked = 0;

        // Group pools by token pair
        let mut pool_map: std::collections::HashMap<(Address, Address), Vec<&DexPool>> =
            std::collections::HashMap::new();

        use ethers::types::Address;
        for pool in pools {
            let key = if pool.token_pair.token0 < pool.token_pair.token1 {
                (pool.token_pair.token0, pool.token_pair.token1)
            } else {
                (pool.token_pair.token1, pool.token_pair.token0)
            };
            pool_map.entry(key).or_insert_with(Vec::new).push(pool);
        }

        println!("Checking {} unique token pairs for arbitrage...", pool_map.len());

        // Find arbitrage opportunities between pools with same token pair
        for (_, pools_for_pair) in pool_map.iter() {
            if pools_for_pair.len() < 2 {
                continue;
            }

            pairs_checked += 1;
            
            for i in 0..pools_for_pair.len() {
                for j in i + 1..pools_for_pair.len() {
                    let pool1 = pools_for_pair[i];
                    let pool2 = pools_for_pair[j];

                    // Calculate flash loan arbitrage opportunity
                    if let Some((borrow_amount, expected_profit)) = 
                        self.calculate_optimal_flash_loan(pool1, pool2) {
                        
                        // Determine buy/sell direction
                        let price1 = self.calculate_price(pool1);
                        let price2 = self.calculate_price(pool2);
                        
                        // Show we found something
                        println!("   ✓ Found price difference: {}/{} between {} and {}", 
                            pool1.token_pair.symbol0,
                            pool1.token_pair.symbol1,
                            pool1.dex,
                            pool2.dex
                        );
                        
                        if price1 < price2 {
                            // Buy from pool1, sell to pool2
                            opportunities.push((
                                (*pool1).clone(),
                                (*pool2).clone(),
                                borrow_amount,
                                expected_profit
                            ));
                        } else {
                            // Buy from pool2, sell to pool1
                            opportunities.push((
                                (*pool2).clone(),
                                (*pool1).clone(),
                                borrow_amount,
                                expected_profit
                            ));
                        }
                    }
                }
            }
            
            if pairs_checked % 100 == 0 {
                println!("Checked {} pairs so far, found {} opportunities", 
                    pairs_checked, opportunities.len());
            }
        }

        println!("✓ Finished checking all pairs. Total opportunities: {}", opportunities.len());
        opportunities
    }

    fn calculate_optimal_flash_loan(&self, pool1: &DexPool, pool2: &DexPool) -> Option<(U256, U256)> {
        // Calculate prices in both pools
        let price1 = self.calculate_price(pool1);
        let price2 = self.calculate_price(pool2);

        // Need meaningful price difference
        if price1.is_zero() || price2.is_zero() {
            return None;
        }

        // Calculate price difference percentage
        let (lower_price, higher_price) = if price1 < price2 {
            (price1, price2)
        } else {
            (price2, price1)
        };

        let price_diff = higher_price - lower_price;
        let diff_percentage = (price_diff * U256::from(10000)) / lower_price;

        // REDUCED THRESHOLD: Need at least 0.1% difference (was 0.5%)
        if diff_percentage < U256::from(10) {  // Changed from 50 to 10
            return None;
        }

        // Determine which pool to buy from (lower price) and sell to (higher price)
        let (buy_pool, sell_pool) = if price1 < price2 {
            (pool1, pool2)
        } else {
            (pool2, pool1)
        };

        // Calculate optimal borrow amount using simplified formula
        // This would be more complex in production, considering pool depths
        let optimal_borrow = self.calculate_optimal_borrow_amount(
            buy_pool.reserve0,
            buy_pool.reserve1,
            sell_pool.reserve0,
            sell_pool.reserve1,
            buy_pool.fee,
            sell_pool.fee,
        );

        if optimal_borrow.is_zero() {
            return None;
        }

        // Simulate the flash loan arbitrage
        let (_output_amount, profit) = self.simulate_flash_loan_arbitrage(
            optimal_borrow,
            buy_pool,
            sell_pool,
        );

        // Don't check profitability here - let the main scanner decide
        // This way we see ALL opportunities, even unprofitable ones
        Some((optimal_borrow, profit))
    }

    fn calculate_optimal_borrow_amount(
        &self,
        reserve0_buy: U256,
        reserve1_buy: U256,
        reserve0_sell: U256,
        reserve1_sell: U256,
        fee_buy: u32,
        fee_sell: u32,
    ) -> U256 {
        // Simplified optimal amount calculation
        // In production, this would use the exact arbitrage formula
        
        // Start with a reasonable test amount (0.1% of smaller reserve)
        let smaller_reserve = reserve0_buy.min(reserve0_sell);
        let test_amount = smaller_reserve / U256::from(1000);
        
        // Ensure it's not too small
        if test_amount < U256::from(10u128.pow(16)) { // 0.01 tokens minimum
            return U256::from(10u128.pow(17)); // 0.1 tokens
        }
        
        test_amount
    }

    fn simulate_flash_loan_arbitrage(
        &self,
        borrow_amount: U256,
        buy_pool: &DexPool,
        sell_pool: &DexPool,
    ) -> (U256, U256) {
        // Step 1: Borrow token0 via flash loan
        // (No actual swap here, just the borrowed amount)
        
        // Step 2: Swap token0 for token1 on buy_pool (lower price)
        let token1_received = self.dex_manager.calculate_output_amount(
            borrow_amount,
            buy_pool.reserve0,
            buy_pool.reserve1,
            buy_pool.fee,
        );
        
        // Step 3: Swap token1 back to token0 on sell_pool (higher price)
        let token0_received = self.dex_manager.calculate_output_amount(
            token1_received,
            sell_pool.reserve1,
            sell_pool.reserve0,
            sell_pool.fee,
        );
        
        // Step 4: Calculate profit (amount received - amount borrowed)
        let profit = if token0_received > borrow_amount {
            token0_received - borrow_amount
        } else {
            U256::zero()
        };
        
        (token0_received, profit)
    }

    fn calculate_price(&self, pool: &DexPool) -> U256 {
        if pool.reserve0.is_zero() || pool.reserve1.is_zero() {
            return U256::zero();
        }
        // Price of token0 in terms of token1
        (pool.reserve1 * U256::from(10u128.pow(18))) / pool.reserve0
    }

    async fn calculate_flash_loan_opportunity(
        &self,
        buy_pool: DexPool,
        sell_pool: DexPool,
        borrow_amount: U256,
        expected_profit: U256,
        block_number: u64,
    ) -> Result<ArbitrageOpportunity> {
        // Select best flash loan provider
        let flashloan_provider = self
            .flash_loan_manager
            .select_best_provider(buy_pool.token_pair.token0);

        // Get flash loan fee
        let flash_loan_fee_bps = self
            .flash_loan_manager
            .get_flash_loan_fee(flashloan_provider)
            .await?;
        
        let flash_loan_cost = self
            .flash_loan_manager
            .calculate_flash_loan_cost(borrow_amount, flash_loan_fee_bps);

        // Estimate gas cost
        let gas_estimate = self.gas_estimator.estimate_arbitrage_gas().await?;

        // Calculate profit after flash loan fee
        let profit_after_loan = if expected_profit > flash_loan_cost {
            expected_profit - flash_loan_cost
        } else {
            U256::zero()
        };

        // Calculate USD values
        let profit_usd = self.gas_estimator.wei_to_usd(profit_after_loan);
        let net_profit_usd = profit_usd - gas_estimate.total_cost_usd;

        Ok(ArbitrageOpportunity {
            token_pair: buy_pool.token_pair.clone(),
            buy_pool,
            sell_pool,
            optimal_amount: borrow_amount,
            profit_wei: profit_after_loan,
            profit_usd,
            gas_cost_wei: gas_estimate.total_cost_wei,
            gas_cost_usd: gas_estimate.total_cost_usd,
            net_profit_usd,
            flashloan_provider,
            block_number,
        })
    }

    fn display_opportunities(&self, opportunities: &[ArbitrageOpportunity]) {
        println!("\n{}", "=".repeat(80));
        println!("⚡ FLASH LOAN ARBITRAGE OPPORTUNITIES - {}", Local::now().format("%Y-%m-%d %H:%M:%S"));
        println!("{}", "=".repeat(80));

        for (i, opp) in opportunities.iter().enumerate() {
            println!("\n📊 Opportunity #{}", i + 1);
            println!("{}", format_opportunity(opp));
            println!("\nExecution Steps:");
            println!("  1. Flash loan {} {} from {}", 
                crate::utils::format_token_amount(opp.optimal_amount, opp.token_pair.decimals0),
                opp.token_pair.symbol0,
                opp.flashloan_provider
            );
            println!("  2. Swap on {} for {}", opp.buy_pool.dex, opp.token_pair.symbol1);
            println!("  3. Swap back on {} for {}", opp.sell_pool.dex, opp.token_pair.symbol0);
            println!("  4. Repay flash loan + fee");
            println!("  5. Keep profit: ${:.2}", opp.net_profit_usd);
        }

        println!("\n{}", "=".repeat(80));
        println!("Total opportunities: {}", opportunities.len());
        
        let total_profit: f64 = opportunities.iter().map(|o| o.net_profit_usd).sum();
        println!("Total potential profit: ${:.2}", total_profit);
        println!("{}", "=".repeat(80));
    }
}