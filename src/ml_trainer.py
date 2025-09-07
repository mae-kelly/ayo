"""
ML model training for arbitrage viability prediction
Optimized for Apple M1 GPU acceleration
"""

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader, TensorDataset
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
import joblib
from pathlib import Path
from typing import Dict, List, Tuple
from loguru import logger
import warnings
warnings.filterwarnings('ignore')

# Check for M1 GPU support
if torch.backends.mps.is_available():
    device = torch.device("mps")
    logger.info("Using Apple M1 GPU (Metal Performance Shaders)")
else:
    device = torch.device("cpu")
    logger.info("M1 GPU not available, using CPU")

class ArbitrageNet(nn.Module):
    """Neural network for arbitrage viability prediction"""
    
    def __init__(self, input_size: int):
        super(ArbitrageNet, self).__init__()
        
        self.layers = nn.Sequential(
            nn.Linear(input_size, 256),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.BatchNorm1d(256),
            
            nn.Linear(256, 128),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.BatchNorm1d(128),
            
            nn.Linear(128, 64),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.BatchNorm1d(64),
            
            nn.Linear(64, 32),
            nn.ReLU(),
            nn.BatchNorm1d(32),
            
            nn.Linear(32, 1),
            nn.Sigmoid()
        )
    
    def forward(self, x):
        return self.layers(x)

class ArbitrageMLTrainer:
    """Train ML models for arbitrage opportunity assessment"""
    
    def __init__(self):
        self.models_dir = Path("models")
        self.models_dir.mkdir(exist_ok=True)
        
        # Initialize models
        self.neural_net = None
        self.random_forest = None
        self.gradient_boost = None
        self.scaler = StandardScaler()
        
        # Feature engineering settings
        self.feature_columns = None
        self.target_column = 'is_profitable'
        
        # Training history
        self.training_history = []
        
    def prepare_features(self, data: List[Dict]) -> pd.DataFrame:
        """Convert raw data to feature matrix"""
        df = pd.DataFrame(data)
        
        # Create target variable (was the trade actually profitable?)
        df[self.target_column] = (df['net_profit'] > 10) & (df['execution_success'] == True)
        
        # Engineer features
        features = pd.DataFrame()
        
        # Basic features
        features['net_profit'] = df['net_profit']
        features['gross_profit_usd'] = df.get('gross_profit_usd', 0)
        features['gas_cost'] = df.get('gas_cost', 0)
        features['gas_ratio'] = df.get('gas_ratio', 0)
        features['optimal_amount'] = df.get('optimal_amount', 0)
        
        # DEX features
        features['is_cross_dex'] = df.get('is_cross_dex', False).astype(int)
        features['is_uniswap_v2'] = df.get('is_uniswap_v2', False).astype(int)
        features['is_uniswap_v3'] = df.get('is_uniswap_v3', False).astype(int)
        features['is_sushiswap'] = df.get('is_sushiswap', False).astype(int)
        
        # Token features (from research)
        for token_num in ['token0', 'token1']:
            if f'{token_num}_data' in df.columns:
                token_data = df[f'{token_num}_data']
                features[f'{token_num}_liquidity'] = token_data.apply(
                    lambda x: x.get('liquidity_usd', 0) if isinstance(x, dict) else 0
                )
                features[f'{token_num}_volume_24h'] = token_data.apply(
                    lambda x: x.get('volume_24h', 0) if isinstance(x, dict) else 0
                )
                features[f'{token_num}_age_days'] = token_data.apply(
                    lambda x: x.get('age_days', 0) if isinstance(x, dict) else 0
                )
                features[f'{token_num}_holder_count'] = token_data.apply(
                    lambda x: x.get('holder_count', 0) if isinstance(x, dict) else 0
                )
                features[f'{token_num}_tax_sell'] = token_data.apply(
                    lambda x: x.get('tax_sell', 0) if isinstance(x, dict) else 0
                )
        
        # Risk features
        if 'risk_factors' in df.columns:
            risk_data = df['risk_factors']
            features['honeypot_risk'] = risk_data.apply(
                lambda x: x.get('honeypot_risk', 0) if isinstance(x, dict) else 0
            )
            features['liquidity_risk'] = risk_data.apply(
                lambda x: x.get('liquidity_risk', 0) if isinstance(x, dict) else 0
            )
            features['contract_risk'] = risk_data.apply(
                lambda x: x.get('contract_risk', 0) if isinstance(x, dict) else 0
            )
        
        # Time features
        features['hour'] = pd.to_datetime(df['timestamp']).dt.hour
        features['day_of_week'] = pd.to_datetime(df['timestamp']).dt.dayofweek
        
        # Fill missing values
        features = features.fillna(0)
        
        # Store feature columns
        self.feature_columns = features.columns.tolist()
        
        return features, df[self.target_column]
    
    def train(self, data: List[Dict]):
        """Train all models with the data"""
        logger.info(f"Training models with {len(data)} samples...")
        
        # Prepare features
        X, y = self.prepare_features(data)
        
        # Split data
        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=0.2, random_state=42, stratify=y
        )
        
        # Scale features
        X_train_scaled = self.scaler.fit_transform(X_train)
        X_test_scaled = self.scaler.transform(X_test)
        
        # Train Neural Network
        self._train_neural_network(X_train_scaled, y_train, X_test_scaled, y_test)
        
        # Train Random Forest
        self._train_random_forest(X_train, y_train, X_test, y_test)
        
        # Train Gradient Boosting
        self._train_gradient_boosting(X_train, y_train, X_test, y_test)
        
        # Save models
        self.save_model()
        
        logger.success("Model training complete")
    
    def _train_neural_network(self, X_train, y_train, X_test, y_test):
        """Train neural network model"""
        logger.info("Training neural network on M1 GPU...")
        
        # Convert to tensors
        X_train_tensor = torch.FloatTensor(X_train).to(device)
        y_train_tensor = torch.FloatTensor(y_train.values).to(device)
        X_test_tensor = torch.FloatTensor(X_test).to(device)
        y_test_tensor = torch.FloatTensor(y_test.values).to(device)
        
        # Create data loaders
        train_dataset = TensorDataset(X_train_tensor, y_train_tensor)
        train_loader = DataLoader(train_dataset, batch_size=32, shuffle=True)
        
        # Initialize model
        self.neural_net = ArbitrageNet(X_train.shape[1]).to(device)
        
        # Loss and optimizer
        criterion = nn.BCELoss()
        optimizer = optim.Adam(self.neural_net.parameters(), lr=0.001)
        scheduler = optim.lr_scheduler.ReduceLROnPlateau(optimizer, patience=10)
        
        # Training loop
        epochs = 100
        best_loss = float('inf')
        
        for epoch in range(epochs):
            self.neural_net.train()
            train_loss = 0
            
            for batch_X, batch_y in train_loader:
                optimizer.zero_grad()
                outputs = self.neural_net(batch_X).squeeze()
                loss = criterion(outputs, batch_y)
                loss.backward()
                optimizer.step()
                train_loss += loss.item()
            
            # Validation
            self.neural_net.eval()
            with torch.no_grad():
                val_outputs = self.neural_net(X_test_tensor).squeeze()
                val_loss = criterion(val_outputs, y_test_tensor)
                
                # Calculate accuracy
                predictions = (val_outputs > 0.5).float()
                accuracy = (predictions == y_test_tensor).float().mean()
            
            scheduler.step(val_loss)
            
            if val_loss < best_loss:
                best_loss = val_loss
                torch.save(self.neural_net.state_dict(), self.models_dir / 'neural_net.pth')
            
            if epoch % 20 == 0:
                logger.info(
                    f"Epoch {epoch}/{epochs} - "
                    f"Train Loss: {train_loss/len(train_loader):.4f} - "
                    f"Val Loss: {val_loss:.4f} - "
                    f"Accuracy: {accuracy:.4f}"
                )
    
    def _train_random_forest(self, X_train, y_train, X_test, y_test):
        """Train Random Forest model"""
        logger.info("Training Random Forest...")
        
        self.random_forest = RandomForestClassifier(
            n_estimators=200,
            max_depth=20,
            min_samples_split=5,
            min_samples_leaf=2,
            random_state=42,
            n_jobs=-1  # Use all CPU cores
        )
        
        self.random_forest.fit(X_train, y_train)
        
        # Evaluate
        train_score = self.random_forest.score(X_train, y_train)
        test_score = self.random_forest.score(X_test, y_test)
        
        logger.info(f"Random Forest - Train: {train_score:.4f}, Test: {test_score:.4f}")
        
        # Feature importance
        feature_importance = pd.DataFrame({
            'feature': self.feature_columns,
            'importance': self.random_forest.feature_importances_
        }).sort_values('importance', ascending=False)
        
        logger.info(f"Top features:\n{feature_importance.head(10)}")
    
    def _train_gradient_boosting(self, X_train, y_train, X_test, y_test):
        """Train Gradient Boosting model"""
        logger.info("Training Gradient Boosting...")
        
        self.gradient_boost = GradientBoostingClassifier(
            n_estimators=100,
            learning_rate=0.1,
            max_depth=5,
            random_state=42
        )
        
        self.gradient_boost.fit(X_train, y_train)
        
        # Evaluate
        train_score = self.gradient_boost.score(X_train, y_train)
        test_score = self.gradient_boost.score(X_test, y_test)
        
        logger.info(f"Gradient Boosting - Train: {train_score:.4f}, Test: {test_score:.4f}")
    
    def predict(self, opportunity: Dict, research: Dict) -> float:
        """Predict viability of an opportunity"""
        # Prepare features
        data = [self._combine_opportunity_research(opportunity, research)]
        X, _ = self.prepare_features(data)
        
        if len(X) == 0:
            return 0.0
        
        # Get predictions from all models
        predictions = []
        
        # Neural Network prediction
        if self.neural_net:
            self.neural_net.eval()
            X_scaled = self.scaler.transform(X)
            X_tensor = torch.FloatTensor(X_scaled).to(device)
            with torch.no_grad():
                nn_pred = self.neural_net(X_tensor).squeeze().cpu().numpy()
                predictions.append(float(nn_pred))
        
        # Random Forest prediction
        if self.random_forest:
            rf_pred = self.random_forest.predict_proba(X)[0, 1]
            predictions.append(rf_pred)
        
        # Gradient Boosting prediction
        if self.gradient_boost:
            gb_pred = self.gradient_boost.predict_proba(X)[0, 1]
            predictions.append(gb_pred)
        
        # Ensemble prediction (average)
        if predictions:
            return np.mean(predictions)
        
        return 0.5  # Default if no models trained
    
    def _combine_opportunity_research(self, opportunity: Dict, research: Dict) -> Dict:
        """Combine opportunity and research data for prediction"""
        combined = opportunity.copy()
        
        # Add research data
        if 'tokens' in research:
            for token_name, token_data in research['tokens'].items():
                combined[f'{token_name}_data'] = token_data
        
        if 'risk_factors' in research:
            combined['risk_factors'] = research['risk_factors']
        
        # Add execution success (for training, this would come from actual execution)
        combined['execution_success'] = True  # Placeholder
        
        return combined
    
    def save_model(self):
        """Save all trained models"""
        # Save neural network
        if self.neural_net:
            torch.save(self.neural_net.state_dict(), self.models_dir / 'neural_net.pth')
        
        # Save sklearn models
        if self.random_forest:
            joblib.dump(self.random_forest, self.models_dir / 'random_forest.pkl')
        
        if self.gradient_boost:
            joblib.dump(self.gradient_boost, self.models_dir / 'gradient_boost.pkl')
        
        # Save scaler
        joblib.dump(self.scaler, self.models_dir / 'scaler.pkl')
        
        # Save feature columns
        joblib.dump(self.feature_columns, self.models_dir / 'features.pkl')
        
        logger.info("Models saved successfully")
    
    def load_model(self):
        """Load pre-trained models"""
        try:
            # Load feature columns
            if (self.models_dir / 'features.pkl').exists():
                self.feature_columns = joblib.load(self.models_dir / 'features.pkl')
            
            # Load scaler
            if (self.models_dir / 'scaler.pkl').exists():
                self.scaler = joblib.load(self.models_dir / 'scaler.pkl')
            
            # Load neural network
            if (self.models_dir / 'neural_net.pth').exists():
                input_size = len(self.feature_columns) if self.feature_columns else 30
                self.neural_net = ArbitrageNet(input_size).to(device)
                self.neural_net.load_state_dict(
                    torch.load(self.models_dir / 'neural_net.pth', map_location=device)
                )
                self.neural_net.eval()
            
            # Load sklearn models
            if (self.models_dir / 'random_forest.pkl').exists():
                self.random_forest = joblib.load(self.models_dir / 'random_forest.pkl')
            
            if (self.models_dir / 'gradient_boost.pkl').exists():
                self.gradient_boost = joblib.load(self.models_dir / 'gradient_boost.pkl')
            
            logger.info("Models loaded successfully")
            
        except Exception as e:
            logger.error(f"Error loading models: {e}")