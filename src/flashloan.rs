use anyhow::Result;
use ethers::{
    contract::abigen,
    providers::Middleware,
    types::{Address, U256},
};
use std::sync::Arc;

use crate::models::FlashLoanProvider;
use crate::providers::MultiProvider;

abigen!(
    AaveV3Pool,
    r#"[function flashLoan(address receiverAddress, address[] calldata assets, uint256[] calldata amounts, uint256[] calldata modes, address onBehalfOf, bytes calldata params, uint16 referralCode) external, function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128)]"#
);

abigen!(
    BalancerVault,
    r#"[function flashLoan(address recipient, address[] memory tokens, uint256[] memory amounts, bytes memory userData) external]"#
);

pub struct FlashLoanManager {
    provider: Arc<MultiProvider>,
    aave_pool: Address,
    balancer_vault: Address,
}

impl FlashLoanManager {
    pub fn new(provider: Arc<MultiProvider>, aave_pool: Address, balancer_vault: Address) -> Self {
        Self {
            provider,
            aave_pool,
            balancer_vault,
        }
    }

    pub async fn get_flash_loan_fee(&self, provider: FlashLoanProvider) -> Result<u32> {
        match provider {
            FlashLoanProvider::AaveV3 => {
                // Aave V3 typically charges 0.09% (9 basis points)
                // We'll use the default fee since the function isn't in our simplified ABI
                Ok(9)
            }
            FlashLoanProvider::Balancer => {
                // Balancer has no flash loan fees
                Ok(0)
            }
            FlashLoanProvider::DyDx => {
                // dYdX typically charges 2 wei
                Ok(0) // Effectively 0 for calculation purposes
            }
        }
    }

    pub fn calculate_flash_loan_cost(&self, amount: U256, fee_bps: u32) -> U256 {
        if fee_bps == 0 {
            return U256::zero();
        }
        amount * U256::from(fee_bps) / U256::from(10000)
    }

    pub fn select_best_provider(&self, _token: Address) -> FlashLoanProvider {
        // For now, prioritize Balancer (no fees) > dYdX > Aave
        // In production, you'd check which providers support the specific token
        FlashLoanProvider::Balancer
    }

    pub fn estimate_gas_for_flash_loan(&self, provider: FlashLoanProvider) -> U256 {
        match provider {
            FlashLoanProvider::AaveV3 => U256::from(350000), // Estimated gas
            FlashLoanProvider::Balancer => U256::from(300000),
            FlashLoanProvider::DyDx => U256::from(280000),
        }
    }
}