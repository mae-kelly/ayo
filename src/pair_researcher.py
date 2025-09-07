"""
Research module for analyzing token pairs
"""

import asyncio
import aiohttp
from web3 import Web3
from typing import Dict, List, Optional
from datetime import datetime, timedelta
from loguru import logger
import json

class PairResearcher:
    """Research token pairs for viability and risk assessment"""
    
    def __init__(self):
        # Initialize Web3
        self.w3 = Web3(Web3.HTTPProvider('https://eth.llamarpc.com'))
        
        # API endpoints
        self.apis = {
            'coingecko': 'https://api.coingecko.com/api/v3',
            'etherscan': 'https://api.etherscan.io/api',
            'dexscreener': 'https://api.dexscreener.com/latest/dex',
            'honeypot': 'https://api.honeypot.is/v2',
        }
        
        # Cache for API results
        self.cache = {}
        self.cache_duration = 3600  # 1 hour
        
    async def research_pair(self, opportunity: Dict) -> Dict:
        """Comprehensive research on a token pair"""
        research = {
            'timestamp': datetime.now().isoformat(),
            'pair': opportunity['pair'],
            'tokens': {},
            'liquidity': {},
            'volume': {},
            'price_history': {},
            'risk_factors': {},
            'social_metrics': {},
        }
        
        # Extract token addresses if available
        addresses = opportunity.get('addresses', [])
        
        # Research each token
        tokens = [opportunity.get('token0'), opportunity.get('token1')]
        
        tasks = []
        for i, token in enumerate(tokens):
            if token:
                tasks.append(self._research_token(token, addresses[i] if i < len(addresses) else None))
        
        if tasks:
            token_data = await asyncio.gather(*tasks, return_exceptions=True)
            for i, data in enumerate(token_data):
                if not isinstance(data, Exception):
                    research['tokens'][tokens[i]] = data
        
        # Research pair-specific metrics
        research['liquidity'] = await self._get_liquidity_data(opportunity)
        research['volume'] = await self._get_volume_data(opportunity)
        research['price_history'] = await self._get_price_history(opportunity)
        research['risk_factors'] = await self._analyze_risks(opportunity, research)
        
        return research
    
    async def _research_token(self, symbol: str, address: Optional[str]) -> Dict:
        """Research individual token"""
        token_data = {
            'symbol': symbol,
            'address': address,
            'contract_verified': False,
            'age_days': 0,
            'holder_count': 0,
            'market_cap': 0,
            'liquidity_usd': 0,
            'volume_24h': 0,
            'price_change_24h': 0,
            'is_honeypot': False,
            'tax_buy': 0,
            'tax_sell': 0,
            'can_take_back_ownership': False,
            'is_open_source': False,
        }
        
        try:
            # Get contract info if address available
            if address:
                contract_data = await self._get_contract_info(address)
                token_data.update(contract_data)
            
            # Get market data
            market_data = await self._get_market_data(symbol, address)
            token_data.update(market_data)
            
            # Check honeypot status
            if address:
                honeypot_data = await self._check_honeypot(address)
                token_data.update(honeypot_data)
            
        except Exception as e:
            logger.error(f"Error researching token {symbol}: {e}")
        
        return token_data
    
    async def _get_contract_info(self, address: str) -> Dict:
        """Get contract information from Etherscan"""
        cache_key = f"contract_{address}"
        
        # Check cache
        if cache_key in self.cache:
            cache_time, data = self.cache[cache_key]
            if datetime.now() - cache_time < timedelta(seconds=self.cache_duration):
                return data
        
        data = {
            'contract_verified': False,
            'is_open_source': False,
            'age_days': 0,
        }
        
        try:
            async with aiohttp.ClientSession() as session:
                # Get contract source code
                url = f"{self.apis['etherscan']}?module=contract&action=getsourcecode&address={address}"
                async with session.get(url) as response:
                    if response.status == 200:
                        result = await response.json()
                        if result['status'] == '1' and result['result']:
                            source = result['result'][0]
                            data['contract_verified'] = source.get('SourceCode', '') != ''
                            data['is_open_source'] = data['contract_verified']
                
                # Get contract creation date
                url = f"{self.apis['etherscan']}?module=account&action=txlist&address={address}&startblock=0&endblock=99999999&page=1&offset=1&sort=asc"
                async with session.get(url) as response:
                    if response.status == 200:
                        result = await response.json()
                        if result['status'] == '1' and result['result']:
                            timestamp = int(result['result'][0].get('timeStamp', 0))
                            if timestamp:
                                creation_date = datetime.fromtimestamp(timestamp)
                                data['age_days'] = (datetime.now() - creation_date).days
        
        except Exception as e:
            logger.error(f"Error getting contract info: {e}")
        
        # Cache result
        self.cache[cache_key] = (datetime.now(), data)
        
        return data
    
    async def _get_market_data(self, symbol: str, address: Optional[str]) -> Dict:
        """Get market data from DexScreener"""
        data = {
            'market_cap': 0,
            'liquidity_usd': 0,
            'volume_24h': 0,
            'price_change_24h': 0,
            'holder_count': 0,
        }
        
        try:
            async with aiohttp.ClientSession() as session:
                # Try to get data by address first
                if address:
                    url = f"{self.apis['dexscreener']}/tokens/{address}"
                else:
                    url = f"{self.apis['dexscreener']}/search?q={symbol}"
                
                async with session.get(url) as response:
                    if response.status == 200:
                        result = await response.json()
                        
                        # Parse DexScreener response
                        if 'pairs' in result and result['pairs']:
                            pair = result['pairs'][0]  # Take most liquid pair
                            data['liquidity_usd'] = float(pair.get('liquidity', {}).get('usd', 0))
                            data['volume_24h'] = float(pair.get('volume', {}).get('h24', 0))
                            data['price_change_24h'] = float(pair.get('priceChange', {}).get('h24', 0))
                            
                            # Estimate market cap
                            if 'fdv' in pair:
                                data['market_cap'] = float(pair['fdv'])
        
        except Exception as e:
            logger.error(f"Error getting market data: {e}")
        
        return data
    
    async def _check_honeypot(self, address: str) -> Dict:
        """Check if token is a honeypot"""
        data = {
            'is_honeypot': False,
            'tax_buy': 0,
            'tax_sell': 0,
            'can_take_back_ownership': False,
        }
        
        try:
            async with aiohttp.ClientSession() as session:
                url = f"{self.apis['honeypot']}/honeypot/{address}"
                async with session.get(url) as response:
                    if response.status == 200:
                        result = await response.json()
                        
                        data['is_honeypot'] = result.get('honeypot', False)
                        data['tax_buy'] = float(result.get('buy_tax', 0))
                        data['tax_sell'] = float(result.get('sell_tax', 0))
                        data['can_take_back_ownership'] = result.get('can_take_back_ownership', False)
        
        except Exception as e:
            logger.debug(f"Honeypot check failed for {address}: {e}")
            # Default to cautious approach
            data['is_honeypot'] = True
        
        return data
    
    async def _get_liquidity_data(self, opportunity: Dict) -> Dict:
        """Get liquidity data for the pair"""
        return {
            'total_liquidity': 0,  # Would need DEX-specific API calls
            'buy_dex_liquidity': 0,
            'sell_dex_liquidity': 0,
            'liquidity_ratio': 1.0,
        }
    
    async def _get_volume_data(self, opportunity: Dict) -> Dict:
        """Get trading volume data"""
        return {
            'volume_24h': 0,
            'volume_7d': 0,
            'tx_count_24h': 0,
            'unique_traders_24h': 0,
        }
    
    async def _get_price_history(self, opportunity: Dict) -> Dict:
        """Get historical price data"""
        return {
            'price_1h_ago': 0,
            'price_24h_ago': 0,
            'price_7d_ago': 0,
            'volatility_24h': 0,
            'price_impact_2_percent': 0,
        }
    
    async def _analyze_risks(self, opportunity: Dict, research: Dict) -> Dict:
        """Analyze risk factors"""
        risks = {
            'honeypot_risk': 0.0,
            'liquidity_risk': 0.0,
            'volatility_risk': 0.0,
            'contract_risk': 0.0,
            'overall_risk': 0.0,
        }
        
        # Calculate honeypot risk
        for token_data in research['tokens'].values():
            if token_data.get('is_honeypot'):
                risks['honeypot_risk'] = 1.0
                break
            if token_data.get('tax_sell', 0) > 10:
                risks['honeypot_risk'] = max(risks['honeypot_risk'], 0.8)
            if token_data.get('can_take_back_ownership'):
                risks['honeypot_risk'] = max(risks['honeypot_risk'], 0.6)
        
        # Calculate liquidity risk
        for token_data in research['tokens'].values():
            if token_data.get('liquidity_usd', 0) < 50000:
                risks['liquidity_risk'] = max(risks['liquidity_risk'], 0.8)
            elif token_data.get('liquidity_usd', 0) < 100000:
                risks['liquidity_risk'] = max(risks['liquidity_risk'], 0.5)
        
        # Calculate contract risk
        for token_data in research['tokens'].values():
            if not token_data.get('contract_verified'):
                risks['contract_risk'] = max(risks['contract_risk'], 0.7)
            if token_data.get('age_days', 0) < 7:
                risks['contract_risk'] = max(risks['contract_risk'], 0.6)
            if token_data.get('holder_count', 0) < 100:
                risks['contract_risk'] = max(risks['contract_risk'], 0.5)
        
        # Calculate overall risk
        risks['overall_risk'] = max(
            risks['honeypot_risk'],
            risks['liquidity_risk'] * 0.8,
            risks['contract_risk'] * 0.7,
            risks['volatility_risk'] * 0.5
        )
        
        return risks