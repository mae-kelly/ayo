// contracts/arbitrage/FlashLoanArbitrage.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

// Simplified Aave interfaces
interface IPoolAddressesProvider {
    function getPool() external view returns (address);
}

interface IPool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IFlashLoanSimpleReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

contract FlashLoanArbitrage is IFlashLoanSimpleReceiver, Ownable {
    using SafeERC20 for IERC20;
    
    IPoolAddressesProvider public immutable ADDRESSES_PROVIDER;
    IPool public immutable POOL;
    
    // Gas optimized storage packing
    struct ArbitrageParams {
        address tokenIn;
        address tokenOut;
        uint128 amountIn;
        uint128 expectedProfit;
        address[] routers;
        bytes routerCalldata;
    }
    
    // Events
    event ArbitrageExecuted(
        address indexed token,
        uint256 profit,
        uint256 gasUsed
    );
    
    event EmergencyWithdraw(
        address indexed token,
        uint256 amount
    );
    
    modifier onlyPool() {
        require(msg.sender == address(POOL), "Caller not pool");
        _;
    }
    
    constructor(address _addressProvider) {
        ADDRESSES_PROVIDER = IPoolAddressesProvider(_addressProvider);
        POOL = IPool(ADDRESSES_PROVIDER.getPool());
    }
    
    /**
     * @dev Initiates a flash loan and executes arbitrage
     */
    function executeArbitrage(
        address asset,
        uint256 amount,
        bytes calldata params
    ) external onlyOwner {
        POOL.flashLoanSimple(
            address(this),
            asset,
            amount,
            params,
            0 // referral code
        );
    }
    
    /**
     * @dev Executes the arbitrage logic after receiving flash loan
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address, // initiator
        bytes calldata params
    ) external override onlyPool returns (bool) {
        uint256 gasStart = gasleft();
        
        // Decode arbitrage parameters
        ArbitrageParams memory arbParams = abi.decode(params, (ArbitrageParams));
        
        // Record initial balance
        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));
        
        // Execute multi-hop arbitrage
        for (uint i = 0; i < arbParams.routers.length;) {
            // Approve router to spend tokens
            IERC20(arbParams.tokenIn).safeApprove(
                arbParams.routers[i],
                arbParams.amountIn
            );
            
            // Execute swap on router
            (bool success, bytes memory result) = arbParams.routers[i].call(
                arbParams.routerCalldata
            );
            require(success, "Arb swap failed");
            
            unchecked { ++i; }
        }
        
        // Calculate profit
        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));
        uint256 profit = balanceAfter - balanceBefore - premium;
        
        // Ensure minimum profit threshold is met
        require(profit >= arbParams.expectedProfit, "Insufficient profit");
        
        // Approve pool for repayment
        uint256 amountOwed = amount + premium;
        IERC20(asset).safeApprove(address(POOL), amountOwed);
        
        // Transfer profit to owner
        if (profit > 0) {
            IERC20(asset).safeTransfer(owner(), profit);
        }
        
        emit ArbitrageExecuted(
            asset,
            profit,
            gasStart - gasleft()
        );
        
        return true;
    }
    
    /**
     * @dev Emergency function to withdraw stuck tokens
     */
    function emergencyWithdraw(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "No balance");
        
        IERC20(token).safeTransfer(owner(), balance);
        emit EmergencyWithdraw(token, balance);
    }
    
    /**
     * @dev Receive function to accept ETH
     */
    receive() external payable {}
}