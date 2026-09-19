const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== ПРОВЕРКА SUPABASE =====
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

// Включаем Supabase ТОЛЬКО если заданы реальные значения
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

// ===== ЛОКАЛЬНАЯ БД =====
const DB_PATH = path.join(__dirname, 'db.json');

function loadLocalDB() {
    try {
        return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    } catch {
        return {};
    }
}

function saveLocalDB(db) {
    try {
        fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    } catch (e) {
        console.error('❌ Ошибка записи db.json:', e.message);
    }
}

// ===== SUPABASE =====
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
    
    console.log(`  📡 ${method} ${urlPath}`);
    
    const res = await fetch(url, options);
    const text = await res.text();
    
    console.log(`  📥 Status: ${res.status}`);
    if (!res.ok) {
        console.error(`  ❌ Response: ${text.slice(0, 300)}`);
        throw new Error(`Supabase ${res.status}: ${text}`);
    }
    
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
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
        // Сначала пробуем получить существующего
        const existing = await getUserSupabase(userId);
        
        if (existing) {
            // Обновляем
            await supabaseQuery('PATCH', `users?user_id=eq.${encodeURIComponent(userId)}`, data);
        } else {
            // Создаём
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

// Нормализация данных пользователя (унифицируем поля из Supabase и локальной БД)
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
    
    if (!user) {
        console.log(`  🔍 hasAccessToday: пользователь ${userId} не найден`);
        return false;
    }
    
    const result = user.has_access === true && user.access_date === today;
    console.log(`  🔍 hasAccessToday: has_access=${user.has_access}, access_date=${user.access_date}, today=${today} => ${result}`);
    return result;
}

async function grantAccess(userId) {
    const today = getToday();
    console.log(`   grantAccess: userId=${userId}, today=${today}`);
    
    const user = await getUser(userId);
    const cardIndex = user ? user.card_index : 0;
    
    const data = {
        has_access: true,
        access_date: today,
        card_index: cardIndex,
        last_date: user ? user.last_date : null,
        last_card_id: user ? user.last_card_id : null
    };
    
    const success = await saveUser(userId, data);
    console.log(`  ✅ grantAccess result: ${success}`);
    return success;
}

async function getTodayCard(userId) {
    const today = getToday();
    const user = await getUser(userId);
    
    // Если сегодня уже получал — возвращаем ту же
    if (user && user.last_date === today && user.last_card_id) {
        console.log(`  🃏 Возвращаем сохранённую карту: ${user.last_card_id}`);
        return cards.find(c => c.id === user.last_card_id);
    }
    
    // Проверяем доступ
    if (!await hasAccessToday(userId)) {
        console.log(`  🃏 Нет доступа на сегодня`);
        return null;
    }
    
    // Берём следующую карту
    const order = getUserCardOrder(userId);
    const cardIndex = user ? user.card_index : 0;
    const card = order[cardIndex % order.length];
    
    console.log(`  🃏 Новая карта: id=${card.id}, title="${card.title}", cardIndex=${cardIndex}`);
    
    // Сохраняем
    await saveUser(userId, {
        card_index: cardIndex + 1,
        last_date: today,
        last_card_id: card.id,
        has_access: true,
        access_date: today
    });
    
    return card;
}

// ===== API =====
app.use(express.json());
app.use(express.static('public'));

app.post('/api/get-card', async (req, res) => {
    console.log('\n📥 POST /api/get-card');
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: 'userId required' });
        
        if (await hasAccessToday(userId)) {
            const card = await getTodayCard(userId);
            if (card) {
                return res.json({ card, alreadyReceived: true });
            }
        }
        
        return res.status(403).json({ error: 'no_access' });
    } catch (e) {
        console.error('❌ Ошибка в get-card:', e.message);
        return res.status(500).json({ error: e.message });
    }
});

app.post('/api/watch-ad', async (req, res) => {
    console.log('\n POST /api/watch-ad');
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: 'userId required' });
        
        const success = await grantAccess(userId);
        if (success) {
            return res.json({ success: true });
        } else {
            return res.status(500).json({ error: 'Failed to save' });
        }
    } catch (e) {
        console.error('❌ Ошибка в watch-ad:', e.message);
        return res.status(500).json({ error: e.message });
    }
});

app.post('/api/subscribe', async (req, res) => {
    console.log('\n📥 POST /api/subscribe');
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: 'userId required' });
        
        const success = await grantAccess(userId);
        if (success) {
            return res.json({ success: true });
        } else {
            return res.status(500).json({ error: 'Failed to save' });
        }
    } catch (e) {
        console.error('❌ Ошибка в subscribe:', e.message);
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

app.listen(PORT, () => {
    console.log(`✅ Сервер запущен на http://localhost:${PORT}`);
});
