use anyhow::Result;
use ethers::{
    abi::Abi,
    contract::abigen,
    types::{Address, U256},
};
use log::{debug, info};
use std::sync::Arc;

use crate::models::{DexPool, DexType, TokenPair};
use crate::providers::MultiProvider;

abigen!(
    UniswapV2Factory,
    r#"[
        function getPair(address tokenA, address tokenB) external view returns (address pair)
        function allPairs(uint256) external view returns (address)
        function allPairsLength() external view returns (uint256)
    ]"#
);

abigen!(
    UniswapV2Pair,
    r#"[
        function token0() external view returns (address)
        function token1() external view returns (address)
        function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)
    ]"#
);

pub struct UniswapV2Handler {
    provider: Arc<MultiProvider>,
    factory_address: Address,
}

impl UniswapV2Handler {
    pub async fn new(provider: Arc<MultiProvider>) -> Result<Self> {
        let factory_address = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f"
            .parse::<Address>()?;

        Ok(Self {
            provider,
            factory_address,
        })
    }

    pub async fn get_all_pools(&self) -> Result<Vec<DexPool>> {
        println!("\n🚀 SCANNING ESTABLISHED PAIRS - Higher chance of arbitrage");
        
        let provider = self.provider.get_provider().await;
        let factory = UniswapV2Factory::new(self.factory_address, provider.clone());

        // Get total number of pairs
        let total_pairs = factory.all_pairs_length().call().await?;
        info!("Total UniswapV2 pairs: {}", total_pairs);
        
        let mut pools = Vec::new();
        
        // Scan OLDER pairs (indices 100,000 to 101,000) - these are established tokens
        // that are more likely to trade on multiple DEXs
        let start = U256::from(100000);
        let end = U256::from(101000).min(total_pairs);
        
        println!("⚡ Scanning established pairs (100k-101k range) - these often have arbitrage!");
        println!("   These older pairs trade on multiple DEXs = more opportunities");
        
        for i in start.as_u64()..end.as_u64() {
            if let Ok(pair_address) = factory.all_pairs(U256::from(i)).call().await {
                // Get basic pool info without token details
                if let Ok(pool) = self.get_pool_info_fast(pair_address).await {
                    // Only include pools with some liquidity
                    if pool.reserve0 > U256::zero() && pool.reserve1 > U256::zero() {
                        pools.push(pool);
                    }
                    
                    // Show progress
                    if pools.len() % 50 == 0 {
                        println!("   Loaded {} pools...", pools.len());
                    }
                }
            }
        }
        
        println!("\n✅ Found {} UniswapV2 pools with liquidity", pools.len());
        Ok(pools)
    }

    pub async fn get_top_pools(&self, limit: usize) -> Result<Vec<DexPool>> {
        let provider = self.provider.get_provider().await;
        let factory = UniswapV2Factory::new(self.factory_address, provider.clone());

        let total_pairs = factory.all_pairs_length().call().await?;
        info!("Total UniswapV2 pairs: {}", total_pairs);

        let mut pools = Vec::new();
        
        // Get the most recent pairs (usually most liquid)
        let start = if total_pairs > U256::from(limit * 2) {
            total_pairs - U256::from(limit * 2)
        } else {
            U256::zero()
        };

        for i in start.as_u64()..total_pairs.as_u64().min(start.as_u64() + limit as u64) {
            if let Ok(pair_address) = factory.all_pairs(U256::from(i)).call().await {
                if let Ok(pool) = self.get_pool_info(pair_address).await {
                    pools.push(pool);
                }
            }
            
            if pools.len() >= limit {
                break;
            }
        }

        Ok(pools)
    }

    async fn get_pool_info_fast(&self, pair_address: Address) -> Result<DexPool> {
        let provider = self.provider.get_provider().await;
        let pair = UniswapV2Pair::new(pair_address, provider.clone());

        // Just get the essential data
        let token0 = pair.token_0().call().await?;
        let token1 = pair.token_1().call().await?;
        let reserves = pair.get_reserves().call().await?;

        // Skip token info lookup - just use addresses
        let token_info = TokenPair {
            token0,
            token1,
            symbol0: format!("T0-{:?}", &token0.to_string()[2..6]),
            symbol1: format!("T1-{:?}", &token1.to_string()[2..6]),
            decimals0: 18,
            decimals1: 18,
        };

        Ok(DexPool {
            dex: DexType::UniswapV2,
            address: pair_address,
            token_pair: token_info,
            reserve0: U256::from(reserves.0),
            reserve1: U256::from(reserves.1),
            fee: 30, // 0.3% fee for UniswapV2
        })
    }

    async fn get_pool_info(&self, pair_address: Address) -> Result<DexPool> {
        self.get_pool_info_fast(pair_address).await
    }

    async fn get_token_info(&self, token0: Address, token1: Address) -> Result<TokenPair> {
        // Simplified - just return with default values
        Ok(TokenPair {
            token0,
            token1,
            symbol0: format!("{:?}", token0).chars().take(6).collect(),
            symbol1: format!("{:?}", token1).chars().take(6).collect(),
            decimals0: 18,
            decimals1: 18,
        })
    }
}