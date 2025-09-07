use anyhow::{Context, Result};
use ethers::types::Address;
use std::env;
use std::str::FromStr;

#[derive(Debug, Clone)]
pub struct Config {
    // API Keys
    pub alchemy_api_key: String,
    pub infura_api_key: String,
    pub etherscan_api_key: String,
    pub backup_rpc_url: Option<String>,
    
    // Scanner settings
    pub min_profit_usd: f64,
    pub max_gas_price_gwei: u64,
    pub block_confirmations: u64,
    pub scan_interval_ms: u64,
    
    // Contract addresses
    pub aave_v3_pool: Address,
    pub balancer_vault: Address,
    pub uniswap_v2_router: Address,
    pub uniswap_v3_router: Address,
    pub sushiswap_router: Address,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        Ok(Config {
            alchemy_api_key: env::var("ALCHEMY_API_KEY")
                .context("ALCHEMY_API_KEY not set")?,
            infura_api_key: env::var("INFURA_API_KEY")
                .context("INFURA_API_KEY not set")?,
            etherscan_api_key: env::var("ETHERSCAN_API_KEY")
                .context("ETHERSCAN_API_KEY not set")?,
            backup_rpc_url: env::var("BACKUP_RPC_URL").ok(),
            
            min_profit_usd: env::var("MIN_PROFIT_USD")
                .unwrap_or_else(|_| "50".to_string())
                .parse()
                .context("Invalid MIN_PROFIT_USD")?,
            max_gas_price_gwei: env::var("MAX_GAS_PRICE_GWEI")
                .unwrap_or_else(|_| "100".to_string())
                .parse()
                .context("Invalid MAX_GAS_PRICE_GWEI")?,
            block_confirmations: env::var("BLOCK_CONFIRMATIONS")
                .unwrap_or_else(|_| "1".to_string())
                .parse()
                .context("Invalid BLOCK_CONFIRMATIONS")?,
            scan_interval_ms: env::var("SCAN_INTERVAL_MS")
                .unwrap_or_else(|_| "2000".to_string())
                .parse()
                .context("Invalid SCAN_INTERVAL_MS")?,
            
            aave_v3_pool: Address::from_str(
                &env::var("AAVE_V3_POOL")
                    .unwrap_or_else(|_| "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2".to_string())
            )?,
            balancer_vault: Address::from_str(
                &env::var("BALANCER_VAULT")
                    .unwrap_or_else(|_| "0xBA12222222228d8Ba445958a75a0704d566BF2C8".to_string())
            )?,
            uniswap_v2_router: Address::from_str(
                &env::var("UNISWAP_V2_ROUTER")
                    .unwrap_or_else(|_| "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D".to_string())
            )?,
            uniswap_v3_router: Address::from_str(
                &env::var("UNISWAP_V3_ROUTER")
                    .unwrap_or_else(|_| "0xE592427A0AEce92De3Edee1F18E0157C05861564".to_string())
            )?,
            sushiswap_router: Address::from_str(
                &env::var("SUSHISWAP_ROUTER")
                    .unwrap_or_else(|_| "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F".to_string())
            )?,
        })
    }

    pub fn get_alchemy_url(&self) -> String {
        format!("https://eth-mainnet.g.alchemy.com/v2/{}", self.alchemy_api_key)
    }

    pub fn get_infura_url(&self) -> String {
        format!("https://mainnet.infura.io/v3/{}", self.infura_api_key)
    }
}