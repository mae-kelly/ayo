#!/bin/bash

# ML-Enhanced Arbitrage Scanner Runner Script
# Runs the Python ML system that monitors the Rust scanner

echo "=========================================="
echo "ML-Enhanced Arbitrage Scanner"
echo "=========================================="

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo "Error: Python 3 is not installed"
    exit 1
fi

# Check if Rust is installed
if ! command -v cargo &> /dev/null; then
    echo "Error: Rust/Cargo is not installed"
    exit 1
fi

# Create necessary directories
mkdir -p logs
mkdir -p data
mkdir -p models

# Install Python dependencies if needed
if [ ! -d "venv" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv venv
fi

# Activate virtual environment
source venv/bin/activate

# Install requirements
echo "Installing Python dependencies..."
pip install -q --upgrade pip
pip install -q -r requirements.txt

# Check if .env file exists
if [ ! -f "../.env" ]; then
    echo "Error: ../.env file not found"
    echo "Please copy ../.env.example to ../.env and add your API keys"
    exit 1
fi

# Export environment for M1 optimization
export PYTORCH_ENABLE_MPS_FALLBACK=1
export TF_CPP_MIN_LOG_LEVEL=2

# Clear old logs
find logs -name "*.log" -mtime +7 -delete

echo ""
echo "Starting ML Scanner System..."
echo "This will:"
echo "1. Start the Rust arbitrage scanner"
echo "2. Monitor its output for opportunities"
echo "3. Research each token pair"
echo "4. Check for honeypots"
echo "5. Use ML to predict viability"
echo "6. Display only profitable, safe opportunities"
echo ""
echo "Press Ctrl+C to stop"
echo "=========================================="

# Run the ML scanner
python3 ml_scanner.py

# Deactivate virtual environment on exit
deactivate