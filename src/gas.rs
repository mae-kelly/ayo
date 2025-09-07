use anyhow::Result;
use ethers::types::U256;
use std::sync::Arc;

use crate::models::{GasPrice, TransactionEstimate};
use crate::providers::MultiProvider;

pub struct GasEstimator {
    provider: Arc<MultiProvider>,
    eth_price_usd: f64,
}

impl GasEstimator {
    pub async fn new(provider: Arc<MultiProvider>) -> Result<Self> {
        let eth_price_usd = provider.get_eth_price().await.unwrap_or(2000.0);
        
        Ok(Self {
            provider,
            eth_price_usd,
        })
    }

    pub async fn update_eth_price(&mut self) -> Result<()> {
        self.eth_price_usd = self.provider.get_eth_price().await?;
        Ok(())
    }

    pub async fn get_current_gas_price(&self) -> Result<GasPrice> {
        let gas_price = self.provider.get_gas_price().await?;
        
        // Convert to gwei
        let total_gwei = gas_price.as_u128() as f64 / 1e9;
        
        // Estimate base fee and priority fee (simplified)
        let base_fee = gas_price * U256::from(90) / U256::from(100);
        let priority_fee = gas_price * U256::from(10) / U256::from(100);

        Ok(GasPrice {
            base_fee,
            priority_fee,
            total_gwei,
        })
    }

    pub async fn estimate_arbitrage_gas(&self) -> Result<TransactionEstimate> {
        let gas_price = self.get_current_gas_price().await?;
        
        // Estimate gas for complex arbitrage transaction
        // Flash loan + 2 swaps + repay
        let gas_limit = U256::from(500000); // Conservative estimate
        
        let total_cost_wei = gas_limit * (gas_price.base_fee + gas_price.priority_fee);
        let total_cost_usd = self.wei_to_usd(total_cost_wei);

        Ok(TransactionEstimate {
            gas_limit,
            gas_price,
            total_cost_wei,
            total_cost_usd,
        })
    }

    pub fn wei_to_usd(&self, wei: U256) -> f64 {
        let eth = wei.as_u128() as f64 / 1e18;
        eth * self.eth_price_usd
    }

    pub fn gwei_to_usd(&self, gwei: f64) -> f64 {
        let eth = gwei / 1e9;
        eth * self.eth_price_usd
    }

    pub fn calculate_gas_cost(&self, gas_used: U256, gas_price_gwei: f64) -> f64 {
        let gas_used_f64 = gas_used.as_u128() as f64;
        let eth_cost = (gas_used_f64 * gas_price_gwei) / 1e9;
        eth_cost * self.eth_price_usd
    }
}