// Simple test file to verify the scanner is working
// Put this in src/bin/test_scanner.rs

use ethers::prelude::*;
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("TEST SCANNER STARTING...");
    
    // Try to connect to Ethereum
    println!("Attempting to connect to Ethereum...");
    
    // Try multiple RPC endpoints
    let rpcs = vec![
        "https://eth.llamarpc.com",
        "https://rpc.ankr.com/eth",
        "https://cloudflare-eth.com",
    ];
    
    let mut provider = None;
    for rpc in rpcs {
        println!("Trying RPC: {}", rpc);
        match Provider::<Http>::try_from(rpc) {
            Ok(p) => {
                // Test the connection
                match p.get_block_number().await {
                    Ok(block) => {
                        println!("✓ Connected! Current block: {}", block);
                        provider = Some(Arc::new(p));
                        break;
                    }
                    Err(e) => println!("  Failed to get block: {}", e),
                }
            }
            Err(e) => println!("  Failed to connect: {}", e),
        }
    }
    
    let provider = provider.ok_or("Failed to connect to any RPC")?;
    
    // Get UniswapV2 factory
    println!("\nGetting UniswapV2 Factory...");
    let factory_address = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f".parse::<Address>()?;
    
    // Simple ABI for allPairsLength
    let abi = ethers::abi::parse_abi(&[
        "function allPairsLength() external view returns (uint256)",
        "function allPairs(uint256) external view returns (address)",
    ])?;
    
    let factory = Contract::new(factory_address, abi, provider.clone());
    
    // Get total pairs
    let total_pairs: U256 = factory.method("allPairsLength", ())?.call().await?;
    println!("Total UniswapV2 pairs: {}", total_pairs);
    
    // Get first 10 pairs
    println!("\nFirst 10 pairs:");
    for i in 0..10u64.min(total_pairs.as_u64()) {
        let pair_address: Address = factory.method("allPairs", U256::from(i))?.call().await?;
        println!("  Pair {}: {}", i, pair_address);
    }
    
    // Get a specific pair's reserves
    if total_pairs > U256::zero() {
        println!("\nGetting reserves for first pair...");
        let pair_address: Address = factory.method("allPairs", U256::from(0))?.call().await?;
        
        let pair_abi = ethers::abi::parse_abi(&[
            "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
            "function token0() external view returns (address)",
            "function token1() external view returns (address)",
        ])?;
        
        let pair = Contract::new(pair_address, pair_abi, provider.clone());
        
        let token0: Address = pair.method("token0", ())?.call().await?;
        let token1: Address = pair.method("token1", ())?.call().await?;
        let reserves: (u128, u128, u32) = pair.method("getReserves", ())?.call().await?;
        
        println!("  Token0: {}", token0);
        println!("  Token1: {}", token1);
        println!("  Reserve0: {}", reserves.0);
        println!("  Reserve1: {}", reserves.1);
    }
    
    println!("\n✅ TEST COMPLETE - Scanner can connect and read blockchain data!");
    
    Ok(())
}