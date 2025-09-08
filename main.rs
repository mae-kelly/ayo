use ethers::{
    prelude::*,
    providers::{Provider, Ws, Http},
    types::{Address, U256, H256, Transaction, BlockNumber},
    contract::abigen,
};
use std::{sync::Arc, time::Duration, collections::HashMap};
use tokio::{sync::RwLock, time::interval};
use redis::{AsyncCommands, Client as RedisClient};
use serde::{Deserialize, Serialize};
use anyhow::{Result, Context};

// Generate contract bindings
abigen!(
    LiquidationExecutor,
    "./abi/LiquidationExecutor.json"
);

abigen!(
    AavePool,
    "./abi/AavePool.json"
);

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LiquidationTarget {
    protocol: String,
    user: Address,
    collateral_asset: Address,
    debt_asset: Address,
    debt_amount: U256,
    health_factor: f64,
    expected_profit: U256,
    gas_price: U256,
}

#[derive(Debug, Clone)]
struct Config {
    // RPC endpoints
    primary_rpc: String,
    backup_rpc: String,
    ws_endpoint: String,
    
    // Contract addresses
    executor_address: Address,
    aave_pool: Address,
    compound_comet: Address,
    
    // MEV settings
    flashbots_relay: String,
    bloxroute_auth: String,
    
    // Thresholds
    min_profit_usd: U256,
    max_gas_price: U256,
    health_factor_threshold: f64,
    
    // Redis
    redis_url: String,
}

pub struct LiquidationBot {
    config: Config,
    provider: Arc<Provider<Ws>>,
    http_provider: Arc<Provider<Http>>,
    executor: LiquidationExecutor<Provider<Ws>>,
    redis: Arc<RedisClient>,
    positions: Arc<RwLock<HashMap<Address, LiquidationTarget>>>,
    wallet: LocalWallet,
}

impl LiquidationBot {
    pub async fn new(config: Config) -> Result<Self> {
        // Connect to WebSocket for real-time updates
        let ws = Ws::connect(&config.ws_endpoint).await?;
        let provider = Arc::new(Provider::new(ws).interval(Duration::from_millis(100)));
        
        // HTTP provider for fallback
        let http_provider = Arc::new(Provider::<Http>::try_from(&config.primary_rpc)?);
        
        // Load wallet
        let wallet = std::env::var("PRIVATE_KEY")?
            .parse::<LocalWallet>()?
            .with_chain_id(1u64);
        
        // Initialize executor contract
        let client = Arc::new(SignerMiddleware::new(
            provider.clone(),
            wallet.clone(),
        ));
        let executor = LiquidationExecutor::new(config.executor_address, client);
        
        // Connect to Redis
        let redis = Arc::new(RedisClient::open(config.redis_url.as_str())?);
        
        Ok(Self {
            config,
            provider,
            http_provider,
            executor,
            redis,
            positions: Arc::new(RwLock::new(HashMap::new())),
            wallet,
        })
    }
    
    pub async fn run(&self) -> Result<()> {
        println!("🚀 Liquidation bot starting...");
        
        // Spawn concurrent tasks
        let mempool_handle = tokio::spawn(self.clone().monitor_mempool());
        let positions_handle = tokio::spawn(self.clone().scan_positions());
        let oracle_handle = tokio::spawn(self.clone().monitor_oracle_updates());
        let health_handle = tokio::spawn(self.clone().health_check());
        
        // Wait for all tasks
        tokio::try_join!(
            mempool_handle,
            positions_handle,
            oracle_handle,
            health_handle
        )?;
        
        Ok(())
    }
    
    // Monitor mempool for liquidation opportunities
    async fn monitor_mempool(self) -> Result<()> {
        let mut stream = self.provider.watch_pending_transactions().await?;
        
        while let Some(tx_hash) = stream.next().await {
            // Get transaction details
            if let Ok(Some(tx)) = self.provider.get_transaction(tx_hash).await {
                self.analyze_transaction(tx).await?;
            }
        }
        
        Ok(())
    }
    
    // Scan all positions for liquidation opportunities
    async fn scan_positions(self) -> Result<()> {
        let mut interval = interval(Duration::from_secs(5));
        
        loop {
            interval.tick().await;
            
            // Load positions from multiple protocols
            self.scan_aave_positions().await?;
            self.scan_compound_positions().await?;
            
            // Check each position for liquidation
            let positions = self.positions.read().await;
            for (user, target) in positions.iter() {
                if target.health_factor < self.config.health_factor_threshold {
                    self.evaluate_and_execute(target.clone()).await?;
                }
            }
        }
    }
    
    // Scan Aave positions
    async fn scan_aave_positions(&self) -> Result<()> {
        // Query recent borrow events
        let filter = Filter::new()
            .address(self.config.aave_pool)
            .event("Borrow(address,address,address,uint256,uint256,uint256,uint16)")
            .from_block(BlockNumber::Latest - 1000);
        
        let logs = self.provider.get_logs(&filter).await?;
        
        for log in logs {
            let user = Address::from(log.topics[2]);
            
            // Get user account data via multicall
            let account_data = self.get_aave_account_data(user).await?;
            
            if let Some(target) = self.evaluate_aave_position(user, account_data).await? {
                self.positions.write().await.insert(user, target);
            }
        }
        
        Ok(())
    }
    
    // Get Aave account data
    async fn get_aave_account_data(&self, user: Address) -> Result<AccountData> {
        // Use multicall for efficiency
        let pool = AavePool::new(self.config.aave_pool, self.provider.clone());
        
        let (
            total_collateral,
            total_debt,
            available_borrows,
            liquidation_threshold,
            ltv,
            health_factor
        ) = pool.get_user_account_data(user).call().await?;
        
        Ok(AccountData {
            total_collateral,
            total_debt,
            health_factor: health_factor.as_u128() as f64 / 1e18,
            liquidation_threshold,
        })
    }
    
    // Evaluate if position is profitable to liquidate
    async fn evaluate_aave_position(
        &self,
        user: Address,
        data: AccountData
    ) -> Result<Option<LiquidationTarget>> {
        if data.health_factor >= 1.0 {
            return Ok(None);
        }
        
        // Calculate maximum liquidation amount (50% of debt)
        let max_liquidation = data.total_debt / 2;
        
        // Get current gas price
        let gas_price = self.provider.get_gas_price().await?;
        
        // Calculate expected profit
        let liquidation_bonus = U256::from(500); // 5% in basis points
        let collateral_value = max_liquidation * (10000 + liquidation_bonus) / 10000;
        
        // Estimate costs
        let gas_cost = U256::from(300_000) * gas_price; // 300k gas estimate
        let flash_loan_fee = max_liquidation * 5 / 10000; // 0.05% Aave fee
        
        let total_cost = max_liquidation + flash_loan_fee + gas_cost;
        
        if collateral_value <= total_cost {
            return Ok(None);
        }
        
        let expected_profit = collateral_value - total_cost;
        
        if expected_profit < self.config.min_profit_usd {
            return Ok(None);
        }
        
        Ok(Some(LiquidationTarget {
            protocol: "AAVE_V3".to_string(),
            user,
            collateral_asset: Address::zero(), // Would need to determine actual asset
            debt_asset: Address::zero(), // Would need to determine actual asset
            debt_amount: max_liquidation,
            health_factor: data.health_factor,
            expected_profit,
            gas_price,
        }))
    }
    
    // Monitor oracle price updates
    async fn monitor_oracle_updates(self) -> Result<()> {
        // Monitor Chainlink price feeds
        let chainlink_feed = Address::from_str("0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419")?; // ETH/USD
        
        let filter = Filter::new()
            .address(chainlink_feed)
            .event("AnswerUpdated(int256,uint256,uint256)");
        
        let mut stream = self.provider.watch(&filter).await?;
        
        while let Some(log) = stream.next().await {
            println!("📊 Oracle update detected: {:?}", log);
            
            // Immediately check positions after oracle update
            self.scan_positions_after_oracle_update().await?;
        }
        
        Ok(())
    }
    
    // Quick position scan after oracle update
    async fn scan_positions_after_oracle_update(&self) -> Result<()> {
        let positions = self.positions.read().await.clone();
        
        for (_, target) in positions.iter() {
            // Re-evaluate with new prices
            let account_data = self.get_aave_account_data(target.user).await?;
            
            if account_data.health_factor < 1.0 {
                // Execute immediately - oracle update likely made it liquidatable
                self.execute_liquidation_flashbots(target.clone()).await?;
            }
        }
        
        Ok(())
    }
    
    // Evaluate and execute profitable liquidation
    async fn evaluate_and_execute(&self, target: LiquidationTarget) -> Result<()> {
        // Double-check profitability with current gas
        let current_gas = self.provider.get_gas_price().await?;
        
        if current_gas > self.config.max_gas_price {
            println!("⚠️ Gas too high: {} gwei", current_gas.as_u64() / 1e9 as u64);
            return Ok(());
        }
        
        // Simulate transaction first
        if self.simulate_liquidation(&target).await? {
            // Try multiple execution strategies
            match self.execute_liquidation_flashbots(target.clone()).await {
                Ok(tx) => {
                    println!("✅ Liquidation submitted via Flashbots: {:?}", tx);
                    self.track_execution(tx).await?;
                }
                Err(_) => {
                    // Fallback to regular execution
                    self.execute_liquidation_standard(target).await?;
                }
            }
        }
        
        Ok(())
    }
    
    // Simulate liquidation to verify profitability
    async fn simulate_liquidation(&self, target: &LiquidationTarget) -> Result<bool> {
        // Use Tenderly or local fork for simulation
        let call = self.executor.calculate_expected_profit(
            target.protocol.clone(),
            target.collateral_asset,
            target.debt_asset,
            target.debt_amount,
            target.gas_price,
        );
        
        match call.call().await {
            Ok((profit, is_profitable)) => {
                println!("📈 Expected profit: {} USD", profit.as_u128() / 1e18 as u128);
                Ok(is_profitable)
            }
            Err(e) => {
                println!("❌ Simulation failed: {:?}", e);
                Ok(false)
            }
        }
    }
    
    // Execute via Flashbots
    async fn execute_liquidation_flashbots(&self, target: LiquidationTarget) -> Result<H256> {
        let flashbots_client = FlashbotsClient::new(
            self.provider.clone(),
            &self.config.flashbots_relay,
        )?;
        
        // Build liquidation transaction
        let tx = self.executor.liquidate(
            target.protocol,
            target.user,
            target.collateral_asset,
            target.debt_asset,
            target.debt_amount,
            true, // use flash loan
        );
        
        // Create bundle with high priority
        let bundle = BundleRequest::new()
            .push_transaction(tx.tx)
            .set_block(self.provider.get_block_number().await? + 1)
            .set_min_timestamp(0)
            .set_max_timestamp(u64::MAX);
        
        // Send bundle
        let result = flashbots_client.send_bundle(bundle).await?;
        
        Ok(result.bundle_hash)
    }
    
    // Standard execution fallback
    async fn execute_liquidation_standard(&self, target: LiquidationTarget) -> Result<H256> {
        let tx = self.executor.liquidate(
            target.protocol,
            target.user,
            target.collateral_asset,
            target.debt_asset,
            target.debt_amount,
            true,
        )
        .gas_price(target.gas_price * 110 / 100) // 10% above base
        .gas(500_000); // Conservative gas limit
        
        let pending_tx = tx.send().await?;
        let receipt = pending_tx.await?;
        
        match receipt {
            Some(r) if r.status == Some(U64::from(1)) => {
                println!("✅ Liquidation successful: {:?}", r.transaction_hash);
                Ok(r.transaction_hash)
            }
            _ => {
                println!("❌ Liquidation failed");
                Err(anyhow::anyhow!("Transaction failed"))
            }
        }
    }
    
    // Track execution results
    async fn track_execution(&self, tx_hash: H256) -> Result<()> {
        // Store in Redis for analysis
        let mut conn = self.redis.get_async_connection().await?;
        
        let key = format!("liquidation:{}", tx_hash);
        let _: () = conn.set_ex(key, tx_hash.to_string(), 86400).await?;
        
        // Increment counters
        let _: () = conn.incr("stats:total_liquidations", 1).await?;
        
        Ok(())
    }
    
    // Health monitoring
    async fn health_check(self) -> Result<()> {
        let mut interval = interval(Duration::from_secs(30));
        
        loop {
            interval.tick().await;
            
            // Check RPC connectivity
            match self.provider.get_block_number().await {
                Ok(block) => {
                    println!("🔄 Health check - Block: {}", block);
                }
                Err(e) => {
                    println!("⚠️ RPC error, switching to backup: {:?}", e);
                    // Switch to backup RPC
                }
            }
            
            // Check Redis connectivity
            if let Ok(mut conn) = self.redis.get_async_connection().await {
                let _: () = conn.set_ex("health:check", "ok", 60).await?;
            }
        }
    }
    
    // Analyze mempool transaction
    async fn analyze_transaction(&self, tx: Transaction) -> Result<()> {
        // Check if it's a liquidation transaction
        if tx.to == Some(self.config.aave_pool) {
            if let Some(input) = tx.input {
                // Decode function selector (first 4 bytes)
                let selector = &input[0..4];
                
                // liquidationCall selector: 0x00a718a9
                if selector == [0x00, 0xa7, 0x18, 0xa9] {
                    println!("🎯 Competitor liquidation detected!");
                    // Could implement front-running logic here
                }
            }
        }
        
        Ok(())
    }
}

// Helper structures
#[derive(Debug)]
struct AccountData {
    total_collateral: U256,
    total_debt: U256,
    health_factor: f64,
    liquidation_threshold: U256,
}

// Clone implementation for async spawning
impl Clone for LiquidationBot {
    fn clone(&self) -> Self {
        Self {
            config: self.config.clone(),
            provider: self.provider.clone(),
            http_provider: self.http_provider.clone(),
            executor: self.executor.clone(),
            redis: self.redis.clone(),
            positions: self.positions.clone(),
            wallet: self.wallet.clone(),
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // Load configuration
    let config = Config {
        primary_rpc: std::env::var("PRIMARY_RPC")?,
        backup_rpc: std::env::var("BACKUP_RPC")?,
        ws_endpoint: std::env::var("WS_ENDPOINT")?,
        executor_address: std::env::var("EXECUTOR_ADDRESS")?.parse()?,
        aave_pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2".parse()?,
        compound_comet: "0xc3d688B66703497DAA19211EEdff47f25384cdc3".parse()?,
        flashbots_relay: "https://relay.flashbots.net".to_string(),
        bloxroute_auth: std::env::var("BLOXROUTE_AUTH")?,
        min_profit_usd: U256::from(30) * U256::exp10(18), // $30 minimum
        max_gas_price: U256::from(100) * U256::exp10(9), // 100 gwei max
        health_factor_threshold: 1.02,
        redis_url: std::env::var("REDIS_URL")?,
    };
    
    // Initialize and run bot
    let bot = LiquidationBot::new(config).await?;
    bot.run().await?;
    
    Ok(())
}