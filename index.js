// v193 — Google Vision API integration: OCR + Web Detection → Claude formats only
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json({ limit: '20mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });
const GOOGLE_VISION_KEY = process.env.GOOGLE_VISION_KEY;

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

// ── Google Vision API call ────────────────────────────────────────────────────
async function callGoogleVision(imageBase64) {
  if (!GOOGLE_VISION_KEY) return null;

  try {
    const response = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_VISION_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            image: { content: imageBase64 },
            features: [
              { type: 'TEXT_DETECTION' },
              { type: 'WEB_DETECTION', maxResults: 10 }
            ]
          }]
        })
      }
    );

    const data = await response.json();
    const result = data.responses?.[0];
    if (!result) return null;

    const ocrText = result.fullTextAnnotation?.text || '';
    const webEntities = result.webDetection?.webEntities || [];
    const webLabels = webEntities
      .filter(e => e.score > 0.5)
      .map(e => e.description)
      .filter(Boolean)
      .slice(0, 8);
    const bestGuess = result.webDetection?.bestGuessLabels?.[0]?.label || '';

    return { ocrText, webLabels, bestGuess };
  } catch (err) {
    console.error('Google Vision error:', err.message);
    return null;
  }
}

app.get('/', (_, res) => res.json({ status: 'TreasureScan v193', version: 'v193' }));

app.post('/analyze', async (req, res) => {
  try {
    const { imageBase64, mediaType = 'image/jpeg', bothSides, backImageBase64, language = 'bg' } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'Missing imageBase64' });

    const selectedLang = getLang(language);

    // ── СЛОЙ 1: Google Vision (OCR + Web Detection) ───────────────────────────
    const visionData = await callGoogleVision(imageBase64);

    // ── СЛОЙ 2: Провери за screen/multiple от Vision текст ───────────────────
    if (visionData) {
      const ocrLower = visionData.ocrText.toLowerCase();
      // Ако Vision не намери нищо смислено → uncertain
      if (!visionData.ocrText && visionData.webLabels.length === 0) {
        return res.json({ success: true, data: { is_coin: false, reason: 'unclear' } });
      }
    }

    // ── СЛОЙ 3: Claude — само форматира, не разпознава ───────────────────────
    const userContent = [];

    // Добавяме снимката само ако нямаме Vision данни (fallback)
    if (!visionData || (!visionData.ocrText && visionData.webLabels.length === 0)) {
      userContent.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } });
    }

    if (bothSides && backImageBase64 && !visionData) {
      userContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: backImageBase64 } });
    }

    // Изграждаме промпта с Vision данни
    let prompt;
    if (visionData && (visionData.ocrText || visionData.webLabels.length > 0)) {
      // ✅ НОВА АРХИТЕКТУРА — Claude получава факти, не гадае
      prompt = `CRITICAL: Respond ONLY in ${selectedLang}. Return ONLY valid JSON without markdown.

You are given VERIFIED FACTS from Google Vision API about a coin image.
DO NOT guess. DO NOT hallucinate. Use ONLY the data provided below.

VERIFIED OCR TEXT FROM COIN: "${visionData.ocrText.replace(/\n/g, ' ').trim()}"
VERIFIED WEB LABELS: ${visionData.webLabels.join(', ')}
BEST GUESS FROM WEB: "${visionData.bestGuess}"

TASK: Based on these verified facts, identify the coin and return structured JSON.

If the data clearly shows a coin, return:
{
  "is_coin": true,
  "name": "Full coin name in ${selectedLang} (e.g. '50 евро цента Германия 2002')",
  "rarity_score": 1-5,
  "condition_score": 3,
  "confidence": 1-5,
  "details": {
    "country": "Country in ${selectedLang}",
    "year": "Year extracted from OCR or web data",
    "metal": "Metal type in ${selectedLang}",
    "nominal": "Face value",
    "history": "2-3 interesting sentences in ${selectedLang}"
  },
  "deep": {
    "fun_fact": "One fact in ${selectedLang}",
    "collector_note": "Collector insight in ${selectedLang}",
    "mintage": ""
  }
}

If data is insufficient or not a coin: {"is_coin": false, "reason": "unclear"}

RULES:
- If OCR shows "DEUTSCHLAND" or web labels say "Germany" → country is Germany
- If OCR shows "БЪЛГАРИЯ" → country is Bulgaria
- Use the YEAR from OCR text directly — never substitute
- rarity: 1=millions, 2=common, 3=interesting, 4=rare, 5=legendary
- confidence: 1=very uncertain, 3=moderate, 5=very certain`;
    } else {
      // FALLBACK — Vision недостъпен, използваме стария подход с изображение
      userContent.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } });
      prompt = `CRITICAL: Respond ONLY in ${selectedLang}. Return ONLY valid JSON without markdown.

Identify this coin. If not a coin or unclear, return {"is_coin": false, "reason": "unclear"}.

If coin:
{
  "is_coin": true,
  "name": "Coin name in ${selectedLang}",
  "rarity_score": 1-5,
  "condition_score": 1-5,
  "confidence": 1-5,
  "details": {"country": "", "year": "", "metal": "", "nominal": "", "history": ""},
  "deep": {"fun_fact": "", "collector_note": "", "mintage": ""}
}`;
    }

    userContent.push({ type: 'text', text: prompt });

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
      both_sides_analyzed: bothSides || false, response_language: language,
      vision_used: !!visionData  // debug flag
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