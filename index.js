// v182 — Language persistence fix, stronger lang enforcement
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json({ limit: '20mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

// ─── LANG MAP ─────────────────────────────────────────────────────────────────
const LANG_MAP = {
  en: 'English',
  bg: 'Bulgarian',
  tr: 'Turkish',
  ru: 'Russian'
};

// v182 — По-строго определяне на езика
function getLang(language) {
  const code = (language || 'bg').toLowerCase().trim();
  return LANG_MAP[code] || 'Bulgarian';
}

// ─── SCORE ────────────────────────────────────────────────────────────────────
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

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.json({ status: 'TreasureScan v182 — Discovery Mode', version: 'v182' }));

// ─── SINGLE COIN ANALYZE ──────────────────────────────────────────────────────
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
      text: `CRITICAL INSTRUCTION: You MUST respond ONLY in ${selectedLang}. Every single text field must be in ${selectedLang}. Do NOT use any other language.
Return ONLY valid JSON without markdown.

If NOT a coin: {"is_coin": false}

If coin:
{
  "is_coin": true,
  "name": "Full coin name in ${selectedLang}",
  "rarity_score": 1-5,
  "condition_score": 1-5,
  "details": {
    "country": "Country name in ${selectedLang}",
    "year": "Year or period",
    "metal": "Metal type in ${selectedLang}",
    "nominal": "Nominal value",
    "history": "2-3 interesting sentences about this coin written in ${selectedLang}. Include mintage if known."
  },
  "deep": {
    "fun_fact": "One surprising fact about this coin written in ${selectedLang}",
    "collector_note": "Brief collector insight written in ${selectedLang}",
    "mintage": "Approximate mintage if known, otherwise empty string"
  }
}

rarity_score:
1 = common circulation (millions minted)
2 = frequent (hundreds of thousands)
3 = interesting (limited, commemorative, special series)
4 = rare (under 100,000 minted, silver, gold, error coin)
5 = legendary (under 10,000, extremely sought after)

condition_score:
1 = poor/damaged, 2 = worn, 3 = good, 4 = very good, 5 = uncirculated

IMPORTANT: Do NOT include any price or monetary value estimation.
IMPORTANT: ALL text fields MUST be in ${selectedLang} — this is mandatory.
${bothSides ? 'Analyze BOTH sides.' : ''}`
    });

    const response = await client.messages.create({
      model: 'claude-opus-4-5',
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
      return res.json({ success: true, data: { is_coin: false } });
    }

    const rarity    = Math.min(5, Math.max(1, coinData.rarity_score    || 1));
    const condition = Math.min(5, Math.max(1, coinData.condition_score || 3));
    const id        = stableId(coinData, `coin_${Date.now()}`);

    const result = {
      id,
      name:            coinData.name,
      rarity_score:    rarity,
      condition_score: condition,
      score:           calcScore(rarity, condition),
      is_rare:         rarity >= 4,
      details:         coinData.details || {},
      deep:            coinData.deep    || {},
      both_sides_analyzed: bothSides || false,
      response_language: language  // v182 — запазваме езика в отговора
    };

    res.json({ success: true, data: result, top: [result], bulk: [] });

  } catch (err) {
    console.error('/analyze error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── MULTIPLE COINS ANALYZE ───────────────────────────────────────────────────
app.post('/analyze-multiple', async (req, res) => {
  try {
    const { imageBase64, mediaType = 'image/jpeg', language = 'bg' } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'Missing imageBase64' });

    const selectedLang = getLang(language);

    const response = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4000,
      timeout: 120000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          {
            type: 'text',
            text: `CRITICAL INSTRUCTION: You MUST respond ONLY in ${selectedLang}. Every text field must be in ${selectedLang}.
Analyze ALL coins. Return ONLY valid JSON array without markdown.

[
  {
    "name": "Coin name in ${selectedLang}",
    "coin_x": 0.0-1.0,
    "coin_y": 0.0-1.0,
    "rarity_score": 1-5,
    "condition_score": 1-5,
    "details": {
      "country": "Country in ${selectedLang}",
      "year": "",
      "metal": "Metal in ${selectedLang}",
      "nominal": "",
      "history": "2-3 interesting sentences in ${selectedLang}"
    },
    "deep": {
      "fun_fact": "Interesting fact in ${selectedLang}",
      "collector_note": "Collector insight in ${selectedLang}",
      "mintage": "Approximate mintage if known"
    }
  }
]

rarity_score: 1=common, 2=frequent, 3=interesting, 4=rare, 5=legendary
condition_score: 1=poor, 2=worn, 3=good, 4=very good, 5=uncirculated
coin_x/coin_y: normalized coordinates (0,0=top-left, 1,1=bottom-right)
IMPORTANT: Do NOT include any price or monetary value.
IMPORTANT: ALL text MUST be in ${selectedLang}.`
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
        return { ...s,
          id:     stableId(coin, `coin_${i}`),
          coin_x: Math.min(0.95, Math.max(0.05, coin.coin_x || 0.5)),
          coin_y: Math.min(0.95, Math.max(0.05, coin.coin_y || 0.5))
        };
      }

      const id = stableId(coin, `coin_${i}`);
      const result = {
        id,
        name:            coin.name || 'Unknown',
        coin_x:          Math.min(0.95, Math.max(0.05, coin.coin_x || 0.5)),
        coin_y:          Math.min(0.95, Math.max(0.05, coin.coin_y || 0.5)),
        rarity_score:    rarity,
        condition_score: condition,
        score:           calcScore(rarity, condition),
        is_rare:         rarity >= 4,
        details:         coin.details || {},
        deep:            coin.deep    || {}
      };

      seen[key] = result;
      return result;
    });

    enriched.sort((a, b) => b.score - a.score);

    res.json({
      success: true,
      data:    enriched,
      top:     enriched.slice(0, 2),
      bulk:    enriched.slice(2),
      collection_summary: {
        total_coins: enriched.length,
        rare_coins:  enriched.filter(c => c.rarity_score >= 4).length,
        top_coins:   enriched.slice(0, 2).map(c => ({ id: c.id, name: c.name, rarity: c.rarity_score }))
      }
    });

  } catch (err) {
    console.error('/analyze-multiple error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── VALIDATE CODE ────────────────────────────────────────────────────────────
app.post('/validate-code', (req, res) => {
  const { code } = req.body;
  const input = (code || '').trim().toUpperCase();
  const CODE_1D  = process.env.CODE_1D  || 'TREASURE1D';
  const CODE_7D  = process.env.CODE_7D  || 'TREASURE7D';
  const CODE_30D = process.env.CODE_30D || 'TREASURE30D';
  if (input === CODE_1D)  return res.json({ valid: true, days: 1 });
  if (input === CODE_7D)  return res.json({ valid: true, days: 7 });
  if (input === CODE_30D) return res.json({ valid: true, days: 30 });
  res.json({ valid: false, days: 0 });
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TreasureScan v182 running on port ${PORT}`));
