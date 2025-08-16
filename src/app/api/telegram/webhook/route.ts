
import { NextRequest, NextResponse } from 'next/server';
import TelegramBot, { Message, CallbackQuery, InlineKeyboardMarkup, InlineKeyboardButton, User, ReplyKeyboardMarkup } from 'node-telegram-bot-api';

const token = process.env.TELEGRAM_BOT_TOKEN || '8300808943:AAEeQsBOOjQ4XhuNNWe40C5c86kIZFMvzZM';

import {
  getAdminMainMenuKeyboard,
 getAdminActionKeyboard,
 getAdminEditKeyboard,
 getPaymentKeyboard,
 getConnectedDriversKeyboard,
 getDriverActionKeyboard,
 getDriverEditKeyboard,
 getCustomerPaymentKeyboard,
 getCustomerQRDoneKeyboard,
 getCustomerPingKeyboard,
 getLanguageKeyboard,
 getLocationRequestKeyboard,
 getDelayKeyboard,
 getFeedbackKeyboard,
 getAdminSettingsKeyboard,
 getManageQRsKeyboard,
 getManageAdminsKeyboard,
} from './keyboards';

import {
  Order,
 Customer,
 Driver,
 User as TelegramUser, // Renaming to avoid conflict with internal User type if any
} from './keyboards'; // Assuming types are also moved or imported from a shared location
const primaryAdminId = parseInt((process.env.ADMIN_USER_IDS || '5186573916').split(',')[0], 10);
let adminUserIds = (process.env.ADMIN_USER_IDS || '5186573916').split(',').map(id => parseInt(id, 10));
// In-memory storage for admin language preferences (replace with persistent storage in production)
const adminLanguagePrefs: Map<number, 'en' | 'ru'> = new Map();
adminLanguagePrefs.set(primaryAdminId, 'en'); // Default language for primary admin

// --- In-Memory Data Storage (replace with persistent storage in production) ---
const orders: Order[] = [];
const drivers: Driver[] = [];
const customers: Customer[] = [];
const sessions: Session[] = []; // For tracking multi-step interactions
const qrCodes: QRCode[] = [];
// Create a single, persistent bot instance
const bot = new TelegramBot(token, { polling: false });

interface Session {
    userId: number;
    state: { [key: string]: any };
}

interface QRCode {
    id: string;
    title: string;
    file_id: string; // Telegram file_id for the photo
}

// --- Session Management ---
const getSession = (userId: number): Session | undefined => sessions.find(s => s.userId === userId);
const setSession = (userId: number, state: any) => {
    const index = sessions.findIndex(s => s.userId === userId);
    if (index > -1) {
        sessions[index].state = { ...sessions[index].state, ...state };
    } else {
        sessions.push({ userId, state });
    }
};
const clearSession = (userId: number) => {
    const index = sessions.findIndex(s => s.userId === userId);
    if (index > -1) {
        sessions.splice(index, 1);
    }
};


// --- Data Helpers ---
const findOrCreateCustomer = (user: TelegramBot.User): Customer => {
  if (!user || !user.id) {
    const fallbackName = `User_${Date.now()}`;
    const fallbackCustomer = { id: fallbackName, name: fallbackName };
    if (!customers.find(c => c.id === fallbackCustomer.id)) {
        customers.push(fallbackCustomer);
    }
    return fallbackCustomer;
  }
  let customer = customers.find(c => c.id === user.id.toString());
  if (!customer) {
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || user.id.toString();
    customer = { id: user.id.toString(), name };
    customers.push(customer);
  }
  return customer;
};

const findOrCreateDriver = (user: TelegramBot.User): Driver => {
  let driver = drivers.find(d => d.id === user.id.toString());
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || user.id.toString();
  if (!driver) {
    driver = { id: user.id.toString(), name, status: 'offline' };
    drivers.push(driver);
  }
  return driver;
};

const genOrderNumber = () => `#${Math.floor(100000 + Math.random() * 900000)}`;

const createOrderFromForward = async (msg: Message): Promise<Order | null> => {
    let customer: Customer;
    let locationLink: string | null = null;
    let items: string = '';
    const fromUser = msg.from;

    if (!fromUser) return null; // Should not happen

    if (msg.forward_sender_name) { // Forwarded from a channel or a user who hides their account
        const existingCustomer = customers.find(c => c.name === msg.forward_sender_name);
        customer = existingCustomer || { id: `forward_${Date.now()}`, name: msg.forward_sender_name };
        if (!existingCustomer) customers.push(customer);
    } else if (msg.forward_from) { // Forwarded from a regular user
        customer = findOrCreateCustomer(msg.forward_from);
    } else { // Not a forward, fallback to the sender (the admin)
        customer = findOrCreateCustomer(fromUser);
    }

    if (msg.location) {
        locationLink = `https://www.google.com/maps/search/?api=1&query=${msg.location.latitude},${msg.location.longitude}`;
        items = msg.text || msg.caption || '';
    } else if (msg.text) {
        items = msg.text;
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const urls = items.match(urlRegex);
        if (urls && urls.length > 0) {
            locationLink = urls[0];
            items = items.replace(locationLink, '').trim();
        }
    } else if (msg.caption) {
        items = msg.caption;
    }

    if (!locationLink && !items) {
        return null;
    }

    const newOrder: Order = {
        id: genOrderNumber(),
        customer,
        locationLink: locationLink || 'No location provided',
        status: 'new',
        createdAt: new Date(),
        items: items,
    };

    orders.push(newOrder);
    // Delete the forwarded message after processing
    await bot.deleteMessage(fromUser.id, msg.message_id).catch(e => console.error("Could not delete forwarded message", e));

    return newOrder;
};

const statusEmoji = (status: Order['status']) => {
    switch(status) {
        case "draft": return "📦";
        case "new": return "🆕";
        case "new_online": return "📲";
        case "active_ready": return "✔️";
        case "active_pickedup": return "🛍️";
        case "arrived": return "🏁";
        case "completed": return "✅";
        case "cancelled": return "❌";
        default: return "❔";
    }
}

const driverStatusEmoji = (status: Driver['status']) => {
    switch(status) {
        case 'offline': return '🔴';
        case 'online': return '🟢';
        case 'assigned': return '🔵';
        case 'busy': return '🟡';
        default: return '⚪';
    }
}

const tgUserLink = (user: User | Customer | Driver | {id: number | string, name: string}) => {
    if (!user || !user.id) return "";
    const name = ('name' in user) ? user.name : [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username;
    if (typeof user.id === 'string' && /^\d+$/.test(user.id)) {
        return `<a href="tg://user?id=${user.id}">${name}</a>`;
    }
    if (typeof user.id === 'number') {
         return `<a href="tg://user?id=${user.id}">${name || user.id}</a>`;
    }
    return name || '';
}

const mapLinkText = (url: string) => {
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
        return `<a href="${url}">map link</a>`;
    }
    return url;
};

export const formatOrderDetails = (order: Order): string => {
  if (!order) return "Order not found.";
  const driver = order.driverId ? drivers.find(d => d.id === order.driverId) : null;
  const driverEmoji = ['active_ready', 'active_pickedup', 'arrived'].includes(order.status) ? '🚚' : '🚀';

  const lines = [
    `${statusEmoji(order.status)} ${order.id}`,
    `👤 ${tgUserLink(order.customer) || ''}`,
    `📍 ${order.locationLink ? mapLinkText(order.locationLink) : ''}`,
    `💲 ${order.payment_status || ''}`,
    `💳 ${order.payment_method || ''}`,
    `💸 Total: ${order.total_amount || ''}`,
  ];

  if (order.payment_method === 'CASH') {
      if(order.cash_given_amount) lines.push(`💰 Cash Given: ${order.cash_given_amount}`);
      if(order.cash_change) lines.push(`💱 Change: ${order.cash_change}`);
  }

  if (!order.driverId) {
    lines.push(`🚀 `);
  }
  lines.push(`📃 ${order.items || ''}`);

  return lines.filter(line => !line.endsWith(': ') && !line.endsWith('null') && line.trim() !== '🚀' && line.trim() !== '🚚').join("\n");
};

// --- Keyboards ---

// --- Message Handlers ---

const handleStart = async (msg: Message) => {
    const chatId = msg.chat.id;
    if (isAdmin(chatId)) {
        await bot.sendMessage(chatId, 'Admin Panel', {
            reply_markup: getAdminMainMenuKeyboard()
        });
    } else {
        const customer = findOrCreateCustomer(msg.from!);
        setSession(chatId, { mode: 'online_order_start' });
        await bot.sendMessage(chatId, "Please choose your language:", {
            reply_markup: getLanguageKeyboard()
        });
    }
};

const isAdmin = (chatId: number) => adminUserIds.includes(chatId);

const handleNewOrder = async (msg: Message) => {
    const chatId = msg.chat.id;

    if (!isAdmin(chatId)) {
         await bot.sendMessage(chatId, 'This command is only for admins.');
         return;
    }

    const newOrder = await createOrderFromForward(msg);
    if (!newOrder) {
        await bot.sendMessage(chatId, 'Could not create an order. Please forward a message with a map link/location or some text content.');
        return;
    }
    
    await bot.sendMessage(chatId, formatOrderDetails(newOrder), {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: getAdminActionKeyboard(newOrder)
    });
};

const handleRegister = async (msg: Message) => {
    const user = msg.from;
    if (!user) return;
    let driver = findOrCreateDriver(user);
    driver.status = 'online';
    await bot.sendMessage(user.id, 'You are now registered and online. You will receive order notifications.');
    await notifyAdminsDriverStatus(driver.name, 'online');
};

const notifyAdminsDriverStatus = async (driverName: string, status: string, details?: string) => {
    const message = `Driver ${driverName} is now ${status}${details ? ` (${details})` : ''}`;
    for (const id of adminUserIds) {
        await bot.sendMessage(id, message).catch(e => console.error("Failed to notify admin", id, e));
    }
};

let disconnectTimers = new Map<number, NodeJS.Timeout>();

const handleDisconnect = async (msg: Message) => {
    const user = msg.from;
    if (!user) return;

    const driver = drivers.find(d => d.id === user.id.toString());
    if (!driver || driver.status === 'offline') {
        await bot.sendMessage(user.id, "You are already disconnected.");
        return;
    }

    if (driver.status === 'busy' || driver.status === 'assigned') {
        const adminMessage = `Driver ${driver.name} wants to disconnect but has an active order. Approve?`;
        const keyboard = { inline_keyboard: [[{ text: "Approve", callback_data: `disconnect:approve:${driver.id}`}, { text: "Deny", callback_data: `disconnect:deny:${driver.id}`}]]};
        for (const adminId of adminUserIds) {
            await bot.sendMessage(adminId, adminMessage, { reply_markup: keyboard });
        }

        const sendPrompt = () => {
            bot.sendMessage(user.id, "You have an active order. An admin must approve your disconnection. This prompt will repeat until an admin responds.").then(() => {
                const timer = setTimeout(sendPrompt, 60000); // 1 minute
                disconnectTimers.set(user.id, timer);
            }).catch(e => console.error("Error sending disconnect prompt", e));
        };
        sendPrompt();

    } else {
        driver.status = 'offline';
        await bot.sendMessage(user.id, "You are now disconnected.");
        await notifyAdminsDriverStatus(driver.name, 'offline');
    }
};

// --- Callback Query Handler ---
const handleCallbackQuery = async (query: CallbackQuery) => {
    const msg = query.message;
    const data = query.data;

    if (!msg || !data) {
        await bot.answerCallbackQuery(query.id);
        return;
    }

    const fromId = query.from.id;
    const chatId = msg.chat.id;

    const parts = data.split(':');
    const action = parts[0];
    const subAction = parts.length > 1 ? parts[1] : null;
    const entityId = parts.length > 2 ? parts[2] : (action.startsWith('admin_') || action === 'none' || action === 'lang' ? null : parts[1]);
    
    const order = (action !== 'qr' && action !== 'admin' && entityId && !action.startsWith('admin') && action !== 'disconnect') ? orders.find(o => o.id === entityId) : undefined;

    // Add check to ensure action is defined
    if (!action) {
        return; // Or handle as an unknown callback
    }
    
    await bot.answerCallbackQuery(query.id);
    
    if (action === 'lang' && subAction) {
        const customer = findOrCreateCustomer(query.from);
        customer.language = subAction as 'en' | 'ru';
        const session = getSession(fromId);
        if (session?.state.mode === 'online_order_start') {
            setSession(fromId, { mode: 'online_order_items' });
            const welcomeText = subAction === 'ru'
                ? `Добро пожаловать, ${customer.name}! Какое блюдо вы хотели бы заказать?`
                : `Welcome ${customer.name}, what meal would you like to order?`;
            await bot.editMessageText(welcomeText, { chat_id: chatId, message_id: msg.message_id });
        }
        return;
    }
    
    if (action === 'admin_main_menu') {
        await bot.deleteMessage(chatId, msg.message_id).catch(e => console.error("Could not delete message", e));
        await bot.sendMessage(chatId, "Admin Panel", { reply_markup: getAdminMainMenuKeyboard() });
        return;
    }
    
    if(action === 'customer_ping' && order?.driverId) {
        const lang = order.customer.language;
        await bot.sendMessage(order.driverId, "Customer is waiting too long!", { reply_markup: { inline_keyboard: [[{ text: "🚩 Share location", callback_data: `driver:location:${order.id}`}, { text: "⏰ Notify Delay", callback_data: `driver:delay:${order.id}` }]] } });
        await bot.answerCallbackQuery(query.id, { text: (lang === 'ru' ? "Водитель уведомлен." : "Driver has been pinged."), show_alert: true });
        return;
    }
    
    if (action === 'customer_pay' && order) {
         if(subAction === 'QR') {
            const qr = qrCodes.length > 0 ? qrCodes[0] : null; // Use the first available QR
            if(qr) {
                const lang = order.customer.language;
                await bot.sendPhoto(chatId, qr.file_id, { caption: lang === 'ru' ? "Пожалуйста, отсканируйте для оплаты." : "Please scan to pay." });
                await bot.sendMessage(chatId, lang === 'ru' ? "Нажмите 'Готово' после оплаты." : "Click 'Done' when you have paid.", { reply_markup: getCustomerQRDoneKeyboard(order.id) });
            } else {
                 await bot.sendMessage(chatId, order.customer.language === 'ru' ? "Оплата по QR временно недоступна." : "QR payment is currently unavailable.");
            }
        } else if (subAction === 'CASH') {
            order.payment_method = 'CASH';
            setSession(fromId, { mode: 'customer_cash_given', order_id: order.id });
            await bot.sendMessage(chatId, order.customer.language === 'ru' ? "Сколько наличных вы передадите водителю?" : "How much cash will you give to the driver?");
        } else if (subAction === 'QR_DONE') {
            order.payment_method = 'QR';
            order.payment_status = 'PAID';
            for (const id of adminUserIds) {
                await bot.sendMessage(id, `✅ Customer for order ${order.id} paid by QR.`);
            }
            await bot.editMessageText(order.customer.language === 'ru' ? "Спасибо за ваш платеж!" : "Thank you for your payment!", { chat_id: chatId, message_id: msg.message_id });
             // Forward to admin
            for (const adminId of adminUserIds) {
                await bot.sendMessage(adminId, `Customer has paid for ${order.id} by QR.\n${formatOrderDetails(order)}`, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: getAdminActionKeyboard(order) });
            }
        }
         return;
    }

    // Handle action buttons from lists
    if (action === 'order_action' && subAction && entityId) {
        const order = orders.find(o => o.id === entityId);
        if (!order) {
            await bot.answerCallbackQuery(query.id, { text: "Order not found." });
            return;
        }

        switch (subAction) {
            case 'delete':
                // For draft/new orders
                orders.splice(orders.findIndex(o => o.id === order.id), 1);
                await bot.editMessageText(`Order ${order.id} deleted.`, { chat_id: chatId, message_id: msg.message_id });
                break;
            case 'cancel':
                // For active orders
                order.status = 'cancelled';
                await bot.editMessageText(`Order ${order.id} cancelled.`, { chat_id: chatId, message_id: msg.message_id });
                break;
            case 'assign':
                // For draft/new orders
                await bot.editMessageText(formatOrderDetails(order), {
                    chat_id: chatId,
                    message_id: msg.message_id,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true,
                    reply_markup: getConnectedDriversKeyboard(order.id) // Assuming this returns drivers for assignment
                });
                break;
            case 'go':
                // For draft/new orders with driver assigned
                 if (!order.driverId) {
                    await bot.answerCallbackQuery(query.id, { text: "Assign a driver first", show_alert: true });
                    return;
                }
                order.status = 'active_ready';
                const driver = drivers.find(d => d.id === order.driverId);
                if (driver) {
                    driver.status = 'assigned';
                    driver.currentOrderId = order.id;
                    const driverMsg = `⚡ New Order Assigned:\n${formatOrderDetails(order)}`;
                    await bot.sendMessage(driver.id, driverMsg, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: getDriverActionKeyboard(order) });
                }
                await bot.editMessageText(`✅ Order sent to driver.\n${formatOrderDetails(order)}`, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML', disable_web_page_preview: true });
                break;
            case 'arrived':
                // For active orders
                order.status = 'arrived';
                 await bot.editMessageReplyMarkup(getAdminActionKeyboard(order), { chat_id: chatId, message_id: msg.message_id });
                break;
            case 'completed':
                // For active orders
                 order.status = 'completed';
                const driverOnComplete = order.driverId ? drivers.find(d => d.id === order.driverId) : null;
                 if (driverOnComplete) {
                    driverOnComplete.status = 'online';
                    driverOnComplete.currentOrderId = undefined;
                 }
                await bot.editMessageReplyMarkup(getAdminActionKeyboard(order), { chat_id: chatId, message_id: msg.message_id });
                break;
            case 'change_driver':
                // For active orders
                await bot.editMessageReplyMarkup(getConnectedDriversKeyboard(order.id), { chat_id: chatId, message_id: msg.message_id });
                break;
            case 'archive':
                // For completed orders (assuming 'archived' is a state or action, here we just acknowledge)
                 await bot.editMessageText(`Order ${order.id} archived.`, { chat_id: chatId, message_id: msg.message_id });
                break;
        }
    }
    if (action === 'admin_archive') {
        const archivedOrders = orders.filter(o => o.status === 'completed' || o.status === 'cancelled');
 if (archivedOrders.length === 0) {
 await bot.sendMessage(chatId, "No archived orders.");
 return;
 }
 for(const o of archivedOrders) {
 await bot.sendMessage(chatId, formatOrderDetails(o), {
                         parse_mode: 'HTML',
                         disable_web_page_preview: true
                     });
                }
 await bot.sendMessage(chatId, 'Archived Orders:', { reply_markup: getAdminMainMenuKeyboard() });
 return;
    }

    if (action === 'admin_settings') {
        await bot.editMessageText("Bot Settings", {
            chat_id: chatId, // Pass chatId as the first argument
            message_id: msg.message_id,
            reply_markup: getAdminSettingsKeyboard(chatId)
        });
        return;
    }

    if (action === 'admin_manage_qrs') {
        await bot.editMessageText("Manage QR Codes", {
            chat_id: chatId,
            message_id: msg.message_id,
            reply_markup: getManageQRsKeyboard()
        });
        return;
    }

    if (action === 'admin_add_qr') {
        setSession(fromId, { mode: 'add_qr_photo' });
        await bot.sendMessage(chatId, "Please send the photo for the new QR code.");
        return;
    }
    
    if (action === 'qr') {
        const qrId = parts[2];
        const qrCode = qrCodes.find(q => q.id === qrId);

        if (subAction === 'delete') {
            const index = qrCodes.findIndex(q => q.id === qrId);
            if (index > -1) {
                qrCodes.splice(index, 1);
                await bot.answerCallbackQuery(query.id, { text: "QR Code deleted." });
                await bot.editMessageText("Manage QR Codes", {
                    chat_id: chatId,
                    message_id: msg.message_id,
                    reply_markup: getManageQRsKeyboard()
                });
            } else {
                await bot.answerCallbackQuery(query.id, { text: "QR Code not found." });
            }
        } else if (subAction === 'view' && qrCode) {
            await bot.sendPhoto(chatId, qrCode.file_id, { caption: qrCode.title });
        }
        return;
    }
    
    if (action === 'disconnect') {
        const driverId = parts[2];
        const driver = drivers.find(d => d.id === driverId);
        if(!driver) return;

        if(disconnectTimers.has(parseInt(driverId, 10))) {
            clearTimeout(disconnectTimers.get(parseInt(driverId, 10))!);
            disconnectTimers.delete(parseInt(driverId, 10));
        }

        if(subAction === 'approve') {
            driver.status = 'offline';
            const completedOrders = orders.filter(o => o.driverId === driver.id && o.status === 'completed');
            const feedbackNotes = completedOrders.map(o => `${o.id}: ${o.feedback || 'N/A'} stars`).join('\n');
            await bot.sendMessage(chatId, `${driver.name} disconnected. Completed orders:\n${feedbackNotes || 'None'}`);
            await bot.sendMessage(driverId, "Your disconnection was approved. You are now offline.");
        } else if(subAction === 'deny') {
             driver.status = 'offline';
             await bot.sendMessage(chatId, `${driver.name} disconnected with penalty.`);
             await bot.sendMessage(driverId, "Your disconnection was denied but you have been set to offline. A penalty may be applied.");
        }
        return;
    }

    if (action === 'admin_set_lang_ru') {
        adminLanguagePrefs.set(fromId, 'ru');
        await bot.sendMessage(chatId, "Язык администратора установлен на Русский.");
        await bot.editMessageReplyMarkup(getAdminSettingsKeyboard(fromId), { chat_id: chatId, message_id: msg.message_id });
        return;
    }

    if (action === 'admin_set_lang_en') {
        adminLanguagePrefs.set(fromId, 'en');
        await bot.sendMessage(chatId, "Admin language set to English.");
        await bot.editMessageReplyMarkup(getAdminSettingsKeyboard(fromId), { chat_id: chatId, message_id: msg.message_id });
        return;
    }

    if (action === 'admin_manage_admins') {
        await bot.editMessageText("Manage Admins", {
            chat_id: chatId,
            message_id: msg.message_id,
            reply_markup: await getManageAdminsKeyboard()
        });
        return;
    }

    if (action === 'admin_manage_drivers') {
        const driverButtons: InlineKeyboardButton[][] = drivers.map(driver => {
            const statusIcon = driver.status === 'online' ? '🟢' : driver.status === 'busy' ? '🟡' : driver.status === 'assigned' ? '🔵' : '🔴';
            const blockIcon = driver.status === 'blocked' ? '⚠️' : '';
            return [{ text: `${blockIcon}${statusIcon} ${tgUserLink(driver)}`, callback_data: `driver:view:${driver.id}` },
                    { text: driver.status === 'blocked' ? '▶️' : '⏸️', callback_data: driver.status === 'blocked' ? `driver_admin:unblock:${driver.id}` : `driver_admin:block:${driver.id}`},
                    { text: '❌', callback_data: `driver_admin:remove:${driver.id}` }];
        });
        driverButtons.push([{ text: "➕ Add New Driver (by link)", callback_data: "admin_add_driver_link" }]);
        driverButtons.push([{ text: "➕ Add New Driver (by ID)", callback_data: "admin_add_driver_id" }]);
        driverButtons.push([{ text: "⬅️ Back to Settings", callback_data: "admin_settings" }]);
        await bot.editMessageText("Manage Drivers", {
            chat_id: chatId,
            message_id: msg.message_id,
            reply_markup: { inline_keyboard: driverButtons }
        });
        return;
    }

    if (action === 'admin_add_admin') {
        setSession(fromId, { mode: 'add_admin' });
        await bot.sendMessage(chatId, "Please send the User ID of the new admin, or forward a message from them.");
        return;
    }

    if (action === 'admin' && subAction === 'remove') {
        const adminIdToRemove = parseInt(parts[2], 10);
        if (adminIdToRemove === primaryAdminId) {
            await bot.answerCallbackQuery(query.id, { text: "Cannot remove the primary admin.", show_alert: true });
            return;
        }
        adminUserIds = adminUserIds.filter(id => id !== adminIdToRemove);
        await bot.answerCallbackQuery(query.id, { text: "Admin removed." });
        await bot.editMessageText("Manage Admins", {
            chat_id: chatId,
            message_id: msg.message_id,
            reply_markup: await getManageAdminsKeyboard()
        });
        return;
    }

    if (action === 'driver_admin' && subAction) {
        const driverId = parts[2];
        const driver = drivers.find(d => d.id === driverId);
        if (!driver) {
            await bot.answerCallbackQuery(query.id, { text: "Driver not found." });
            return;
        }

        if (subAction === 'block') {
            driver.status = 'blocked';
            await bot.answerCallbackQuery(query.id, { text: "Driver blocked." });
            await bot.sendMessage(driver.id, "You have been blocked by the admin. You cannot receive new orders or update your status.");
        } else if (subAction === 'unblock') {
            driver.status = 'online'; // Or 'offline', based on desired behavior after unblock
            await bot.answerCallbackQuery(query.id, { text: "Driver unblocked." });
            await bot.sendMessage(driver.id, "You have been unblocked by the admin. You are now online.");
        } else if (subAction === 'remove') {
            const index = drivers.findIndex(d => d.id === driverId);
            if (index > -1) {
                drivers.splice(index, 1);
                await bot.answerCallbackQuery(query.id, { text: "Driver removed and blocked from re-registering." });
                // TODO: Implement blocking mechanism to prevent re-registration
            } else {
                await bot.answerCallbackQuery(query.id, { text: "Driver not found." });
            }
        }
        // Refresh the manage drivers message
        await bot.editMessageText("Manage Drivers", { chat_id: chatId, message_id: msg.message_id, reply_markup: { inline_keyboard: drivers.map(d => {
            const statusIcon = d.status === 'online' ? '🟢' : d.status === 'busy' ? '🟡' : d.status === 'assigned' ? '🔵' : '🔴';
            const blockIcon = d.status === 'blocked' ? '⚠️' : '';
            return [{ text: `${blockIcon}${statusIcon} ${tgUserLink(d)}`, callback_data: `driver:view:${d.id}` },
                    { text: d.status === 'blocked' ? '▶️' : '⏸️', callback_data: d.status === 'blocked' ? `driver_admin:unblock:${d.id}` : `driver_admin:block:${d.id}`},
                    { text: '❌', callback_data: `driver_admin:remove:${d.id}` }];
        }).concat([
            [{ text: "➕ Add New Driver (by link)", callback_data: "admin_add_driver_link" }],
            [{ text: "➕ Add New Driver (by ID)", callback_data: "admin_add_driver_id" }],
            [{ text: "⬅️ Back to Settings", callback_data: "admin_settings" }]
        ])}});
        return;
    }

    if(action === 'detail' && order) {
        await bot.editMessageText(`${formatOrderDetails(order)}`, {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: 'HTML', 
            disable_web_page_preview: true,
            reply_markup: getAdminActionKeyboard(order)
        });
        return;
    }

    if (action === 'edit_menu' && order) {
        await bot.editMessageReplyMarkup(getAdminEditKeyboard(order), {
            chat_id: chatId,
            message_id: msg.message_id
        });
        return;
    }

    if (action === 'edit' && order && subAction) {
        let prompt = '';
        switch(subAction) {
            case 'customer': prompt = 'Send a contact, a name, or @username for the customer.'; break;
            case 'location': prompt = 'Send the map link or a text location.'; break;
            case 'items': prompt = 'Please type the items for this order.'; break;
            case 'total': prompt = 'Please type the total amount for this order.'; break;
            case 'payment':
                 await bot.editMessageReplyMarkup(getPaymentKeyboard(order.id), { chat_id: chatId, message_id: msg.message_id });
                 return;
            case 'driver':
                await bot.editMessageReplyMarkup(getConnectedDriversKeyboard(order.id), { chat_id: chatId, message_id: msg.message_id });
                return;
            case 'lang_ru':
                if(order.customer) order.customer.language = 'ru';
                await bot.answerCallbackQuery(query.id, { text: "Customer language set to Russian" });
                await bot.editMessageText(formatOrderDetails(order), { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: getAdminEditKeyboard(order) });
                return;
            default: return; // Safety return
        }
        setSession(fromId, { mode: 'edit', field: subAction, order_id: order.id });
        await bot.sendMessage(chatId, prompt);
        return;
    }

    if(action === 'payment' && order && subAction) {
        const orderId = parts[2];
        if(subAction === 'PAID') {
            order.payment_status = 'PAID';
        } else {
             order.payment_method = subAction as Order['payment_method'];
             if (subAction === 'CASH') {
                setSession(fromId, { mode: 'edit', field: 'cash_given', order_id: orderId });
                await bot.sendMessage(chatId, "Enter cash amount given by customer or type 'skip'.");
                return;
            }
        }
        await bot.editMessageText(formatOrderDetails(order), { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: getAdminEditKeyboard(order) });
        return;
    }

    if(action === 'assign' && order && subAction) {
        const driverId = subAction;
        const driver = drivers.find(d => d.id === driverId);
        if(driver) {
            order.driverId = driver.id;
        }
        await bot.editMessageText(formatOrderDetails(order), { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: getAdminEditKeyboard(order) });
        return;
    }

     if (action === 'go' && order) {
        if (!order.driverId) {
            await bot.answerCallbackQuery(query.id, { text: "Assign a driver first", show_alert: true });
            return;
        }
        order.status = 'active_ready';
        const driver = drivers.find(d => d.id === order.driverId);
        if (driver) {
            driver.status = 'assigned';
            driver.currentOrderId = order.id;
            const driverMsg = `⚡ New Order Assigned:\n${formatOrderDetails(order)}`;
            await bot.sendMessage(driver.id, driverMsg, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: getDriverActionKeyboard(order) });
        }
        await bot.editMessageText(`✅ Order sent to driver.\n${formatOrderDetails(order)}`, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML', disable_web_page_preview: true });
         return;
    }

    if (action === 'cancel' && order) {
        order.status = 'cancelled';
        await bot.editMessageText(`Order ${order.id} cancelled.`, { chat_id: chatId, message_id: msg.message_id });
        return;
    }

    if (action === 'save' && order) {
        order.status = 'draft';
        clearSession(fromId);
        await bot.editMessageText('Order saved as draft.', { chat_id: chatId, message_id: msg.message_id });
        return;
    }

    if (action === 'driver' && order && subAction) {
        const driver = drivers.find(d => d.id === fromId.toString());
        if (!driver) return;
        const lang = order.customer.language;
        const adminLang = adminLanguagePrefs.get(fromId) || 'en'; // Assuming driver user id is also admin id in this context
        switch (subAction) {
            case 'pickup':
                order.status = 'active_pickedup';
                driver.status = 'busy';
                await bot.answerCallbackQuery(query.id, { text: "Status: Picked Up" });
                await notifyAdminsDriverStatus(driver.name, `going to deliver ${order.id} to ${order.customer.name}`);
                if(order.customer?.id && /^\d+$/.test(order.customer.id)) {
                    const customerMessage = lang === 'ru'
                        ? `Уважаемый(-ая) ${order.customer.name}, ваш заказ в пути и должен прибыть в течение 20 минут. Вы можете пингануть водителя, если он задерживается.\n\n${formatOrderDetails(order)}`
                        : `Dear ${order.customer.name} your order is on the way and should arrive within 20 minutes, you can ping the driver if he is late.\n\n${formatOrderDetails(order)}`;

                    await bot.sendMessage(parseInt(order.customer.id), customerMessage, { reply_markup: getCustomerPingKeyboard(order.id, lang), parse_mode: 'HTML', disable_web_page_preview: true });
                }
                await bot.editMessageReplyMarkup(getDriverActionKeyboard(order), { chat_id: chatId, message_id: msg.message_id });
                break;
            case 'arrived':
                order.status = 'arrived';
                if(order.customer?.id && /^\d+$/.test(order.customer.id)) {
                    const customerMessage = lang === 'ru'
                        ? `🏁 Ваш водитель по заказу ${order.id} прибыл и ждет вас у вашей двери!`
                        : `🏁 Your driver for order ${order.id} has arrived and is waiting for you at your doorstep!`;
                    await bot.sendMessage(parseInt(order.customer.id), customerMessage);
                }
                await notifyAdminsDriverStatus(driver.name, `delivered to ${order.customer.name}`);
                await bot.answerCallbackQuery(query.id, { text: "Arrived notification sent" });
                await bot.editMessageReplyMarkup(getDriverActionKeyboard(order), { chat_id: chatId, message_id: msg.message_id });
                break;
            case 'completed':
                order.status = 'completed';
                driver.status = 'online';
                driver.currentOrderId = undefined;
                if(order.customer?.id && /^\d+$/.test(order.customer.id)) {
                     const customerMessage = lang === 'ru'
                        ? `✅ Ваш заказ ${order.id} выполнен. Спасибо за ваш заказ! Оцените качество доставки по 5-балльной шкале /5`
                        : `✅ Your order ${order.id} is complete. Thanks for ordering with us! Please rate your delivery experience /5`;
                    await bot.sendMessage(parseInt(order.customer.id), customerMessage, { reply_markup: getFeedbackKeyboard(order.id, lang) });
                }
                await notifyAdminsDriverStatus(driver.name, `completed ${order.id} for ${order.customer.name}`);
                await bot.editMessageText(`Order ${order.id} completed.`, { chat_id: chatId, message_id: msg.message_id });
                break;
            case 'delay':
                await bot.editMessageReplyMarkup(getDelayKeyboard(order.id), { chat_id: chatId, message_id: msg.message_id });
                return;
            case 'location':
                 // Prompt driver to share live location
                 setSession(fromId, { mode: 'share_location_to_customer', order_id: order.id });
                 await bot.sendMessage(fromId, "Please share your live location.", {
                    reply_markup: { keyboard: [[{ text: "📍 Share Location", request_location: true }]], resize_keyboard: true, one_time_keyboard: true }
                 });
                await bot.answerCallbackQuery(query.id, { text: "Please share your location." });
                 break;
            case 'cancel_request':
                for (const id of adminUserIds) {
                    await bot.sendMessage(id, `❌ Driver ${driver.name} wants to cancel order ${order.id}. Approve?`, { reply_markup: { inline_keyboard: [[{text: "Approve", callback_data: `driver:cancel_approve:${order.id}`}, {text: "Deny", callback_data: `driver:cancel_deny:${order.id}`}]]}});
                }
                await bot.answerCallbackQuery(query.id, { text: "Cancellation request sent to admin." });
                break;
            case 'cancel_approve':
            case 'cancel_deny':
                const approve = subAction === 'cancel_approve';
                const originalDriverId = order.driverId;
                if(approve) {
                    order.status = 'new';
                    order.driverId = undefined;
                    await bot.sendMessage(chatId, `Order ${order.id} cancellation approved. It's now a new order.`);
                    if(originalDriverId) await bot.sendMessage(originalDriverId, `Your cancellation for ${order.id} was approved.`);
                } else {
                    await bot.sendMessage(chatId, `Order ${order.id} cancellation denied.`);
                     if(originalDriverId) await bot.sendMessage(originalDriverId, `Your cancellation for ${order.id} was denied.`);
                }
                break;
            case 'active_order_detail':
                await bot.editMessageText(`⚡ Order Assigned:\n${formatOrderDetails(order)}`, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: getDriverActionKeyboard(order) });
                break;
            case 'edit':
                 await bot.editMessageReplyMarkup(getDriverEditKeyboard(order.id), { chat_id: chatId, message_id: msg.message_id });
                 break;
            case 'save':
            case 'cancel_edit':
                 await bot.editMessageReplyMarkup(getDriverActionKeyboard(order), { chat_id: chatId, message_id: msg.message_id });
                 break;
            default:
                break;
        }
        return;
    }

     if(action === 'delay' && order && subAction) {
        let delayMsg = '';
        let delayMsgRu = '';
        if (subAction === "lt5") {
             delayMsg = "Traffic is dense, I am not far. Give me 5 minutes 🙏";
             delayMsgRu = "Движение плотное, я недалеко. Дайте мне 5 минут 🙏";
        }
        if (subAction === "lt2") {
            delayMsg = "I am really close, just a couple of minutes 🙏";
            delayMsgRu = "Я очень близко, всего пару минут 🙏";
        }
        if (subAction === "gt10") {
            delayMsg = "We are busier than usual. I am on the way and will deliver in about 10 minutes. Thank you for understanding.";
            delayMsgRu = "У нас больше заказов, чем обычно. Я уже в пути и доставлю примерно через 10 минут. Спасибо за понимание.";
        }
        if(order.customer?.id && /^\d+$/.test(order.customer.id)) {
            const lang = order.customer.language;
            const message = lang === 'ru' ? delayMsgRu : delayMsg;
            await bot.sendMessage(parseInt(order.customer.id), `⏰ Regarding order ${order.id}: ${message}`);
        }
        await notifyAdminsDriverStatus(order.driverId ? drivers.find(d=>d.id === order.driverId)?.name || 'Driver' : 'Driver', `notified ${order.customer.name} about a delay.`);
        await bot.answerCallbackQuery(query.id, { text: "Delay notified" });
        await bot.editMessageReplyMarkup(getDriverActionKeyboard(order), { chat_id: chatId, message_id: msg.message_id });
        return;
    }

    if (action === 'fb' && order && subAction) {
        const score = parseInt(subAction, 10);
        const lang = order.customer.language;
        if (isNaN(score)) return;
        
        order.feedback = score as Order['feedback'];
        await bot.answerCallbackQuery(query.id, { text: lang === 'ru' ? `Спасибо за ваш отзыв ${score} ⭐!` : `Thank you for the ${score} star feedback!` });
        const driver = order.driverId ? drivers.find(d => d.id === order.driverId) : null;
        
        const feedbackMessage = `${driver?.name || 'Driver'} has completed ${order.id} for ${order.customer.name} ${order.feedback}⭐`;
        for (const id of adminUserIds) {
            await bot.sendMessage(id, feedbackMessage);
        }
        
        if (driver) {
            await bot.sendMessage(driver.id, `Done right! ${order.customer.name} ${order.feedback}⭐`);
        }
        await bot.editMessageText(lang === 'ru' ? "Спасибо за ваш отзыв!" : `Thank you for your feedback!`, { chat_id: chatId, message_id: msg.message_id });
        return;
    }
};

const handleMessage = async (msg: Message) => {
    const chatId = msg.chat.id;
    const fromId = msg.from?.id;
    if (!fromId) return;

    const session = getSession(fromId);

    if (isAdmin(chatId) && msg.text) {
        switch(msg.text) {
            case '📦 DRAFT':
                const draftOrders = orders.filter(o => o.status === 'draft' || o.status === 'new' || o.status === 'new_online').reverse();
                if (draftOrders.length === 0) {
                    await bot.sendMessage(chatId, "empty!", { reply_markup: getAdminMainMenuKeyboard() });
                    return;
                }
                if (draftOrders.length === 0) {
 await bot.sendMessage(chatId, "empty!", { reply_markup: getAdminMainMenuKeyboard() });
                    return;
                }
                if (draftOrders.length === 1) {
                    const order = draftOrders[0];
                    await bot.sendMessage(chatId, formatOrderDetails(order), {
                         reply_markup: getAdminEditKeyboard(order),
                         parse_mode: 'HTML',
                         disable_web_page_preview: true
                     });
                } else {
                    const orderList = draftOrders.map(o => ({
                         text: `${statusEmoji(o.status)} ${o.id} - ${o.customer.name}`,
                         callback_data: `view_detail:${o.id}` // Callback to view details in edit mode
                    }));

                    const inlineKeyboard: InlineKeyboardButton[][] = orderList.map(button => {
                        const buttons: InlineKeyboardButton[] = [button]; // The list item itself is a button to view details
                        buttons.push({ text: '❌', callback_data: `order_action:delete:${button.callback_data.split(':')[1]}` });
                        if (button.callback_data.split(':')[1]) { // Check if order ID exists
                            const order = orders.find(ord => ord.id === button.callback_data.split(':')[1]);
                            if (order && !order.driverId) buttons.push({ text: '🚀', callback_data: `order_action:assign:${order.id}` });
                            if (order && order.driverId) buttons.push({ text: '⚡', callback_data: `order_action:go:${order.id}` });
                        }
                        return buttons;
                    });                    await bot.sendMessage(chatId, 'Select a draft/new order or use action buttons:', { reply_markup: { inline_keyboard: inlineKeyboard } });
                }
                await bot.sendMessage(chatId, 'Draft Orders:', { reply_markup: getAdminMainMenuKeyboard() });
                return;
            case '⚡ ACTIVE':
                const activeOrders = orders.filter(o => ['active_ready', 'active_pickedup', 'arrived'].includes(o.status)).reverse();
                if (activeOrders.length === 0) {
                     await bot.sendMessage(chatId, "empty!", { reply_markup: getAdminMainMenuKeyboard() });
                    return;
                }
                 if (activeOrders.length === 1) {
                     const order = activeOrders[0];
                      await bot.sendMessage(chatId, formatOrderDetails(order), {
                         reply_markup: getAdminActionKeyboard(order),
                         parse_mode: 'HTML',
                         disable_web_page_preview: true
                     });
                 } else {
                    const orderList = activeOrders.map(o => ({
                         text: `${statusEmoji(o.status)} ${o.id} - ${o.customer.name} ${o.driverId ? `(${drivers.find(d => d.id === o.driverId)?.name || 'N/A'})` : ''}`,
                         callback_data: `view_detail:${o.id}` // Callback to view details
                    }));
                    const inlineKeyboard: InlineKeyboardButton[][] = orderList.map(button => {
                        const buttons: InlineKeyboardButton[] = [button]; // The list item itself is a button to view details
                        buttons.push({ text: '🏁', callback_data: `order_action:arrived:${button.callback_data.split(':')[1]}` });
                        buttons.push({ text: '✅', callback_data: `order_action:completed:${button.callback_data.split(':')[1]}` });
                         if (drivers.length > 1) {
                            buttons.push({ text: '♻️', callback_data: `order_action:change_driver:${button.callback_data.split(':')[1]}` });
                         }
                        buttons.push({ text: '❌', callback_data: `order_action:cancel:${button.callback_data.split(':')[1]}` });

                        return buttons;
                    });                    await bot.sendMessage(chatId, 'Select an active order or use action buttons:', { reply_markup: { inline_keyboard: inlineKeyboard } });
                }
                await bot.sendMessage(chatId, 'Active Orders:', { reply_markup: getAdminMainMenuKeyboard() });
                return;
            case '✅ COMPLETED':
                 const completedOrders = orders.filter(o => o.status === 'completed').reverse();
                if (completedOrders.length === 0) {
                      await bot.sendMessage(chatId, "empty!", { reply_markup: getAdminMainMenuKeyboard() });
                    return;
                }
                if (completedOrders.length === 1) {
                     const order = completedOrders[0];
                      await bot.sendMessage(chatId, formatOrderDetails(order), {
                         parse_mode: 'HTML',
                         disable_web_page_preview: true
                     });
                 } else {
                    const orderList = completedOrders.map(o => ({
                         text: `${statusEmoji(o.status)} ${o.id} - ${o.customer.name} ${o.driverId ? `(${drivers.find(d => d.id === o.driverId)?.name || 'N/A'})` : ''}`,
                         callback_data: `view_detail:${o.id}` // Callback to view details
                     }));
                    const inlineKeyboard: InlineKeyboardButton[][] = orderList.map(button => {
                         const buttons: InlineKeyboardButton[] = [button]; // The list item itself is a button to view details
                         buttons.push({ text: '🗂️', callback_data: `order_action:archive:${button.callback_data.split(':')[1]}` });
                         return buttons;
                     });                    await bot.sendMessage(chatId, 'Select a completed order or use action buttons:', { reply_markup: { inline_keyboard: inlineKeyboard } });
                }
                // Add the "View Archived Orders" button separately if needed, or handle archiving as a state change.
                // await bot.sendMessage(chatId, "View Archived Orders", { reply_markup: { inline_keyboard: [[{ text: "🗂️ Archived", callback_data: "admin_archive" }]] }});
                await bot.sendMessage(chatId, 'Completed Orders:', { reply_markup: getAdminMainMenuKeyboard() });
                return;
            case '📥 Orders':
                const onlineOrders = orders.filter(o => o.status === 'new_online').reverse();
                if (onlineOrders.length === 0) {
                    await bot.sendMessage(chatId, "empty!", { reply_markup: getAdminMainMenuKeyboard() });
                    return;
                }
                if (onlineOrders.length === 0) {
 await bot.sendMessage(chatId, "empty!", { reply_markup: getAdminMainMenuKeyboard() });
                    return;
                }
                if (onlineOrders.length === 1) {
                     const order = onlineOrders[0];
                      await bot.sendMessage(chatId, formatOrderDetails(order), {
                         reply_markup: getAdminEditKeyboard(order),
                         parse_mode: 'HTML',
                         disable_web_page_preview: true
                     });
                } else {
                    const orderList = onlineOrders.map(o => ({
                        text: `${statusEmoji(o.status)} ${o.id} - ${o.customer.name}`,
                         callback_data: `view_detail:${o.id}` // Callback to view details in edit mode
                    }));
                    const inlineKeyboard: InlineKeyboardButton[][] = orderList.map(button => {
                        const buttons: InlineKeyboardButton[] = [button]; // The list item itself is a button to view details
                        buttons.push({ text: '❌', callback_data: `order_action:delete:${button.callback_data.split(':')[1]}` });
                        buttons.push({ text: '🚀', callback_data: `order_action:assign:${button.callback_data.split(':')[1]}` });
                        buttons.push({ text: '⚡', callback_data: `order_action:go:${button.callback_data.split(':')[1]}` });
                        return buttons;
                    });                    await bot.sendMessage(chatId, 'Select an online order or use action buttons:', { reply_markup: { inline_keyboard: inlineKeyboard } });
                }
                await bot.sendMessage(chatId, 'Online Orders:', { reply_markup: getAdminMainMenuKeyboard() });
 return;
 case '🚀 DRIVERS':
                const driverList = drivers.map(d =>
                    `${driverStatusEmoji(d.status)} ${tgUserLink(d)} - ${d.status}`
                ).join('\n');
                if (drivers.length === 0) {
                    await bot.sendMessage(chatId, "No drivers have registered yet.", { reply_markup: getAdminMainMenuKeyboard() });
                    return;
                }
                await bot.sendMessage(chatId, `<b>Connected Drivers</b>\n\n${driverList}`, { parse_mode: 'HTML', reply_markup: getAdminMainMenuKeyboard() });
                return;
            case '⚙️ SETTINGS':
                 await bot.sendMessage(chatId, "Bot Settings", {
                    reply_markup: getAdminSettingsKeyboard(chatId)
                 });
                return;
        }

        // Handle the text command for '➕ New Draft'
        if (msg.text === '➕ New Draft') {
             const newOrderId = genOrderNumber();
             const newDraftOrder: Order = {
                 id: newOrderId,
                 customer: { id: 'new_draft_customer', name: 'New Customer' }, // Default customer for a new draft
                 locationLink: '',
                 status: 'draft',
                 createdAt: new Date(),
                 items: '',
             };
             orders.push(newDraftOrder);
             setSession(fromId, { mode: 'edit', field: 'items', order_id: newOrderId }); // Set initial edit mode
             await bot.sendMessage(chatId, formatOrderDetails(newDraftOrder), {
                 reply_markup: getAdminEditKeyboard(newDraftOrder),
                 parse_mode: 'HTML',
             });
             return;
        }
    }


    if (session && session.state.mode === 'online_order_items' && msg.text) {
        const orderId = genOrderNumber();
        const customer = findOrCreateCustomer(msg.from!);
        const newOrder: Order = {
            id: orderId,
            customer: customer,
            items: msg.text,
            status: 'new_online',
            createdAt: new Date(),
            locationLink: '' // Will be filled next
        };
        orders.push(newOrder);
        setSession(fromId, { mode: 'online_order_location', order_id: orderId });
        const text = customer.language === 'ru'
            ? 'Принято! Поделитесь своим местоположением с помощью кнопки ниже.'
            : 'Noted! Share your location using the button below.';
        await bot.sendMessage(chatId, text, { reply_markup: getLocationRequestKeyboard(customer.language) });
        return;
    }
    
    if (session && session.state.mode === 'online_order_location' && msg.location) {
        const order = orders.find(o => o.id === session.state.order_id);
        if (!order) { 
            clearSession(fromId);
            return;
        }
        order.locationLink = `https://www.google.com/maps/search/?api=1&query=${msg.location.latitude},${msg.location.longitude}`;
        const customer = findOrCreateCustomer(msg.from!);
        const text = customer.language === 'ru'
            ? 'Спасибо! Ваш заказ отправлен администратору, вы получите подтверждение в течение минуты.'
            : 'Thank you! Your order has been sent to admin, you will receive a confirmation in a minute.';
        await bot.sendMessage(chatId, text, { reply_markup: { remove_keyboard: true }});
        
        // Notify admins
        const adminMessage = `📲 New online order ${order.id} from ${order.customer.name}\n${formatOrderDetails(order)}`;
        for (const id of adminUserIds) {
            await bot.sendMessage(id, adminMessage, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: getAdminActionKeyboard(order) });
        }
        clearSession(fromId);
        
        return;
    }

    if (session && session.state.mode === 'customer_cash_given' && msg.text) {
        const order = orders.find(o => o.id === session.state.order_id);
        const givenAmount = parseFloat(msg.text);
        if (order && !isNaN(givenAmount)) {
            order.payment_method = 'CASH';
            order.payment_status = 'Not paid yet';
            order.cash_given_amount = givenAmount;
            if(order.total_amount) {
                order.cash_change = givenAmount - order.total_amount;
            }
             // Notify admin
            const adminMessage = `💰 Customer for order ${order.id} will pay with ${givenAmount} cash.\n${formatOrderDetails(order)}`;
            for (const id of adminUserIds) {
                await bot.sendMessage(id, adminMessage, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: getAdminActionKeyboard(order) });
            }
            clearSession(fromId);
            await bot.sendMessage(chatId, order.customer.language === 'ru' ? "Спасибо, водитель уведомлен." : "Thank you, the driver has been notified.");
        }
         return;
    }


    if (session && session.state.mode === 'edit' && session.state.order_id) {
        const order = orders.find(o => o.id === session.state.order_id);
        if (!order) {
            clearSession(fromId);
            return;
        }

        let updatedField = session.state.field;
        let customerNotified = false;

        switch(session.state.field) {
            case 'customer':
                if (!order.customer) order.customer = { id: '0', name: '' };
                if (msg.text) order.customer.name = msg.text;
                break;
            case 'location':
                if (msg.text) order.locationLink = msg.text;
                break;
            case 'items':
                if (msg.text) order.items = msg.text;
                break;
            case 'total':
                if (msg.text) {
                    const total = parseFloat(msg.text);
                    if(!isNaN(total)) {
                        order.total_amount = total;
                        if(order.status === 'new_online' && /^\d+$/.test(order.customer.id)) {
                             const lang = order.customer.language;
                             const customerMsg = lang === 'ru'
                                ? `Уважаемый(-ая) ${order.customer.name}, ваш заказ был одобрен и готовится.\nСумма: ${order.total_amount}\nХотите оплатить НАЛИЧНЫМИ или по QR?`
                                : `Dear ${order.customer.name}, your order has been approved and is being prepared.\nTotal: ${order.total_amount}\nWould you like to pay by CASH or QR?`;
                             await bot.sendMessage(parseInt(order.customer.id, 10), customerMsg, {reply_markup: getCustomerPaymentKeyboard(order.id)});
                             customerNotified = true;
                        }
                    }
                }
                break;
            case 'cash_given':
                if (msg.text && msg.text.toLowerCase() !== 'skip') {
                    const given = parseFloat(msg.text);
                    if (!isNaN(given)) {
                        order.cash_given_amount = given;
                        if(order.total_amount) {
                            order.cash_change = given - order.total_amount;
                        }
                    }
                }
                updatedField = 'cash payment';
                break;
        }
        clearSession(fromId);

        if (!customerNotified) {
            await bot.sendMessage(chatId, `✅ Updated ${updatedField}.`);
        }
         await bot.sendMessage(chatId, formatOrderDetails(order), {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: getAdminActionKeyboard(order)
        });
        return;
    }

    if (session && session.state.mode === 'add_qr_photo' && msg.photo) {
        const file_id = msg.photo[msg.photo.length - 1].file_id; // get highest resolution
        setSession(fromId, { mode: 'add_qr_title', file_id });
        await bot.sendMessage(chatId, 'Great. Now, please send a title for this QR code.');
        return;
    }

    if (session && session.state.mode === 'add_qr_title' && msg.text) {
        const newQR: QRCode = {
            id: `qr_${Date.now()}`,
            title: msg.text,
            file_id: session.state.file_id
        };
        qrCodes.push(newQR);
        clearSession(fromId);
        await bot.sendMessage(chatId, '✅ QR Code saved successfully!');
        await bot.sendMessage(chatId, "Manage QR Codes", {
            reply_markup: getManageQRsKeyboard()
        });
        return;
    }
    
    if (session && session.state.mode === 'add_admin') {
        let newAdminId: number | undefined;
        if (msg.forward_from) {
            newAdminId = msg.forward_from.id;
        } else if (msg.text && /^\d+$/.test(msg.text)) {
            newAdminId = parseInt(msg.text, 10);
        }

        if (newAdminId) {
            if (adminUserIds.includes(newAdminId)) {
                await bot.sendMessage(chatId, 'This user is already an admin.');
            } else {
                adminUserIds.push(newAdminId);
                await bot.sendMessage(chatId, '✅ New admin added successfully!');
            }
        } else {
            await bot.sendMessage(chatId, 'Could not add admin. Please provide a valid User ID or forward a message from the user.');
        }

        clearSession(fromId);
        await bot.sendMessage(chatId, "Manage Admins", {
            reply_markup: await getManageAdminsKeyboard()
        });
        return;
    }

    if (msg.text) {
        const command = msg.text.split(' ')[0];
        switch (command) {
            case '/start':
                await handleStart(msg);
                return;
            case '/register':
                await handleRegister(msg);
                return;
            case '/disconnect':
                await handleDisconnect(msg);
                return;
        }
    }
    
    if (isAdmin(chatId) && (msg.forward_from || msg.forward_sender_name || msg.location || (msg.text && (msg.text.startsWith('http') || msg.text.includes('\n')) ))) {
        await handleNewOrder(msg);
    }
};

// Register listeners
bot.on('message', async (msg) => {
    try {
        await handleMessage(msg);
    } catch (e) {
        console.error("Error in message handler:", e);
        const fromId = msg.from?.id;
        if(fromId && isAdmin(fromId)) {
            const errorMessage = e instanceof Error ? e.message : 'An unknown error occurred';
            await bot.sendMessage(fromId, `An error occurred: ${errorMessage}`).catch(sendErr => {
                console.error("Failed to send error message to admin:", sendErr);
            });
        }
    }
});

bot.on('callback_query', async (query) => {
    try {
        await handleCallbackQuery(query);
    } catch (e) {
        console.error("Error in callback query handler:", e);
        const fromId = query.from.id;
        if(isAdmin(fromId)) {
            const errorMessage = e instanceof Error ? e.message : 'An unknown error occurred';
            await bot.sendMessage(fromId, `An error occurred: ${errorMessage}`).catch(sendErr => {
                console.error("Failed to send error message to admin:", sendErr);
            });
        }
    }
});

async function handler(req: NextRequest) {
  try {
    const body = await req.json();
    await bot.processUpdate(body);
    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    console.error('Error in webhook handler:', error);
    if (error instanceof Error) {
        return new NextResponse(JSON.stringify({ status: 'error', message: `Webhook handler failed: ${error.message}` }), { status: 500 });
    }
    return new NextResponse(JSON.stringify({ status: 'error', message: 'Unknown error in webhook handler' }), { status: 500 });
  }
}

export const POST = handler;
