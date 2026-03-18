import { startMessage, donateMessage } from './constants.js';
import { getRandomPositiveReaction, splitEmojis } from './helper.js';
import { MongoClient } from 'mongodb';
import fs from 'fs';
import path from 'path';

// Memory aur DB me chats aur states yaad rakhne ke liye
let activeChats = new Set();
let additionalAdmins = new Set(); // Naye admins ka data
let bannedChats = new Set(); // Ban kiye gaye groups/channels ka data
let customReactions = []; // Admin duara set kiye gaye custom reactions
const adminStates = new Map(); // Multiple admins ke state track karne ke liye

let dbClient;
let dbCollection;
let databaseInstance;

export async function initDB(uri, AdminId, botApi) {
    if (!uri) {
        console.error("⚠️ MONGODB_URI is not defined in .env! Database will not be saved.");
        return;
    }
    try {
        dbClient = new MongoClient(uri);
        await dbClient.connect();
        databaseInstance = dbClient.db('reaction_bot');
        dbCollection = databaseInstance.collection('bot_data');
        
        // Database se purana data load karna
        const data = await dbCollection.findOne({ _id: 'global_data' });
        if (data) {
            if (data.activeChats) activeChats = new Set(data.activeChats);
            if (data.additionalAdmins) additionalAdmins = new Set(data.additionalAdmins);
            if (data.bannedChats) bannedChats = new Set(data.bannedChats);
            if (data.customReactions) customReactions = data.customReactions;
        } else {
            // Naya Database hone par: Local database.json check karo aur MongoDB me migrate (transfer) kar do
            const DB_FILE = path.join(process.cwd(), 'database.json');
            if (fs.existsSync(DB_FILE)) {
                console.log("📦 Migrating local database.json to MongoDB...");
                try {
                    const localData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
                    if (localData.activeChats) activeChats = new Set(localData.activeChats);
                    if (localData.additionalAdmins) additionalAdmins = new Set(localData.additionalAdmins);
                    if (localData.bannedChats) bannedChats = new Set(localData.bannedChats);
                    if (localData.customReactions) customReactions = localData.customReactions;
                    
                    saveDatabase(); // MongoDB me data save kar do
                    console.log("✅ Migration complete! Data has been transferred to MongoDB.");
                } catch (e) {
                    console.error("Migration Error:", e);
                }
            }
        }
        console.log("✅ MongoDB Connected and Data Loaded!");

        // Storage check setup (Har 24 Ghante mein check karega)
        setInterval(() => checkStorageAlert(botApi, AdminId), 24 * 60 * 60 * 1000);
        // Ek check bot start hone ke 10 second baad
        setTimeout(() => checkStorageAlert(botApi, AdminId), 10000);

    } catch (e) {
        console.error("❌ MongoDB Connection Error:", e);
    }
}

async function checkStorageAlert(botApi, AdminId) {
    if (!databaseInstance || !AdminId) return;
    try {
        const stats = await databaseInstance.command({ dbStats: 1 });
        const storageSizeMB = stats.storageSize / (1024 * 1024);
        // MongoDB Atlas Free Tier ki limit 512MB hoti hai. Hum 450MB par alert bhejenge.
        if (storageSizeMB > 450) {
            await botApi.sendMessage(AdminId, `⚠️ *DATABASE STORAGE ALERT*\n\nYour MongoDB storage is getting full!\nCurrent Size: \`${storageSizeMB.toFixed(2)} MB\` / 512 MB.\n\nPlease clean up or upgrade your database.`).catch(()=>{});
        }
    } catch (e) {
        console.error("Storage check error:", e.message);
    }
}

// Database me data save karna (Async/Background)
function saveDatabase() {
    if (!dbCollection) return;
    dbCollection.updateOne(
        { _id: 'global_data' },
        { $set: {
            activeChats: Array.from(activeChats),
            additionalAdmins: Array.from(additionalAdmins),
            bannedChats: Array.from(bannedChats),
            customReactions: customReactions
        }},
        { upsert: true }
    ).catch(err => console.error("DB Save Error:", err));
}

/**
 * Auto-healing Reaction Sender
 * Invalid reactions ko automatically detect karke delete kar dega.
 */
async function applyReaction(botApi, chatId, message_id, activeReactions, defaultReactions, AdminId) {
    let attempts = 0;
    let maxAttempts = activeReactions.length + 5; 
    
    while (attempts < maxAttempts && activeReactions.length > 0) {
        const emoji = getRandomPositiveReaction(activeReactions);
        if (!emoji) break;

        try {
            await botApi.setMessageReaction(chatId, message_id, emoji);
            break; // Kamyabi se react ho gaya
        } catch (error) {
            // Agar Telegram bole ki emoji support nahi karta (REACTION_INVALID)
            if (error.message && error.message.includes('REACTION_INVALID')) {
                if (customReactions.length === 0) {
                    customReactions = defaultReactions.filter(e => e !== emoji);
                } else {
                    customReactions = customReactions.filter(e => e !== emoji);
                }

                // Agar galti se saare emojis delete ho jayein, toh safe defaults daal do
                if (customReactions.length === 0) {
                    customReactions = ['👍', '❤️', '🔥'];
                }

                saveDatabase(); // Hamesha ke liye DB me save kardo (invalid emoji hat gaya)
                
                activeReactions = activeReactions.filter(e => e !== emoji);
                if (activeReactions.length === 0) {
                    activeReactions = [...customReactions];
                }

                // Admin ko turant message bhej kar batao ki emoji delete ho gaya hai
                if (AdminId) {
                    await botApi.sendMessage(AdminId, `⚠️ *Auto-Correction:*\n\nThe bot detected that the emoji [ ${emoji} ] is not supported by Telegram reactions.\nTherefore, this emoji has been permanently **removed** from the reaction list.`).catch(()=>{});
                }
                attempts++;
            } else {
                break; // Message deleted ya koi aur error hone par chhod do
            }
        }
    }
}

/**
 * Setup Left Side Menu Commands (Pin)
 * Normal users ke liye default commands, aur admins ke liye extra /admin command
 */
export async function initBotCommands(botApi, AdminId) {
    const defaultCommands = [
        { command: 'start', description: 'Start the bot' },
        { command: 'reactions', description: 'View available reactions' },
        { command: 'donate', description: 'Support the bot' }
    ];

    const adminCommands = [
        ...defaultCommands,
        { command: 'admin', description: 'Advanced Admin Panel' }
    ];

    // 1. Set default commands for everyone
    await botApi.setMyCommands(defaultCommands).catch(() => {});

    // 2. Set admin commands specifically for Main Admin
    if (AdminId) {
        await botApi.setMyCommands(adminCommands, { type: 'chat', chat_id: AdminId }).catch(() => {});
    }

    // 3. Set admin commands for all Additional Admins
    for (const admin of additionalAdmins) {
        await botApi.setMyCommands(adminCommands, { type: 'chat', chat_id: admin }).catch(() => {});
    }
}

/**
 * Handle incoming Telegram Update
 * https://core.telegram.org/bots/api#update
 *
 * @param {Object} data - Telegram update object
 * @param {Object} botApi - TelegramBotAPI instance
 * @param {Array} Reactions - Array of emoji reactions
 * @param {string} botUsername - Bot username
 * @param {number} AdminId - Admin's user ID
 */
export async function onUpdate(data, botApi, Reactions, botUsername, AdminId) {
    
    // 1. Agar kisi ne Button click kiya (Callback Query)
    if (data.callback_query) {
        const callbackQuery = data.callback_query;
        const senderId = callbackQuery.from.id;
        const chatId = callbackQuery.message.chat.id;

        const isAdmin = senderId === AdminId || additionalAdmins.has(senderId);

        await botApi.answerCallbackQuery(callbackQuery.id); // Button ka loading stop karo

        if (isAdmin) {
            if (callbackQuery.data === 'admin_promo') {
                adminStates.set(senderId, 'WAITING_PROMO');
                await botApi.sendMessage(chatId, "📢 *Promotion Mode ON*\n\nNow send me your Promotion Message (Text, Photo, Video, or Link), and I will broadcast it everywhere.\n\n_(Type /cancel to cancel)_");
            } else if (callbackQuery.data === 'admin_add') {
                adminStates.set(senderId, 'WAITING_PASS_ADD');
                await botApi.sendMessage(chatId, "🔒 *Security Check*\n\nPlease send the password to add a new admin:\n\n_(Type /cancel to cancel)_");
            } else if (callbackQuery.data === 'admin_remove') {
                adminStates.set(senderId, 'WAITING_PASS_REMOVE');
                await botApi.sendMessage(chatId, "🔒 *Security Check*\n\nPlease send the password to remove an admin:\n\n_(Type /cancel to cancel)_");
            } else if (callbackQuery.data === 'admin_ban') {
                adminStates.set(senderId, 'WAITING_BAN_CHAT');
                await botApi.sendMessage(chatId, "🚫 *Ban Chat/Channel*\n\nSend the Chat ID or Username you want to ban (e.g., -100123456789 or @mychannel).\n\n_(Type /cancel to cancel)_");
            } else if (callbackQuery.data === 'admin_unban') {
                adminStates.set(senderId, 'WAITING_UNBAN_CHAT');
                await botApi.sendMessage(chatId, "✅ *Unban Chat/Channel*\n\nSend the Chat ID or Username you want to unban.\n\n_(Type /cancel to cancel)_");
            } else if (callbackQuery.data === 'admin_add_reaction') {
                adminStates.set(senderId, 'WAITING_ADD_REACTION');
                await botApi.sendMessage(chatId, "➕ *Add Reaction*\n\nSend one or more emojis that you want to add to the bot's reactions.\n\n_(Type /cancel to cancel)_");
            } else if (callbackQuery.data === 'admin_remove_reaction') {
                adminStates.set(senderId, 'WAITING_REMOVE_REACTION');
                await botApi.sendMessage(chatId, "➖ *Remove Reaction*\n\nSend the emoji you want to remove.\n\n_(Type /cancel to cancel)_");
            } else if (callbackQuery.data === 'admin_list') {
                let adminListMsg = `📋 *Active Admins List*\n\n👑 *Primary Admin:*\n\`${AdminId || 'Not Set'}\`\n\n👮 *Additional Admins:*\n`;
                if (additionalAdmins.size > 0) {
                    Array.from(additionalAdmins).forEach((id, index) => {
                        adminListMsg += `${index + 1}. \`${id}\`\n`;
                    });
                } else {
                    adminListMsg += "_None_\n";
                }
                await botApi.sendMessage(chatId, adminListMsg);
            }
        }
        return;
    }

    let chatId, message_id, text;

    if (data.message || data.channel_post) {
        // Custom reactions use karein (agar setup hain), warna .env wale default reactions
        let activeReactions = customReactions.length > 0 ? customReactions : Reactions;

        const content = data.message || data.channel_post;
        chatId = content.chat.id;
        message_id = content.message_id;
        text = content.text;
        const senderId = content.from ? content.from.id : null;

        const isAdmin = senderId ? (senderId === AdminId || additionalAdmins.has(senderId)) : false;
        const currentState = senderId ? adminStates.get(senderId) : null;

        // Banned chat check (Groups/Channels)
        const chatUsername = content.chat.username ? '@' + content.chat.username.toLowerCase() : null;
        if ((bannedChats.has(chatId) || (chatUsername && bannedChats.has(chatUsername))) && ["group", "supergroup", "channel"].includes(content.chat.type)) {
            if (activeChats.has(chatId)) {
                activeChats.delete(chatId); // Remove from active list just in case
                saveDatabase();
            }
            return; // Agar chat banned hai (ID ya Username se), toh bot chupchap ignore kar dega
        }

        // Bot jis bhi group ya user ke saath add hai, usko yaad rakho (Sirf Admins ki private chat ko chhod kar)
        if (chatId && !activeChats.has(chatId)) {
            if (!(content.chat.type === "private" && isAdmin)) {
                activeChats.add(chatId);
                saveDatabase();
            }
        }

        if (data.message && (text === '/start' || text === '/start@' + botUsername)) {
            await botApi.sendMessage(chatId, startMessage.replace('UserName', content.chat.type === "private" ? content.from.first_name : content.chat.title), [
                [
                    { "text": "➕ Add to Channel ➕", "url": `https://t.me/${botUsername}?startchannel=true&admin=post_messages+edit_messages+delete_messages` },
                    { "text": "➕ Add to Group ➕", "url": `https://t.me/${botUsername}?startgroup=true&admin=manage_chat+delete_messages+pin_messages` },
                ],
                [
                    { "text": "🤖 More Bots", "url": "https://t.me/flinsbots" }
                ]
            ]);
        } else if (data.message && text === '/reactions') {
            const reactionsList = activeReactions.join(", ");
        if (isAdmin) {
            await botApi.sendMessage(chatId, "✅ Enabled Reactions : \n\n" + reactionsList, [
                [ { "text": "➕ Add Reaction", "callback_data": "admin_add_reaction" }, { "text": "➖ Remove Reaction", "callback_data": "admin_remove_reaction" } ]
            ]);
        } else {
            await botApi.sendMessage(chatId, "✅ Enabled Reactions : \n\n" + reactionsList);
        }
        } else if (data.message && (text === '/donate' || text === '/start donate')) {
            await botApi.sendMessage(chatId, donateMessage);
        } else if (data.message && text === '/admin' && isAdmin) {
            // NAYA: Advanced Admin Panel
            await botApi.sendMessage(chatId, "👨‍💻 *Advanced Admin Panel*\n\nFrom here you can fully control the bot:", [
                [ { "text": "📢 Send Promotion", "callback_data": "admin_promo" } ],
                [ { "text": "👮 Add Admin", "callback_data": "admin_add" }, { "text": "⛔ Remove Admin", "callback_data": "admin_remove" } ],
                [ { "text": "🚫 Ban Chat", "callback_data": "admin_ban" }, { "text": "✅ Unban Chat", "callback_data": "admin_unban" } ],
                [ { "text": "➕ Add Reaction", "callback_data": "admin_add_reaction" }, { "text": "➖ Remove Reaction", "callback_data": "admin_remove_reaction" } ],
                [ { "text": "📋 View Admins", "callback_data": "admin_list" } ]
            ]);
        } else if (data.message && text === '/cancel' && isAdmin && currentState) {
            adminStates.delete(senderId);
            await botApi.sendMessage(chatId, "❌ Action cancelled.");
        } else if (data.message && isAdmin && currentState === 'WAITING_PASS_ADD') {
            if (text.trim() === 'Sujoy') {
                adminStates.set(senderId, 'WAITING_ADD_ADMIN');
                await botApi.sendMessage(chatId, "✅ *Password Accepted*\n\nSend the Telegram User ID of the new admin (Numbers only):");
            } else {
                adminStates.delete(senderId);
                await botApi.sendMessage(chatId, "❌ Incorrect Password! Action cancelled.");
            }
        } else if (data.message && isAdmin && currentState === 'WAITING_PASS_REMOVE') {
            if (text.trim() === 'sujoy') {
                adminStates.set(senderId, 'WAITING_REMOVE_ADMIN');
                let adminListMsg = `✅ *Password Accepted*\n\n👮 *Current Additional Admins:*\n`;
                if (additionalAdmins.size > 0) {
                    Array.from(additionalAdmins).forEach((id, index) => {
                        adminListMsg += `${index + 1}. \`${id}\`\n`;
                    });
                } else {
                    adminListMsg += "_None_\n";
                }
                await botApi.sendMessage(chatId, `${adminListMsg}\nSend the Telegram User ID of the admin you want to remove (Tap ID to copy):`);
            } else {
                adminStates.delete(senderId);
                await botApi.sendMessage(chatId, "❌ Incorrect Password! Action cancelled.");
            }
        } else if (data.message && isAdmin && currentState === 'WAITING_ADD_ADMIN') {
            adminStates.delete(senderId);
            const newAdminId = text ? parseInt(text.trim()) : NaN;
            if (!isNaN(newAdminId)) {
                if (newAdminId === AdminId || additionalAdmins.has(newAdminId)) {
                    await botApi.sendMessage(chatId, `🤔 User ${newAdminId} is already an Admin.`);
                } else {
                    additionalAdmins.add(newAdminId);
                    saveDatabase();

                    // Naye admin ko bhi commands menu (Left Side Pin) update karke dikhayein
                    await botApi.setMyCommands([
                        { command: 'start', description: 'Start the bot' },
                        { command: 'reactions', description: 'View available reactions' },
                        { command: 'donate', description: 'Support the bot' },
                        { command: 'admin', description: 'Advanced Admin Panel' }
                    ], { type: 'chat', chat_id: newAdminId }).catch(() => {});

                    await botApi.sendMessage(chatId, `✅ Success! User ${newAdminId} is now an Admin.`);
                    
                    // Naye admin ko turant message bhej kar notify karein
                    await botApi.sendMessage(newAdminId, `🎉 *Congratulations!*\n\nYou have been promoted to an Admin of this bot.\nSend /admin to access the Advanced Admin Panel.`).catch(() => {});
                }
            } else {
                await botApi.sendMessage(chatId, "❌ Invalid User ID. Action cancelled.");
            }
        } else if (data.message && isAdmin && currentState === 'WAITING_REMOVE_ADMIN') {
            adminStates.delete(senderId);
            const remAdminId = text ? parseInt(text.trim()) : NaN;
            if (!isNaN(remAdminId)) {
                if (remAdminId === AdminId) { // Primary Admin ko remove nahi kar sakte
                    await botApi.sendMessage(chatId, "❌ Action Denied! The Primary Admin cannot be removed.");
                } else if (additionalAdmins.has(remAdminId)) {
                    additionalAdmins.delete(remAdminId);
                    saveDatabase();
                    // Admin hatne par commands ka extra scope remove karein (taki unhe default commands dikhein)
                    await botApi.deleteMyCommands({ type: 'chat', chat_id: remAdminId }).catch(() => {});
                    await botApi.sendMessage(chatId, `✅ Success! User ${remAdminId} has been removed from Admins.`);
                    
                    // Remove hue admin ko bhi notify karein
                    await botApi.sendMessage(remAdminId, `⚠️ *Admin Status Revoked*\n\nYour admin privileges for this bot have been removed.`).catch(() => {});
                } else {
                    await botApi.sendMessage(chatId, `🤷‍♂️ User ${remAdminId} was not found in the admin list.`);
                }
            } else {
                await botApi.sendMessage(chatId, "❌ Invalid User ID. Action cancelled.");
            }
        } else if (data.message && isAdmin && currentState === 'WAITING_BAN_CHAT') {
            adminStates.delete(senderId);
            const banInput = text ? text.trim() : "";
            if (banInput.startsWith('@')) {
                bannedChats.add(banInput.toLowerCase());
                saveDatabase();
                await botApi.sendMessage(chatId, `🚫 Success! Username ${banInput} has been BANNED.`);
            } else {
                const banId = Number(banInput);
                if (!isNaN(banId)) {
                    bannedChats.add(banId);
                    activeChats.delete(banId); // Remove from active list
                    saveDatabase();
                    await botApi.sendMessage(chatId, `🚫 Success! Chat/Channel ${banId} has been BANNED.`);
                } else {
                    await botApi.sendMessage(chatId, "❌ Invalid format. Use @username or Numeric ID. Action cancelled.");
                }
            }
        } else if (data.message && isAdmin && currentState === 'WAITING_UNBAN_CHAT') {
            adminStates.delete(senderId);
            const unbanInput = text ? text.trim() : "";
            if (unbanInput.startsWith('@')) {
                bannedChats.delete(unbanInput.toLowerCase());
                saveDatabase();
                await botApi.sendMessage(chatId, `✅ Success! Username ${unbanInput} has been UNBANNED.`);
            } else {
                const unbanId = Number(unbanInput);
                if (!isNaN(unbanId)) {
                    bannedChats.delete(unbanId);
                    saveDatabase();
                    await botApi.sendMessage(chatId, `✅ Success! Chat/Channel ${unbanId} has been UNBANNED.`);
                } else {
                    await botApi.sendMessage(chatId, "❌ Invalid format. Use @username or Numeric ID. Action cancelled.");
                }
            }
        } else if (data.message && isAdmin && currentState === 'WAITING_PROMO') {
            adminStates.delete(senderId); // State reset karo
            let count = 0;
            await botApi.sendMessage(chatId, "⏳ Broadcasting your message...");
            for (const targetChat of activeChats) {
                if (bannedChats.has(targetChat)) continue; // Banned chats me na bheje
                try {
                    await botApi.copyMessage(targetChat, chatId, message_id);
                    count++;
                    // Telegram rate limit (30 msgs/sec) se bachne ke liye chhota delay
                    await new Promise(resolve => setTimeout(resolve, 35));
                } catch (e) { 
                    // Agar bot ko group se nikal (kick) diya gaya hai, to us inactive group ko delete kar do
                    activeChats.delete(targetChat);
                }
            }
            saveDatabase(); // Inactive chats hatane ke baad DB ko ek baar save karein
            await botApi.sendMessage(chatId, `✅ Promotion sent successfully to ${count} chats!`);
        } else if (data.message && isAdmin && currentState === 'WAITING_ADD_REACTION') {
            adminStates.delete(senderId);
            const newEmojis = splitEmojis(text);
            if (newEmojis.length > 0) {
                if (customReactions.length === 0) customReactions = [...Reactions];
                for (const emoji of newEmojis) {
                    if (!customReactions.includes(emoji)) {
                        customReactions.push(emoji);
                    }
                }
                saveDatabase();
                await botApi.sendMessage(chatId, `✅ Emojis added successfully!\n\nCurrent Reactions: ${customReactions.join(', ')}`);
            } else {
                await botApi.sendMessage(chatId, "❌ No valid emoji found. Action cancelled.");
            }
        } else if (data.message && isAdmin && currentState === 'WAITING_REMOVE_REACTION') {
            adminStates.delete(senderId);
            const emojisToRemove = splitEmojis(text);
            if (emojisToRemove.length > 0) {
                if (customReactions.length === 0) customReactions = [...Reactions];
                
                customReactions = customReactions.filter(e => !emojisToRemove.includes(e));
                
                if (customReactions.length === 0) {
                    customReactions = [...Reactions]; // Prevent deleting all
                    await botApi.sendMessage(chatId, "⚠️ You cannot remove all reactions. Default reactions have been restored.");
                } else {
                    saveDatabase();
                    await botApi.sendMessage(chatId, `✅ Emojis removed successfully!\n\nCurrent Reactions: ${customReactions.join(', ')}`);
                }
            } else {
                await botApi.sendMessage(chatId, "❌ No valid emoji found. Action cancelled.");
            }
        } else if (data.message && content.chat.type === "private" && !isAdmin) {
            // FORWARD DMs TO PRIMARY ADMIN
            if (AdminId && text) {
                const userLink = `${content.from.first_name || 'User'}`;
                await botApi.sendMessage(AdminId, `📩 *Message from ${userLink}:*\n\n${text}`);
            }
            // Taki usey doubt na ho, bot message par ek reaction de dega
        await applyReaction(botApi, chatId, message_id, activeReactions, Reactions, AdminId);
        } else {
            // React to EVERY message instantly without any restrictions
        await applyReaction(botApi, chatId, message_id, activeReactions, Reactions, AdminId);
        }
    } else if (data.message_reaction) {
        // Naya Feature: Agar chat me kisi ne kisi purane message par react kiya, toh bot bhi turant uspar react karega
        const reactionData = data.message_reaction;
        
        // Agar reaction change karne wala khud ek bot hai, to use ignore karein (infinite loop se bachne ke liye)
        if (reactionData.user && reactionData.user.is_bot) return;

        let activeReactions = customReactions.length > 0 ? customReactions : Reactions;
        await applyReaction(botApi, reactionData.chat.id, reactionData.message_id, activeReactions, Reactions, AdminId);
        
    } else if (data.pre_checkout_query) {
        await botApi.answerPreCheckoutQuery(data.pre_checkout_query.id, true);
        await botApi.sendMessage(data.pre_checkout_query.from.id, "Thank you for your donation! 💝");
    }
}