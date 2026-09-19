const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

// ===== НАСТРОЙКИ SUPABASE =====
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

const USE_SUPABASE = SUPABASE_URL.includes('.supabase.co') && 
                     SUPABASE_KEY.startsWith('eyJ') &&
                     !SUPABASE_URL.includes('ВАШ');

console.log('\n========================================');
console.log('🚀 Сервер запускается');
console.log('📡 SUPABASE_URL:', SUPABASE_URL || '(не задан)');
console.log('🔑 SUPABASE_KEY:', SUPABASE_KEY ? '***' + SUPABASE_KEY.slice(-8) : '(не задан)');
console.log('⚙️  Режим:', USE_SUPABASE ? 'SUPABASE' : 'ЛОКАЛЬНЫЙ ФАЙЛ db.json');
console.log('========================================\n');

const cardsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'cards.json'), 'utf-8'));
const cards = cardsData.cards;

// ===== ЛОКАЛЬНАЯ БД (Fallback) =====
const DB_PATH = path.join(__dirname, 'db.json');

function loadLocalDB() {
    try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')); } 
    catch { return {}; }
}

function saveLocalDB(db) {
    try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); } 
    catch (e) { console.error('❌ Ошибка записи db.json:', e.message); }
}

// ===== SUPABASE ФУНКЦИИ =====
async function supabaseQuery(method, urlPath, body = null) {
    const url = `${SUPABASE_URL}/rest/v1/${urlPath}`;
    const headers = {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
    };
    
    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);
    
    const res = await fetch(url, options);
    const text = await res.text();
    
    if (!res.ok) {
        console.error(`  ❌ Supabase ${res.status}: ${text.slice(0, 200)}`);
        throw new Error(`Supabase ${res.status}`);
    }
    
    try { return JSON.parse(text); } 
    catch { return null; }
}

async function getUserSupabase(userId) {
    try {
        const result = await supabaseQuery('GET', `users?user_id=eq.${encodeURIComponent(userId)}&select=*`);
        return Array.isArray(result) && result.length > 0 ? result[0] : null;
    } catch (e) {
        console.error('  ❌ getUserSupabase:', e.message);
        return null;
    }
}

async function saveUserSupabase(userId, data) {
    try {
        const existing = await getUserSupabase(userId);
        if (existing) {
            await supabaseQuery('PATCH', `users?user_id=eq.${encodeURIComponent(userId)}`, data);
        } else {
            await supabaseQuery('POST', 'users', { user_id: userId, ...data });
        }
        return true;
    } catch (e) {
        console.error('  ❌ saveUserSupabase:', e.message);
        return false;
    }
}

// ===== УНИВЕРСАЛЬНЫЕ ФУНКЦИИ =====
function shuffleWithSeed(array, seed) {
    const result = [...array];
    let m = result.length;
    let seedNum = parseInt(seed.substring(0, 8), 16);
    while (m) {
        seedNum = (seedNum * 1103515245 + 12345) & 0x7fffffff;
        const i = seedNum % m--;
        [result[m], result[i]] = [result[i], result[m]];
    }
    return result;
}

function getUserCardOrder(userId) {
    const seed = crypto.createHash('sha256')
        .update(userId + '_my_secret_salt_2026')
        .digest('hex');
    return shuffleWithSeed(cards, seed);
}

function getToday() {
    return new Date().toISOString().split('T')[0];
}

function normalizeUser(user) {
    if (!user) return null;
    return {
        card_index: user.card_index ?? user.cardIndex ?? 0,
        last_date: user.last_date ?? user.lastDate ?? null,
        last_card_id: user.last_card_id ?? user.lastCardId ?? null,
        has_access: user.has_access ?? user.hasAccess ?? false,
        access_date: user.access_date ?? user.accessDate ?? null
    };
}

async function getUser(userId) {
    if (USE_SUPABASE) {
        const user = await getUserSupabase(userId);
        return normalizeUser(user);
    } else {
        const db = loadLocalDB();
        return normalizeUser(db[userId]);
    }
}

async function saveUser(userId, data) {
    if (USE_SUPABASE) {
        return await saveUserSupabase(userId, data);
    } else {
        const db = loadLocalDB();
        const existing = db[userId] || {};
        db[userId] = { ...existing, ...data };
        saveLocalDB(db);
        return true;
    }
}

async function hasAccessToday(userId) {
    const today = getToday();
    const user = await getUser(userId);
    if (!user) return false;
    return user.has_access === true && user.access_date === today;
}

async function grantAccess(userId) {
    const today = getToday();
    const user = await getUser(userId);
    const cardIndex = user ? user.card_index : 0;
    
    const data = {
        has_access: true,
        access_date: today,
        card_index: cardIndex,
        last_date: user ? user.last_date : null,
        last_card_id: user ? user.last_card_id : null
    };
    
    return await saveUser(userId, data);
}

async function getTodayCard(userId) {
    const today = getToday();
    const user = await getUser(userId);
    
    if (user && user.last_date === today && user.last_card_id) {
        return cards.find(c => c.id === user.last_card_id);
    }
    
    if (!await hasAccessToday(userId)) {
        return null;
    }
    
    const order = getUserCardOrder(userId);
    const cardIndex = user ? user.card_index : 0;
    const card = order[cardIndex % order.length];
    
    await saveUser(userId, {
        card_index: cardIndex + 1,
        last_date: today,
        last_card_id: card.id,
        has_access: true,
        access_date: today
    });
    
    return card;
}

// ===== API МАРШРУТЫ =====
app.use(express.json());
app.use(express.static('public'));

app.post('/api/get-card', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: 'userId required' });
        
        if (await hasAccessToday(userId)) {
            const card = await getTodayCard(userId);
            if (card) return res.json({ card, alreadyReceived: true });
        }
        return res.status(403).json({ error: 'no_access' });
    } catch (e) {
        console.error('❌ Ошибка get-card:', e.message);
        return res.status(500).json({ error: e.message });
    }
});

app.post('/api/watch-ad', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: 'userId required' });
        
        const success = await grantAccess(userId);
        return success ? res.json({ success: true }) : res.status(500).json({ error: 'Failed to save' });
    } catch (e) {
        console.error('❌ Ошибка watch-ad:', e.message);
        return res.status(500).json({ error: e.message });
    }
});

app.post('/api/subscribe', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: 'userId required' });
        
        const success = await grantAccess(userId);
        return success ? res.json({ success: true }) : res.status(500).json({ error: 'Failed to save' });
    } catch (e) {
        console.error('❌ Ошибка subscribe:', e.message);
        return res.status(500).json({ error: e.message });
    }
});

app.get('/api/status/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const user = await getUser(userId);
        res.json({
            hasAccessToday: await hasAccessToday(userId),
            totalCardsReceived: user?.card_index || 0,
            lastCardDate: user?.last_date || null,
            mode: USE_SUPABASE ? 'supabase' : 'local'
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===== ЕЖЕДНЕВНЫЕ НАПОМИНАНИЯ =====
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const REMINDER_SECRET = 'my_secret_key_2026';
const APP_URL = 'https://metaphor-cards.onrender.com';

app.get('/api/send-reminders', async (req, res) => {
    // Защита: вызвать может только тот, кто знает секретный ключ
    if (req.query.key !== REMINDER_SECRET) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    
    if (!BOT_TOKEN) {
        return res.status(500).json({ error: 'BOT_TOKEN не задан в Environment' });
    }
    
    try {
        const today = getToday();
        let users = [];
        
        // Получаем всех пользователей из Supabase
        if (USE_SUPABASE) {
            const result = await supabaseQuery('GET', 'users?select=user_id,access_date');
            if (Array.isArray(result)) {
                // Оставляем только тех, кто сегодня ещё НЕ получал карту
                users = result
                    .filter(u => u.access_date !== today)
                    .map(u => u.user_id);
            }
        } else {
            const db = loadLocalDB();
            users = Object.keys(db).filter(id => db[id].access_date !== today);
        }
        
        let sent = 0, failed = 0;
        
        for (const userId of users) {
            // Пропускаем тестовых пользователей
            if (String(userId).startsWith('test_')) continue;
            
            try {
                const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: userId,
                        text: '🎴 <b>Твоя карта дня готова!</b>\n\nВселенная приготовила для тебя новое послание. Нажми кнопку, чтобы открыть его.',
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [[{
                                text: '🎴 Получить карту',
                                web_app: { url: APP_URL }
                            }]]
                        }
                    })
                });
                
                if (response.ok) {
                    sent++;
                } else {
                    failed++;
                }
                
                // Пауза 100мс, чтобы не превысить лимиты Telegram
                await new Promise(r => setTimeout(r, 100));
            } catch (e) {
                failed++;
            }
        }
        
        console.log(`📨 Напоминания: отправлено ${sent}, ошибок ${failed}`);
        res.json({ success: true, sent, failed, total: users.length });
    } catch (e) {
        console.error('❌ Ошибка напоминаний:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Сервер запущен на http://localhost:${PORT}`);
});
