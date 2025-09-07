use anyhow::{Result, Context};
use ethers::{
    prelude::*,
    providers::{Provider, Http},
    types::{Address, U256},
};
use std::sync::Arc;
use std::str::FromStr;
use std::collections::HashMap;
use chrono::Local;

abigen!(
    IUniswapV2Factory,
    r#"[
        function getPair(address,address) external view returns (address)
        function allPairsLength() external view returns (uint256)
        function allPairs(uint256) external view returns (address)
    ]"#
);

abigen!(
    IUniswapV2Pair,
    r#"[
        function getReserves() external view returns (uint112,uint112,uint32)
        function token0() external view returns (address)
        function token1() external view returns (address)
    ]"#
);

abigen!(
    IERC20,
    r#"[
        function symbol() external view returns (string)
        function decimals() external view returns (uint8)
    ]"#
);

#[derive(Clone)]
struct Pool {
    dex: String,
    address: Address,
    token0: Address,
    token1: Address,
    symbol0: String,
    symbol1: String,
    decimals0: u8,
    decimals1: u8,
    reserve0: U256,
    reserve1: U256,
}

#[tokio::main]
async fn main() -> Result<()> {
    println!("\n╔══════════════════════════════════════════════════════════╗");
    println!("║         CONTINUOUS ARBITRAGE OPPORTUNITY STREAM           ║");
    println!("╚══════════════════════════════════════════════════════════╝\n");

    // Connect to Ethereum - try multiple endpoints
    let endpoints = vec![
        "https://rpc.ankr.com/eth",
        "https://cloudflare-eth.com", 
        "https://eth.llamarpc.com",
        "https://ethereum.publicnode.com",
    ];
    
    let mut provider = None;
    for endpoint in endpoints {
        if let Ok(p) = Provider::<Http>::try_from(endpoint) {
            if p.get_block_number().await.is_ok() {
                println!("✅ Connected via {}", endpoint);
                provider = Some(Arc::new(p));
                break;
            }
        }
    }
    
    let provider = provider.ok_or(anyhow::anyhow!("Failed to connect to any RPC"))?;
    
    // Get initial data
    let mut last_block = provider.get_block_number().await?;
    let gas_price = provider.get_gas_price().await?;
    let gas_gwei = gas_price.as_u128() as f64 / 1e9;
    
    println!("📡 Connected to Ethereum - Block #{}", last_block);
    println!("⛽ Gas: {:.2} gwei\n", gas_gwei);
    
    // Get ETH price
    let eth_price = get_eth_price().await;
    println!("💵 ETH: ${:.2}", eth_price);
    
    let gas_cost = (500_000f64 * gas_gwei / 1e9) * eth_price;
    println!("📊 Gas cost per arb: ${:.2}\n", gas_cost);
    
    println!("════════════════════════════════════════════════════════════");
    println!("  STREAMING LIVE ARBITRAGE OPPORTUNITIES (Press Ctrl+C to stop)");
    println!("════════════════════════════════════════════════════════════\n");
    
    // Factory addresses
    let uni_factory_addr = Address::from_str("0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f")?;
    let sushi_factory_addr = Address::from_str("0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac")?;
    
    let uni_factory = IUniswapV2Factory::new(uni_factory_addr, provider.clone());
    let sushi_factory = IUniswapV2Factory::new(sushi_factory_addr, provider.clone());
    
    // Token cache
    let mut token_cache: HashMap<Address, (String, u8)> = HashMap::new();
    
    // Main tokens to focus on
    let main_tokens = vec![
        Address::from_str("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")?, // WETH
        Address::from_str("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")?, // USDC
        Address::from_str("0xdAC17F958D2ee523a2206206994597C13D831ec7")?, // USDT
        Address::from_str("0x6B175474E89094C44Da98b954EedeAC495271d0F")?, // DAI
        Address::from_str("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599")?, // WBTC
        Address::from_str("0x514910771AF9Ca656af840dff83E8264EcF986CA")?, // LINK
        Address::from_str("0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984")?, // UNI
    ];
    
    // Continuous scanning loop
    let mut opportunity_count = 0;
    let mut scan_count = 0;
    
    loop {
        scan_count += 1;
        let scan_start = std::time::Instant::now();
        
        // Check for new block
        if let Ok(current_block) = provider.get_block_number().await {
            if current_block > last_block {
                println!("🔲 New block: #{} (+{})", current_block, current_block - last_block);
                last_block = current_block;
                
                // Update gas price
                if let Ok(new_gas) = provider.get_gas_price().await {
                    let new_gwei = new_gas.as_u128() as f64 / 1e9;
                    if (new_gwei - gas_gwei).abs() > 0.5 {
                        println!("⛽ Gas changed: {:.2} gwei", new_gwei);
                    }
                }
            }
        }
        
        // Scan all pairs between main tokens
        for i in 0..main_tokens.len() {
            for j in i+1..main_tokens.len() {
                let token0 = main_tokens[i];
                let token1 = main_tokens[j];
                
                // Get both DEX pairs
                let uni_pair = uni_factory.get_pair(token0, token1).call().await?;
                let sushi_pair = sushi_factory.get_pair(token0, token1).call().await?;
                
                if uni_pair == Address::zero() || sushi_pair == Address::zero() {
                    continue;
                }
                
                // Get pool data
                let uni_pool = get_pool_data(
                    provider.clone(), 
                    uni_pair, 
                    "Uniswap",
                    &mut token_cache
                ).await?;
                
                let sushi_pool = get_pool_data(
                    provider.clone(),
                    sushi_pair,
                    "Sushiswap",
                    &mut token_cache
                ).await?;
                
                // Skip if low liquidity
                if uni_pool.reserve0 < U256::from(1000) || sushi_pool.reserve0 < U256::from(1000) {
                    continue;
                }
                
                // Calculate prices (handling token order)
                let uni_price = calculate_price(&uni_pool);
                let sushi_price = calculate_price(&sushi_pool);
                
                if uni_price == 0.0 || sushi_price == 0.0 {
                    continue;
                }
                
                // Calculate spread
                let spread = ((uni_price - sushi_price).abs() / uni_price.min(sushi_price)) * 100.0;
                
                // Show ALL opportunities, even small ones
                if spread > 0.1 {
                    opportunity_count += 1;
                    
                    let (buy_dex, sell_dex, buy_price, sell_price) = 
                        if uni_price < sushi_price {
                            ("Uniswap", "Sushiswap", uni_price, sushi_price)
                        } else {
                            ("Sushiswap", "Uniswap", sushi_price, uni_price)
                        };
                    
                    // Calculate profit for 10 ETH trade
                    let trade_value = 10.0 * eth_price;
                    let gross_profit = trade_value * spread / 100.0;
                    let net_after_dex = trade_value * (spread - 0.6) / 100.0; // 0.3% fee each
                    let flash_fee = trade_value * 0.0009; // Aave
                    let net_profit = net_after_dex - flash_fee - gas_cost;
                    
                    // Display with timestamp
                    let timestamp = Local::now().format("%H:%M:%S");
                    
                    if net_profit > 0.0 {
                        // Profitable opportunity - highlight
                        println!("🟢 [{}] #{} PROFITABLE", timestamp, opportunity_count);
                    } else if net_profit > -10.0 {
                        // Close to profitable
                        println!("🟡 [{}] #{} NEAR-PROFIT", timestamp, opportunity_count);
                    } else {
                        // Loss but show anyway
                        println!("⚪ [{}] #{} OPPORTUNITY", timestamp, opportunity_count);
                    }
                    
                    println!("   {}/{}: {} → {}", 
                        uni_pool.symbol0, uni_pool.symbol1, buy_dex, sell_dex);
                    println!("   Spread: {:.4}% | Buy: {:.6} | Sell: {:.6}", 
                        spread, buy_price, sell_price);
                    println!("   Gross: ${:.2} | Fees: -${:.2} | Gas: -${:.2}", 
                        gross_profit, gross_profit - net_after_dex + flash_fee, gas_cost);
                    
                    if net_profit > 0.0 {
                        println!("   ✅ NET PROFIT: ${:.2}", net_profit);
                    } else {
                        println!("   ❌ NET LOSS: ${:.2}", net_profit);
                    }
                    
                    // Show reserves for transparency
                    let r0 = uni_pool.reserve0.as_u128() as f64 / 10f64.powi(uni_pool.decimals0 as i32);
                    let r1 = uni_pool.reserve1.as_u128() as f64 / 10f64.powi(uni_pool.decimals1 as i32);
                    println!("   Liquidity: {:.2} {} / {:.2} {}", 
                        r0, uni_pool.symbol0, r1, uni_pool.symbol1);
                    println!();
                }
            }
        }
        
        // Also scan some random pools for more opportunities
        if scan_count % 5 == 0 {
            println!("🔍 Scanning additional pools...");
            
            // Get total pairs
            let total_pairs = uni_factory.all_pairs_length().call().await?;
            
            // Sample some random recent pairs
            let start = if total_pairs > U256::from(100) {
                total_pairs - U256::from(100)
            } else {
                U256::zero()
            };
            
            for idx in start.as_u64()..total_pairs.as_u64().min(start.as_u64() + 10) {
                if let Ok(pair_addr) = uni_factory.all_pairs(U256::from(idx)).call().await {
                    // Check if this pair exists on Sushi too
                    if let Ok(pool) = get_pool_data(
                        provider.clone(),
                        pair_addr,
                        "Uniswap",
                        &mut token_cache
                    ).await {
                        // Try to find matching Sushi pair
                        if let Ok(sushi_pair) = sushi_factory.get_pair(pool.token0, pool.token1).call().await {
                            if sushi_pair != Address::zero() {
                                // Found matching pair on both DEXs
                                println!("   Found pair on both DEXs: {}/{}", 
                                    pool.symbol0, pool.symbol1);
                            }
                        }
                    }
                }
            }
        }
        
        let scan_time = scan_start.elapsed();
        if scan_count % 10 == 0 {
            println!("📈 Stats: {} opportunities found | Scan #{} | {:.1}s", 
                opportunity_count, scan_count, scan_time.as_secs_f32());
        }
        
        // Small delay to not overwhelm RPC
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    }
}

async fn get_pool_data(
    provider: Arc<Provider<Http>>,
    pair_address: Address,
    dex_name: &str,
    cache: &mut HashMap<Address, (String, u8)>,
) -> Result<Pool> {
    let pair = IUniswapV2Pair::new(pair_address, provider.clone());
    
    let reserves = pair.get_reserves().call().await?;
    let token0 = pair.token_0().call().await?;
    let token1 = pair.token_1().call().await?;
    
    // Get token info (with caching)
    let (symbol0, decimals0) = if let Some(info) = cache.get(&token0) {
        info.clone()
    } else {
        let info = get_token_info(provider.clone(), token0).await
            .unwrap_or(("TOKEN0".to_string(), 18));
        cache.insert(token0, info.clone());
        info
    };
    
    let (symbol1, decimals1) = if let Some(info) = cache.get(&token1) {
        info.clone()
    } else {
        let info = get_token_info(provider.clone(), token1).await
            .unwrap_or(("TOKEN1".to_string(), 18));
        cache.insert(token1, info.clone());
        info
    };
    
    Ok(Pool {
        dex: dex_name.to_string(),
        address: pair_address,
        token0,
        token1,
        symbol0,
        symbol1,
        decimals0,
        decimals1,
        reserve0: U256::from(reserves.0),
        reserve1: U256::from(reserves.1),
    })
}

async fn get_token_info(provider: Arc<Provider<Http>>, token: Address) -> Result<(String, u8)> {
    let token_contract = IERC20::new(token, provider);
    
    let symbol = token_contract.symbol().call().await
        .unwrap_or_else(|_| format!("0x{:x}", token));
    let decimals = token_contract.decimals().call().await
        .unwrap_or(18);
    
    Ok((symbol, decimals))
}

fn calculate_price(pool: &Pool) -> f64 {
    if pool.reserve0.is_zero() || pool.reserve1.is_zero() {
        return 0.0;
    }
    
    let r0 = pool.reserve0.as_u128() as f64 / 10f64.powi(pool.decimals0 as i32);
    let r1 = pool.reserve1.as_u128() as f64 / 10f64.powi(pool.decimals1 as i32);
    
    r1 / r0
}

async fn get_eth_price() -> f64 {
    if let Ok(response) = reqwest::get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd").await {
        if let Ok(json) = response.json::<serde_json::Value>().await {
            if let Some(price) = json["ethereum"]["usd"].as_f64() {
                return price;
            }
        }
    }
    0.0
}