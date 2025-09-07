#!/usr/bin/env python3
"""
ML-Enhanced Arbitrage Scanner
Monitors Rust scanner output, researches pairs, and trains ML model for viability prediction
"""

import os
import sys
import asyncio
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from loguru import logger

# Configure logger
logger.add("logs/ml_scanner_{time}.log", rotation="100 MB", retention="7 days")

# Import modules
from src.terminal_scraper import TerminalScraper
from src.pair_researcher import PairResearcher
from src.ml_trainer import ArbitrageMLTrainer
from src.honeypot_detector import HoneypotDetector
from src.database_manager import DatabaseManager
from src.execution_predictor import ExecutionPredictor

class MLArbitrageSystem:
    """Main ML system for arbitrage opportunity analysis"""
    
    def __init__(self):
        logger.info("Initializing ML Arbitrage System...")
        
        # Initialize components
        self.db = DatabaseManager()
        self.scraper = TerminalScraper()
        self.researcher = PairResearcher()
        self.ml_trainer = ArbitrageMLTrainer()
        self.honeypot_detector = HoneypotDetector()
        self.execution_predictor = ExecutionPredictor()
        
        # System state
        self.is_running = False
        self.rust_process = None
        self.opportunities_queue = asyncio.Queue()
        
        # Load existing ML model if available
        self.load_models()
        
    def load_models(self):
        """Load pre-trained models if they exist"""
        try:
            self.ml_trainer.load_model()
            self.honeypot_detector.load_model()
            logger.success("Loaded existing ML models")
        except Exception as e:
            logger.warning(f"No existing models found, will train new ones: {e}")
    
    async def start(self):
        """Start the ML-enhanced arbitrage system"""
        self.is_running = True
        logger.info("Starting ML Arbitrage System...")
        
        # Start Rust scanner in subprocess
        await self.start_rust_scanner()
        
        # Start async tasks
        tasks = [
            asyncio.create_task(self.scrape_terminal()),
            asyncio.create_task(self.process_opportunities()),
            asyncio.create_task(self.train_models_periodically()),
            asyncio.create_task(self.monitor_performance()),
        ]
        
        try:
            await asyncio.gather(*tasks)
        except KeyboardInterrupt:
            logger.info("Shutting down...")
            await self.shutdown()
    
    async def start_rust_scanner(self):
        """Start the Rust arbitrage scanner subprocess"""
        try:
            logger.info("Starting Rust scanner subprocess...")
            
            # Build the Rust project if needed
            build_result = subprocess.run(
                ["cargo", "build", "--release"],
                cwd="../",  # Assuming Python is in a subdirectory
                capture_output=True,
                text=True
            )
            
            if build_result.returncode != 0:
                logger.error(f"Failed to build Rust project: {build_result.stderr}")
                return
            
            # Start the scanner
            self.rust_process = subprocess.Popen(
                ["cargo", "run", "--release"],
                cwd="../",
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                universal_newlines=True
            )
            
            logger.success("Rust scanner started successfully")
            
        except Exception as e:
            logger.error(f"Failed to start Rust scanner: {e}")
            raise
    
    async def scrape_terminal(self):
        """Continuously scrape terminal output from Rust scanner"""
        while self.is_running:
            try:
                if self.rust_process and self.rust_process.stdout:
                    line = self.rust_process.stdout.readline()
                    if line:
                        # Parse opportunity from terminal output
                        opportunity = self.scraper.parse_line(line)
                        if opportunity:
                            await self.opportunities_queue.put(opportunity)
                            logger.debug(f"Found opportunity: {opportunity['pair']}")
                
                await asyncio.sleep(0.1)
                
            except Exception as e:
                logger.error(f"Error scraping terminal: {e}")
                await asyncio.sleep(1)
    
    async def process_opportunities(self):
        """Process scraped opportunities through ML pipeline"""
        while self.is_running:
            try:
                # Get opportunity from queue
                opportunity = await self.opportunities_queue.get()
                
                # Research the pair
                logger.info(f"Researching pair: {opportunity['pair']}")
                research_data = await self.researcher.research_pair(opportunity)
                
                # Check for honeypot
                honeypot_risk = self.honeypot_detector.check_honeypot(
                    opportunity, 
                    research_data
                )
                
                if honeypot_risk > 0.7:
                    logger.warning(f"High honeypot risk for {opportunity['pair']}: {honeypot_risk:.2f}")
                    opportunity['honeypot_risk'] = honeypot_risk
                    opportunity['viable'] = False
                else:
                    # Predict execution viability
                    viability = self.execution_predictor.predict_viability(
                        opportunity,
                        research_data
                    )
                    
                    opportunity['viability_score'] = viability
                    opportunity['viable'] = viability > 0.6
                    
                    if opportunity['viable']:
                        logger.success(
                            f"✅ VIABLE: {opportunity['pair']} - "
                            f"Profit: ${opportunity['net_profit']:.2f} - "
                            f"Viability: {viability:.2%}"
                        )
                        self.display_opportunity(opportunity)
                    else:
                        logger.info(
                            f"❌ Not viable: {opportunity['pair']} - "
                            f"Viability: {viability:.2%}"
                        )
                
                # Store in database for training
                await self.db.store_opportunity(opportunity, research_data)
                
            except asyncio.QueueEmpty:
                await asyncio.sleep(0.5)
            except Exception as e:
                logger.error(f"Error processing opportunity: {e}")
                await asyncio.sleep(1)
    
    async def train_models_periodically(self):
        """Periodically retrain ML models with new data"""
        while self.is_running:
            try:
                # Train every hour
                await asyncio.sleep(3600)
                
                logger.info("Starting periodic model training...")
                
                # Get training data from database
                training_data = await self.db.get_training_data()
                
                if len(training_data) > 100:  # Need minimum data
                    # Train arbitrage viability model
                    self.ml_trainer.train(training_data)
                    
                    # Train honeypot detection model
                    self.honeypot_detector.train(training_data)
                    
                    logger.success("Models retrained successfully")
                else:
                    logger.info("Not enough data for training yet")
                
            except Exception as e:
                logger.error(f"Error in model training: {e}")
    
    async def monitor_performance(self):
        """Monitor system performance and accuracy"""
        while self.is_running:
            try:
                await asyncio.sleep(300)  # Every 5 minutes
                
                # Get performance metrics
                metrics = await self.db.get_performance_metrics()
                
                logger.info(
                    f"📊 Performance Metrics:\n"
                    f"  Total Opportunities: {metrics['total']}\n"
                    f"  Viable: {metrics['viable']}\n"
                    f"  Honeypots Detected: {metrics['honeypots']}\n"
                    f"  Model Accuracy: {metrics['accuracy']:.2%}\n"
                    f"  Avg Profit: ${metrics['avg_profit']:.2f}"
                )
                
            except Exception as e:
                logger.error(f"Error monitoring performance: {e}")
    
    def display_opportunity(self, opportunity):
        """Display viable opportunity with ML insights"""
        print("\n" + "="*80)
        print("🤖 ML-VERIFIED ARBITRAGE OPPORTUNITY")
        print("="*80)
        print(f"Pair: {opportunity['pair']}")
        print(f"DEXs: {opportunity['buy_dex']} → {opportunity['sell_dex']}")
        print(f"Net Profit: ${opportunity['net_profit']:.2f}")
        print(f"Viability Score: {opportunity['viability_score']:.2%}")
        print(f"Honeypot Risk: {opportunity.get('honeypot_risk', 0):.2%}")
        print(f"Recommended: {'✅ EXECUTE' if opportunity['viable'] else '❌ SKIP'}")
        print("="*80 + "\n")
    
    async def shutdown(self):
        """Gracefully shutdown the system"""
        logger.info("Shutting down ML Arbitrage System...")
        self.is_running = False
        
        # Save models
        self.ml_trainer.save_model()
        self.honeypot_detector.save_model()
        
        # Terminate Rust process
        if self.rust_process:
            self.rust_process.terminate()
            self.rust_process.wait()
        
        # Close database
        await self.db.close()
        
        logger.success("Shutdown complete")

async def main():
    """Main entry point"""
    system = MLArbitrageSystem()
    
    try:
        await system.start()
    except KeyboardInterrupt:
        logger.info("Received interrupt signal")
    finally:
        await system.shutdown()

if __name__ == "__main__":
    # Set up environment
    os.environ['TF_CPP_MIN_LOG_LEVEL'] = '2'  # Reduce TensorFlow verbosity
    
    # Run the system
    asyncio.run(main())