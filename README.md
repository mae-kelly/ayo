# Flash Loan Arbitrage Scanner

A production-ready Rust application that scans Ethereum mainnet for profitable flash loan arbitrage opportunities across multiple DEXs in real-time.

## Features

- **Multi-DEX Support**: Scans UniswapV2, UniswapV3, Sushiswap, and more
- **Real-time Monitoring**: Continuously monitors blockchain for arbitrage opportunities
- **Flash Loan Integration**: Supports Aave V3, Balancer, and dYdX flash loans
- **Gas Optimization**: Calculates profitability after gas costs and fees
- **Multi-Provider Redundancy**: Uses Alchemy, Infura, and Etherscan APIs
- **Production Ready**: Proper error handling, logging, and performance optimization

## Prerequisites

1. **API Keys** - Get free API keys from:
   - [Alchemy](https://www.alchemy.com/)
   - [Infura](https://infura.io/)
   - [Etherscan](https://etherscan.io/apis)

2. **Rust** - Install from [rustup.rs](https://rustup.rs/)

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd flash-loan-arbitrage-scanner
```

2. Copy the environment template:
```bash
cp .env.example .env
```

3. Edit `.env` and add your API keys:
```bash
ALCHEMY_API_KEY=your_alchemy_key_here
INFURA_API_KEY=your_infura_key_here
ETHERSCAN_API_KEY=your_etherscan_key_here
```

4. Build the project:
```bash
cargo build --release
```

## Usage

Run the scanner:
```bash
cargo run --release
```

Or with custom logging:
```bash
RUST_LOG=info cargo run --release
```

## Configuration

Edit `.env` to customize:

- `MIN_PROFIT_USD`: Minimum profit threshold (default: $50)
- `MAX_GAS_PRICE_GWEI`: Maximum gas price to execute trades (default: 100 gwei)
- `SCAN_INTERVAL_MS`: Scan frequency in milliseconds (default: 2000ms)

## How It Works

1. **Pool Discovery**: Fetches liquidity pools from major DEXs
2. **Price Analysis**: Compares token prices across different pools
3. **Opportunity Detection**: Identifies price discrepancies > 0.3%
4. **Profit Calculation**: 
   - Calculates optimal trade amount
   - Simulates swap outputs
   - Deducts flash loan fees
   - Estimates gas costs
   - Calculates net profit in USD
5. **Display Results**: Shows profitable opportunities in console

## Output Example

```
================================================================================
⚡ ARBITRAGE OPPORTUNITIES FOUND - 2025-01-15 14:23:45
================================================================================

📊 Opportunity #1
  Token Pair: WETH/USDC
  Buy from: UniswapV2 | Sell to: UniswapV3
  Optimal Amount: 10.5 WETH
  Gross Profit: $125.50 (62750000000000000 wei)
  Gas Cost: $35.20
  Flash Loan Provider: Balancer
  NET PROFIT: $90.30 ✅
  Block: #19234567

================================================================================
Total opportunities: 1
Total potential profit: $90.30
================================================================================
```

## Architecture

```
src/
├── main.rs           # Entry point
├── config.rs         # Configuration management
├── models.rs         # Data structures
├── providers.rs      # RPC provider management
├── scanner.rs        # Main scanning logic
├── dex/
│   ├── mod.rs       # DEX manager
│   ├── uniswap_v2.rs # UniswapV2 integration
│   └── uniswap_v3.rs # UniswapV3 integration
├── flashloan.rs      # Flash loan providers
├── gas.rs            # Gas estimation
└── utils.rs          # Helper functions
```

## Security Considerations

- **Read-Only**: This scanner only reads blockchain data, no transactions are executed
- **API Keys**: Keep your API keys secure and never commit them to version control
- **Rate Limits**: Respects API rate limits with configurable scan intervals
- **Error Handling**: Robust error handling prevents crashes from network issues

## Performance

- **Optimized Binary**: Release builds with maximum optimizations
- **Concurrent Scanning**: Async/await for efficient network operations
- **Provider Rotation**: Automatic failover between RPC providers
- **Memory Efficient**: Uses references and Arc for shared data

## Limitations

- **Mainnet Only**: Currently configured for Ethereum mainnet
- **No Execution**: Shows opportunities but doesn't execute trades
- **Simplified Calculations**: Some calculations are simplified for performance
- **Limited Pools**: Focuses on major token pairs for reliability

## Advanced Usage

### Custom Token Pairs

To add specific token pairs, modify `src/dex/uniswap_v3.rs`:
```rust
let common_tokens = vec![
    "0x...", // Add your token addresses here
];
```

### Adjusting Gas Estimates

Edit `src/gas.rs` to fine-tune gas calculations:
```rust
let gas_limit = U256::from(500000); // Adjust based on complexity
```

### Adding New DEXs

Implement a new handler in `src/dex/` following the pattern of existing integrations.

## Troubleshooting

### No Opportunities Found
- Increase `SCAN_INTERVAL_MS` for more frequent checks
- Lower `MIN_PROFIT_USD` threshold
- Check if gas prices are within `MAX_GAS_PRICE_GWEI`

### Connection Errors
- Verify API keys are correct
- Check network connectivity
- Ensure API rate limits aren't exceeded

### High Gas Prices
- Wait for lower network congestion
- Increase `MAX_GAS_PRICE_GWEI` if needed

## Disclaimer

**IMPORTANT**: This tool is for educational and research purposes. Executing arbitrage trades on mainnet requires:
- Significant capital for gas fees
- Smart contract implementation for atomic execution
- MEV protection strategies
- Thorough testing on testnets

Always conduct your own research and understand the risks before engaging in arbitrage trading.

## License

MIT License - See LICENSE file for details

## Contributing

Contributions are welcome! Please feel free to submit pull requests.

## Support

For issues or questions, please open an issue on GitHub.