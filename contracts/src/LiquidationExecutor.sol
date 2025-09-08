// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@aave/core-v3/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol";
import "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import "@aave/core-v3/contracts/interfaces/IPool.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IDYdXFlashLoan {
    function flashLoan(address token, uint256 amount, bytes calldata data) external;
}

interface ICompoundV3 {
    function absorb(address absorber, address[] calldata accounts) external;
    function isLiquidatable(address account) external view returns (bool);
}

interface IEulerV2 {
    function liquidate(address violator, address collateral, uint256 repayAmount) external;
}

contract LiquidationExecutor is FlashLoanSimpleReceiverBase, Ownable {
    // Protocol addresses
    mapping(string => address) public protocols;
    mapping(address => uint256) public liquidationBonuses; // basis points
    
    // Security
    mapping(address => bool) public authorizedCallers;
    bool public emergencyStop = false;
    
    // Profit tracking
    uint256 public totalProfit;
    uint256 public totalLiquidations;
    uint256 public minProfitThreshold = 10e18; // 10 USD minimum profit
    
    // Events
    event LiquidationExecuted(
        address indexed protocol,
        address indexed user,
        address indexed collateral,
        uint256 debtRepaid,
        uint256 collateralSeized,
        uint256 profit
    );
    event EmergencyStopToggled(bool stopped);
    event ProfitWithdrawn(uint256 amount);
    
    modifier onlyAuthorized() {
        require(authorizedCallers[msg.sender] || msg.sender == owner(), "Unauthorized");
        _;
    }
    
    modifier notStopped() {
        require(!emergencyStop, "Emergency stop active");
        _;
    }
    
    constructor(address _addressProvider) 
        FlashLoanSimpleReceiverBase(IPoolAddressesProvider(_addressProvider)) 
    {
        authorizedCallers[msg.sender] = true;
        
        // Initialize protocol addresses (mainnet)
        protocols["AAVE_V3"] = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
        protocols["COMPOUND_V3"] = 0xc3d688B66703497DAA19211EEdff47f25384cdc3;
        protocols["EULER_V2"] = 0x0000000000000000000000000000000000000000; // Update with V2 address
        protocols["DYDX"] = 0x1E0447b19BB6EcFdAe1e4AE1694b0C3659614e4e;
        
        // Set default liquidation bonuses
        liquidationBonuses[protocols["AAVE_V3"]] = 500; // 5%
        liquidationBonuses[protocols["COMPOUND_V3"]] = 700; // 7%
    }
    
    // Main liquidation entry point
    function liquidate(
        string memory protocol,
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 debtToCover,
        bool useFlashLoan
    ) external onlyAuthorized notStopped {
        if (useFlashLoan) {
            // Determine best flash loan source
            if (debtAsset == address(0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE)) {
                // Use dYdX for ETH (free)
                _executeDYdXFlashLoan(user, collateralAsset, debtAsset, debtToCover);
            } else {
                // Use Aave for other assets
                _executeAaveFlashLoan(protocol, user, collateralAsset, debtAsset, debtToCover);
            }
        } else {
            // Direct liquidation with bot's funds
            _performLiquidation(protocol, user, collateralAsset, debtAsset, debtToCover);
        }
    }
    
    // Aave flash loan execution
    function _executeAaveFlashLoan(
        string memory protocol,
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 amount
    ) internal {
        bytes memory params = abi.encode(protocol, user, collateralAsset);
        POOL.flashLoanSimple(address(this), debtAsset, amount, params, 0);
    }
    
    // dYdX flash loan execution (free for ETH, DAI, USDC)
    function _executeDYdXFlashLoan(
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 amount
    ) internal {
        bytes memory data = abi.encode(user, collateralAsset, debtAsset, amount);
        IDYdXFlashLoan(protocols["DYDX"]).flashLoan(debtAsset, amount, data);
    }
    
    // Flash loan callback from Aave
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == address(POOL), "Invalid caller");
        require(initiator == address(this), "Invalid initiator");
        
        (string memory protocol, address user, address collateralAsset) = 
            abi.decode(params, (string, address, address));
        
        // Perform the liquidation
        uint256 collateralReceived = _performLiquidation(
            protocol, 
            user, 
            collateralAsset, 
            asset, 
            amount
        );
        
        // Calculate profit
        uint256 totalDebt = amount + premium;
        require(collateralReceived > totalDebt, "Unprofitable liquidation");
        
        uint256 profit = collateralReceived - totalDebt;
        require(profit >= minProfitThreshold, "Below minimum profit");
        
        totalProfit += profit;
        totalLiquidations++;
        
        // Approve repayment
        IERC20(asset).approve(address(POOL), totalDebt);
        
        emit LiquidationExecuted(
            protocols[protocol],
            user,
            collateralAsset,
            amount,
            collateralReceived,
            profit
        );
        
        return true;
    }
    
    // Core liquidation logic
    function _performLiquidation(
        string memory protocol,
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 debtToCover
    ) internal returns (uint256 collateralReceived) {
        address protocolAddress = protocols[protocol];
        require(protocolAddress != address(0), "Unknown protocol");
        
        if (keccak256(bytes(protocol)) == keccak256(bytes("AAVE_V3"))) {
            return _liquidateAave(user, collateralAsset, debtAsset, debtToCover);
        } else if (keccak256(bytes(protocol)) == keccak256(bytes("COMPOUND_V3"))) {
            return _liquidateCompound(user);
        } else if (keccak256(bytes(protocol)) == keccak256(bytes("EULER_V2"))) {
            return _liquidateEuler(user, collateralAsset, debtToCover);
        }
        
        revert("Unsupported protocol");
    }
    
    // Aave V3 liquidation
    function _liquidateAave(
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 debtToCover
    ) internal returns (uint256) {
        uint256 balanceBefore = IERC20(collateralAsset).balanceOf(address(this));
        
        // Approve debt token
        IERC20(debtAsset).approve(protocols["AAVE_V3"], debtToCover);
        
        // Execute liquidation
        IPool(protocols["AAVE_V3"]).liquidationCall(
            collateralAsset,
            debtAsset,
            user,
            debtToCover,
            false // receive collateral as token, not aToken
        );
        
        uint256 balanceAfter = IERC20(collateralAsset).balanceOf(address(this));
        return balanceAfter - balanceBefore;
    }
    
    // Compound V3 absorption
    function _liquidateCompound(address user) internal returns (uint256) {
        address[] memory accounts = new address[](1);
        accounts[0] = user;
        
        // Compound V3 uses absorption mechanism
        ICompoundV3(protocols["COMPOUND_V3"]).absorb(address(this), accounts);
        
        // Calculate received collateral
        // Note: Actual implementation needs market-specific logic
        return 0; // Placeholder
    }
    
    // Euler V2 liquidation
    function _liquidateEuler(
        address violator,
        address collateral,
        uint256 repayAmount
    ) internal returns (uint256) {
        // Euler V2 liquidation with Dutch auction mechanism
        IEulerV2(protocols["EULER_V2"]).liquidate(violator, collateral, repayAmount);
        
        // Calculate received collateral
        return 0; // Placeholder
    }
    
    // Multi-liquidation batch execution
    function batchLiquidate(
        string[] memory protocols,
        address[] memory users,
        address[] memory collateralAssets,
        address[] memory debtAssets,
        uint256[] memory amounts
    ) external onlyAuthorized notStopped {
        require(
            protocols.length == users.length && 
            users.length == collateralAssets.length &&
            collateralAssets.length == debtAssets.length &&
            debtAssets.length == amounts.length,
            "Array length mismatch"
        );
        
        for (uint256 i = 0; i < protocols.length; i++) {
            liquidate(
                protocols[i],
                users[i],
                collateralAssets[i],
                debtAssets[i],
                amounts[i],
                true
            );
        }
    }
    
    // Profit calculation helper
    function calculateExpectedProfit(
        string memory protocol,
        address collateralAsset,
        address debtAsset,
        uint256 debtAmount,
        uint256 gasPrice
    ) external view returns (uint256 expectedProfit, bool isProfitable) {
        uint256 bonus = liquidationBonuses[protocols[protocol]];
        uint256 collateralValue = (debtAmount * (10000 + bonus)) / 10000;
        
        // Estimate gas costs (300k gas for liquidation)
        uint256 gasCost = 300000 * gasPrice;
        
        // Flash loan fee (0.05% for Aave)
        uint256 flashLoanFee = (debtAmount * 5) / 10000;
        
        uint256 totalCost = debtAmount + flashLoanFee + gasCost;
        
        if (collateralValue > totalCost) {
            expectedProfit = collateralValue - totalCost;
            isProfitable = expectedProfit >= minProfitThreshold;
        }
        
        return (expectedProfit, isProfitable);
    }
    
    // Admin functions
    function toggleEmergencyStop() external onlyOwner {
        emergencyStop = !emergencyStop;
        emit EmergencyStopToggled(emergencyStop);
    }
    
    function updateProtocol(string memory name, address addr) external onlyOwner {
        protocols[name] = addr;
    }
    
    function updateLiquidationBonus(address protocol, uint256 bonus) external onlyOwner {
        liquidationBonuses[protocol] = bonus;
    }
    
    function updateMinProfit(uint256 threshold) external onlyOwner {
        minProfitThreshold = threshold;
    }
    
    function authorizeAddress(address addr, bool authorized) external onlyOwner {
        authorizedCallers[addr] = authorized;
    }
    
    function withdrawProfit() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "No ETH to withdraw");
        
        payable(owner()).transfer(balance);
        emit ProfitWithdrawn(balance);
    }
    
    function withdrawToken(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "No tokens to withdraw");
        
        IERC20(token).transfer(owner(), balance);
        emit ProfitWithdrawn(balance);
    }
    
    receive() external payable {}
}