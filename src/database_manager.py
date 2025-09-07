"""
Database management for storing opportunities and training data
"""

import sqlite3
import json
import asyncio
from datetime import datetime, timedelta
from typing import Dict, List, Optional
from pathlib import Path
from loguru import logger
import pandas as pd

class DatabaseManager:
    """Manage SQLite database for arbitrage data"""
    
    def __init__(self, db_path: str = "data/arbitrage.db"):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(exist_ok=True)
        
        # Initialize database
        self._init_database()
        
    def _init_database(self):
        """Initialize database tables"""
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            
            # Opportunities table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS opportunities (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    pair TEXT NOT NULL,
                    token0 TEXT,
                    token1 TEXT,
                    buy_dex TEXT,
                    sell_dex TEXT,
                    optimal_amount REAL,
                    gross_profit_usd REAL,
                    gas_cost REAL,
                    net_profit REAL,
                    block_number INTEGER,
                    viability_score REAL,
                    honeypot_risk REAL,
                    executed BOOLEAN DEFAULT FALSE,
                    execution_success BOOLEAN,
                    actual_profit REAL,
                    raw_data TEXT
                )
            """)
            
            # Research data table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS research_data (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    opportunity_id INTEGER,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    token0_data TEXT,
                    token1_data TEXT,
                    liquidity_data TEXT,
                    volume_data TEXT,
                    risk_factors TEXT,
                    raw_research TEXT,
                    FOREIGN KEY (opportunity_id) REFERENCES opportunities (id)
                )
            """)
            
            # Execution history table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS execution_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    opportunity_id INTEGER,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    executed_at DATETIME,
                    success BOOLEAN,
                    actual_profit REAL,
                    gas_used REAL,
                    error_message TEXT,
                    tx_hash TEXT,
                    FOREIGN KEY (opportunity_id) REFERENCES opportunities (id)
                )
            """)
            
            # Model performance table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS model_performance (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    model_type TEXT,
                    accuracy REAL,
                    precision REAL,
                    recall REAL,
                    f1_score REAL,
                    total_predictions INTEGER,
                    correct_predictions INTEGER
                )
            """)
            
            # Create indexes
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_pair ON opportunities (pair)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_timestamp ON opportunities (timestamp)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_net_profit ON opportunities (net_profit)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_viability ON opportunities (viability_score)")
            
            conn.commit()
            
        logger.info(f"Database initialized at {self.db_path}")
    
    async def store_opportunity(self, opportunity: Dict, research: Dict):
        """Store opportunity and research data"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                
                # Insert opportunity
                cursor.execute("""
                    INSERT INTO opportunities (
                        pair, token0, token1, buy_dex, sell_dex,
                        optimal_amount, gross_profit_usd, gas_cost,
                        net_profit, block_number, viability_score,
                        honeypot_risk, raw_data
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    opportunity.get('pair'),
                    opportunity.get('token0'),
                    opportunity.get('token1'),
                    opportunity.get('buy_dex'),
                    opportunity.get('sell_dex'),
                    opportunity.get('optimal_amount'),
                    opportunity.get('gross_profit_usd'),
                    opportunity.get('gas_cost'),
                    opportunity.get('net_profit'),
                    opportunity.get('block'),
                    opportunity.get('viability_score'),
                    opportunity.get('honeypot_risk'),
                    json.dumps(opportunity)
                ))
                
                opportunity_id = cursor.lastrowid
                
                # Insert research data
                cursor.execute("""
                    INSERT INTO research_data (
                        opportunity_id, token0_data, token1_data,
                        liquidity_data, volume_data, risk_factors,
                        raw_research
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (
                    opportunity_id,
                    json.dumps(research.get('tokens', {}).get(opportunity.get('token0'), {})),
                    json.dumps(research.get('tokens', {}).get(opportunity.get('token1'), {})),
                    json.dumps(research.get('liquidity', {})),
                    json.dumps(research.get('volume', {})),
                    json.dumps(research.get('risk_factors', {})),
                    json.dumps(research)
                ))
                
                conn.commit()
                
        except Exception as e:
            logger.error(f"Error storing opportunity: {e}")
    
    async def get_training_data(self, days: int = 7) -> List[Dict]:
        """Get recent data for model training"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                # Get data from last N days
                query = """
                    SELECT 
                        o.*,
                        r.token0_data,
                        r.token1_data,
                        r.risk_factors,
                        e.success as execution_success,
                        e.actual_profit
                    FROM opportunities o
                    LEFT JOIN research_data r ON o.id = r.opportunity_id
                    LEFT JOIN execution_history e ON o.id = e.opportunity_id
                    WHERE o.timestamp > datetime('now', '-{} days')
                    AND o.net_profit > 0
                """.format(days)
                
                df = pd.read_sql_query(query, conn)
                
                # Parse JSON fields
                json_fields = ['raw_data', 'token0_data', 'token1_data', 'risk_factors']
                for field in json_fields:
                    if field in df.columns:
                        df[field] = df[field].apply(
                            lambda x: json.loads(x) if x and x != 'null' else {}
                        )
                
                # Convert to list of dicts
                data = df.to_dict('records')
                
                # Combine opportunity and research data
                processed_data = []
                for row in data:
                    item = {
                        'opportunity': json.loads(row.get('raw_data', '{}')) if isinstance(row.get('raw_data'), str) else row.get('raw_data', {}),
                        'research': {
                            'tokens': {
                                row.get('token0', ''): row.get('token0_data', {}),
                                row.get('token1', ''): row.get('token1_data', {}),
                            },
                            'risk_factors': row.get('risk_factors', {}),
                        },
                        'execution_success': row.get('execution_success', False),
                        'actual_profit': row.get('actual_profit', 0),
                        'net_profit': row.get('net_profit', 0),
                    }
                    processed_data.append(item)
                
                return processed_data
                
        except Exception as e:
            logger.error(f"Error getting training data: {e}")
            return []
    
    async def get_performance_metrics(self) -> Dict:
        """Get system performance metrics"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                
                # Total opportunities
                cursor.execute("SELECT COUNT(*) FROM opportunities")
                total = cursor.fetchone()[0]
                
                # Viable opportunities
                cursor.execute("SELECT COUNT(*) FROM opportunities WHERE viability_score > 0.6")
                viable = cursor.fetchone()[0]
                
                # Honeypots detected
                cursor.execute("SELECT COUNT(*) FROM opportunities WHERE honeypot_risk > 0.7")
                honeypots = cursor.fetchone()[0]
                
                # Average profit
                cursor.execute("SELECT AVG(net_profit) FROM opportunities WHERE net_profit > 0")
                avg_profit = cursor.fetchone()[0] or 0
                
                # Model accuracy
                cursor.execute("""
                    SELECT AVG(accuracy) FROM model_performance 
                    WHERE timestamp > datetime('now', '-1 day')
                """)
                accuracy = cursor.fetchone()[0] or 0
                
                # Execution success rate
                cursor.execute("""
                    SELECT 
                        COUNT(CASE WHEN success = 1 THEN 1 END) * 100.0 / COUNT(*)
                    FROM execution_history
                    WHERE timestamp > datetime('now', '-7 days')
                """)
                success_rate = cursor.fetchone()[0] or 0
                
                return {
                    'total': total,
                    'viable': viable,
                    'honeypots': honeypots,
                    'avg_profit': avg_profit,
                    'accuracy': accuracy / 100 if accuracy else 0,
                    'success_rate': success_rate / 100,
                }
                
        except Exception as e:
            logger.error(f"Error getting performance metrics: {e}")
            return {
                'total': 0,
                'viable': 0,
                'honeypots': 0,
                'avg_profit': 0,
                'accuracy': 0,
                'success_rate': 0,
            }
    
    async def record_execution(self, opportunity_id: int, success: bool, 
                              actual_profit: float, gas_used: float = 0,
                              error_message: str = None, tx_hash: str = None):
        """Record execution result"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                
                cursor.execute("""
                    INSERT INTO execution_history (
                        opportunity_id, executed_at, success,
                        actual_profit, gas_used, error_message, tx_hash
                    ) VALUES (?, datetime('now'), ?, ?, ?, ?, ?)
                """, (
                    opportunity_id, success, actual_profit,
                    gas_used, error_message, tx_hash
                ))
                
                # Update opportunity record
                cursor.execute("""
                    UPDATE opportunities
                    SET executed = TRUE,
                        execution_success = ?,
                        actual_profit = ?
                    WHERE id = ?
                """, (success, actual_profit, opportunity_id))
                
                conn.commit()
                
        except Exception as e:
            logger.error(f"Error recording execution: {e}")
    
    async def cleanup_old_data(self, days: int = 30):
        """Clean up old data to manage database size"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                
                # Delete old unsuccessful opportunities
                cursor.execute("""
                    DELETE FROM opportunities
                    WHERE timestamp < datetime('now', '-{} days')
                    AND viability_score < 0.3
                    AND executed = FALSE
                """.format(days))
                
                deleted = cursor.rowcount
                conn.commit()
                
                logger.info(f"Cleaned up {deleted} old records")
                
        except Exception as e:
            logger.error(f"Error cleaning up data: {e}")
    
    async def close(self):
        """Close database connection"""
        # SQLite connections are closed automatically
        logger.info("Database connection closed")