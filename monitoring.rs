use prometheus::{
    register_counter, register_gauge, register_histogram_vec,
    Counter, Gauge, HistogramVec, Encoder, TextEncoder,
};
use std::sync::Arc;
use tokio::sync::RwLock;
use warp::{Filter, Rejection, Reply};
use chrono::{DateTime, Utc};
use serde::{Serialize, Deserialize};

#[derive(Clone)]
pub struct Metrics {
    // Counters
    pub liquidations_total: Counter,
    pub liquidations_successful: Counter,
    pub liquidations_failed: Counter,
    pub flash_loans_total: Counter,
    pub transactions_total: Counter,
    
    // Gauges
    pub health_factor_min: Gauge,
    pub positions_monitored: Gauge,
    pub gas_price_gwei: Gauge,
    pub profit_usd_total: Gauge,
    pub success_rate: Gauge,
    
    // Histograms
    pub liquidation_profit: HistogramVec,
    pub execution_time: HistogramVec,
    pub gas_used: HistogramVec,
    
    // Custom metrics
    pub daily_stats: Arc<RwLock<DailyStats>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyStats {
    pub date: DateTime<Utc>,
    pub liquidations_count: u64,
    pub total_profit_usd: f64,
    pub total_gas_spent_usd: f64,
    pub success_rate: f64,
    pub largest_liquidation_usd: f64,
    pub failed_attempts: u64,
    pub protocols: HashMap<String, ProtocolStats>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtocolStats {
    pub liquidations: u64,
    pub profit_usd: f64,
    pub avg_health_factor: f64,
}

impl Metrics {
    pub fn new() -> Self {
        let liquidations_total = register_counter!(
            "liquidations_total",
            "Total number of liquidation attempts"
        ).unwrap();
        
        let liquidations_successful = register_counter!(
            "liquidations_successful",
            "Number of successful liquidations"
        ).unwrap();
        
        let liquidations_failed = register_counter!(
            "liquidations_failed",
            "Number of failed liquidations"
        ).unwrap();
        
        let flash_loans_total = register_counter!(
            "flash_loans_total",
            "Total number of flash loans executed"
        ).unwrap();
        
        let transactions_total = register_counter!(
            "transactions_total",
            "Total number of transactions sent"
        ).unwrap();
        
        let health_factor_min = register_gauge!(
            "health_factor_min",
            "Minimum health factor observed"
        ).unwrap();
        
        let positions_monitored = register_gauge!(
            "positions_monitored",
            "Number of positions being monitored"
        ).unwrap();
        
        let gas_price_gwei = register_gauge!(
            "gas_price_gwei",
            "Current gas price in gwei"
        ).unwrap();
        
        let profit_usd_total = register_gauge!(
            "profit_usd_total",
            "Total profit in USD"
        ).unwrap();
        
        let success_rate = register_gauge!(
            "success_rate",
            "Current success rate percentage"
        ).unwrap();
        
        let liquidation_profit = register_histogram_vec!(
            "liquidation_profit",
            "Profit distribution of liquidations",
            &["protocol", "asset"]
        ).unwrap();
        
        let execution_time = register_histogram_vec!(
            "execution_time",
            "Time taken to execute liquidations",
            &["protocol", "step"]
        ).unwrap();
        
        let gas_used = register_histogram_vec!(
            "gas_used",
            "Gas used for liquidations",
            &["protocol"]
        ).unwrap();
        
        Self {
            liquidations_total,
            liquidations_successful,
            liquidations_failed,
            flash_loans_total,
            transactions_total,
            health_factor_min,
            positions_monitored,
            gas_price_gwei,
            profit_usd_total,
            success_rate,
            liquidation_profit,
            execution_time,
            gas_used,
            daily_stats: Arc::new(RwLock::new(DailyStats::new())),
        }
    }
    
    pub async fn record_liquidation(
        &self,
        protocol: &str,
        asset: &str,
        profit: f64,
        gas: u64,
        success: bool,
        execution_time_ms: u64,
    ) {
        self.liquidations_total.inc();
        
        if success {
            self.liquidations_successful.inc();
            self.liquidation_profit
                .with_label_values(&[protocol, asset])
                .observe(profit);
            
            // Update total profit
            let current = self.profit_usd_total.get();
            self.profit_usd_total.set(current + profit);
            
            // Update daily stats
            let mut stats = self.daily_stats.write().await;
            stats.liquidations_count += 1;
            stats.total_profit_usd += profit;
            
            if profit > stats.largest_liquidation_usd {
                stats.largest_liquidation_usd = profit;
            }
            
            // Update protocol stats
            let protocol_stats = stats.protocols.entry(protocol.to_string())
                .or_insert(ProtocolStats {
                    liquidations: 0,
                    profit_usd: 0.0,
                    avg_health_factor: 0.0,
                });
            protocol_stats.liquidations += 1;
            protocol_stats.profit_usd += profit;
        } else {
            self.liquidations_failed.inc();
            
            let mut stats = self.daily_stats.write().await;
            stats.failed_attempts += 1;
        }
        
        // Record gas usage
        self.gas_used
            .with_label_values(&[protocol])
            .observe(gas as f64);
        
        // Record execution time
        self.execution_time
            .with_label_values(&[protocol, "total"])
            .observe(execution_time_ms as f64);
        
        // Update success rate
        let total = self.liquidations_total.get();
        let successful = self.liquidations_successful.get();
        if total > 0.0 {
            self.success_rate.set((successful / total) * 100.0);
        }
    }
    
    pub fn update_gas_price(&self, gwei: f64) {
        self.gas_price_gwei.set(gwei);
    }
    
    pub fn update_positions_count(&self, count: usize) {
        self.positions_monitored.set(count as f64);
    }
    
    pub fn update_min_health_factor(&self, health: f64) {
        let current = self.health_factor_min.get();
        if health < current || current == 0.0 {
            self.health_factor_min.set(health);
        }
    }
    
    pub async fn get_daily_stats(&self) -> DailyStats {
        self.daily_stats.read().await.clone()
    }
    
    pub async fn reset_daily_stats(&self) {
        let mut stats = self.daily_stats.write().await;
        *stats = DailyStats::new();
    }
}

impl DailyStats {
    fn new() -> Self {
        Self {
            date: Utc::now(),
            liquidations_count: 0,
            total_profit_usd: 0.0,
            total_gas_spent_usd: 0.0,
            success_rate: 0.0,
            largest_liquidation_usd: 0.0,
            failed_attempts: 0,
            protocols: HashMap::new(),
        }
    }
}

// HTTP server for Prometheus metrics
pub async fn metrics_server(metrics: Arc<Metrics>) {
    let metrics_route = warp::path!("metrics")
        .and(with_metrics(metrics))
        .and_then(metrics_handler);
    
    let health_route = warp::path!("health")
        .map(|| warp::reply::json(&serde_json::json!({"status": "healthy"})));
    
    let routes = metrics_route.or(health_route);
    
    println!("📊 Metrics server listening on :9091");
    warp::serve(routes)
        .run(([0, 0, 0, 0], 9091))
        .await;
}

fn with_metrics(
    metrics: Arc<Metrics>
) -> impl Filter<Extract = (Arc<Metrics>,), Error = std::convert::Infallible> + Clone {
    warp::any().map(move || metrics.clone())
}

async fn metrics_handler(metrics: Arc<Metrics>) -> Result<impl Reply, Rejection> {
    let encoder = TextEncoder::new();
    let metric_families = prometheus::gather();
    
    let mut buffer = Vec::new();
    encoder.encode(&metric_families, &mut buffer).unwrap();
    
    Ok(warp::reply::with_header(
        buffer,
        "Content-Type",
        encoder.format_type(),
    ))
}

// Alert manager for critical events
pub struct AlertManager {
    telegram_bot: Option<TelegramBot>,
    discord_webhook: Option<String>,
    email_config: Option<EmailConfig>,
    thresholds: AlertThresholds,
}

#[derive(Clone)]
struct TelegramBot {
    token: String,
    chat_id: String,
}

#[derive(Clone)]
struct EmailConfig {
    smtp_server: String,
    from: String,
    to: Vec<String>,
}

#[derive(Clone)]
struct AlertThresholds {
    min_profit_usd: f64,
    max_gas_gwei: f64,
    max_failed_consecutive: u32,
    min_success_rate: f64,
}

impl AlertManager {
    pub fn new() -> Self {
        let telegram_bot = std::env::var("TELEGRAM_BOT_TOKEN").ok()
            .and_then(|token| {
                std::env::var("TELEGRAM_CHAT_ID").ok()
                    .map(|chat_id| TelegramBot { token, chat_id })
            });
        
        let discord_webhook = std::env::var("DISCORD_WEBHOOK").ok();
        
        Self {
            telegram_bot,
            discord_webhook,
            email_config: None,
            thresholds: AlertThresholds {
                min_profit_usd: 30.0,
                max_gas_gwei: 200.0,
                max_failed_consecutive: 5,
                min_success_rate: 80.0,
            },
        }
    }
    
    pub async fn send_alert(&self, level: AlertLevel, message: &str) {
        let formatted = format!(
            "🚨 {} Alert\n{}\nTime: {}",
            level,
            message,
            Utc::now().format("%Y-%m-%d %H:%M:%S UTC")
        );
        
        // Send to Telegram
        if let Some(bot) = &self.telegram_bot {
            self.send_telegram(&bot, &formatted).await;
        }
        
        // Send to Discord
        if let Some(webhook) = &self.discord_webhook {
            self.send_discord(webhook, &formatted).await;
        }
        
        // Log to console
        println!("{}", formatted);
    }
    
    async fn send_telegram(&self, bot: &TelegramBot, message: &str) {
        let url = format!(
            "https://api.telegram.org/bot{}/sendMessage",
            bot.token
        );
        
        let params = serde_json::json!({
            "chat_id": bot.chat_id,
            "text": message,
            "parse_mode": "Markdown"
        });
        
        let _ = reqwest::Client::new()
            .post(&url)
            .json(&params)
            .send()
            .await;
    }
    
    async fn send_discord(&self, webhook: &str, message: &str) {
        let params = serde_json::json!({
            "content": message
        });
        
        let _ = reqwest::Client::new()
            .post(webhook)
            .json(&params)
            .send()
            .await;
    }
    
    pub async fn check_thresholds(&self, metrics: &Metrics) {
        let stats = metrics.get_daily_stats().await;
        
        // Check success rate
        if stats.success_rate < self.thresholds.min_success_rate {
            self.send_alert(
                AlertLevel::Warning,
                &format!("Success rate dropped to {:.1}%", stats.success_rate)
            ).await;
        }
        
        // Check gas price
        let gas = metrics.gas_price_gwei.get();
        if gas > self.thresholds.max_gas_gwei {
            self.send_alert(
                AlertLevel::Warning,
                &format!("Gas price high: {} gwei", gas)
            ).await;
        }
        
        // Check consecutive failures
        if stats.failed_attempts > self.thresholds.max_failed_consecutive as u64 {
            self.send_alert(
                AlertLevel::Critical,
                &format!("Multiple consecutive failures: {}", stats.failed_attempts)
            ).await;
        }
    }
}

#[derive(Debug, Clone)]
enum AlertLevel {
    Info,
    Warning,
    Critical,
}

impl std::fmt::Display for AlertLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AlertLevel::Info => write!(f, "ℹ️ INFO"),
            AlertLevel::Warning => write!(f, "⚠️ WARNING"),
            AlertLevel::Critical => write!(f, "🔴 CRITICAL"),
        }
    }
}

use std::collections::HashMap;