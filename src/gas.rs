use anyhow::Result;
use ethers::types::U256;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::models::{GasPrice, TransactionEstimate};
use crate::providers::MultiProvider;

pub struct GasEstimator {
    provider: Arc<MultiProvider>,
    eth_price_usd: Arc<RwLock<f64>>,
}

impl GasEstimator {
    pub async fn new(provider: Arc<MultiProvider>) -> Result<Self> {
        let eth_price_usd = provider.get_eth_price().await.unwrap_or(3000.0); // Default to $3000
        
        println!("💵 Current ETH price: ${:.2}", eth_price_usd);
        
        Ok(Self {
            provider,
            eth_price_usd: Arc::new(RwLock::new(eth_price_usd)),
        })
    }

    pub async fn update_eth_price(&self) -> Result<()> {
        let new_price = self.provider.get_eth_price().await?;
        *self.eth_price_usd.write().await = new_price;
        Ok(())
    }

    pub async fn get_current_gas_price(&self) -> Result<GasPrice> {
        let gas_price = self.provider.get_gas_price().await?;
        
        // Convert to gwei
        let total_gwei = gas_price.as_u128() as f64 / 1e9;
        
        // Estimate base fee and priority fee
        // In reality, you'd use eth_getBlock to get baseFeePerGas
        let base_fee = gas_price * U256::from(85) / U256::from(100); // ~85% is base fee
        let priority_fee = gas_price * U256::from(15) / U256::from(100); // ~15% is priority

        Ok(GasPrice {
            base_fee,
            priority_fee,
            total_gwei,
        })
    }

    pub async fn estimate_arbitrage_gas(&self) -> Result<TransactionEstimate> {
        let gas_price = self.get_current_gas_price().await?;
        
        // More accurate gas estimation for arbitrage transaction:
        // - Flash loan initiation: ~100k gas
        // - First DEX swap: ~150k gas  
        // - Second DEX swap: ~150k gas
        // - Flash loan repayment: ~50k gas
        // - Additional logic: ~50k gas
        // Total: ~500k gas (conservative estimate)
        
        let gas_limit = U256::from(500000);
        
        // For competitive arbitrage, you might need higher priority fee
        let competitive_priority = gas_price.priority_fee * U256::from(2); // 2x priority
        let total_gas_price = gas_price.base_fee + competitive_priority;
        
        let total_cost_wei = gas_limit * total_gas_price;
        let total_cost_usd = self.wei_to_usd(total_cost_wei).await;

        Ok(TransactionEstimate {
            gas_limit,
            gas_price: GasPrice {
                base_fee: gas_price.base_fee,
                priority_fee: competitive_priority,
                total_gwei: total_gas_price.as_u128() as f64 / 1e9,
            },
            total_cost_wei,
            total_cost_usd,
        })
    }

    pub async fn wei_to_usd(&self, wei: U256) -> f64 {
        let eth = wei.as_u128() as f64 / 1e18;
        let price = *self.eth_price_usd.read().await;
        eth * price
    }

    pub fn wei_to_usd_sync(&self, wei: U256, eth_price: f64) -> f64 {
        let eth = wei.as_u128() as f64 / 1e18;
        eth * eth_price
    }

    pub async fn gwei_to_usd(&self, gwei: f64) -> f64 {
        let eth = gwei / 1e9;
        let price = *self.eth_price_usd.read().await;
        eth * price
    }

    pub async fn calculate_gas_cost(&self, gas_used: U256, gas_price_gwei: f64) -> f64 {
        let gas_used_f64 = gas_used.as_u128() as f64;
        let eth_cost = (gas_used_f64 * gas_price_gwei) / 1e9;
        let price = *self.eth_price_usd.read().await;
        eth_cost * price
    }

    pub async fn estimate_transaction_cost(&self, gas_limit: U256) -> Result<f64> {
        let gas_price = self.get_current_gas_price().await?;
        let total_cost_wei = gas_limit * (gas_price.base_fee + gas_price.priority_fee);
        Ok(self.wei_to_usd(total_cost_wei).await)
    }
}