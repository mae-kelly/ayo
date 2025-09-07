use anyhow::Result;
use ethers::{
    contract::abigen,
    types::{Address, U256},
};
use log::{debug, error, warn, info};
use std::sync::Arc;
use std::collections::HashSet;

use crate::models::DexPool;
use crate::providers::MultiProvider;

pub mod uniswap_v2;
pub mod uniswap_v3;
pub mod sushiswap;

use uniswap_v2::UniswapV2Handler;
use uniswap_v3::UniswapV3Handler;
use sushiswap::SushiswapHandler;

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
    sushiswap: SushiswapHandler,
}

impl DexManager {
    pub async fn new(provider: Arc<MultiProvider>) -> Result<Self> {
        let uniswap_v2 = UniswapV2Handler::new(provider.clone()).await?;
        let uniswap_v3 = UniswapV3Handler::new(provider.clone()).await?;
        let sushiswap = SushiswapHandler::new(provider.clone()).await?;

        Ok(Self {
            provider,
            uniswap_v2,
            uniswap_v3,
            sushiswap,
        })
    }

    pub async fn get_all_pools(&self) -> Result<Vec<DexPool>> {
        let mut all_pools = Vec::new();

        println!("🔍 Starting comprehensive DEX pool scan...");

        // Get high-liquidity tokens that are likely to have arbitrage
        let target_tokens = self.get_target_tokens();
        
        println!("📊 Scanning {} high-liquidity tokens across multiple DEXs", target_tokens.len());

        // Get UniswapV2 pools for target pairs
        println!("\n1️⃣ Getting UniswapV2 pools...");
        match self.uniswap_v2.get_pools_for_tokens(&target_tokens).await {
            Ok(pools) => {
                println!("   ✓ Found {} UniswapV2 pools", pools.len());
                all_pools.extend(pools);
            }
            Err(e) => {
                error!("Failed to get UniswapV2 pools: {}", e);
            }
        }

        // Get SushiSwap pools for same pairs
        println!("\n2️⃣ Getting SushiSwap pools...");
        match self.sushiswap.get_pools_for_tokens(&target_tokens).await {
            Ok(pools) => {
                println!("   ✓ Found {} SushiSwap pools", pools.len());
                all_pools.extend(pools);
            }
            Err(e) => {
                error!("Failed to get SushiSwap pools: {}", e);
            }
        }

        // Get UniswapV3 pools
        println!("\n3️⃣ Getting UniswapV3 pools...");
        let token_pairs = self.create_token_pairs(&target_tokens);
        match self.uniswap_v3.get_all_pools_for_pairs(token_pairs).await {
            Ok(pools) => {
                println!("   ✓ Found {} UniswapV3 pools", pools.len());
                all_pools.extend(pools);
            }
            Err(e) => {
                error!("Failed to get UniswapV3 pools: {}", e);
            }
        }

        println!("\n✅ Total pools ready for arbitrage analysis: {}", all_pools.len());
        
        // Group by token pair to show coverage
        let mut pair_coverage = std::collections::HashMap::new();
        for pool in &all_pools {
            let key = format!("{}/{}", pool.token_pair.symbol0, pool.token_pair.symbol1);
            pair_coverage.entry(key).or_insert(Vec::new()).push(pool.dex.to_string());
        }
        
        println!("\n📈 Token pairs with multiple DEXs (arbitrage potential):");
        for (pair, dexes) in pair_coverage.iter() {
            if dexes.len() > 1 {
                println!("   {} on: {:?}", pair, dexes);
            }
        }

        Ok(all_pools)
    }

    fn get_target_tokens(&self) -> Vec<Address> {
        // High-liquidity tokens that commonly have arbitrage opportunities
        vec![
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
            "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
            "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
            "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
            "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", // WBTC
            "0x514910771AF9Ca656af840dff83E8264EcF986CA", // LINK
            "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", // UNI
            "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0", // MATIC
            "0x4d224452801ACEd8B2F0aebE155379bb5D594381", // APE
            "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", // AAVE
            "0xC944E90C64B2c07662A292be6244BDf05Cda44a7", // GRT
            "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2", // MKR
            "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F", // SNX
            "0xD533a949740bb3306d119CC777fa900bA034cd52", // CRV
            "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c", // EUROC
        ].iter().map(|s| s.parse::<Address>().unwrap()).collect()
    }

    fn create_token_pairs(&self, tokens: &[Address]) -> Vec<(Address, Address)> {
        let mut pairs = Vec::new();
        for i in 0..tokens.len() {
            for j in i+1..tokens.len() {
                pairs.push((tokens[i], tokens[j]));
            }
        }
        pairs
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
        for (pair, pools_for_pair) in pool_map.iter() {
            if pools_for_pair.len() < 2 {
                continue;
            }

            // Prioritize cross-DEX opportunities
            for i in 0..pools_for_pair.len() {
                for j in i + 1..pools_for_pair.len() {
                    let pool1 = pools_for_pair[i];
                    let pool2 = pools_for_pair[j];

                    // Skip if same DEX (less likely to have arbitrage)
                    if pool1.dex == pool2.dex {
                        continue;
                    }

                    // Check if there's a price difference
                    if let Some(optimal_amount) = self.calculate_optimal_trade(pool1, pool2) {
                        if optimal_amount > U256::from(10u128.pow(16)) { // Min 0.01 tokens
                            opportunities.push(((*pool1).clone(), (*pool2).clone(), optimal_amount));
                        }
                    }
                }
            }
        }

        // Sort by expected profit (approximate)
        opportunities.sort_by(|a, b| b.2.cmp(&a.2));

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

        // Calculate price difference percentage
        let diff = if price1 > price2 {
            ((price1 - price2) * U256::from(10000)) / price2
        } else {
            ((price2 - price1) * U256::from(10000)) / price1
        };

        // Need at least 0.7% difference to cover fees (0.3% on each DEX)
        if diff > U256::from(70) { // 0.7% difference
            // Calculate optimal trade amount using actual formula
            let optimal = self.calculate_optimal_amount_exact(pool1, pool2);
            Some(optimal)
        } else {
            None
        }
    }

    fn calculate_optimal_amount_exact(&self, pool1: &DexPool, pool2: &DexPool) -> U256 {
        // Simplified optimal amount calculation
        // Start with 1% of the smaller reserve
        let smaller_reserve = pool1.reserve0.min(pool2.reserve0);
        let amount = smaller_reserve / U256::from(100);
        
        // Cap at reasonable amount (e.g., 10 ETH worth)
        let max_amount = U256::from(10u128.pow(19)); // 10 tokens
        amount.min(max_amount)
    }

    fn calculate_price_ratio(&self, pool: &DexPool) -> U256 {
        if pool.reserve0.is_zero() || pool.reserve1.is_zero() {
            return U256::zero();
        }
        (pool.reserve1 * U256::from(10u128.pow(18))) / pool.reserve0
    }
}