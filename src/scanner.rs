use anyhow::Result;
use chrono::Local;
use ethers::types::U256;
use log::{error, info, warn, debug};
use std::sync::Arc;
use tokio::time::{sleep, Duration};

use crate::config::Config;
use crate::dex::DexManager;
use crate::flashloan::FlashLoanManager;
use crate::gas::GasEstimator;
use crate::models::{ArbitrageOpportunity, DexPool, FlashLoanProvider};
use crate::providers::MultiProvider;

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
        let mut total_opportunities_found = 0u64;
        let mut profitable_opportunities_found = 0u64;
        
        println!("\n🚀 ARBITRAGE SCANNER STARTED");
        println!("================================");
        println!("Settings:");
        println!("  Min Profit: ${}", self.config.min_profit_usd);
        println!("  Max Gas: {} gwei", self.config.max_gas_price_gwei);
        println!("  Scan Interval: {}ms", self.config.scan_interval_ms);
        println!("================================\n");

        loop {
            iteration += 1;
            
            match self.scan_cycle(iteration).await {
                Ok(opportunities) => {
                    if !opportunities.is_empty() {
                        total_opportunities_found += opportunities.len() as u64;
                        
                        // Count profitable ones
                        let profitable = opportunities.iter()
                            .filter(|o| o.net_profit_usd > 0.0)
                            .count() as u64;
                        profitable_opportunities_found += profitable;
                        
                        self.display_opportunities(&opportunities);
                        
                        // Show statistics
                        println!("\n📊 STATISTICS:");
                        println!("  Total opportunities found: {}", total_opportunities_found);
                        println!("  Profitable opportunities: {}", profitable_opportunities_found);
                        println!("  Current scan: #{}", iteration);
                    } else if iteration % 10 == 0 {
                        println!("⏳ Scan #{}: No opportunities (checked {} times, found {} total, {} profitable)", 
                            iteration, iteration, total_opportunities_found, profitable_opportunities_found);
                    }
                }
                Err(e) => {
                    error!("Scan cycle error: {}", e);
                }
            }

            sleep(Duration::from_millis(self.config.scan_interval_ms)).await;
        }
    }

    async fn scan_cycle(&self, iteration: u64) -> Result<Vec<ArbitrageOpportunity>> {
        // Update gas price and ETH price periodically
        if iteration % 5 == 0 {
            if let Err(e) = self.gas_estimator.update_eth_price().await {
                warn!("Failed to update ETH price: {}", e);
            }
            
            if let Ok(gas_price) = self.gas_estimator.get_current_gas_price().await {
                debug!("Current gas price: {:.2} gwei", gas_price.total_gwei);
                
                if gas_price.total_gwei > self.config.max_gas_price_gwei as f64 {
                    warn!("⚠️ Gas too high: {:.2} gwei > {} gwei (opportunities will be less profitable)",
                        gas_price.total_gwei, self.config.max_gas_price_gwei
                    );
                }
            }
        }

        // Get current block
        let block_number = self.provider.get_block_number().await?;
        
        if iteration == 1 || iteration % 20 == 0 {
            info!("Scanning block #{}", block_number);
        }

        // Fetch all DEX pools
        let pools = self.dex_manager.get_all_pools().await?;
        
        if pools.is_empty() {
            warn!("No pools found");
            return Ok(Vec::new());
        }

        // Find arbitrage opportunities
        let raw_opportunities = self.find_flash_loan_arbitrage(&pools);
        
        if !raw_opportunities.is_empty() {
            println!("🔍 Found {} potential arbitrage paths, calculating actual profits...", 
                raw_opportunities.len());
            
            // Show sample of what we found
            for (i, (buy, sell, _amount, diff)) in raw_opportunities.iter().take(5).enumerate() {
                println!("  #{}: {}/{} - Buy on {} → Sell on {} (spread: {:.2}%)",
                    i + 1,
                    buy.token_pair.symbol0,
                    buy.token_pair.symbol1,
                    buy.dex,
                    sell.dex,
                    diff.as_u64() as f64 / 100.0
                );
            }
        }
        
        // Limit to top 20 opportunities for speed
        let top_opportunities: Vec<_> = raw_opportunities.into_iter()
            .take(20)
            .collect();
        
        // Calculate ACTUAL profitability with all fees
        let mut all_opportunities = Vec::new();
        
        for (buy_pool, sell_pool, borrow_amount, _) in top_opportunities {
            // Test with Balancer first (0% fee)
            if let Ok(opportunity) = self
                .calculate_accurate_profit(
                    buy_pool.clone(),
                    sell_pool.clone(),
                    borrow_amount,
                    FlashLoanProvider::Balancer,
                    block_number,
                )
                .await
            {
                all_opportunities.push(opportunity);
            }
        }
        
        // Sort by net profit
        all_opportunities.sort_by(|a, b| b.net_profit_usd.partial_cmp(&a.net_profit_usd).unwrap());
        
        Ok(all_opportunities)
    }

    fn find_flash_loan_arbitrage(&self, pools: &[DexPool]) -> Vec<(DexPool, DexPool, U256, U256)> {
        let mut opportunities = Vec::new();

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

        debug!("Analyzing {} unique token pairs", pool_map.len());

        // Find arbitrage opportunities
        for (_pair, pools_for_pair) in pool_map.iter() {
            if pools_for_pair.len() < 2 {
                continue;
            }

            for i in 0..pools_for_pair.len() {
                for j in i + 1..pools_for_pair.len() {
                    let pool1 = pools_for_pair[i];
                    let pool2 = pools_for_pair[j];

                    // Prioritize cross-DEX opportunities
                    if pool1.dex == pool2.dex {
                        continue;
                    }

                    // Calculate price difference
                    let price1 = self.calculate_price(pool1);
                    let price2 = self.calculate_price(pool2);
                    
                    if price1.is_zero() || price2.is_zero() {
                        continue;
                    }

                    // Calculate percentage difference
                    let (lower_price, higher_price, buy_pool, sell_pool) = 
                        if price1 < price2 {
                            (price1, price2, pool1, pool2)
                        } else {
                            (price2, price1, pool2, pool1)
                        };

                    let price_diff = higher_price - lower_price;
                    let diff_percentage = (price_diff * U256::from(10000)) / lower_price;

                    // Need at least 0.65% to cover both DEX fees (0.3% each)
                    if diff_percentage > U256::from(65) {
                        // Calculate optimal borrow amount
                        let borrow_amount = self.calculate_optimal_borrow(buy_pool, sell_pool);
                        
                        if borrow_amount > U256::from(10u128.pow(16)) { // Min 0.01 tokens
                            opportunities.push((
                                (*buy_pool).clone(),
                                (*sell_pool).clone(),
                                borrow_amount,
                                diff_percentage
                            ));
                            
                            debug!("Found opportunity: {}/{} - {:.2}% spread between {} and {}", 
                                buy_pool.token_pair.symbol0,
                                buy_pool.token_pair.symbol1,
                                diff_percentage.as_u64() as f64 / 100.0,
                                buy_pool.dex,
                                sell_pool.dex
                            );
                        }
                    }
                }
            }
        }

        opportunities
    }

    fn calculate_optimal_borrow(&self, buy_pool: &DexPool, sell_pool: &DexPool) -> U256 {
        // Use the actual optimal arbitrage formula
        // For simplicity, using a conservative approach: 0.5% of smaller reserve
        let smaller_reserve = buy_pool.reserve0.min(sell_pool.reserve0);
        let optimal = smaller_reserve / U256::from(200);
        
        // Cap at 100 ETH worth to be realistic
        let max_borrow = U256::from(100u128 * 10u128.pow(18));
        optimal.min(max_borrow)
    }

    async fn calculate_accurate_profit(
        &self,
        buy_pool: DexPool,
        sell_pool: DexPool,
        borrow_amount: U256,
        flashloan_provider: FlashLoanProvider,
        block_number: u64,
    ) -> Result<ArbitrageOpportunity> {
        // Step 1: Calculate the arbitrage trade path
        // Borrow token0 -> Buy token1 on buy_pool -> Sell token1 on sell_pool -> Get token0 back
        
        // Calculate first swap (token0 -> token1 on buy_pool)
        let token1_received = self.dex_manager.calculate_output_amount(
            borrow_amount,
            buy_pool.reserve0,
            buy_pool.reserve1,
            buy_pool.fee,
        );
        
        // Calculate second swap (token1 -> token0 on sell_pool)
        let token0_received = self.dex_manager.calculate_output_amount(
            token1_received,
            sell_pool.reserve1,
            sell_pool.reserve0,
            sell_pool.fee,
        );
        
        // Step 2: Calculate flash loan costs
        let flash_loan_fee_bps = self
            .flash_loan_manager
            .get_flash_loan_fee(flashloan_provider)
            .await?;
        
        let flash_loan_fee = self
            .flash_loan_manager
            .calculate_flash_loan_cost(borrow_amount, flash_loan_fee_bps);
        
        // Total amount we need to repay (principal + fee)
        let repay_amount = borrow_amount + flash_loan_fee;
        
        // Step 3: Calculate gross profit
        let gross_profit_wei = if token0_received > repay_amount {
            token0_received - repay_amount
        } else {
            U256::zero()
        };
        
        // Step 4: Calculate gas costs
        let gas_estimate = self.gas_estimator.estimate_arbitrage_gas().await?;
        
        // Add extra gas for flash loan operations
        let flash_loan_extra_gas = U256::from(100000); // Simplified - was calling undefined method
        let total_gas = gas_estimate.gas_limit + flash_loan_extra_gas;
        let total_gas_cost_wei = total_gas * (gas_estimate.gas_price.base_fee + gas_estimate.gas_price.priority_fee);
        let total_gas_cost_usd = self.gas_estimator.wei_to_usd(total_gas_cost_wei).await;
        
        // Step 5: Calculate final NET profit - FIX THE AWAIT HERE
        let gross_profit_usd = self.gas_estimator.wei_to_usd(gross_profit_wei).await;
        let net_profit_usd = gross_profit_usd - total_gas_cost_usd;
        
        // Step 6: Calculate additional metrics
        let _price_impact = self.estimate_price_impact(&buy_pool, &sell_pool, borrow_amount);
        
        // Log the calculation breakdown
        if net_profit_usd > 0.0 || gross_profit_usd > 10.0 {
            debug!("📊 Profit Breakdown:");
            debug!("  Borrow: {} {}", 
                crate::utils::format_token_amount(borrow_amount, buy_pool.token_pair.decimals0),
                buy_pool.token_pair.symbol0
            );
            debug!("  After swap 1: {} {}", 
                crate::utils::format_token_amount(token1_received, buy_pool.token_pair.decimals1),
                buy_pool.token_pair.symbol1
            );
            debug!("  After swap 2: {} {}", 
                crate::utils::format_token_amount(token0_received, buy_pool.token_pair.decimals0),
                buy_pool.token_pair.symbol0
            );
            debug!("  Flash loan fee: {} {} ({} bps)", 
                crate::utils::format_token_amount(flash_loan_fee, buy_pool.token_pair.decimals0),
                buy_pool.token_pair.symbol0,
                flash_loan_fee_bps
            );
            debug!("  Gross profit: ${:.2}", gross_profit_usd);
            debug!("  Gas cost: ${:.2}", total_gas_cost_usd);
            debug!("  NET PROFIT: ${:.2}", net_profit_usd);
        }

        Ok(ArbitrageOpportunity {
            token_pair: buy_pool.token_pair.clone(),
            buy_pool,
            sell_pool,
            optimal_amount: borrow_amount,
            profit_wei: gross_profit_wei,
            profit_usd: gross_profit_usd,
            gas_cost_wei: total_gas_cost_wei,
            gas_cost_usd: total_gas_cost_usd,
            net_profit_usd,
            flashloan_provider,
            block_number,
        })
    }

    fn estimate_price_impact(&self, buy_pool: &DexPool, sell_pool: &DexPool, amount: U256) -> f64 {
        // Estimate how much our trade will move the price
        // Simplified calculation
        let impact_buy = amount.as_u128() as f64 / buy_pool.reserve0.as_u128() as f64;
        let impact_sell = amount.as_u128() as f64 / sell_pool.reserve0.as_u128() as f64;
        (impact_buy + impact_sell) * 100.0 // Return as percentage
    }

    fn calculate_price(&self, pool: &DexPool) -> U256 {
        if pool.reserve0.is_zero() || pool.reserve1.is_zero() {
            return U256::zero();
        }
        (pool.reserve1 * U256::from(10u128.pow(18))) / pool.reserve0
    }

    fn display_opportunities(&self, opportunities: &[ArbitrageOpportunity]) {
        println!("\n{}", "=".repeat(80));
        println!("💰 ARBITRAGE OPPORTUNITIES FOUND - {}", Local::now().format("%Y-%m-%d %H:%M:%S"));
        println!("{}", "=".repeat(80));

        let mut profitable = Vec::new();
        let mut unprofitable = Vec::new();

        for opp in opportunities {
            if opp.net_profit_usd > 0.0 {
                profitable.push(opp);
            } else {
                unprofitable.push(opp);
            }
        }

        // Show profitable opportunities first
        if !profitable.is_empty() {
            println!("\n✅ PROFITABLE OPPORTUNITIES ({} found):", profitable.len());
            println!("{}", "-".repeat(80));
            
            for (i, opp) in profitable.iter().enumerate() {
                println!("\n🎯 Opportunity #{} [PROFITABLE]", i + 1);
                self.display_opportunity_details(opp);
            }
        }

        // Show unprofitable ones for learning
        if !unprofitable.is_empty() {
            println!("\n❌ UNPROFITABLE OPPORTUNITIES ({} found):", unprofitable.len());
            println!("{}", "-".repeat(80));
            
            for (i, opp) in unprofitable.iter().take(3).enumerate() {
                println!("\n📉 Opportunity #{} [LOSS]", profitable.len() + i + 1);
                self.display_opportunity_details(opp);
            }
            
            if unprofitable.len() > 3 {
                println!("\n... and {} more unprofitable opportunities", unprofitable.len() - 3);
            }
        }

        // Summary
        println!("\n{}", "=".repeat(80));
        println!("📊 SUMMARY:");
        println!("  Total opportunities analyzed: {}", opportunities.len());
        println!("  Profitable: {} ({}%)", 
            profitable.len(), 
            (profitable.len() * 100) / opportunities.len().max(1)
        );
        println!("  Unprofitable: {}", unprofitable.len());
        
        if !profitable.is_empty() {
            let total_profit: f64 = profitable.iter().map(|o| o.net_profit_usd).sum();
            let best_profit = profitable.iter()
                .map(|o| o.net_profit_usd)
                .max_by(|a, b| a.partial_cmp(b).unwrap())
                .unwrap_or(0.0);
            
            println!("  Best opportunity: ${:.2}", best_profit);
            println!("  Total potential profit: ${:.2}", total_profit);
        }
        
        println!("{}", "=".repeat(80));
    }

    fn display_opportunity_details(&self, opp: &ArbitrageOpportunity) {
        println!("  📍 Token Pair: {}/{}", opp.token_pair.symbol0, opp.token_pair.symbol1);
        println!("  🔄 Route: {} → {} → {}", 
            opp.flashloan_provider,
            opp.buy_pool.dex,
            opp.sell_pool.dex
        );
        
        println!("\n  💵 FINANCIAL BREAKDOWN:");
        println!("  ├─ Flash Loan Amount: {} {}", 
            crate::utils::format_token_amount(opp.optimal_amount, opp.token_pair.decimals0),
            opp.token_pair.symbol0
        );
        println!("  ├─ Gross Profit: ${:.4} ({} wei)", 
            opp.profit_usd,
            opp.profit_wei
        );
        println!("  ├─ Gas Cost: ${:.4}", opp.gas_cost_usd);
        
        if opp.net_profit_usd > 0.0 {
            println!("  └─ NET PROFIT: ${:.4} ✅", opp.net_profit_usd);
        } else {
            println!("  └─ NET LOSS: ${:.4} ❌", opp.net_profit_usd);
        }
        
        // Show profitability metrics
        let roi = if opp.gas_cost_usd > 0.0 {
            (opp.net_profit_usd / opp.gas_cost_usd) * 100.0
        } else {
            0.0
        };
        
        println!("\n  📈 METRICS:");
        println!("  ├─ ROI: {:.1}%", roi);
        println!("  ├─ Gas/Profit Ratio: {:.1}%", 
            if opp.profit_usd > 0.0 {
                (opp.gas_cost_usd / opp.profit_usd) * 100.0
            } else {
                100.0
            }
        );
        println!("  └─ Block: #{}", opp.block_number);
        
        // Execution instructions if profitable
        if opp.net_profit_usd > 0.0 {
            println!("\n  ⚡ EXECUTION STEPS:");
            println!("  1. Flash borrow {} {} from {}", 
                crate::utils::format_token_amount(opp.optimal_amount, opp.token_pair.decimals0),
                opp.token_pair.symbol0,
                opp.flashloan_provider
            );
            println!("  2. Swap to {} on {} (at lower price)", 
                opp.token_pair.symbol1,
                opp.buy_pool.dex
            );
            println!("  3. Swap back to {} on {} (at higher price)", 
                opp.token_pair.symbol0,
                opp.sell_pool.dex
            );
            println!("  4. Repay flash loan + fees");
            println!("  5. Keep profit: ${:.2}", opp.net_profit_usd);
        }
    }
}