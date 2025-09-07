use anyhow::Result;
use dotenv::dotenv;
use env_logger;
use log::{error, info};
use std::sync::Arc;
use tokio;

mod config;
mod dex;
mod flashloan;
mod gas;
mod models;
mod providers;
mod scanner;
mod utils;

use config::Config;
use providers::MultiProvider;
use scanner::ArbitrageScanner;

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize environment
    dotenv().ok();
    
    // Initialize logger with default INFO level if not set
    if std::env::var("RUST_LOG").is_err() {
        std::env::set_var("RUST_LOG", "info");
    }
    env_logger::init();

    println!("=== FLASH LOAN ARBITRAGE SCANNER STARTING ===");
    info!("Starting Flash Loan Arbitrage Scanner...");

    // Load configuration
    println!("Loading configuration from .env file...");
    let config = match Config::from_env() {
        Ok(c) => Arc::new(c),
        Err(e) => {
            eprintln!("ERROR: Failed to load configuration: {}", e);
            eprintln!("Make sure .env file exists with API keys!");
            return Err(e);
        }
    };
    info!("Configuration loaded successfully");
    println!("✓ Config loaded - Min profit: ${}, Max gas: {} gwei", 
             config.min_profit_usd, config.max_gas_price_gwei);

    // Initialize multi-provider
    println!("Connecting to Ethereum network...");
    let provider = Arc::new(MultiProvider::new(&config).await?);
    info!("Connected to Ethereum network");
    println!("✓ Connected to network");

    // Create and start scanner
    println!("Initializing scanner...");
    let scanner = ArbitrageScanner::new(config.clone(), provider.clone()).await?;
    
    info!("Scanner initialized. Starting monitoring...");
    info!("Min profit threshold: ${}", config.min_profit_usd);
    info!("Max gas price: {} gwei", config.max_gas_price_gwei);
    
    println!("✓ Scanner ready!");
    println!("=== MONITORING FOR ARBITRAGE OPPORTUNITIES ===");
    println!("(This may take a while - real opportunities are rare)");
    
    // Run scanner
    if let Err(e) = scanner.run().await {
        error!("Scanner error: {}", e);
        eprintln!("FATAL ERROR: {}", e);
        return Err(e);
    }

    Ok(())
}