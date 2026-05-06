// v189 — OCR priority fix: text on coin overrides visual similarity
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json({ limit: '20mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

const LANG_MAP = { en: 'English', bg: 'Bulgarian', tr: 'Turkish', ru: 'Russian' };

function getLang(language) {
  const code = (language || 'bg').toLowerCase().trim();
  return LANG_MAP[code] || 'Bulgarian';
}

function calcScore(rarity, condition) {
  return Math.round((rarity * 0.7 + condition * 0.3) * 20);
}

function stableId(coin, fallback) {
  if (coin.id) return coin.id;
  const n = (coin.name || '').replace(/\s+/g, '_');
  const y = coin.details?.year || '';
  const c = (coin.details?.country || '').replace(/\s+/g, '_');
  const id = `${n}_${y}_${c}`.replace(/[^a-zA-Z0-9_]/g, '');
  return id || fallback;
}

// v192 — Complete Bulgaria euro 2026 database with all denominations
app.get('/', (_, res) => res.json({ status: 'TreasureScan v192', version: 'v192' }));

app.post('/analyze', async (req, res) => {
  try {
    const { imageBase64, mediaType = 'image/jpeg', bothSides, backImageBase64, language = 'bg' } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'Missing imageBase64' });

    const selectedLang = getLang(language);
    const userContent = [];
    userContent.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } });
    if (bothSides && backImageBase64) {
      userContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: backImageBase64 } });
    }
    userContent.push({
      type: 'text',
      text: `CRITICAL: Respond ONLY in ${selectedLang}. ALL text fields in ${selectedLang}.
Return ONLY valid JSON without markdown.

FIRST CHECK — before anything else:
1. If the image CLEARLY shows a phone/computer SCREEN with UI elements, app interface, or browser — return:
{"is_coin": false, "reason": "screen"}
IMPORTANT: Photos of coins on white background, catalog images, or coins held in hand are NOT screens. Only return "screen" if you clearly see a digital display with UI.

2. If the image contains MULTIPLE COINS (2 or more coins clearly visible as separate coins) — return:
{"is_coin": false, "reason": "multiple"}

3. If the image is SO BLURRY or DARK that the coin is completely unrecognizable — return:
{"is_coin": false, "reason": "unclear"}
IMPORTANT: Slightly imperfect, tilted, or partially lit photos are acceptable. Only return "unclear" if truly impossible to identify.

4. If you CANNOT IDENTIFY the coin with at least 50% confidence — return:
{"is_coin": false, "reason": "uncertain"}

Only proceed if you see ONE SINGLE REAL PHYSICAL COIN.

IDENTIFICATION RULES — follow in this exact order:
1. READ ALL TEXT visible on the coin FIRST — this is the most important step
2. DETECT the year — READ IT DIRECTLY from the coin. If you see "2026" written on the coin, the year IS 2026. NEVER substitute with another year.
3. DETECT the person/subject name if written on the coin (e.g. "KONRAD ADENAUER", "GRACE KELLY", "BEETHOVEN")
4. DETECT the country from text (e.g. BUNDESREPUBLIK DEUTSCHLAND = Germany, not Austria)
5. TEXT ALWAYS OVERRIDES visual similarity — if coin says "KONRAD ADENAUER" it CANNOT be "Johann Strauss"
6. If confidence is below 3/5 — return uncertain

AUTO-FILTER RULES (prevent absurd results):
- If coin has EURO stars ring → it is a Euro coin (NOT ancient/medieval)
- If coin shows year > 1900 → it CANNOT be ancient, medieval, or Roman
- If coin text says a specific person's name → use THAT person, not a visually similar coin
- If coin is bimetallic (two metals/colors) → it is likely 1€ or 2€ modern coin

BULGARIA EURO COINS 2026 (CRITICAL — these are NEW coins not in training data):
Bulgaria adopted the euro on 1 January 2026. ALL Bulgarian euro coins show "БЪЛГАРИЯ" in Cyrillic and "2026".
- 1 евро цент / стотинка — Мадарски конник, жълт цвят
- 2 евро цента / стотинки — Мадарски конник, жълт цвят
- 5 евро цента / стотинки — Мадарски конник, жълт цвят
- 10 евро цента / стотинки — Мадарски конник, сребрист цвят
- 20 евро цента / стотинки — Мадарски конник, сребрист цвят
- 50 евро цента / стотинки — Мадарски конник, сребрист цвят
- 1 евро България 2026 — Св. Иван Рилски (мъж с брада и расо, ореол)
- 2 евро България 2026 — Паисий Хилендарски (монах с книга), надпис по гурта "БОЖЕ ПАЗИ БЪЛГАРИЯ"

RULE: If you see БЪЛГАРИЯ + ЕВРО + 2026 → it is a Bulgarian Euro coin. Do NOT confuse with Greek, Austrian or any other euro coin!
LETZEBUERG / LUXEMBURG = Luxembourg
HELVETIA / CONFOEDERATIO HELVETICA = Switzerland  
BUNDESREPUBLIK DEUTSCHLAND = Germany
REPUBLIQUE FRANÇAISE / RF = France
ITALIA / REPUBBLICA ITALIANA = Italy
ESPAÑA = Spain
NEDERLAND = Netherlands
ÖSTERREICH = Austria
BELGIQUE / BELGIË = Belgium
EIRE = Ireland
SUOMI / FINLAND = Finland
PORTUGUESA = Portugal
ΕΛΛΑΔΑ / HELLAS = Greece
ΚΥΠΡΟΣ / KIBRIS = Cyprus
MALTA = Malta
SLOVENIJA = Slovenia
SLOVENSKO = Slovakia
EESTI = Estonia
LATVIJA = Latvia
LIETUVA = Lithuania

If NOT a coin: {"is_coin": false, "reason": "not_coin"}

If coin:
{
  "is_coin": true,
  "name": "Full coin name including subject/design (e.g. '2 Euro Monaco - Princess Grace Kelly 2007', not just '2 Euro Monaco'). In ${selectedLang}.",
  "rarity_score": 1-5,
  "condition_score": 1-5,
  "confidence": 1-5,
  "details": {
    "country": "Country in ${selectedLang}",
    "year": "Year or period",
    "metal": "Metal in ${selectedLang}",
    "nominal": "Nominal value",
    "history": "2-3 interesting sentences in ${selectedLang}. Include mintage if known."
  },
  "deep": {
    "fun_fact": "One surprising fact in ${selectedLang}",
    "collector_note": "Brief collector insight in ${selectedLang}",
    "mintage": "Approximate mintage if known, else empty string"
  }
}

rarity_score: 1=common(millions), 2=frequent(100k+), 3=interesting(limited/commemorative), 4=rare(<100k/silver/gold/error), 5=legendary(<10k)
condition_score: 1=poor, 2=worn, 3=good, 4=very good, 5=uncirculated
confidence: 1=very uncertain, 3=moderate, 5=very certain
Do NOT include any price or monetary value.
NEVER assign a country based only on visual similarity — always prioritize text on the coin.
NEVER guess if not confident — return uncertain instead.
${bothSides ? 'Analyze BOTH sides for maximum accuracy.' : ''}`
    });

    // ✅ v183 — Haiku за single scan (10x по-евтино)
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: userContent }]
    });

    const raw = response.content[0].text.trim();
    let coinData;
    try {
      coinData = JSON.parse(raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
    } catch {
      return res.status(500).json({ error: 'AI parse error', raw });
    }

    if (!coinData.is_coin) {
      return res.json({ success: true, data: { is_coin: false, reason: coinData.reason || 'not_coin' } });
    }

    const rarity    = Math.min(5, Math.max(1, coinData.rarity_score    || 1));
    const condition = Math.min(5, Math.max(1, coinData.condition_score || 3));
    const id        = stableId(coinData, `coin_${Date.now()}`);

    const result = {
      id, name: coinData.name, rarity_score: rarity, condition_score: condition,
      score: calcScore(rarity, condition), is_rare: rarity >= 4,
      confidence: Math.min(5, Math.max(1, coinData.confidence || 3)),
      details: coinData.details || {}, deep: coinData.deep || {},
      both_sides_analyzed: bothSides || false, response_language: language
    };

    res.json({ success: true, data: result, top: [result], bulk: [] });

  } catch (err) {
    console.error('/analyze error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/analyze-multiple', async (req, res) => {
  try {
    const { imageBase64, mediaType = 'image/jpeg', language = 'bg' } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'Missing imageBase64' });

    const selectedLang = getLang(language);

    // ✅ v183 — Opus остава за multi scan (по-сложен анализ)
    const response = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          {
            type: 'text',
            text: `CRITICAL: Respond ONLY in ${selectedLang}. ALL text in ${selectedLang}.

FIRST CHECK: If the image shows a SCREEN, PHONE DISPLAY, or SCREENSHOT — return: []

Analyze ALL physical coins visible. Return ONLY valid JSON array without markdown.

[{
  "name": "Coin name in ${selectedLang}",
  "coin_x": 0.0-1.0, "coin_y": 0.0-1.0,
  "rarity_score": 1-5, "condition_score": 1-5,
  "details": { "country": "", "year": "", "metal": "", "nominal": "", "history": "2-3 sentences in ${selectedLang}" },
  "deep": { "fun_fact": "in ${selectedLang}", "collector_note": "in ${selectedLang}", "mintage": "" }
}]

rarity_score: 1=common, 2=frequent, 3=interesting, 4=rare, 5=legendary
Do NOT include price or monetary value. ALL text in ${selectedLang}.`
          }
        ]
      }]
    });

    const raw = response.content[0].text.trim();
    let coins;
    try {
      coins = JSON.parse(raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
      if (!Array.isArray(coins)) coins = [coins];
      if (coins.length > 15) coins = coins.slice(0, 15);
    } catch {
      return res.status(500).json({ error: 'AI parse error', raw });
    }

    const seen = {};
    const enriched = coins.map((coin, i) => {
      const rarity    = Math.min(5, Math.max(1, coin.rarity_score    || 1));
      const condition = Math.min(5, Math.max(1, coin.condition_score || 3));
      const key       = `${(coin.name || '').toLowerCase()}_${coin.details?.year || ''}`;

      if (seen[key]) {
        const s = seen[key];
        return { ...s, id: stableId(coin, `coin_${i}`),
          coin_x: Math.min(0.95, Math.max(0.05, coin.coin_x || 0.5)),
          coin_y: Math.min(0.95, Math.max(0.05, coin.coin_y || 0.5)) };
      }

      const result = {
        id: stableId(coin, `coin_${i}`), name: coin.name || 'Unknown',
        coin_x: Math.min(0.95, Math.max(0.05, coin.coin_x || 0.5)),
        coin_y: Math.min(0.95, Math.max(0.05, coin.coin_y || 0.5)),
        rarity_score: rarity, condition_score: condition,
        score: calcScore(rarity, condition), is_rare: rarity >= 4,
        details: coin.details || {}, deep: coin.deep || {}
      };

      seen[key] = result;
      return result;
    });

    enriched.sort((a, b) => b.score - a.score);

    res.json({
      success: true, data: enriched,
      top: enriched.slice(0, 2), bulk: enriched.slice(2),
      collection_summary: {
        total_coins: enriched.length,
        rare_coins: enriched.filter(c => c.rarity_score >= 4).length,
        top_coins: enriched.slice(0, 2).map(c => ({ id: c.id, name: c.name, rarity: c.rarity_score }))
      }
    });

  } catch (err) {
    console.error('/analyze-multiple error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/validate-code', (req, res) => {
  const { code } = req.body;
  const input = (code || '').trim().toUpperCase();

  // ── Стандартни premium кодове (от environment variables) ──
  const CODE_1D  = process.env.CODE_1D  || 'TREASURE1D';
  const CODE_7D  = process.env.CODE_7D  || 'TREASURE7D';
  const CODE_30D = process.env.CODE_30D || 'TREASURE30D';
  if (input === CODE_1D)  return res.json({ valid: true, type: 'premium', days: 1 });
  if (input === CODE_7D)  return res.json({ valid: true, type: 'premium', days: 7 });
  if (input === CODE_30D) return res.json({ valid: true, type: 'premium', days: 30 });

  // ── Creator cheat кодове (от environment variables) ────────
  const KRIS777    = process.env.CODE_KRIS777    || 'KRIS777';
  const TREASUREGOD = process.env.CODE_TREASUREGOD || 'TREASUREGOD';
  const BADGEKING  = process.env.CODE_BADGEKING  || 'BADGEKING';
  const GRACEKELLY = process.env.CODE_GRACEKELLY || 'GRACEKELLY';
  const KRIS2014   = process.env.CODE_KRIS2014   || 'KRIS2014';

  if (input === KRIS777)     return res.json({ valid: true, type: 'scans',    amount: 500 });
  if (input === TREASUREGOD) return res.json({ valid: true, type: 'godmode',  xp: 5000, level: 50 });
  if (input === BADGEKING)   return res.json({ valid: true, type: 'badges',   count: 20 });
  if (input === GRACEKELLY)  return res.json({ valid: true, type: 'legendary' });
  if (input === KRIS2014)    return res.json({ valid: true, type: 'family',   scans: 500, xp: 5000, level: 50, days: 30 });

  res.json({ valid: false, type: 'invalid' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TreasureScan v183 running on port ${PORT}`));