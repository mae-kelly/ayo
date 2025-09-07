"""
Terminal scraper for parsing Rust scanner output
"""

import re
from datetime import datetime
from typing import Dict, Optional
from loguru import logger

class TerminalScraper:
    """Parse and extract arbitrage opportunities from terminal output"""
    
    def __init__(self):
        # Regex patterns for parsing
        self.patterns = {
            'opportunity_start': re.compile(r'📊 Opportunity #(\d+)'),
            'token_pair': re.compile(r'Token Pair:\s+(\w+)/(\w+)'),
            'dexes': re.compile(r'Buy from:\s+(\w+)\s+\|\s+Sell to:\s+(\w+)'),
            'optimal_amount': re.compile(r'Optimal Amount:\s+([\d.]+)\s+(\w+)'),
            'gross_profit': re.compile(r'Gross Profit:\s+\$([\d.]+)\s+\((\d+)\s+wei\)'),
            'gas_cost': re.compile(r'Gas Cost:\s+\$([\d.]+)'),
            'net_profit': re.compile(r'NET PROFIT:\s+\$([\d.]+)'),
            'block': re.compile(r'Block:\s+#(\d+)'),
            'flashloan': re.compile(r'Flash Loan Provider:\s+(\w+(?:\s+\w+)*)'),
            'addresses': re.compile(r'0x[a-fA-F0-9]{40}'),
        }
        
        # Buffer for multi-line parsing
        self.buffer = []
        self.current_opportunity = {}
        
    def parse_line(self, line: str) -> Optional[Dict]:
        """Parse a single line of terminal output"""
        line = line.strip()
        
        if not line:
            return None
        
        # Add to buffer
        self.buffer.append(line)
        
        # Check if we're starting a new opportunity
        if self.patterns['opportunity_start'].search(line):
            # Process previous opportunity if exists
            if self.current_opportunity:
                opp = self.current_opportunity.copy()
                self.current_opportunity = {}
                if self._validate_opportunity(opp):
                    return self._enrich_opportunity(opp)
            
            # Start new opportunity
            self.current_opportunity = {
                'timestamp': datetime.now().isoformat(),
                'raw_text': []
            }
        
        # Parse current line into opportunity
        if self.current_opportunity:
            self.current_opportunity['raw_text'].append(line)
            self._extract_fields(line)
        
        # Check if opportunity is complete
        if 'block' in self.current_opportunity and 'net_profit' in self.current_opportunity:
            opp = self.current_opportunity.copy()
            self.current_opportunity = {}
            if self._validate_opportunity(opp):
                return self._enrich_opportunity(opp)
        
        return None
    
    def _extract_fields(self, line: str):
        """Extract fields from a line"""
        # Token pair
        match = self.patterns['token_pair'].search(line)
        if match:
            self.current_opportunity['token0'] = match.group(1)
            self.current_opportunity['token1'] = match.group(2)
            self.current_opportunity['pair'] = f"{match.group(1)}/{match.group(2)}"
        
        # DEXes
        match = self.patterns['dexes'].search(line)
        if match:
            self.current_opportunity['buy_dex'] = match.group(1)
            self.current_opportunity['sell_dex'] = match.group(2)
        
        # Optimal amount
        match = self.patterns['optimal_amount'].search(line)
        if match:
            self.current_opportunity['optimal_amount'] = float(match.group(1))
            self.current_opportunity['amount_token'] = match.group(2)
        
        # Gross profit
        match = self.patterns['gross_profit'].search(line)
        if match:
            self.current_opportunity['gross_profit_usd'] = float(match.group(1))
            self.current_opportunity['gross_profit_wei'] = int(match.group(2))
        
        # Gas cost
        match = self.patterns['gas_cost'].search(line)
        if match:
            self.current_opportunity['gas_cost'] = float(match.group(1))
        
        # Net profit
        match = self.patterns['net_profit'].search(line)
        if match:
            self.current_opportunity['net_profit'] = float(match.group(1))
        
        # Block number
        match = self.patterns['block'].search(line)
        if match:
            self.current_opportunity['block'] = int(match.group(1))
        
        # Flash loan provider
        match = self.patterns['flashloan'].search(line)
        if match:
            self.current_opportunity['flashloan_provider'] = match.group(1)
        
        # Extract addresses
        addresses = self.patterns['addresses'].findall(line)
        if addresses:
            if 'addresses' not in self.current_opportunity:
                self.current_opportunity['addresses'] = []
            self.current_opportunity['addresses'].extend(addresses)
    
    def _validate_opportunity(self, opp: Dict) -> bool:
        """Validate that opportunity has all required fields"""
        required_fields = [
            'pair', 'buy_dex', 'sell_dex', 
            'net_profit', 'block'
        ]
        
        for field in required_fields:
            if field not in opp:
                logger.debug(f"Missing required field: {field}")
                return False
        
        # Validate profit is positive
        if opp['net_profit'] <= 0:
            return False
        
        return True
    
    def _enrich_opportunity(self, opp: Dict) -> Dict:
        """Add calculated fields to opportunity"""
        # Calculate profit ratio
        if 'gross_profit_usd' in opp and opp['gross_profit_usd'] > 0:
            opp['gas_ratio'] = opp.get('gas_cost', 0) / opp['gross_profit_usd']
        else:
            opp['gas_ratio'] = 1.0
        
        # Add DEX type flags
        opp['is_uniswap_v2'] = 'UniswapV2' in opp.get('buy_dex', '') or 'UniswapV2' in opp.get('sell_dex', '')
        opp['is_uniswap_v3'] = 'UniswapV3' in opp.get('buy_dex', '') or 'UniswapV3' in opp.get('sell_dex', '')
        opp['is_sushiswap'] = 'Sushiswap' in opp.get('buy_dex', '') or 'Sushiswap' in opp.get('sell_dex', '')
        
        # Add cross-DEX flag
        opp['is_cross_dex'] = opp.get('buy_dex') != opp.get('sell_dex')
        
        # Clean up raw text
        opp['raw_text'] = '\n'.join(opp.get('raw_text', []))
        
        logger.debug(f"Enriched opportunity: {opp['pair']} - ${opp['net_profit']:.2f}")
        
        return opp
    
    def parse_batch(self, text: str) -> list:
        """Parse a batch of text containing multiple opportunities"""
        opportunities = []
        
        for line in text.split('\n'):
            opp = self.parse_line(line)
            if opp:
                opportunities.append(opp)
        
        # Process any remaining opportunity
        if self.current_opportunity and self._validate_opportunity(self.current_opportunity):
            opportunities.append(self._enrich_opportunity(self.current_opportunity))
            self.current_opportunity = {}
        
        return opportunities