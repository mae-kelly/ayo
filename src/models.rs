use ethers::types::{Address, U256};
use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TokenPair {
    pub token0: Address,
    pub token1: Address,
    pub symbol0: String,
    pub symbol1: String,
    pub decimals0: u8,
    pub decimals1: u8,
}

#[derive(Debug, Clone)]
pub struct DexPool {
    pub dex: DexType,
    pub address: Address,
    pub token_pair: TokenPair,
    pub reserve0: U256,
    pub reserve1: U256,
    pub fee: u32, // basis points (30 = 0.3%)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DexType {
    UniswapV2,
    UniswapV3,
    Sushiswap,
    Balancer,
    Curve,
}

impl fmt::Display for DexType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DexType::UniswapV2 => write!(f, "UniswapV2"),
            DexType::UniswapV3 => write!(f, "UniswapV3"),
            DexType::Sushiswap => write!(f, "Sushiswap"),
            DexType::Balancer => write!(f, "Balancer"),
            DexType::Curve => write!(f, "Curve"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ArbitrageOpportunity {
    pub token_pair: TokenPair,
    pub buy_pool: DexPool,
    pub sell_pool: DexPool,
    pub optimal_amount: U256,
    pub profit_wei: U256,
    pub profit_usd: f64,
    pub gas_cost_wei: U256,
    pub gas_cost_usd: f64,
    pub net_profit_usd: f64,
    pub flashloan_provider: FlashLoanProvider,
    pub block_number: u64,
}

#[derive(Debug, Clone, Copy)]
pub enum FlashLoanProvider {
    AaveV3,
    Balancer,
    DyDx,
}

impl fmt::Display for FlashLoanProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FlashLoanProvider::AaveV3 => write!(f, "Aave V3"),
            FlashLoanProvider::Balancer => write!(f, "Balancer"),
            FlashLoanProvider::DyDx => write!(f, "dYdX"),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TokenInfo {
    pub address: Address,
    pub symbol: String,
    pub decimals: u8,
    pub price_usd: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct GasPrice {
    pub base_fee: U256,
    pub priority_fee: U256,
    pub total_gwei: f64,
}

#[derive(Debug)]
pub struct TransactionEstimate {
    pub gas_limit: U256,
    pub gas_price: GasPrice,
    pub total_cost_wei: U256,
    pub total_cost_usd: f64,
}