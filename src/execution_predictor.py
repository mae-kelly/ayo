"""
Execution viability prediction module
Determines if an arbitrage opportunity is worth executing
"""

import numpy as np
from typing import Dict, Tuple
from datetime import datetime, timedelta
from loguru import logger

class ExecutionPredictor:
    """Predict execution viability and success probability"""
    
    def __init__(self):
        # Thresholds and weights
        self.weights = {
            'profit': 0.25,
            'liquidity': 0.20,
            'gas_efficiency': 0.15,
            'token_safety': 0.20,
            'market_conditions': 0.10,
            'historical_success': 0.10,
        }
        
        # Historical execution data (would be loaded from database)
        self.execution_history = {}
        self.success_rates = {}
        
        # Market condition trackers
        self.gas_price_history = []
        self.network_congestion = 0.5  # 0-1 scale
        
    def predict_viability(self, opportunity: Dict, research: Dict) -> float:
        """
        Predict execution viability
        Returns score from 0 (don't execute) to 1 (definitely execute)
        """
        scores = {}
        
        # Calculate individual scores
        scores['profit'] = self._score_profit(opportunity)
        scores['liquidity'] = self._score_liquidity(research)
        scores['gas_efficiency'] = self._score_gas_efficiency(opportunity)
        scores['token_safety'] = self._score_token_safety(research)
        scores['market_conditions'] = self._score_market_conditions(opportunity)
        scores['historical_success'] = self._score_historical_success(opportunity)
        
        # Calculate weighted average
        viability = sum(
            scores[factor] * weight 
            for factor, weight in self.weights.items()
        )
        
        # Apply penalties
        viability = self._apply_penalties(viability, opportunity, research)
        
        # Log decision factors
        if viability > 0.7:
            logger.debug(f"High viability: {scores}")
        elif viability < 0.3:
            logger.debug(f"Low viability: {scores}")
        
        return min(max(viability, 0), 1)  # Clamp to [0, 1]
    
    def _score_profit(self, opportunity: Dict) -> float:
        """Score based on profit potential"""
        net_profit = opportunity.get('net_profit', 0)
        
        if net_profit <= 0:
            return 0.0
        elif net_profit < 10:
            return 0.2
        elif net_profit < 50:
            return 0.5
        elif net_profit < 100:
            return 0.7
        elif net_profit < 500:
            return 0.85
        else:
            # Very high profit might be suspicious
            if net_profit > 5000:
                return 0.5  # Too good to be true
            return 0.95
    
    def _score_liquidity(self, research: Dict) -> float:
        """Score based on liquidity depth"""
        min_liquidity = float('inf')
        
        # Check token liquidity
        for token_data in research.get('tokens', {}).values():
            liquidity = token_data.get('liquidity_usd', 0)
            min_liquidity = min(min_liquidity, liquidity)
        
        if min_liquidity == float('inf') or min_liquidity == 0:
            return 0.0
        elif min_liquidity < 10000:
            return 0.1
        elif min_liquidity < 50000:
            return 0.3
        elif min_liquidity < 100000:
            return 0.5
        elif min_liquidity < 500000:
            return 0.7
        elif min_liquidity < 1000000:
            return 0.85
        else:
            return 1.0
    
    def _score_gas_efficiency(self, opportunity: Dict) -> float:
        """Score based on gas cost efficiency"""
        gas_ratio = opportunity.get('gas_ratio', 1.0)
        
        if gas_ratio >= 0.8:  # Gas costs 80%+ of profit
            return 0.0
        elif gas_ratio >= 0.5:
            return 0.3
        elif gas_ratio >= 0.3:
            return 0.5
        elif gas_ratio >= 0.2:
            return 0.7
        elif gas_ratio >= 0.1:
            return 0.85
        else:
            return 1.0
    
    def _score_token_safety(self, research: Dict) -> float:
        """Score based on token safety metrics"""
        safety_score = 1.0
        
        for token_data in research.get('tokens', {}).values():
            # Contract verification
            if not token_data.get('contract_verified', False):
                safety_score *= 0.7
            
            # Contract age
            age_days = token_data.get('age_days', 0)
            if age_days < 7:
                safety_score *= 0.5
            elif age_days < 30:
                safety_score *= 0.7
            elif age_days < 90:
                safety_score *= 0.85
            
            # Holder count
            holders = token_data.get('holder_count', 0)
            if holders < 100:
                safety_score *= 0.6
            elif holders < 500:
                safety_score *= 0.8
            
            # Trading taxes
            sell_tax = token_data.get('tax_sell', 0)
            if sell_tax > 10:
                safety_score *= 0.3
            elif sell_tax > 5:
                safety_score *= 0.6
            elif sell_tax > 2:
                safety_score *= 0.8
        
        return safety_score
    
    def _score_market_conditions(self, opportunity: Dict) -> float:
        """Score based on current market conditions"""
        score = 0.5  # Default neutral score
        
        # Time of day (avoid high congestion hours)
        hour = datetime.now().hour
        if hour >= 14 and hour <= 18:  # US peak hours (EST)
            score *= 0.8
        elif hour >= 2 and hour <= 6:  # Low congestion
            score *= 1.2
        
        # Day of week
        day = datetime.now().weekday()
        if day in [5, 6]:  # Weekend
            score *= 1.1  # Usually lower congestion
        
        # Network congestion
        score *= (1.5 - self.network_congestion)
        
        # Gas price trend
        gas_cost = opportunity.get('gas_cost', 0)
        if gas_cost > 100:
            score *= 0.7
        elif gas_cost > 50:
            score *= 0.85
        
        return min(score, 1.0)
    
    def _score_historical_success(self, opportunity: Dict) -> float:
        """Score based on historical success rate for similar trades"""
        pair = opportunity.get('pair', '')
        buy_dex = opportunity.get('buy_dex', '')
        sell_dex = opportunity.get('sell_dex', '')
        
        # Create key for this type of trade
        trade_key = f"{pair}_{buy_dex}_{sell_dex}"
        
        # Check historical success rate
        if trade_key in self.success_rates:
            return self.success_rates[trade_key]
        
        # Check similar trades
        similar_score = 0.5  # Default
        
        # Same token pair
        for key, rate in self.success_rates.items():
            if pair in key:
                similar_score = max(similar_score, rate * 0.8)
        
        return similar_score
    
    def _apply_penalties(self, base_score: float, opportunity: Dict, research: Dict) -> float:
        """Apply penalties for various risk factors"""
        score = base_score
        
        # Honeypot risk penalty
        risk_factors = research.get('risk_factors', {})
        honeypot_risk = risk_factors.get('honeypot_risk', 0)
        if honeypot_risk > 0.5:
            score *= (1 - honeypot_risk)
        
        # New token penalty
        for token_data in research.get('tokens', {}).values():
            if token_data.get('age_days', 365) < 1:
                score *= 0.3  # Heavy penalty for day-old tokens
                break
        
        # Extreme profit penalty (likely too good to be true)
        net_profit = opportunity.get('net_profit', 0)
        if net_profit > 10000:
            score *= 0.2
        
        # Low volume penalty
        for token_data in research.get('tokens', {}).values():
            if token_data.get('volume_24h', 0) < 1000:
                score *= 0.5
                break
        
        return score
    
    def update_execution_result(self, opportunity: Dict, success: bool, actual_profit: float):
        """Update historical data with execution result"""
        pair = opportunity.get('pair', '')
        buy_dex = opportunity.get('buy_dex', '')
        sell_dex = opportunity.get('sell_dex', '')
        
        trade_key = f"{pair}_{buy_dex}_{sell_dex}"
        
        # Update execution history
        if trade_key not in self.execution_history:
            self.execution_history[trade_key] = {
                'attempts': 0,
                'successes': 0,
                'total_profit': 0,
                'avg_profit': 0,
            }
        
        history = self.execution_history[trade_key]
        history['attempts'] += 1
        if success:
            history['successes'] += 1
            history['total_profit'] += actual_profit
        
        # Update success rate
        self.success_rates[trade_key] = history['successes'] / history['attempts']
        
        # Update average profit
        if history['successes'] > 0:
            history['avg_profit'] = history['total_profit'] / history['successes']
        
        logger.info(
            f"Execution result updated: {trade_key} - "
            f"Success rate: {self.success_rates[trade_key]:.2%}"
        )
    
    def get_execution_recommendation(self, viability: float) -> Tuple[bool, str]:
        """Get execution recommendation based on viability score"""
        if viability >= 0.8:
            return True, "STRONG BUY - High confidence execution"
        elif viability >= 0.6:
            return True, "EXECUTE - Good opportunity"
        elif viability >= 0.4:
            return False, "RISKY - Consider waiting"
        elif viability >= 0.2:
            return False, "AVOID - High risk, low reward"
        else:
            return False, "SKIP - Do not execute"