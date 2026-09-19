const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== SUPABASE НАСТРОЙКИ =====
// Если переменные окружения не заданы — используем значения по умолчанию (для локального теста)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ВАШ_ПРОЕКТ.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'ВАШ_ANON_KEY';
const USE_SUPABASE = SUPABASE_URL.includes('supabase.co');

console.log(' Supabase URL:', SUPABASE_URL);
console.log('🔑 Supabase Key:', SUPABASE_KEY ? '***' + SUPABASE_KEY.slice(-10) : 'НЕ ЗАДАН');
console.log(' Режим:', USE_SUPABASE ? 'Supabase' : 'Локальный файл db.json');

const cardsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'cards.json'), 'utf-8'));
const cards = cardsData.cards;

// ===== ЛОКАЛЬНАЯ БД (fallback) =====
const DB_PATH = path.join(__dirname, 'db.json');

function loadLocalDB() {
    try {
        return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    } catch {
        return {};
    }
}

function saveLocalDB(db) {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ===== SUPABASE ФУНКЦИИ =====
async function supabaseRequest(method, urlPath, body = null) {
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
    
    console.log(`  📥 Status: ${res.status}, Body: ${text.slice(0, 200)}`);
    
    if (!res.ok) {
        throw new Error(`Supabase error ${res.status}: ${text}`);
    }
    
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

async function getUserFromSupabase(userId) {
    try {
        const result = await supabaseRequest('GET', `users?user_id=eq.${userId}&select=*`);
        return Array.isArray(result) ? result[0] : null;
    } catch (e) {
        console.error('  ❌ getUserFromSupabase error:', e.message);
        return null;
    }
}

async function upsertUser(userId, data) {
    try {
        // Пробуем INSERT с on conflict (upsert)
        const result = await supabaseRequest('POST', 'users', {
            user_id: userId,
            ...data
        });
        console.log('  ✅ Upsert success');
        return true;
    } catch (e) {
        console.error('  ❌ Upsert error:', e.message);
        // Если конфликт — пробуем PATCH
        try {
            await supabaseRequest('PATCH', `users?user_id=eq.${userId}`, data);
            console.log('  ✅ Patch success');
            return true;
        } catch (e2) {
            console.error('  ❌ Patch error:', e2.message);
            return false;
        }
    }
}

// ===== ЛОГИКА =====
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

async function getUserData(userId) {
    if (USE_SUPABASE) {
        return await getUserFromSupabase(userId);
    } else {
        const db = loadLocalDB();
        return db[userId] || null;
    }
}

async function saveUserData(userId, data) {
    if (USE_SUPABASE) {
        return await upsertUser(userId, data);
    } else {
        const db = loadLocalDB();
        db[userId] = { ...db[userId], ...data };
        saveLocalDB(db);
        return true;
    }
}

async function hasAccessToday(userId) {
    const today = getToday();
    const user = await getUserData(userId);
    
    if (!user) {
        console.log(`  🔍 hasAccessToday: пользователь не найден`);
        return false;
    }
    
    // Supabase возвращает boolean как true/false, локальная БД тоже
    const hasAccess = user.has_access === true || user.hasAccess === true;
    const accessDate = user.access_date || user.accessDate;
    
    console.log(`  🔍 hasAccessToday: hasAccess=${hasAccess}, accessDate=${accessDate}, today=${today}`);
    
    return hasAccess && accessDate === today;
}

async function grantAccess(userId) {
    const today = getToday();
    console.log(`  🔑 grantAccess: userId=${userId}, today=${today}`);
    
    const user = await getUserData(userId);
    
    const data = {
        has_access: true,
        access_date: today,
        card_index: user ? (user.card_index || 0) : 0,
        last_date: user ? (user.last_date || '') : '',
        last_card_id: user ? (user.last_card_id || null) : null
    };
    
    const success = await saveUserData(userId, data);
    console.log(`   grantAccess result: ${success}`);
    return success;
}

async function getTodayCard(userId) {
    const today = getToday();
    const user = await getUserData(userId);
    
    // Если сегодня уже получал — возвращаем ту же
    const lastDate = user ? (user.last_date || user.lastDate) : null;
    const lastCardId = user ? (user.last_card_id || user.lastCardId) : null;
    
    if (lastDate === today && lastCardId) {
        console.log(`  🃏 Возвращаем ту же карту: ${lastCardId}`);
        return cards.find(c => c.id === lastCardId);
    }
    
    // Проверяем доступ
    if (!await hasAccessToday(userId)) {
        console.log(`  🃏 Нет доступа`);
        return null;
    }
    
    // Берём следующую карту
    const order = getUserCardOrder(userId);
    const cardIndex = user ? (user.card_index || user.cardIndex || 0) : 0;
    const card = order[cardIndex % order.length];
    
    console.log(`  🃏 Новая карта: ${card.id} - ${card.title}, cardIndex=${cardIndex}`);
    
    // Сохраняем
    await saveUserData(userId, {
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
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    
    const hasAccess = await hasAccessToday(userId);
    console.log(`  hasAccessToday: ${hasAccess}`);
    
    if (hasAccess) {
        const card = await getTodayCard(userId);
        if (card) {
            return res.json({ card, alreadyReceived: true });
        }
    }
    
    return res.status(403).json({ error: 'no_access' });
});

app.post('/api/watch-ad', async (req, res) => {
    console.log('\n📥 POST /api/watch-ad');
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    
    const success = await grantAccess(userId);
    if (success) {
        res.json({ success: true });
    } else {
        res.status(500).json({ error: 'Failed to save access' });
    }
});

app.post('/api/subscribe', async (req, res) => {
    console.log('\n📥 POST /api/subscribe');
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    
    const success = await grantAccess(userId);
    if (success) {
        res.json({ success: true });
    } else {
        res.status(500).json({ error: 'Failed to save access' });
    }
});

app.get('/api/status/:userId', async (req, res) => {
    const { userId } = req.params;
    const user = await getUserData(userId);
    res.json({
        hasAccessToday: await hasAccessToday(userId),
        totalCardsReceived: user?.card_index || user?.cardIndex || 0,
        lastCardDate: user?.last_date || user?.lastDate || null
    });
});

app.listen(PORT, () => {
    console.log(`\n✅ Сервер запущен на http://localhost:${PORT}`);
});
