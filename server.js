const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ⚠️ ЗАМЕНИТЕ НА ВАШИ ЗНАЧЕНИЯ ИЗ SUPABASE
const SUPABASE_URL = 'https://mmyfzresvqvluwcigxgi.supabase.co/rest/v1/';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1teWZ6cmVzdnF2bHV3Y2lneGdpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4MzQ3MDgsImV4cCI6MjEwNTQxMDcwOH0.T6cQMYrovdAYkepBwk68BPsc7wQTy7ISWId0yTGt6R8';

// Загружаем карты
const cardsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'cards.json'), 'utf-8'));
const cards = cardsData.cards;

// Функции для работы с Supabase
async function getUserFromDB(userId) {
    try {
        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/users?user_id=eq.${userId}&select=*`,
            {
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${SUPABASE_KEY}`
                }
            }
        );
        const data = await response.json();
        return data[0] || null;
    } catch (e) {
        console.error('Ошибка чтения из БД:', e);
        return null;
    }
}

async function saveUserToDB(userId, cardIndex, lastDate, lastCardId, hasAccess, accessDate) {
    try {
        const existing = await getUserFromDB(userId);
        
        if (existing) {
            await fetch(
                `${SUPABASE_URL}/rest/v1/users?user_id=eq.${userId}`,
                {
                    method: 'PATCH',
                    headers: {
                        'apikey': SUPABASE_KEY,
                        'Authorization': `Bearer ${SUPABASE_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        card_index: cardIndex,
                        last_date: lastDate,
                        last_card_id: lastCardId,
                        has_access: hasAccess,
                        access_date: accessDate
                    })
                }
            );
        } else {
            await fetch(
                `${SUPABASE_URL}/rest/v1/users`,
                {
                    method: 'POST',
                    headers: {
                        'apikey': SUPABASE_KEY,
                        'Authorization': `Bearer ${SUPABASE_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        user_id: userId,
                        card_index: cardIndex,
                        last_date: lastDate,
                        last_card_id: lastCardId,
                        has_access: hasAccess,
                        access_date: accessDate
                    })
                }
            );
        }
    } catch (e) {
        console.error('Ошибка записи в БД:', e);
    }
}

// Детерминированный shuffle
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

async function getTodayCard(userId) {
    const today = getToday();
    const user = await getUserFromDB(userId);
    
    if (user && user.last_date === today && user.last_card_id) {
        return cards.find(c => c.id === user.last_card_id);
    }
    
    if (!user || !user.has_access || user.access_date !== today) {
        return null;
    }
    
    const order = getUserCardOrder(userId);
    const cardIndex = user.card_index || 0;
    const card = order[cardIndex % order.length];
    
    await saveUserToDB(userId, cardIndex + 1, today, card.id, true, today);
    
    return card;
}

async function hasAccessToday(userId) {
    const today = getToday();
    const user = await getUserFromDB(userId);
    return user && user.has_access === true && user.access_date === today;
}

async function grantAccess(userId) {
    const today = getToday();
    const user = await getUserFromDB(userId);
    
    if (user) {
        await saveUserToDB(userId, user.card_index, today, user.last_card_id, true, today);
    } else {
        await saveUserToDB(userId, 0, today, null, true, today);
    }
}

// Middleware
app.use(express.json());
app.use(express.static('public'));

app.post('/api/get-card', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    
    if (await hasAccessToday(userId)) {
        const card = await getTodayCard(userId);
        return res.json({ card, alreadyReceived: true });
    }
    
    return res.status(403).json({ 
        error: 'no_access',
        message: 'Посмотрите рекламу или купите подписку'
    });
});

app.post('/api/watch-ad', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    await grantAccess(userId);
    res.json({ success: true });
});

app.post('/api/subscribe', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    await grantAccess(userId);
    res.json({ success: true });
});

app.get('/api/status/:userId', async (req, res) => {
    const { userId } = req.params;
    const user = await getUserFromDB(userId);
    res.json({
        hasAccessToday: await hasAccessToday(userId),
        totalCardsReceived: user?.card_index || 0,
        lastCardDate: user?.last_date || null
    });
});

app.listen(PORT, () => {
    console.log(`✅ Сервер запущен на http://localhost:${PORT}`);
});
