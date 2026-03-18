import express from 'express';
import dotenv from 'dotenv';
import TelegramBotAPI from './telegramBotAPI.js';
import { htmlContent } from './constants.js';
import { splitEmojis } from './helper.js';
import { onUpdate, initBotCommands, initDB } from './bot-handler.js';

dotenv.config();

const app = express();
app.use(express.json());

const botToken = process.env.BOT_TOKEN;
const botUsername = process.env.BOT_USERNAME ? process.env.BOT_USERNAME.replace('@', '') : '';
const Reactions = splitEmojis(process.env.EMOJI_LIST);
const AdminId = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID) : null;

const botApi = new TelegramBotAPI(botToken);

let lastUpdateId = 0;

const startApp = async () => {
    // Database Initialize karein
    await initDB(process.env.MONGODB_URI, AdminId, botApi);
    
    // Har start par commands initialize karein
    initBotCommands(botApi, AdminId).catch(err => console.error("Commands init failed:", err.message));

    console.log('🤖 Bot starting in Polling mode...');
    // Webhook delete karna zaroori hai polling start karne se pehle
    fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook`).catch(() => {});
    
    startPolling();
};

const startPolling = async () => {
    try {
        const response = await botApi.getUpdates(lastUpdateId + 1);
        if (response && response.ok && response.result.length > 0) {
            for (const update of response.result) {
                lastUpdateId = update.update_id;
                await onUpdate(update, botApi, Reactions, botUsername, AdminId);
            }
        }
    } catch (error) {
        if (error.message && error.message.includes('Unauthorized')) {
            console.error('🚨 CRITICAL ERROR: Bot Token is INVALID or REVOKED! Polling stopped to prevent spam. Please check your BOT_TOKEN in Render Environment Variables.');
            return; // Stop the infinite loop
        }
        // Polling errors ko chupchap ignore karo taaki app crash na ho
    }
    
    // Turant agla check shuru karo bina kisi delay ke (Long Polling)
    setTimeout(startPolling, 100);
};

startApp();

app.post('/', async (req, res) => {
    const data = req.body;
    try {
        await onUpdate(data, botApi, Reactions, botUsername, AdminId);
        res.status(200).send('Ok');
    } catch (error) {
        console.error('Error in onUpdate:', error.message);
        res.status(200).send('Ok');
    }
});

app.get('/', (req, res) => {
    res.send(htmlContent);
});

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV || 'development',
        botConfigured: !!botToken && !!botUsername
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});