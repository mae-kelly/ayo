import winston from 'winston';
import path from 'path';
import fs from 'fs';

export class Logger {
    private logger: winston.Logger;
    private logDir: string;
    
    constructor() {
        // Create logs directory if it doesn't exist
        this.logDir = path.join(process.cwd(), 'logs');
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
        
        // Configure winston logger
        this.logger = winston.createLogger({
            level: process.env.LOG_LEVEL || 'info',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.errors({ stack: true }),
                winston.format.json()
            ),
            defaultMeta: { service: 'l2-arbitrage-bot' },
            transports: [
                // Console output with colors
                new winston.transports.Console({
                    format: winston.format.combine(
                        winston.format.colorize(),
                        winston.format.simple(),
                        winston.format.printf(({ timestamp, level, message, ...meta }) => {
                            const metaStr = Object.keys(meta).length ? 
                                '\n' + JSON.stringify(meta, null, 2) : '';
                            return `${timestamp} [${level}]: ${message}${metaStr}`;
                        })
                    ),
                }),
                // File output for all logs
                new winston.transports.File({
                    filename: path.join(this.logDir, 'combined.log'),
                    maxsize: 10485760, // 10MB
                    maxFiles: 5,
                }),
                // File output for errors only
                new winston.transports.File({
                    filename: path.join(this.logDir, 'error.log'),
                    level: 'error',
                    maxsize: 10485760, // 10MB
                    maxFiles: 5,
                }),
                // File output for arbitrage executions
                new winston.transports.File({
                    filename: path.join(this.logDir, 'arbitrage.log'),
                    level: 'info',
                    format: winston.format.combine(
                        winston.format.timestamp(),
                        winston.format.json()
                    ),
                }),
            ],
        });
    }
    
    info(message: string, meta?: any) {
        this.logger.info(message, meta);
    }
    
    warn(message: string, meta?: any) {
        this.logger.warn(message, meta);
    }
    
    error(message: string, error?: any) {
        if (error instanceof Error) {
            this.logger.error(message, {
                error: error.message,
                stack: error.stack,
            });
        } else {
            this.logger.error(message, error);
        }
    }
    
    debug(message: string, meta?: any) {
        this.logger.debug(message, meta);
    }
    
    success(message: string, meta?: any) {
        // Custom success level using info with success flag
        this.logger.info(`✅ ${message}`, { ...meta, success: true });
    }
    
    // Log arbitrage opportunity
    logOpportunity(opportunity: any) {
        this.logger.info('Arbitrage opportunity found', {
            type: 'opportunity',
            ...opportunity,
            timestamp: new Date().toISOString(),
        });
    }
    
    // Log execution result
    logExecution(result: any) {
        const level = result.success ? 'info' : 'error';
        this.logger.log(level, 'Arbitrage execution', {
            type: 'execution',
            ...result,
            timestamp: new Date().toISOString(),
        });
    }
    
    // Get recent logs for analysis
    async getRecentLogs(type?: string, limit: number = 100): Promise<any[]> {
        const logFile = path.join(this.logDir, 'arbitrage.log');
        
        if (!fs.existsSync(logFile)) {
            return [];
        }
        
        const content = fs.readFileSync(logFile, 'utf-8');
        const lines = content.split('\n').filter(line => line.trim());
        
        const logs = lines
            .slice(-limit)
            .map(line => {
                try {
                    return JSON.parse(line);
                } catch {
                    return null;
                }
            })
            .filter(log => log !== null);
        
        if (type) {
            return logs.filter(log => log.type === type);
        }
        
        return logs;
    }
    
    // Calculate statistics from logs
    async getStatistics(): Promise<{
        totalOpportunities: number;
        totalExecutions: number;
        successRate: number;
        totalProfit: number;
        averageProfit: number;
    }> {
        const logs = await this.getRecentLogs();
        
        const opportunities = logs.filter(log => log.type === 'opportunity');
        const executions = logs.filter(log => log.type === 'execution');
        const successful = executions.filter(log => log.success);
        
        const totalProfit = successful.reduce((sum, log) => sum + (log.profit || 0), 0);
        
        return {
            totalOpportunities: opportunities.length,
            totalExecutions: executions.length,
            successRate: executions.length > 0 ? 
                (successful.length / executions.length) * 100 : 0,
            totalProfit,
            averageProfit: successful.length > 0 ? 
                totalProfit / successful.length : 0,
        };
    }
}