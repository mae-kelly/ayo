use anyhow::{Context, Result};
use ethers::{
    middleware::Middleware,
    providers::{Http, Provider, Ws},
    types::{Address, Block, Transaction, U256, H256},
};
use log::{debug, warn, info};
use std::sync::Arc;
use tokio::sync::RwLock;
use serde_json::Value;

use crate::config::Config;

pub struct EnhancedMultiProvider {
    // RPC providers for different purposes
    alchemy_providers: Vec<Arc<Provider<Http>>>,
    infura_providers: Vec<Arc<Provider<Http>>>,
    public_providers: Vec<Arc<Provider<Http>>>,
    
    // API endpoints
    alchemy_api_key: String,
    infura_api_key: String,
    etherscan_api_key: String,
    
    // Round-robin indices
    alchemy_index: Arc<RwLock<usize>>,
    infura_index: Arc<RwLock<usize>>,
    public_index: Arc<RwLock<usize>>,
    
    config: Arc<Config>,
}

impl EnhancedMultiProvider {
    pub async fn new(config: &Config) -> Result<Self> {
        let mut alchemy_providers = Vec::new();
        let mut infura_providers = Vec::new();
        let mut public_providers = Vec::new();

        // ALCHEMY ENDPOINTS - Multiple services they offer
        if config.alchemy_api_key != "demo" && !config.alchemy_api_key.is_empty() {
            info!("Setting up Alchemy endpoints...");
            
            // 1. Standard JSON-RPC
            let endpoints = vec![
                format!("https://eth-mainnet.g.alchemy.com/v2/{}", config.alchemy_api_key),
                format!("https://eth-mainnet.alchemyapi.io/v2/{}", config.alchemy_api_key),
            ];
            
            for endpoint in endpoints {
                if let Ok(provider) = Provider::<Http>::try_from(endpoint.as_str()) {
                    alchemy_providers.push(Arc::new(provider));
                }
            }
            
            info!("✓ Configured {} Alchemy RPC endpoints", alchemy_providers.len());
        }

        // INFURA ENDPOINTS - Multiple services they offer
        if config.infura_api_key != "demo" && !config.infura_api_key.is_empty() {
            info!("Setting up Infura endpoints...");
            
            // Multiple Infura endpoints
            let endpoints = vec![
                format!("https://mainnet.infura.io/v3/{}", config.infura_api_key),
                format!("https://mainnet.infura.io/v3/{}", config.infura_api_key), // Can use same key multiple times
            ];
            
            for endpoint in endpoints {
                if let Ok(provider) = Provider::<Http>::try_from(endpoint.as_str()) {
                    infura_providers.push(Arc::new(provider));
                }
            }
            
            info!("✓ Configured {} Infura RPC endpoints", infura_providers.len());
        }

        // PUBLIC ENDPOINTS - Free alternatives
        info!("Setting up public RPC endpoints...");
        let public_endpoints = vec![
            "https://eth.llamarpc.com",
            "https://rpc.ankr.com/eth",
            "https://cloudflare-eth.com",
            "https://eth-mainnet.public.blastapi.io",
            "https://ethereum.publicnode.com",
            "https://1rpc.io/eth",
        ];
        
        for endpoint in public_endpoints {
            if let Ok(provider) = Provider::<Http>::try_from(endpoint) {
                public_providers.push(Arc::new(provider));
            }
        }
        
        info!("✓ Configured {} public RPC endpoints", public_providers.len());

        if alchemy_providers.is_empty() && infura_providers.is_empty() && public_providers.is_empty() {
            return Err(anyhow::anyhow!("No working providers found!"));
        }

        Ok(Self {
            alchemy_providers,
            infura_providers,
            public_providers,
            alchemy_api_key: config.alchemy_api_key.clone(),
            infura_api_key: config.infura_api_key.clone(),
            etherscan_api_key: config.etherscan_api_key.clone(),
            alchemy_index: Arc::new(RwLock::new(0)),
            infura_index: Arc::new(RwLock::new(0)),
            public_index: Arc::new(RwLock::new(0)),
            config: Arc::new(config.clone()),
        })
    }

    // Get best provider for the task
    pub async fn get_provider(&self) -> Arc<Provider<Http>> {
        // Prioritize: Alchemy > Infura > Public
        if !self.alchemy_providers.is_empty() {
            let index = *self.alchemy_index.read().await;
            return self.alchemy_providers[index % self.alchemy_providers.len()].clone();
        }
        
        if !self.infura_providers.is_empty() {
            let index = *self.infura_index.read().await;
            return self.infura_providers[index % self.infura_providers.len()].clone();
        }
        
        let index = *self.public_index.read().await;
        self.public_providers[index % self.public_providers.len()].clone()
    }

    // Rotate through providers for load balancing
    pub async fn rotate_provider(&self) {
        if !self.alchemy_providers.is_empty() {
            let mut index = self.alchemy_index.write().await;
            *index = (*index + 1) % self.alchemy_providers.len();
        } else if !self.infura_providers.is_empty() {
            let mut index = self.infura_index.write().await;
            *index = (*index + 1) % self.infura_providers.len();
        } else {
            let mut index = self.public_index.write().await;
            *index = (*index + 1) % self.public_providers.len();
        }
    }

    // ALCHEMY ENHANCED APIs
    pub async fn get_alchemy_token_metadata(&self, token: Address) -> Result<Value> {
        if self.alchemy_api_key == "demo" {
            return Err(anyhow::anyhow!("Alchemy API key not configured"));
        }
        
        let url = format!(
            "https://eth-mainnet.g.alchemy.com/nft/v2/{}/getTokenMetadata?contractAddress={}",
            self.alchemy_api_key, token
        );
        
        let response = reqwest::get(&url).await?;
        Ok(response.json().await?)
    }
    
    pub async fn get_alchemy_asset_transfers(&self, address: Address) -> Result<Value> {
        if self.alchemy_api_key == "demo" {
            return Err(anyhow::anyhow!("Alchemy API key not configured"));
        }
        
        let client = reqwest::Client::new();
        let url = format!("https://eth-mainnet.g.alchemy.com/v2/{}", self.alchemy_api_key);
        
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "alchemy_getAssetTransfers",
            "params": [{
                "fromAddress": format!("{:?}", address),
                "category": ["external", "erc20", "erc721", "erc1155"],
                "maxCount": "0x64"
            }]
        });
        
        let response = client.post(&url).json(&body).send().await?;
        Ok(response.json().await?)
    }
    
    pub async fn get_alchemy_token_balances(&self, address: Address) -> Result<Value> {
        if self.alchemy_api_key == "demo" {
            return Err(anyhow::anyhow!("Alchemy API key not configured"));
        }
        
        let client = reqwest::Client::new();
        let url = format!("https://eth-mainnet.g.alchemy.com/v2/{}", self.alchemy_api_key);
        
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "alchemy_getTokenBalances",
            "params": [format!("{:?}", address)]
        });
        
        let response = client.post(&url).json(&body).send().await?;
        Ok(response.json().await?)
    }

    // INFURA ENHANCED APIs
    pub async fn get_infura_gas_prices(&self) -> Result<Value> {
        if self.infura_api_key == "demo" {
            return Err(anyhow::anyhow!("Infura API key not configured"));
        }
        
        let client = reqwest::Client::new();
        let url = format!("https://gas.api.infura.io/v3/{}/suggestedGasFees", self.infura_api_key);
        
        let response = client.get(&url).send().await?;
        Ok(response.json().await?)
    }
    
    pub async fn get_infura_transaction_receipt(&self, tx_hash: H256) -> Result<Value> {
        if self.infura_api_key == "demo" {
            return Err(anyhow::anyhow!("Infura API key not configured"));
        }
        
        let client = reqwest::Client::new();
        let url = format!("https://mainnet.infura.io/v3/{}", self.infura_api_key);
        
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_getTransactionReceipt",
            "params": [format!("{:?}", tx_hash)]
        });
        
        let response = client.post(&url).json(&body).send().await?;
        Ok(response.json().await?)
    }

    // ETHERSCAN COMPREHENSIVE APIS
    pub async fn get_etherscan_contract_abi(&self, address: Address) -> Result<Value> {
        if self.etherscan_api_key == "demo" {
            return Err(anyhow::anyhow!("Etherscan API key not configured"));
        }
        
        let url = format!(
            "https://api.etherscan.io/api?module=contract&action=getabi&address={:?}&apikey={}",
            address, self.etherscan_api_key
        );
        
        let response = reqwest::get(&url).await?;
        Ok(response.json().await?)
    }
    
    pub async fn get_etherscan_token_info(&self, address: Address) -> Result<Value> {
        if self.etherscan_api_key == "demo" {
            return Err(anyhow::anyhow!("Etherscan API key not configured"));
        }
        
        let url = format!(
            "https://api.etherscan.io/api?module=token&action=tokeninfo&contractaddress={:?}&apikey={}",
            address, self.etherscan_api_key
        );
        
        let response = reqwest::get(&url).await?;
        Ok(response.json().await?)
    }
    
    pub async fn get_etherscan_token_holders(&self, address: Address) -> Result<Value> {
        if self.etherscan_api_key == "demo" {
            return Err(anyhow::anyhow!("Etherscan API key not configured"));
        }
        
        let url = format!(
            "https://api.etherscan.io/api?module=token&action=tokenholderlist&contractaddress={:?}&apikey={}",
            address, self.etherscan_api_key
        );
        
        let response = reqwest::get(&url).await?;
        Ok(response.json().await?)
    }
    
    pub async fn get_etherscan_dex_trades(&self, address: Address) -> Result<Value> {
        if self.etherscan_api_key == "demo" {
            return Err(anyhow::anyhow!("Etherscan API key not configured"));
        }
        
        let url = format!(
            "https://api.etherscan.io/api?module=account&action=tokentx&address={:?}&startblock=0&endblock=999999999&sort=desc&apikey={}",
            address, self.etherscan_api_key
        );
        
        let response = reqwest::get(&url).await?;
        Ok(response.json().await?)
    }
    
    pub async fn get_etherscan_gas_oracle(&self) -> Result<Value> {
        if self.etherscan_api_key == "demo" {
            return Err(anyhow::anyhow!("Etherscan API key not configured"));
        }
        
        let url = format!(
            "https://api.etherscan.io/api?module=gastracker&action=gasoracle&apikey={}",
            self.etherscan_api_key
        );
        
        let response = reqwest::get(&url).await?;
        Ok(response.json().await?)
    }
    
    pub async fn get_etherscan_eth_price(&self) -> Result<f64> {
        if self.etherscan_api_key == "demo" {
            return Ok(3500.0); // Fallback
        }
        
        let url = format!(
            "https://api.etherscan.io/api?module=stats&action=ethprice&apikey={}",
            self.etherscan_api_key
        );
        
        let response = reqwest::get(&url).await?;
        let json: Value = response.json().await?;
        
        json["result"]["ethusd"]
            .as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .context("Failed to parse ETH price")
    }

    // Combined data fetching using multiple sources
    pub async fn get_comprehensive_token_data(&self, token: Address) -> Result<Value> {
        let mut data = serde_json::json!({});
        
        // Try Alchemy
        if let Ok(alchemy_data) = self.get_alchemy_token_metadata(token).await {
            data["alchemy"] = alchemy_data;
        }
        
        // Try Etherscan
        if let Ok(etherscan_data) = self.get_etherscan_token_info(token).await {
            data["etherscan"] = etherscan_data;
        }
        
        // Get holder data from Etherscan
        if let Ok(holders) = self.get_etherscan_token_holders(token).await {
            data["holders"] = holders;
        }
        
        Ok(data)
    }
    
    pub async fn get_best_gas_price(&self) -> Result<U256> {
        // Try Infura's gas API first
        if let Ok(gas_data) = self.get_infura_gas_prices().await {
            if let Some(suggested) = gas_data["medium"]["suggestedMaxFeePerGas"].as_str() {
                if let Ok(gwei) = suggested.parse::<f64>() {
                    return Ok(U256::from((gwei * 1e9) as u64));
                }
            }
        }
        
        // Try Etherscan's gas oracle
        if let Ok(gas_data) = self.get_etherscan_gas_oracle().await {
            if let Some(safe_gas) = gas_data["result"]["SafeGasPrice"].as_str() {
                if let Ok(gwei) = safe_gas.parse::<u64>() {
                    return Ok(U256::from(gwei) * U256::from(1e9 as u64));
                }
            }
        }
        
        // Fallback to standard RPC
        let provider = self.get_provider().await;
        provider.get_gas_price().await.context("Failed to get gas price")
    }
    
    pub async fn get_block_number(&self) -> Result<u64> {
        let provider = self.get_provider().await;
        Ok(provider.get_block_number().await?.as_u64())
    }
}