// contracts/interfaces/IDexRouter.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IDexRouter {
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);
    
    function swapTokensForExactTokens(
        uint amountOut,
        uint amountInMax,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);
    
    function getAmountsOut(uint amountIn, address[] calldata path) 
        external view returns (uint[] memory amounts);
    
    function getAmountsIn(uint amountOut, address[] calldata path)
        external view returns (uint[] memory amounts);
}