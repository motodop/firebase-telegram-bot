import { QRCode } from '@/types';
import TelegramBot, { InlineKeyboardMarkup, InlineKeyboardButton, ReplyKeyboardMarkup, KeyboardButton, User } from 'node-telegram-bot-api';

// Assuming these types and data structures are needed by the keyboard functions
// You might need to adjust imports based on where these are defined in your actual project
export interface Order {
    id: string;
    customer: Customer;
    locationLink: string;
    status: 'draft' | 'new' | 'new_online' | 'active_ready' | 'active_pickedup' | 'arrived' | 'completed' | 'cancelled';
    createdAt: Date;
    driverId?: string;
    items: string;
    payment_method?: 'CASH' | 'QR';
    payment_status?: 'PAID' | 'Not paid yet';
    total_amount?: number;
    cash_given_amount?: number;
    cash_change?: number;
    feedback?: 1 | 2 | 3 | 4 | 5;
}

export interface Customer {
    id: string; // Telegram User ID or a generated ID for forwarded messages
    name: string;
    language?: 'en' | 'ru';
}

export interface Driver {
    id: string; // Telegram User ID
    name: string;
    status: 'offline' | 'online' | 'assigned' | 'busy' | 'blocked';
    currentOrderId?: string;
    // Add other driver-specific properties as needed
}

// These data structures are likely needed to populate keyboards
// You will need to import or define these as well
declare const drivers: Driver[];
declare const qrCodes: QRCode[];
declare const adminUserIds: number[];
declare const primaryAdminId: number;
declare const adminLanguagePrefs: Map<number, 'en' | 'ru'>;


// Assuming this helper is needed by the keyboard functions
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


// --- Keyboards ---

export const getAdminMainMenuKeyboard = (): ReplyKeyboardMarkup => ({
    keyboard: [
        [{ text: '💾 SAVED' }, { text: '⚡ ACTIVE' }, { text: '✅ COMPLETED' }],
        [{ text: '🆕 ONLINE' }, { text: '⚙️ SETTINGS' }, { text: '➕ New Draft' }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false
});

export const getAdminActionKeyboard = (order: Order): InlineKeyboardMarkup => {
    const keyboard: InlineKeyboardButton[][] = [];

    const isActiveOrder = ['active_ready', 'active_pickedup', 'arrived'].includes(order.status);

    const editButton: InlineKeyboardButton[] = [
        { text: '✏️ Edit', callback_data: `edit_menu:${order.id}` },
    ];
     if (!['new', 'draft', 'new_online'].includes(order.status)) {
        editButton.push({ text: '❌ Cancel', callback_data: `cancel:${order.id}` });
    }

    const actionRow = [...editButton];
    if (order.status === 'completed') {
        actionRow.push({ text: '🗃️ Archive', callback_data: `admin_archive:${order.id}` });
    }
    keyboard.push(actionRow);

    if (isActiveOrder) {
        const actionButtons: InlineKeyboardButton[] = [
            { text: '🏁 Arrived', callback_data: `driver:arrived:${order.id}` },
            { text: '✅ Completed', callback_data: `driver:completed:${order.id}` },
            { text: ' Ping Driver', callback_data: `customer_ping:${order.id}` },
        ];
        keyboard.push(actionButtons);
    }

    // GO button for new/draft orders
    if (['new', 'draft', 'new_online'].includes(order.status)) {
        keyboard.push([{ text: '⚡ GO', callback_data: `go:${order.id}`}]);
    }

    return { inline_keyboard: keyboard };
};

export const getAdminEditKeyboard = (order: Order): InlineKeyboardMarkup => {
    const keyboard: InlineKeyboardButton[][] = [];

    const row1: InlineKeyboardButton[] = [
        { text: '👤 Customer', callback_data: `edit:customer:${order.id}` },
        { text: '📍 Location', callback_data: `edit:location:${order.id}` },
    ];
    keyboard.push(row1);

     const row2: InlineKeyboardButton[] = [
        { text: '🚀 Driver', callback_data: `edit:driver:${order.id}` },
        { text: '💸 Total', callback_data: `edit:total:${order.id}` },
    ];
    keyboard.push(row2);

    const row3: InlineKeyboardButton[] = [
        { text: '📃 Items', callback_data: `edit:items:${order.id}` },
        { text: '💳 Payment', callback_data: `edit:payment:${order.id}`},
    ];
     if (!order.customer.language) {
        row3.push({ text: '🇷🇺 Russian customer', callback_data: `edit:lang_ru:${order.id}` });
    }
     keyboard.push(row3);



    const rowFinal: InlineKeyboardButton[] = [
        { text: '💾 Save', callback_data: `save:${order.id}` },
        { text: '❌ Cancel', callback_data: `cancel:${order.id}` },
        { text: '⬅️ Back', callback_data: `detail:${order.id}` }
    ];
    keyboard.push(rowFinal);

    return { inline_keyboard: keyboard };
};

export const getCompletedOrderKeyboard = (order: Order): InlineKeyboardMarkup => ({
    inline_keyboard: [
        [{ text: '🗃️ Archive', callback_data: `archive:${order.id}` }]
    ]
});

export const getPaymentKeyboard = (orderId: string): InlineKeyboardMarkup => ({
    inline_keyboard: [
        [{ text: "💳 CASH", callback_data: `payment:CASH:${orderId}`},
         { text: "💳 QR", callback_data: `payment:QR:${orderId}`}],
        [{ text: "💲 Mark as PAID", callback_data: `payment:PAID:${orderId}`}],
        [{ text: "⬅️ Back", callback_data: `edit_menu:${orderId}`}]
    ]
});

export const getConnectedDriversKeyboard = (orderId: string): InlineKeyboardMarkup => {
    const onlineDrivers = drivers.filter(d => ['online', 'busy', 'assigned'].includes(d.status));
    if (onlineDrivers.length === 0) {
        return { inline_keyboard: [[{ text: "No drivers online", callback_data: "none" }]] };
    }
    const keyboard: InlineKeyboardButton[][] = onlineDrivers.map(d => ([{
        text: `${driverStatusEmoji(d.status)} ${d.name}`, // Assuming driverStatusEmoji is needed and available
        callback_data: `assign:${d.id}:${orderId}`
    }]));
    keyboard.push([{ text: "Back to Order", callback_data: `edit_menu:${orderId}` }]);
    return { inline_keyboard: keyboard };
}

export const getDriverActionKeyboard = (order: Order): InlineKeyboardMarkup => {
    const keyboard: InlineKeyboardButton[][] = [];

    if (order.status === 'active_ready') {
        keyboard.push([{ text: "🛍️ Pick-up", callback_data: `driver:pickup:${order.id}`}]);
    } else if (order.status === 'active_pickedup' || order.status === 'arrived') {
        const mainButtons: InlineKeyboardButton[] = [
             { text: "🏁 Arrived", callback_data: `driver:arrived:${order.id}` },
             { text: "✅ Completed", callback_data: `driver:completed:${order.id}` },
        ];
       keyboard.push(mainButtons);

        const otherButtons: InlineKeyboardButton[] = [
             { text: "🚩 location", callback_data: `driver:location:${order.id}`},
             { text: "⏰ Notify Delay", callback_data: `driver:delay:${order.id}` },
             { text: "❌ Cancel", callback_data: `driver:cancel_request:${order.id}` },
        ];
        keyboard.push(otherButtons);
    }
    return { inline_keyboard: keyboard };
};

export const getDriverEditKeyboard = (orderId: string): InlineKeyboardMarkup => {
    return { inline_keyboard: [
        [{ text: '💾 Save', callback_data: `driver:save:${orderId}` }, { text: '❌ Cancel', callback_data: `driver:cancel_edit:${orderId}` }]
    ]};
}

export const getCustomerPaymentKeyboard = (orderId: string): InlineKeyboardMarkup => ({
    inline_keyboard: [
        [{ text: "💳 CASH", callback_data: `customer_pay:CASH:${orderId}`},
         { text: "💳 QR", callback_data: `customer_pay:QR:${orderId}`}],
    ]
});

export const getCustomerQRDoneKeyboard = (orderId: string): InlineKeyboardMarkup => ({
    inline_keyboard: [
        [{ text: "Done", callback_data: `customer_pay:QR_DONE:${orderId}`}]
    ]
});

export const getCustomerPingKeyboard = (orderId: string, lang: 'ru' | 'en' = 'en'): InlineKeyboardMarkup => ({
    inline_keyboard: [
        [{ text: lang === 'ru' ? "📍 Пинг водителя" : "Ping Driver", callback_data: `customer_ping:${orderId}` }] // Assuming order.id is available here
    ]
});

export const getLanguageKeyboard = (): InlineKeyboardMarkup => ({
    inline_keyboard: [
        [{ text: "English 🇬🇧", callback_data: `lang:en` }],
        [{ text: "Russian 🇷🇺", callback_data: `lang:ru` }]
    ]
});

export const getLocationRequestKeyboard = (language: 'en' | 'ru' = 'en'): ReplyKeyboardMarkup => ({
    keyboard: [[{
        text: language === 'ru' ? "📍 Поделиться местоположением" : "📍 Share Location",
        request_location: true
    }]],
    resize_keyboard: true,
    one_time_keyboard: true
});


export const getDelayKeyboard = (orderId: string): InlineKeyboardMarkup => ({
    inline_keyboard: [
        [{ text: "⌛ <5mn", callback_data: `delay:lt5:${orderId}` }],
        [{ text: "🏁 <2mn", callback_data: `delay:lt2:${orderId}` }],
        [{ text: "🚧 >10mn", callback_data: `delay:gt10:${orderId}` }],
        [{ text: "⬅️ Back", callback_data: `driver:active_order_detail:${orderId}`}]
    ]
});

export const getFeedbackKeyboard = (orderId: string, lang: 'ru' | 'en' = 'en'): InlineKeyboardMarkup => ({
    inline_keyboard: [
        [{ text: "1⭐", callback_data: `fb:1:${orderId}` },
         { text: "2⭐", callback_data: `fb:2:${orderId}` },
         { text: "3⭐", callback_data: `fb:3:${orderId}` },
         { text: "4⭐", callback_data: `fb:4:${orderId}` },
         { text: "5⭐", callback_data: `fb:5:${orderId}` }]
    ]
});

export const getAdminSettingsKeyboard = (adminId: number): InlineKeyboardMarkup => {
    const currentLang = adminLanguagePrefs.get(adminId) || 'en';
    const langButton = currentLang === 'en'
        ? { text: "Set Russian language", callback_data: "admin_set_lang_ru" }
        : { text: "Set English language", callback_data: "admin_set_lang_en" };

    return {
        inline_keyboard: [
            [{ text: "Manage Admins", callback_data: "admin_manage_admins" }],
            [{ text: "Manage QR Codes", callback_data: "admin_manage_qrs" }],
            [{ text: "Manage Drivers", callback_data: "admin_manage_drivers" }],
            [{ text: '🗄️ Archive', callback_data: 'admin_archive' }],
            [langButton],
            [{ text: "⬅️ Back to Main Menu", callback_data: "admin_main_menu" }]
        ]
    };
}

export const getManageQRsKeyboard = (): InlineKeyboardMarkup => {
    const qrButtons: InlineKeyboardButton[][] = qrCodes.map(qr => ([
        { text: `QR: ${qr.title}`, callback_data: `qr:view:${qr.id}` },
        { text: `🗑️`, callback_data: `qr:delete:${qr.id}` }
    ]));

    return {
        inline_keyboard: [
            ...qrButtons,
            [{ text: "➕ Add New QR", callback_data: "admin_add_qr" }],
            [{ text: "⬅️ Back to Settings", callback_data: "admin_settings" }]
        ]
    };
};

export const getManageAdminsKeyboard = async (): Promise<InlineKeyboardMarkup> => {
    const adminButtons: InlineKeyboardButton[][] = [];
    // Note: Accessing 'bot' here would require passing it as an argument or importing it
    // For now, assuming bot.getChat is handled elsewhere or this function is passed a way to get user info
    // The original code directly used 'bot' which is defined in route.ts
    // You will need to adjust this based on how you structure imports and dependencies
    for (const adminId of adminUserIds) {
        let buttonText = `${adminId}`;
        // try {
        //     const user = await bot.getChat(adminId);
        //     if(user.first_name || user.username) {
        //         buttonText = `${user.first_name || ''} ${user.last_name || ''} (@${user.username || 'N/A'})`.trim();
        //     }
        // } catch (e) {
        //     console.error(`Could not fetch info for admin ID ${adminId}`, e);
        // }

        const buttons = [{ text: buttonText, callback_data: `admin:view:${adminId}` }];
        if (adminId !== primaryAdminId) {
            buttons.push({ text: '🗑️', callback_data: `admin:remove:${adminId}` });
        }
        adminButtons.push(buttons);
    }

    return {
        inline_keyboard: [
            ...adminButtons,
            [{ text: "➕ Add New Admin", callback_data: "admin_add_admin" }],
            [{ text: "⬅️ Back to Settings", callback_data: "admin_settings" }]
        ]
    };
};

function driverStatusEmoji(status: string) {
    throw new Error('Function not implemented.');
}

export type { User };