// backend/notifications.js
// Version: 1.00
// Updated: 2026-06-11 12:00
// TreasureScan v3.1.0 — FCM Server-side Notifications
// Endpoints: POST /fcm/register, POST /fcm/send, POST /fcm/send-to-all
// Scheduled jobs: streak_warning (20:00), vault_ready check

const admin = require('firebase-admin');

// ── FCM token store (Firestore /fcm_tokens/{uid}) ──────────────
// Структура: { uid, token, lang, updatedAt }

// ── Register token ─────────────────────────────────────────────
async function registerToken(req, res) {
  try {
    const { token, uid, lang } = req.body;
    if (!token) return res.status(400).json({ error: 'token required' });

    const db = admin.firestore();
    await db.collection('fcm_tokens').doc(uid || token.slice(-20)).set({
      token,
      uid:       uid || '',
      lang:      lang || 'bg',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    res.json({ ok: true });
  } catch (e) {
    console.error('FCM register error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── Send to single token ───────────────────────────────────────
async function sendToToken(token, title, body, data = {}) {
  try {
    await admin.messaging().send({
      token,
      notification: { title, body },
      data: { ...data },
      android: {
        notification: {
          channelId: 'treasurescan_channel',
          color:     '#FFD700',
          priority:  'high',
        },
        priority: 'high',
      },
    });
    return true;
  } catch (e) {
    console.error('FCM send error:', e.message);
    return false;
  }
}

// ── Send notification endpoint (manual / from admin) ───────────
async function sendNotification(req, res) {
  try {
    const { uid, type, lang = 'bg' } = req.body;
    if (!uid || !type) return res.status(400).json({ error: 'uid and type required' });

    const db = admin.firestore();
    const tokenDoc = await db.collection('fcm_tokens').doc(uid).get();
    if (!tokenDoc.exists) return res.status(404).json({ error: 'token not found' });

    const { token } = tokenDoc.data();
    const { title, body } = getNotificationContent(type, lang, req.body);

    const ok = await sendToToken(token, title, body, { type, ...req.body });
    res.json({ ok });
  } catch (e) {
    console.error('Send notification error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── Broadcast to all users with a specific lang ────────────────
async function sendToAll(req, res) {
  try {
    const { type, lang, data = {} } = req.body;
    if (!type) return res.status(400).json({ error: 'type required' });

    const db = admin.firestore();
    let query = db.collection('fcm_tokens');
    if (lang) query = query.where('lang', '==', lang);

    const snap = await query.get();
    if (snap.empty) return res.json({ sent: 0 });

    const { title, body } = getNotificationContent(type, lang || 'bg', data);

    // FCM multicast — max 500 per batch
    const tokens = snap.docs.map(d => d.data().token).filter(Boolean);
    const chunks = chunkArray(tokens, 500);

    let sent = 0;
    for (const chunk of chunks) {
      const response = await admin.messaging().sendEachForMulticast({
        tokens: chunk,
        notification: { title, body },
        data: { type, ...data },
        android: {
          notification: { channelId: 'treasurescan_channel', color: '#FFD700', priority: 'high' },
          priority: 'high',
        },
      });
      sent += response.successCount;
    }

    res.json({ sent, total: tokens.length });
  } catch (e) {
    console.error('Send to all error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── Scheduled: streak warning (call at 20:00 server time) ──────
async function sendStreakWarnings() {
  try {
    const db = admin.firestore();

    // Намери потребители с streak > 0 и без scan днес
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const usersSnap = await db.collection('users')
      .where('streak', '>', 0)
      .get();

    let sent = 0;
    for (const doc of usersSnap.docs) {
      const user = doc.data();
      const uid  = user.uid || doc.id;
      const lang = user.lang || 'bg';

      // Провери дали е сканирал днес
      const lastScan = user.lastScanDate;
      if (lastScan && lastScan.startsWith(today)) continue; // вече е сканирал

      // Вземи FCM token
      const tokenDoc = await db.collection('fcm_tokens').doc(uid).get();
      if (!tokenDoc.exists) continue;

      const { token } = tokenDoc.data();
      const streak = user.streak || 1;
      const { title, body } = getNotificationContent('streak_warning', lang, { streak });

      await sendToToken(token, title, body, { type: 'streak_warning', streak: String(streak) });
      sent++;
    }

    console.log(`Streak warnings sent: ${sent}`);
    return sent;
  } catch (e) {
    console.error('Streak warnings error:', e.message);
    return 0;
  }
}

// ── Notification content by type + lang ───────────────────────
function getNotificationContent(type, lang, data = {}) {
  const streak = data.streak || 1;
  const level  = data.level  || 1;

  const content = {
    vault_ready: {
      bg: { title: '🏛️ Хранилището е готово!',      body: 'Завъртете колелото и спечелете бонус сканирания.' },
      en: { title: '🏛️ The Vault is ready!',         body: 'Spin the wheel and claim your bonus scans.' },
      tr: { title: '🏛️ Hazine Odası hazır!',         body: 'Çarkı çevir ve bonus taramalarını al.' },
      ru: { title: '🏛️ Хранилище готово!',           body: 'Крутите колесо и получите бонусные сканы.' },
    },
    streak_warning: {
      bg: { title: '🔥 Серията ти е в опасност!',    body: `Имаш серия от ${streak} дни. Скенирай монета преди полунощ!` },
      en: { title: '🔥 Your streak is at risk!',      body: `You have a ${streak}-day streak. Scan a coin before midnight!` },
      tr: { title: '🔥 Seriniz tehlikede!',           body: `${streak} günlük seriniz var. Gece yarısından önce para tarayın!` },
      ru: { title: '🔥 Ваша серия под угрозой!',      body: `У вас серия ${streak} дней. Отсканируйте монету до полуночи!` },
    },
    level_up: {
      bg: { title: `⭐ Ниво ${level} достигнато!`,   body: 'Продължавай да сканираш — следващото ниво те чака!' },
      en: { title: `⭐ Level ${level} reached!`,      body: 'Keep scanning — the next level awaits!' },
      tr: { title: `⭐ Seviye ${level} ulaşıldı!`,   body: 'Taramaya devam et — bir sonraki seviye seni bekliyor!' },
      ru: { title: `⭐ Достигнут уровень ${level}!`, body: 'Продолжай сканировать — следующий уровень ждёт!' },
    },
  };

  const typeContent = content[type];
  if (!typeContent) return { title: 'TreasureScan', body: '' };
  return typeContent[lang] || typeContent['en'];
}

// ── Helper ─────────────────────────────────────────────────────
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

module.exports = {
  registerToken,
  sendNotification,
  sendToAll,
  sendStreakWarnings,
  sendToToken,
  getNotificationContent,
};
