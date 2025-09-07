use anyhow::Result;
use ethers::{
    abi::Abi,
    contract::abigen,
    types::{Address, U256, H256},
};
use log::{info, warn, debug};
use std::sync::Arc;

use crate::models::{DexPool, DexType, TokenPair};
use crate::providers::MultiProvider;

abigen!(
    UniswapV3Factory,
    r#"[
        function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)
    ]"#
);

abigen!(
    UniswapV3Pool,
    r#"[
        function token0() external view returns (address)
        function token1() external view returns (address)
        function fee() external view returns (uint24)
        function liquidity() external view returns (uint128)
        function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)
    ]"#
);

pub struct UniswapV3Handler {
    provider: Arc<MultiProvider>,
    factory_address: Address,
}

impl UniswapV3Handler {
    pub async fn new(provider: Arc<MultiProvider>) -> Result<Self> {
        let factory_address = "0x1F98431c8aD98523631AE4a59f267346ea31F984"
            .parse::<Address>()?;

        Ok(Self {
            provider,
            factory_address,
        })
    }

    pub async fn get_all_pools_for_pairs(&self, token_pairs: Vec<(Address, Address)>) -> Result<Vec<DexPool>> {
        let provider = self.provider.get_provider().await;
        let factory = UniswapV3Factory::new(self.factory_address, provider.clone());
        
        let fee_tiers = vec![100u32, 500u32, 3000u32, 10000u32]; // 0.01%, 0.05%, 0.3%, 1%
        let mut pools = Vec::new();
        
        info!("Scanning UniswapV3 pools for {} token pairs", token_pairs.len());
        
        for (i, (token0, token1)) in token_pairs.iter().enumerate() {
            for &fee in &fee_tiers {
                match factory.get_pool(*token0, *token1, fee).call().await {
                    Ok(pool_address) if pool_address != Address::zero() => {
                        if let Ok(pool) = self.get_pool_info(pool_address).await {
                            // Check for minimum liquidity
                            if pool.reserve0 > U256::from(10u128.pow(15)) || 
                               pool.reserve1 > U256::from(10u128.pow(15)) {
                                pools.push(pool);
                            }
                        }
                    }
                    _ => {}
                }
            }
            
            if i % 100 == 0 && i > 0 {
                debug!("Checked {} V3 pairs, found {} pools", i, pools.len());
            }
        }
        
        info!("Found {} UniswapV3 pools with liquidity", pools.len());
        Ok(pools)
    }

    pub async fn get_top_pools(&self, limit: usize) -> Result<Vec<DexPool>> {
        let provider = self.provider.get_provider().await;
        let factory = UniswapV3Factory::new(self.factory_address, provider.clone());

        // Common token addresses on mainnet
        let common_tokens = vec![
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
            "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
            "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
            "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
            "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", // WBTC
            "0x514910771AF9Ca656af840dff83E8264EcF986CA", // LINK
            "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", // UNI
            "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", // SHIB
            "0x4d224452801ACEd8B2F0aebE155379bb5D594381", // APE
            "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", // AAVE
        ];

        let fee_tiers = vec![500u32, 3000u32, 10000u32]; // 0.05%, 0.3%, 1%
        let mut pools = Vec::new();

        // Get pools for common token pairs
        for i in 0..common_tokens.len() {
            for j in i + 1..common_tokens.len() {
                let token0 = common_tokens[i].parse::<Address>()?;
                let token1 = common_tokens[j].parse::<Address>()?;

                for &fee in &fee_tiers {
                    if let Ok(pool_address) = factory
                        .get_pool(token0, token1, fee)
                        .call()
                        .await
                    {
                        if pool_address != Address::zero() {
                            if let Ok(pool) = self.get_pool_info(pool_address).await {
                                pools.push(pool);
                            }
                        }
                    }

                    if pools.len() >= limit {
                        return Ok(pools);
                    }
                }
            }
        }

        Ok(pools)
    }

    async fn get_pool_info(&self, pool_address: Address) -> Result<DexPool> {
        let provider = self.provider.get_provider().await;
        let pool = UniswapV3Pool::new(pool_address, provider.clone());

        let token0 = pool.token_0().call().await?;
        let token1 = pool.token_1().call().await?;
        let fee = pool.fee().call().await?;
        let liquidity = pool.liquidity().call().await?;
        let slot0 = pool.slot_0().call().await?;

        // Calculate approximate reserves from liquidity and price
        let _sqrt_price = U256::from(slot0.0);
        let liquidity_u256 = U256::from(liquidity);

        // Simplified reserve calculation
        let reserve0 = liquidity_u256 * U256::from(10u128.pow(12));
        let reserve1 = liquidity_u256 * U256::from(10u128.pow(12));

        // Get token info
        let token_info = self.get_token_info(token0, token1).await?;

        Ok(DexPool {
            dex: DexType::UniswapV3,
            address: pool_address,
            token_pair: token_info,
            reserve0,
            reserve1,
            fee: fee / 100, // Convert to basis points
        })
    }

    async fn get_token_info(&self, token0: Address, token1: Address) -> Result<TokenPair> {
        let provider = self.provider.get_provider().await;

        let erc20_abi: Abi = serde_json::from_str(
            r#"[
                {"constant":true,"inputs":[],"name":"symbol","outputs":[{"name":"","type":"string"}],"type":"function"},
                {"constant":true,"inputs":[],"name":"decimals","outputs":[{"name":"","type":"uint8"}],"type":"function"}
            ]"#
        )?;

        let mut symbol0 = "UNKNOWN".to_string();
        let mut symbol1 = "UNKNOWN".to_string();
        let mut decimals0 = 18u8;
        let mut decimals1 = 18u8;

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