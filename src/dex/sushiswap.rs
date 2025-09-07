use anyhow::Result;
use ethers::{
    contract::abigen,
    types::{Address, U256},
};
use log::{debug, info};
use std::sync::Arc;

use crate::models::{DexPool, DexType, TokenPair};
use crate::providers::MultiProvider;

abigen!(
    SushiFactory,
    r#"[
        function getPair(address tokenA, address tokenB) external view returns (address pair)
        function allPairs(uint256) external view returns (address)
        function allPairsLength() external view returns (uint256)
    ]"#
);

abigen!(
    SushiPair,
    r#"[
        function token0() external view returns (address)
        function token1() external view returns (address)
        function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)
    ]"#
);

pub struct SushiswapHandler {
    provider: Arc<MultiProvider>,
    factory_address: Address,
}

impl SushiswapHandler {
    pub async fn new(provider: Arc<MultiProvider>) -> Result<Self> {
        // SushiSwap factory on mainnet
        let factory_address = "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac"
            .parse::<Address>()?;

        Ok(Self {
            provider,
            factory_address,
        })
    }

    pub async fn get_pools_for_tokens(&self, tokens: &[Address]) -> Result<Vec<DexPool>> {
        let provider = self.provider.get_provider().await;
        let factory = SushiFactory::new(self.factory_address, provider.clone());
        
        let mut pools = Vec::new();
        
        info!("Checking SushiSwap pairs for {} tokens", tokens.len());
        
        // Check all token pairs
        for i in 0..tokens.len() {
            for j in i+1..tokens.len() {
                let token0 = tokens[i];
                let token1 = tokens[j];
                
                match factory.get_pair(token0, token1).call().await {
                    Ok(pair_address) if pair_address != Address::zero() => {
                        if let Ok(pool) = self.get_pool_info(pair_address).await {
                            // Only include pools with meaningful liquidity
                            if pool.reserve0 > U256::from(10u128.pow(15)) && 
                               pool.reserve1 > U256::from(10u128.pow(15)) {
                                pools.push(pool);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        
        info!("Found {} SushiSwap pools with liquidity", pools.len());
        Ok(pools)
    }

    pub async fn get_all_pools(&self) -> Result<Vec<DexPool>> {
        let provider = self.provider.get_provider().await;
        let factory = SushiFactory::new(self.factory_address, provider.clone());

        let total_pairs = factory.all_pairs_length().call().await?;
        info!("Total SushiSwap pairs: {}", total_pairs);
        
        let mut pools = Vec::new();
        
        // Get recent pairs (more likely to be active)
        let start = if total_pairs > U256::from(1000) {
            total_pairs - U256::from(1000)
        } else {
            U256::zero()
        };
        
        for i in start.as_u64()..total_pairs.as_u64() {
            if let Ok(pair_address) = factory.all_pairs(U256::from(i)).call().await {
                if let Ok(pool) = self.get_pool_info(pair_address).await {
                    if pool.reserve0 > U256::zero() && pool.reserve1 > U256::zero() {
                        pools.push(pool);
                    }
                }
            }
            
            if pools.len() >= 500 {
                break;
            }
        }
        
        Ok(pools)
    }

    async fn get_pool_info(&self, pair_address: Address) -> Result<DexPool> {
        let provider = self.provider.get_provider().await;
        let pair = SushiPair::new(pair_address, provider.clone());

        let token0 = pair.token_0().call().await?;
        let token1 = pair.token_1().call().await?;
        let reserves = pair.get_reserves().call().await?;

        // Get token info
        let token_info = self.get_token_info(token0, token1).await?;

        Ok(DexPool {
            dex: DexType::Sushiswap,
            address: pair_address,
            token_pair: token_info,
            reserve0: U256::from(reserves.0),
            reserve1: U256::from(reserves.1),
            fee: 30, // 0.3% fee for SushiSwap
        })
    }

    async fn get_token_info(&self, token0: Address, token1: Address) -> Result<TokenPair> {
        let provider = self.provider.get_provider().await;

        let erc20_abi: ethers::abi::Abi = serde_json::from_str(
            r#"[
                {"constant":true,"inputs":[],"name":"symbol","outputs":[{"name":"","type":"string"}],"type":"function"},
                {"constant":true,"inputs":[],"name":"decimals","outputs":[{"name":"","type":"uint8"}],"type":"function"}
            ]"#
        )?;

        let mut symbol0 = format!("T0-{:?}", &token0.to_string()[2..6]);
        let mut symbol1 = format!("T1-{:?}", &token1.to_string()[2..6]);
        let mut decimals0 = 18u8;
        let mut decimals1 = 18u8;

        // Try to get actual symbols (but don't fail if we can't)
        let contract0 = ethers::contract::Contract::new(token0, erc20_abi.clone(), provider.clone());
        if let Ok(s) = contract0.method::<_, String>("symbol", ())?.call().await {
            symbol0 = s;
        }
        if let Ok(d) = contract0.method::<_, u8>("decimals", ())?.call().await {
            decimals0 = d;
        }

        let contract1 = ethers::contract::Contract::new(token1, erc20_abi, provider);
        if let Ok(s) = contract1.method::<_, String>("symbol", ())?.call().await {
            symbol1 = s;
        }
        if let Ok(d) = contract1.method::<_, u8>("decimals", ())?.call().await {
            decimals1 = d;
        }

        Ok(TokenPair {
            token0,
            token1,
            symbol0,
            symbol1,
            decimals0,
            decimals1,
        })
    }
}