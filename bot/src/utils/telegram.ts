import TelegramBot from 'node-telegram-bot-api';

export class TelegramNotifier {
    private bot: TelegramBot | null;
    private chatId: string;
    private enabled: boolean;
    
    constructor(token: string, chatId: string) {
        this.chatId = chatId;
        this.enabled = !!(token && chatId);
        
        if (this.enabled) {
            try {
                this.bot = new TelegramBot(token, { polling: false });
                console.log('Telegram notifier initialized');
            } catch (error) {
                console.error('Failed to initialize Telegram bot:', error);
                this.enabled = false;
                this.bot = null;
            }
        } else {
            this.bot = null;
            console.log('Telegram notifier disabled (no token/chatId provided)');
        }
    }
    
    async sendNotification(title: string, message: string, isUrgent: boolean = false): Promise<void> {
        if (!this.enabled || !this.bot) {
            return;
        }
        
        try {
            const emoji = isUrgent ? '🚨' : '📢';
            const formattedMessage = `${emoji} <b>${title}</b>\n\n${message}`;
            
            await this.bot.sendMessage(this.chatId, formattedMessage, {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            });
        } catch (error) {
            console.error('Failed to send Telegram notification:', error);
        }
    }
    
    async sendArbitrageAlert(
        network: string,
        profit: number,
        tokens: string[],
        txHash?: string
    ): Promise<void> {
        const message = `
💰 <b>Arbitrage Opportunity Executed!</b>

📍 Network: ${network}
💵 Profit: $${profit.toFixed(2)}
🔄 Tokens: ${tokens.join(' → ')}
${txHash ? `🔗 TX: <code>${txHash}</code>` : ''}
⏰ Time: ${new Date().toLocaleString()}
        `.trim();
        
        await this.sendNotification('Arbitrage Alert', message, profit > 100);
    }
    
    async sendErrorAlert(error: string, context?: any): Promise<void> {
        const message = `
⚠️ <b>Bot Error</b>

Error: ${error}
${context ? `Context: ${JSON.stringify(context, null, 2)}` : ''}
Time: ${new Date().toLocaleString()}
        `.trim();
        
        await this.sendNotification('Error Alert', message, true);
    }
    
    async sendDailyReport(stats: {
        totalOpportunities: number;
        totalExecutions: number;
        successRate: number;
        totalProfit: number;
        averageProfit: number;
    }): Promise<void> {
        const message = `
📊 <b>Daily Report</b>

📈 Opportunities Found: ${stats.totalOpportunities}
✅ Executions: ${stats.totalExecutions}
📊 Success Rate: ${stats.successRate.toFixed(1)}%
💰 Total Profit: $${stats.totalProfit.toFixed(2)}
💵 Average Profit: $${stats.averageProfit.toFixed(2)}

Generated: ${new Date().toLocaleString()}
        `.trim();
        
        await this.sendNotification('Daily Report', message);
    }
}