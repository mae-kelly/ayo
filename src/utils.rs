use ethers::types::U256;

use crate::models::ArbitrageOpportunity;

pub fn format_opportunity(opp: &ArbitrageOpportunity) -> String {
    let mut output = String::new();
    
    output.push_str(&format!(
        "  Token Pair: {}/{}\n",
        opp.token_pair.symbol0, opp.token_pair.symbol1
    ));
    
    output.push_str(&format!(
        "  Buy from: {} | Sell to: {}\n",
        opp.buy_pool.dex, opp.sell_pool.dex
    ));
    
    output.push_str(&format!(
        "  Optimal Amount: {} {}\n",
        format_token_amount(opp.optimal_amount, opp.token_pair.decimals0),
        opp.token_pair.symbol0
    ));
    
    output.push_str(&format!(
        "  Gross Profit: ${:.2} ({} wei)\n",
        opp.profit_usd,
        opp.profit_wei
    ));
    
    output.push_str(&format!(
        "  Gas Cost: ${:.2}\n",
        opp.gas_cost_usd
    ));
    
    output.push_str(&format!(
        "  Flash Loan Provider: {}\n",
        opp.flashloan_provider
    ));
    
    output.push_str(&format!(
        "  NET PROFIT: ${:.2} ✅\n",
        opp.net_profit_usd
    ));
    
    output.push_str(&format!(
        "  Block: #{}",
        opp.block_number
    ));
    
    output
}

pub fn format_token_amount(amount: U256, decimals: u8) -> String {
    let divisor = U256::from(10u128.pow(decimals as u32));
    let whole = amount / divisor;
    let fraction = amount % divisor;
    
    if fraction.is_zero() {
        format!("{}", whole)
    } else {
        let fraction_str = format!("{:0>width$}", fraction, width = decimals as usize);
        let trimmed = fraction_str.trim_end_matches('0');
        if trimmed.is_empty() {
            format!("{}", whole)
        } else {
            format!("{}.{}", whole, trimmed)
        }
    }
}

pub fn wei_to_ether(wei: U256) -> f64 {
    wei.as_u128() as f64 / 1e18
}

pub fn gwei_to_wei(gwei: f64) -> U256 {
    U256::from((gwei * 1e9) as u128)
}