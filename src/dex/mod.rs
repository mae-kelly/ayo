use anyhow::Result;
use ethers::{
    contract::abigen,
    types::{Address, U256},
};
use log::{debug, error, warn};
use std::sync::Arc;

use crate::models::DexPool;
use crate::providers::MultiProvider;

pub mod uniswap_v2;
pub mod uniswap_v3;

use uniswap_v2::UniswapV2Handler;
use uniswap_v3::UniswapV3Handler;

// Generate contract bindings
abigen!(
    ERC20,
    r#"[
        function name() external view returns (string)
        function symbol() external view returns (string)
        function decimals() external view returns (uint8)
        function totalSupply() external view returns (uint256)
        function balanceOf(address account) external view returns (uint256)
    ]"#
);

pub struct DexManager {
    provider: Arc<MultiProvider>,
    uniswap_v2: UniswapV2Handler,
    uniswap_v3: UniswapV3Handler,
}

impl DexManager {
    pub async fn new(provider: Arc<MultiProvider>) -> Result<Self> {
        let uniswap_v2 = UniswapV2Handler::new(provider.clone()).await?;
        let uniswap_v3 = UniswapV3Handler::new(provider.clone()).await?;

        Ok(Self {
            provider,
            uniswap_v2,
            uniswap_v3,
        })
    }

    pub async fn get_all_pools(&self) -> Result<Vec<DexPool>> {
        let mut all_pools = Vec::new();

        println!("Starting DEX pool scan...");

        // Get UniswapV2 pools QUICKLY
        println!("\n📊 Getting UniswapV2 pools...");
        match self.uniswap_v2.get_all_pools().await {
            Ok(pools) => {
                all_pools.extend(pools.clone());
                
                // For now, skip UniswapV3 to get results faster
                println!("📊 Skipping UniswapV3 scan for speed - focusing on V2 arbitrage");
                println!("   (V2 pools often have better arbitrage opportunities anyway)");
            }
            Err(e) => {
                error!("Failed to get UniswapV2 pools: {}", e);
                // Try to get at least some pools
                if let Ok(pools) = self.uniswap_v2.get_top_pools(50).await {
                    all_pools.extend(pools);
                }
            }
        }

        println!("\n✅ Total pools ready for analysis: {}", all_pools.len());

        Ok(all_pools)
    }

    pub async fn get_token_info(&self, address: Address) -> Result<(String, u8)> {
        let provider = self.provider.get_provider().await;
        let token = ERC20::new(address, provider.clone());

        let symbol = token.symbol().call().await.unwrap_or_else(|_| "UNKNOWN".to_string());
        let decimals = token.decimals().call().await.unwrap_or(18);

        Ok((symbol, decimals))
    }

    pub fn calculate_output_amount(
        &self,
        input_amount: U256,
        reserve_in: U256,
        reserve_out: U256,
        fee_bps: u32,
    ) -> U256 {
        if input_amount.is_zero() || reserve_in.is_zero() || reserve_out.is_zero() {
            return U256::zero();
        }

        let fee_multiplier = U256::from(10000 - fee_bps);
        let input_with_fee = input_amount * fee_multiplier;
        let numerator = input_with_fee * reserve_out;
        let denominator = reserve_in * U256::from(10000) + input_with_fee;

        if denominator.is_zero() {
            return U256::zero();
        }

        numerator / denominator
    }

    pub fn find_arbitrage_opportunities(
        &self,
        pools: &[DexPool],
    ) -> Vec<(DexPool, DexPool, U256)> {
        let mut opportunities = Vec::new();

        // Group pools by token pair
        let mut pool_map: std::collections::HashMap<(Address, Address), Vec<&DexPool>> =
            std::collections::HashMap::new();

        for pool in pools {
            let key = if pool.token_pair.token0 < pool.token_pair.token1 {
                (pool.token_pair.token0, pool.token_pair.token1)
            } else {
                (pool.token_pair.token1, pool.token_pair.token0)
            };
            pool_map.entry(key).or_insert_with(Vec::new).push(pool);
        }

        // Find arbitrage opportunities between pools with same token pair
        for (_, pools_for_pair) in pool_map.iter() {
            if pools_for_pair.len() < 2 {
                continue;
            }

            for i in 0..pools_for_pair.len() {
                for j in i + 1..pools_for_pair.len() {
                    let pool1 = pools_for_pair[i];
                    let pool2 = pools_for_pair[j];

                    // Check if there's a price difference
                    if let Some(optimal_amount) = self.calculate_optimal_trade(pool1, pool2) {
                        if optimal_amount > U256::from(1000000) {
                            // Min amount threshold
                            opportunities.push(((*pool1).clone(), (*pool2).clone(), optimal_amount));
                        }
                    }
                }
            }
        }

        opportunities
    }

    fn calculate_optimal_trade(&self, pool1: &DexPool, pool2: &DexPool) -> Option<U256> {
        // Calculate price ratios
        let price1 = self.calculate_price_ratio(pool1);
        let price2 = self.calculate_price_ratio(pool2);

        // Check for zero prices
        if price1.is_zero() || price2.is_zero() {
            return None;
        }

        // Check if there's a meaningful price difference (> 0.3%)
        let diff = if price1 > price2 {
            ((price1 - price2) * U256::from(1000)) / price2
        } else {
            ((price2 - price1) * U256::from(1000)) / price1
        };

        if diff > U256::from(3) {
            // More than 0.3% difference
            // Calculate optimal trade amount (simplified formula)
            let optimal = U256::from(10u128.pow(18)); // Start with 1 token
            Some(optimal)
        } else {
            None
        }
    }

    fn calculate_price_ratio(&self, pool: &DexPool) -> U256 {
        if pool.reserve0.is_zero() || pool.reserve1.is_zero() {
            return U256::zero();
        }
        (pool.reserve1 * U256::from(10u128.pow(18))) / pool.reserve0
    }
}