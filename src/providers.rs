use anyhow::{Context, Result};
use ethers::{
    middleware::Middleware,
    providers::{Http, Provider},
    types::U256,
};
use log::{debug, warn};
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::config::Config;

pub struct MultiProvider {
    providers: Vec<Arc<Provider<Http>>>,
    current_index: Arc<RwLock<usize>>,
    config: Arc<Config>,
}

impl MultiProvider {
    pub async fn new(config: &Config) -> Result<Self> {
        let mut providers = Vec::new();

        // Alchemy provider
        let alchemy_provider = Provider::<Http>::try_from(config.get_alchemy_url())
            .context("Failed to create Alchemy provider")?;
        providers.push(Arc::new(alchemy_provider));

        // Infura provider
        let infura_provider = Provider::<Http>::try_from(config.get_infura_url())
            .context("Failed to create Infura provider")?;
        providers.push(Arc::new(infura_provider));

        // Backup provider if available
        if let Some(backup_url) = &config.backup_rpc_url {
            if let Ok(backup_provider) = Provider::<Http>::try_from(backup_url.as_str()) {
                providers.push(Arc::new(backup_provider));
            }
        }

        // Test connectivity
        for (i, provider) in providers.iter().enumerate() {
            match provider.get_block_number().await {
                Ok(block) => debug!("Provider {} connected, block: {}", i, block),
                Err(e) => warn!("Provider {} connection failed: {}", i, e),
            }
        }

        Ok(Self {
            providers,
            current_index: Arc::new(RwLock::new(0)),
            config: Arc::new(config.clone()),
        })
    }

    pub async fn get_provider(&self) -> Arc<Provider<Http>> {
        let index = *self.current_index.read().await;
        self.providers[index].clone()
    }

    pub async fn rotate_provider(&self) {
        let mut index = self.current_index.write().await;
        *index = (*index + 1) % self.providers.len();
        debug!("Rotated to provider {}", *index);
    }

    pub async fn get_block_number(&self) -> Result<u64> {
        let mut last_error = None;
        
        for _ in 0..self.providers.len() {
            let provider = self.get_provider().await;
            match provider.get_block_number().await {
                Ok(block) => return Ok(block.as_u64()),
                Err(e) => {
                    warn!("Provider error: {}", e);
                    last_error = Some(e);
                    self.rotate_provider().await;
                }
            }
        }

        Err(anyhow::anyhow!(
            "All providers failed: {:?}",
            last_error
        ))
    }

    pub async fn get_gas_price(&self) -> Result<U256> {
        let provider = self.get_provider().await;
        provider
            .get_gas_price()
            .await
            .context("Failed to get gas price")
    }

    pub async fn get_eth_price(&self) -> Result<f64> {
        // Use Etherscan API for price
        let url = format!(
            "https://api.etherscan.io/api?module=stats&action=ethprice&apikey={}",
            self.config.etherscan_api_key
        );
        
        let response: serde_json::Value = reqwest::get(&url)
            .await?
            .json()
            .await?;
        
        response["result"]["ethusd"]
            .as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .context("Failed to parse ETH price")
    }
}