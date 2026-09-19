const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const cardsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'cards.json'), 'utf-8'));
const cards = cardsData.cards;

const DB_PATH = path.join(__dirname, 'db.json');

function loadDB() {
    try {
        return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    } catch {
        return {};
    }
}

function saveDB(db) {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

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

function getTodayCard(userId) {
    const db = loadDB();
    const today = getToday();
    const user = db[userId] || { 
        cardIndex: 0, 
        lastDate: null, 
        lastCard: null,
        hasAccess: false,
        accessDate: null
    };
    
    if (user.lastDate === today && user.lastCard) {
        return user.lastCard;
    }
    
    if (!user.hasAccess || user.accessDate !== today) {
        return null;
    }
    
    const order = getUserCardOrder(userId);
    const card = order[user.cardIndex % order.length];
    
    user.cardIndex = user.cardIndex + 1;
    user.lastDate = today;
    user.lastCard = card;
    db[userId] = user;
    saveDB(db);
    
    return card;
}

function hasAccessToday(userId) {
    const db = loadDB();
    const today = getToday();
    const user = db[userId];
    return user && user.hasAccess && user.accessDate === today;
}

function grantAccess(userId) {
    const db = loadDB();
    const today = getToday();
    const user = db[userId] || { cardIndex: 0, lastDate: null, lastCard: null };
    user.hasAccess = true;
    user.accessDate = today;
    db[userId] = user;
    saveDB(db);
}

app.use(express.json());
app.use(express.static('public'));

app.post('/api/get-card', (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    
    if (hasAccessToday(userId)) {
        const card = getTodayCard(userId);
        return res.json({ card, alreadyReceived: true });
    }
    
    return res.status(403).json({ 
        error: 'no_access',
        message: 'Посмотрите рекламу или купите подписку'
    });
});

app.post('/api/watch-ad', (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    grantAccess(userId);
    res.json({ success: true });
});

app.post('/api/subscribe', (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    grantAccess(userId);
    res.json({ success: true });
});

app.get('/api/status/:userId', (req, res) => {
    const { userId } = req.params;
    const db = loadDB();
    const user = db[userId];
    res.json({
        hasAccessToday: hasAccessToday(userId),
        totalCardsReceived: user?.cardIndex || 0,
        lastCardDate: user?.lastDate || null
    });
});

app.listen(PORT, () => {
    console.log(`✅ Сервер запущен на http://localhost:${PORT}`);
});