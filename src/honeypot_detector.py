"""
Honeypot and scam detection module
"""

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler
import joblib
from pathlib import Path
from typing import Dict, List
from loguru import logger

class HoneypotDetector:
    """Detect honeypots and scam tokens using ML"""
    
    def __init__(self):
        self.models_dir = Path("models")
        self.models_dir.mkdir(exist_ok=True)
        
        # Initialize models
        self.isolation_forest = None
        self.scaler = StandardScaler()
        
        # Known honeypot patterns
        self.honeypot_patterns = {
            'high_tax': lambda x: x.get('tax_sell', 0) > 50,
            'ownership_risk': lambda x: x.get('can_take_back_ownership', False),
            'no_liquidity': lambda x: x.get('liquidity_usd', 0) < 1000,
            'new_contract': lambda x: x.get('age_days', 365) < 1,
            'few_holders': lambda x: x.get('holder_count', 1000) < 10,
            'unverified': lambda x: not x.get('contract_verified', False),
        }
        
        # Historical honeypot addresses (would be loaded from database)
        self.known_honeypots = set()
        self.known_safe = set()
        
    def check_honeypot(self, opportunity: Dict, research: Dict) -> float:
        """
        Check if opportunity involves a honeypot
        Returns risk score from 0 (safe) to 1 (definite honeypot)
        """
        risk_scores = []
        
        # Check each token
        for token_data in research.get('tokens', {}).values():
            token_risk = self._evaluate_token_risk(token_data)
            risk_scores.append(token_risk)
        
        # Check pair-level risks
        pair_risk = self._evaluate_pair_risk(opportunity, research)
        risk_scores.append(pair_risk)
        
        # Use ML model if available
        if self.isolation_forest:
            ml_risk = self._ml_risk_assessment(opportunity, research)
            risk_scores.append(ml_risk)
        
        # Calculate overall risk (max of all risks)
        overall_risk = max(risk_scores) if risk_scores else 0.0
        
        # Log high-risk detections
        if overall_risk > 0.7:
            logger.warning(
                f"High honeypot risk detected for {opportunity.get('pair')}: {overall_risk:.2f}"
            )
        
        return overall_risk
    
    def _evaluate_token_risk(self, token_data: Dict) -> float:
        """Evaluate risk for a single token"""
        risk = 0.0
        risk_factors = []
        
        # Check against known patterns
        for pattern_name, pattern_func in self.honeypot_patterns.items():
            if pattern_func(token_data):
                risk_factors.append(pattern_name)
                risk += 0.3
        
        # Specific honeypot indicators
        if token_data.get('is_honeypot', False):
            risk = max(risk, 0.9)
            risk_factors.append('confirmed_honeypot')
        
        # High sell tax
        sell_tax = token_data.get('tax_sell', 0)
        if sell_tax > 50:
            risk = max(risk, 0.95)
            risk_factors.append(f'extreme_sell_tax_{sell_tax}%')
        elif sell_tax > 25:
            risk = max(risk, 0.7)
            risk_factors.append(f'high_sell_tax_{sell_tax}%')
        elif sell_tax > 10:
            risk = max(risk, 0.4)
            risk_factors.append(f'moderate_sell_tax_{sell_tax}%')
        
        # Ownership risks
        if token_data.get('can_take_back_ownership', False):
            risk = max(risk, 0.8)
            risk_factors.append('ownership_vulnerability')
        
        # Liquidity risks
        liquidity = token_data.get('liquidity_usd', 0)
        if liquidity < 10000:
            risk = max(risk, 0.6)
            risk_factors.append(f'low_liquidity_${liquidity:.0f}')
        
        # Contract age
        age_days = token_data.get('age_days', 0)
        if age_days < 7:
            risk = max(risk, 0.5)
            risk_factors.append(f'new_contract_{age_days}days')
        
        # Holder distribution
        holders = token_data.get('holder_count', 0)
        if holders < 50:
            risk = max(risk, 0.6)
            risk_factors.append(f'few_holders_{holders}')
        
        # Check if address is known honeypot
        address = token_data.get('address')
        if address and address in self.known_honeypots:
            risk = 1.0
            risk_factors.append('known_honeypot_address')
        elif address and address in self.known_safe:
            risk = min(risk, 0.2)  # Reduce risk for known safe tokens
        
        if risk_factors:
            logger.debug(f"Token risk factors: {risk_factors}")
        
        return min(risk, 1.0)
    
    def _evaluate_pair_risk(self, opportunity: Dict, research: Dict) -> float:
        """Evaluate pair-level risks"""
        risk = 0.0
        
        # Check for suspicious profit margins
        net_profit = opportunity.get('net_profit', 0)
        if net_profit > 1000:  # Unusually high profit
            risk = max(risk, 0.3)
            logger.debug(f"Suspicious high profit: ${net_profit:.2f}")
        
        # Check liquidity imbalance
        liquidity_data = research.get('liquidity', {})
        buy_liq = liquidity_data.get('buy_dex_liquidity', 1)
        sell_liq = liquidity_data.get('sell_dex_liquidity', 1)
        
        if buy_liq > 0 and sell_liq > 0:
            ratio = min(buy_liq, sell_liq) / max(buy_liq, sell_liq)
            if ratio < 0.1:  # 10x liquidity imbalance
                risk = max(risk, 0.5)
                logger.debug(f"Liquidity imbalance: {ratio:.2f}")
        
        # Check for new pairs
        for dex in ['buy_dex', 'sell_dex']:
            if 'new' in opportunity.get(dex, '').lower():
                risk = max(risk, 0.4)
        
        return risk
    
    def _ml_risk_assessment(self, opportunity: Dict, research: Dict) -> float:
        """Use ML model for risk assessment"""
        try:
            # Prepare features
            features = self._extract_features(opportunity, research)
            
            if features is None:
                return 0.5  # Default medium risk
            
            # Scale features
            features_scaled = self.scaler.transform([features])
            
            # Predict anomaly (-1 for anomaly, 1 for normal)
            prediction = self.isolation_forest.predict(features_scaled)[0]
            
            # Get anomaly score
            score = self.isolation_forest.score_samples(features_scaled)[0]
            
            # Convert to risk score (0-1)
            if prediction == -1:  # Anomaly detected
                risk = 0.7 + (1 - (score + 1) / 2) * 0.3  # Scale to 0.7-1.0
            else:
                risk = max(0, (1 - (score + 1) / 2) * 0.7)  # Scale to 0-0.7
            
            return risk
            
        except Exception as e:
            logger.error(f"ML risk assessment failed: {e}")
            return 0.5
    
    def _extract_features(self, opportunity: Dict, research: Dict) -> List[float]:
        """Extract numerical features for ML model"""
        features = []
        
        try:
            # Opportunity features
            features.append(opportunity.get('net_profit', 0))
            features.append(opportunity.get('gas_ratio', 0))
            features.append(1 if opportunity.get('is_cross_dex', False) else 0)
            
            # Token features
            for token_data in research.get('tokens', {}).values():
                features.append(token_data.get('liquidity_usd', 0))
                features.append(token_data.get('volume_24h', 0))
                features.append(token_data.get('age_days', 0))
                features.append(token_data.get('holder_count', 0))
                features.append(token_data.get('tax_sell', 0))
                features.append(1 if token_data.get('contract_verified', False) else 0)
            
            # Pad if needed
            while len(features) < 20:
                features.append(0)
            
            return features[:20]  # Ensure consistent size
            
        except Exception as e:
            logger.error(f"Feature extraction failed: {e}")
            return None
    
    def train(self, data: List[Dict]):
        """Train the honeypot detection model"""
        logger.info("Training honeypot detection model...")
        
        # Extract features from historical data
        features = []
        labels = []  # 1 for honeypot, 0 for safe
        
        for item in data:
            f = self._extract_features(item.get('opportunity', {}), item.get('research', {}))
            if f:
                features.append(f)
                # Label based on execution success and profit
                is_honeypot = (
                    not item.get('execution_success', True) or
                    item.get('actual_profit', 0) < -10  # Lost money
                )
                labels.append(1 if is_honeypot else 0)
        
        if len(features) < 10:
            logger.warning("Not enough data for honeypot training")
            return
        
        # Scale features
        features_scaled = self.scaler.fit_transform(features)
        
        # Train Isolation Forest
        self.isolation_forest = IsolationForest(
            contamination=0.2,  # Expected proportion of honeypots
            random_state=42,
            n_estimators=100
        )
        
        self.isolation_forest.fit(features_scaled)
        
        # Update known honeypots list
        for item, label in zip(data, labels):
            if label == 1:  # Honeypot
                for token_data in item.get('research', {}).get('tokens', {}).values():
                    address = token_data.get('address')
                    if address:
                        self.known_honeypots.add(address)
        
        logger.success(f"Honeypot model trained on {len(features)} samples")
    
    def save_model(self):
        """Save the trained model"""
        if self.isolation_forest:
            joblib.dump(self.isolation_forest, self.models_dir / 'honeypot_detector.pkl')
            joblib.dump(self.scaler, self.models_dir / 'honeypot_scaler.pkl')
            joblib.dump(self.known_honeypots, self.models_dir / 'known_honeypots.pkl')
            logger.info("Honeypot detection model saved")
    
    def load_model(self):
        """Load pre-trained model"""
        try:
            if (self.models_dir / 'honeypot_detector.pkl').exists():
                self.isolation_forest = joblib.load(self.models_dir / 'honeypot_detector.pkl')
            
            if (self.models_dir / 'honeypot_scaler.pkl').exists():
                self.scaler = joblib.load(self.models_dir / 'honeypot_scaler.pkl')
            
            if (self.models_dir / 'known_honeypots.pkl').exists():
                self.known_honeypots = joblib.load(self.models_dir / 'known_honeypots.pkl')
            
            logger.info("Honeypot detection model loaded")
            
        except Exception as e:
            logger.error(f"Error loading honeypot model: {e}")