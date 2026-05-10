// ═══════════════════════════════════════════════════════════════
// TreasureScan Backend — v202
// Hybrid Pipeline: AI (eyes) + Database (brain)
// Архитектура: Identify → Fingerprint → Lookup → Safe Valuation
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '20mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });
const GOOGLE_VISION_KEY = process.env.GOOGLE_VISION_KEY;

const LANG_MAP = { en: 'English', bg: 'Bulgarian', tr: 'Turkish', ru: 'Russian' };
function getLang(language) {
  return LANG_MAP[(language || 'bg').toLowerCase().trim()] || 'Bulgarian';
}

// ══════════════════════════════════════════════════════════════
// DATABASE LAYER
// ══════════════════════════════════════════════════════════════

let legendaryCoins = [];
try {
  const raw = fs.readFileSync(path.join(__dirname, 'legendary_coins.json'), 'utf-8');
  legendaryCoins = JSON.parse(raw).coins || [];
  console.log(`Legendary coins loaded: ${legendaryCoins.length}`);
} catch (e) {
  console.warn('legendary_coins.json not found:', e.message);
}

// Verified coins database — indexed by canonical_key за O(1) lookup
let verifiedCoinsIndex = {};
let verifiedCoinsCount = 0;
try {
  const raw = fs.readFileSync(path.join(__dirname, 'coins_verified.json'), 'utf-8');
  const data = JSON.parse(raw);
  const coins = data.coins || [];
  // Индексираме по canonical_key И по id
  for (const coin of coins) {
    if (coin.canonical_key) verifiedCoinsIndex[coin.canonical_key] = coin;
    if (coin.id) verifiedCoinsIndex[coin.id] = coin;
  }
  verifiedCoinsCount = coins.length;
  console.log(`Verified coins loaded: ${verifiedCoinsCount} (index size: ${Object.keys(verifiedCoinsIndex).length})`);
} catch (e) {
  console.warn('coins_verified.json not found:', e.message);
}

// ── Normalized fingerprint ────────────────────────────────────
function normalizeFingerprint(country, nominal, year) {
  const c = (country || '').toLowerCase()
    .replace(/българия|bulgaria/i, 'bg')
    .replace(/германия|germany|deutschland/i, 'de')
    .replace(/франция|france/i, 'fr')
    .replace(/белгия|belgium|belgique/i, 'be')
    .replace(/монако|monaco/i, 'mc')
    .replace(/австрия|austria/i, 'at')
    .replace(/холандия|netherlands|nederland/i, 'nl')
    .replace(/испания|spain/i, 'es')
    .replace(/италия|italy|italia/i, 'it')
    .replace(/португалия|portugal/i, 'pt')
    .replace(/финландия|finland/i, 'fi')
    .replace(/ирландия|ireland/i, 'ie')
    .replace(/гърция|greece/i, 'gr')
    .replace(/русия|russia/i, 'ru')
    .replace(/\s+/g, '').trim();

  const n = (nominal || '').toLowerCase()
    .replace(/евро цент|euro cent|евроцент/gi, 'c')
    .replace(/евро|euro|eur/gi, 'eur')
    .replace(/лев|лева|bgn/gi, 'bgn')
    .replace(/стотинк[аи]/gi, 'st')
    .replace(/\s+/g, '').trim();

  const y = (year || '').toString().trim();
  return `${c}_${n}_${y}`.replace(/[^a-z0-9_]/g, '');
}

// ── Legendary match ───────────────────────────────────────────
function matchLegendary(coinName) {
  if (!coinName || !legendaryCoins.length) return null;
  const lower = coinName.toLowerCase();
  let best = null, bestScore = 0;
  for (const coin of legendaryCoins) {
    let score = 0;
    for (const kw of (coin.keywords || [])) {
      if (lower.includes(kw.toLowerCase())) score += kw.length;
    }
    if (score > bestScore && score >= 5) { bestScore = score; best = coin; }
  }
  return best;
}

// ── Verified coins lookup ─────────────────────────────────────
function lookupVerified(country, nominal, year, coinName) {
  if (!verifiedCoinsCount) return null;

  const nomKey = getNominalKey(nominal);
  const yearStr = (year || '').toString().trim();

  // Normalize nominal за търсене
  const nomNorm = nomKey.replace('_', '');

  // 1. Точен fingerprint с country
  const fingerprint = normalizeFingerprint(country, nominal, year);
  if (verifiedCoinsIndex[fingerprint]) return verifiedCoinsIndex[fingerprint];

  // 2. Без country prefix — само nominal + year
  // Покрива случаите когато Claude дава грешна country
  const nomYear = `${nomNorm}_${yearStr}`;
  for (const key of Object.keys(verifiedCoinsIndex)) {
    if (key.endsWith(nomYear) || key.includes(`_${nomNorm}_${yearStr}`)) {
      return verifiedCoinsIndex[key];
    }
  }

  // 3. EU prefix опити
  const euPrefixes = ['eu_de', 'eu_fr', 'eu_it', 'eu_es', 'eu_nl', 'eu_be',
                      'eu_at', 'eu_pt', 'eu_fi', 'eu_ie', 'eu_gr', 'eu_lu',
                      'eu_si', 'eu_sk', 'eu_mt', 'eu_cy', 'eu_ee', 'eu_lv',
                      'eu_lt', 'eu_hr'];

  // Ако е euro монета — търси по всички EU countries
  const isEuro = /euro|eur/i.test(nominal);
  if (isEuro) {
    for (const prefix of euPrefixes) {
      const key = `${prefix}_${nomNorm}_${yearStr}`;
      if (verifiedCoinsIndex[key]) return verifiedCoinsIndex[key];
    }
  }

  // 4. BG prefix за стотинки/лева
  const isBgn = /стотинк|stotink|лев|lev|bgn/i.test(nominal);
  if (isBgn) {
    const bgKey = `bg_${nomNorm}_${yearStr}`;
    if (verifiedCoinsIndex[bgKey]) return verifiedCoinsIndex[bgKey];
  }

  // 5. Keyword match от coinName — последна опция
  if (coinName) {
    const lower = coinName.toLowerCase();
    for (const [key, coin] of Object.entries(verifiedCoinsIndex)) {
      if (coin.keywords) {
        for (const kw of coin.keywords) {
          if (lower.includes(kw.toLowerCase()) && kw.length >= 6) {
            return coin;
          }
        }
      }
    }
  }

  return null;
}

// ── Hard caps по номинал ──────────────────────────────────────
const NOMINAL_CAPS = {
  '1_cent':  { common: 1.0,  uncommon: 5,   rare: 30  },
  '2_cent':  { common: 1.0,  uncommon: 5,   rare: 30  },
  '5_cent':  { common: 1.5,  uncommon: 8,   rare: 40  },
  '10_cent': { common: 2.0,  uncommon: 10,  rare: 50  },
  '20_cent': { common: 2.0,  uncommon: 12,  rare: 60  },
  '50_cent': { common: 2.5,  uncommon: 15,  rare: 80  },
  '1_euro':  { common: 3.0,  uncommon: 20,  rare: 100 },
  '2_euro':  { common: 5.0,  uncommon: 30,  rare: 200 },
  '1_st':    { common: 0.5,  uncommon: 3,   rare: 20  },
  '2_st':    { common: 0.5,  uncommon: 3,   rare: 20  },
  '5_st':    { common: 1.0,  uncommon: 5,   rare: 30  },
  '10_st':   { common: 1.0,  uncommon: 8,   rare: 40  },
  '20_st':   { common: 1.5,  uncommon: 10,  rare: 50  },
  '50_st':   { common: 2.0,  uncommon: 15,  rare: 80  },
  '1_bgn':   { common: 2.0,  uncommon: 20,  rare: 150 },
  '2_bgn':   { common: 3.0,  uncommon: 25,  rare: 200 },
  // Сребърни и исторически монети — по-висок cap
  '5_bgn':   { common: 10.0, uncommon: 50,  rare: 500 },
  '10_bgn':  { common: 15.0, uncommon: 80,  rare: 800 },
  '20_bgn':  { common: 20.0, uncommon: 100, rare: 1000 },
  'default': { common: 5.0,  uncommon: 30,  rare: 200 },
};

function getNominalKey(nominal) {
  const n = (nominal || '').toLowerCase();
  if (/1\s*(цент|cent)/i.test(n)) return '1_cent';
  if (/2\s*(цент|cent)/i.test(n)) return '2_cent';
  if (/5\s*(цент|cent)/i.test(n)) return '5_cent';
  if (/10\s*(цент|cent)/i.test(n)) return '10_cent';
  if (/20\s*(цент|cent)/i.test(n)) return '20_cent';
  if (/50\s*(цент|cent)/i.test(n)) return '50_cent';
  if (/1\s*(евро|euro)/i.test(n)) return '1_euro';
  if (/2\s*(евро|euro)/i.test(n)) return '2_euro';
  if (/1\s*стотин/i.test(n)) return '1_st';
  if (/2\s*стотин/i.test(n)) return '2_st';
  if (/5\s*стотин/i.test(n)) return '5_st';
  if (/10\s*стотин/i.test(n)) return '10_st';
  if (/20\s*стотин/i.test(n)) return '20_st';
  if (/50\s*стотин/i.test(n)) return '50_st';
  if (/1\s*лев/i.test(n)) return '1_bgn';
  if (/2\s*лев/i.test(n)) return '2_bgn';
  return 'default';
}

// ── Safe valuation ────────────────────────────────────────────
function safeValuation(rarityScore, nominal, baseAvg) {
  const nomKey = getNominalKey(nominal);
  const caps = NOMINAL_CAPS[nomKey] || NOMINAL_CAPS['default'];

  if (rarityScore >= 5) {
    // Legendary — без hard cap, но с разумна граница
    const avg  = Math.max(baseAvg, caps.rare);
    return { low: parseFloat((avg * 0.6).toFixed(2)), avg: parseFloat(avg.toFixed(2)), high: parseFloat((avg * 1.5).toFixed(2)) };
  }

  const maxVal = rarityScore === 4 ? caps.rare :
                 rarityScore === 3 ? caps.uncommon : caps.common;

  const avg  = Math.min(baseAvg || maxVal * 0.4, maxVal);
  return {
    low:  parseFloat((avg * 0.6).toFixed(2)),
    avg:  parseFloat(avg.toFixed(2)),
    high: parseFloat((avg * 1.4).toFixed(2))
  };
}

// ── 3 нива confidence ─────────────────────────────────────────
function calcConfidences(identityConf, legendaryMatch, rarityScore, nomKey) {
  const identity = Math.round((identityConf / 5) * 100);
  const match = legendaryMatch ? 95 : (rarityScore <= 2 ? 70 : 55);
  const knownNominal = nomKey !== 'default';
  const value = legendaryMatch ? 90 :
    (rarityScore <= 2 && knownNominal) ? 75 :
    rarityScore <= 2 ? 60 :
    rarityScore === 3 ? 50 : 40;
  return { identity, match, value };
}

// ── Google Vision ─────────────────────────────────────────────
async function callGoogleVision(imageBase64) {
  if (!GOOGLE_VISION_KEY) return null;
  try {
    const response = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_VISION_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [{ image: { content: imageBase64 },
          features: [{ type: 'TEXT_DETECTION' }, { type: 'WEB_DETECTION', maxResults: 10 }] }] }) });
    const data = await response.json();
    const result = data.responses?.[0];
    if (!result) return null;
    return {
      ocrText: result.fullTextAnnotation?.text || '',
      webLabels: (result.webDetection?.webEntities || [])
        .filter(e => e.score > 0.5).map(e => e.description).filter(Boolean).slice(0, 8),
      bestGuess: result.webDetection?.bestGuessLabels?.[0]?.label || ''
    };
  } catch (err) { console.error('Vision error:', err.message); return null; }
}

function calcScore(rarity, condition) {
  return Math.round((rarity * 0.7 + condition * 0.3) * 20);
}

function stableId(coin, fallback) {
  if (coin.id) return coin.id;
  const n = (coin.name || '').replace(/\s+/g, '_');
  const y = coin.details?.year || '';
  const c = (coin.details?.country || '').replace(/\s+/g, '_');
  return (`${n}_${y}_${c}`.replace(/[^a-zA-Z0-9_]/g, '')) || fallback;
}

// ══════════════════════════════════════════════════════════════
// ENDPOINTS
// ══════════════════════════════════════════════════════════════
app.get('/', (_, res) => res.json({ status: 'TreasureScan v203', version: 'v203' }));

app.post('/analyze', async (req, res) => {
  try {
    const { imageBase64, mediaType = 'image/jpeg', bothSides, backImageBase64, language = 'bg' } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'Missing imageBase64' });

    const selectedLang = getLang(language);
    const visionData = await callGoogleVision(imageBase64);

    const userContent = [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } }
    ];
    if (bothSides && backImageBase64) {
      userContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: backImageBase64 } });
    }

    const visionContext = visionData && (visionData.ocrText || visionData.webLabels.length > 0)
      ? `\nOCR TEXT: "${visionData.ocrText.replace(/\n/g, ' ').trim()}"\nWEB: ${visionData.webLabels.join(', ')}\nGUESS: "${visionData.bestGuess}"`
      : '';

    const prompt = `Return ONLY valid JSON. No markdown.${visionContext}

TASK: IDENTIFY the coin. Do NOT estimate prices. Be conservative.

If a coin:
{
  "is_coin": true,
  "name": "Exact name (e.g. '10 Euro Cent Belgium 2002')",
  "identity_confidence": 1-5,
  "rarity_score": 1-5,
  "condition_score": 1-5,
  "coin_type": "circulation|commemorative|proof|error|bullion",
  "details": {
    "country": "Country in English",
    "year": "Year",
    "nominal": "Face value (e.g. '10 cent', '2 euro', '50 стотинки')",
    "metal": "Composition",
    "history": "2-3 sentences in ${selectedLang}",
    "diameter": "mm or empty",
    "weight": "grams or empty",
    "edge": "type or empty",
    "krause": "KM# or empty"
  },
  "deep": {
    "fun_fact": "in ${selectedLang}",
    "collector_note": "in ${selectedLang}",
    "mintage": "number or empty"
  }
}

RARITY (strict):
1=standard circulation millions minted
2=less common 10M-100M
3=commemorative limited under 10M
4=rare/error/proof under 1M
5=ONLY legendary under 100k or museum

CONFIDENCE: 5=crystal clear 4=good 3=moderate 2=poor 1=very uncertain

If NOT a coin: {"is_coin": false, "reason": "unclear"}`;

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

    const rarity    = Math.min(5, Math.max(1, coinData.rarity_score || 1));
    const condition = Math.min(5, Math.max(1, coinData.condition_score || 3));
    const identConf = Math.min(5, Math.max(1, coinData.identity_confidence || 3));
    const nominal   = coinData.details?.nominal || '';
    const country   = coinData.details?.country || '';
    const year      = coinData.details?.year || '';

    // DB lookup
    const legendary  = matchLegendary(coinData.name);
    const verified   = !legendary ? lookupVerified(country, nominal, year, coinData.name) : null;
    const fingerprint = normalizeFingerprint(country, nominal, year);
    const nomKey     = getNominalKey(nominal);
    const caps       = NOMINAL_CAPS[nomKey] || NOMINAL_CAPS['default'];

    // Market valuation — приоритет: legendary → verified → ai_capped
    let market, valueSource;
    if (legendary) {
      market = { low: legendary.market.low, avg: legendary.market.avg, high: legendary.market.high };
      valueSource = 'legendary_verified';
    } else if (verified) {
      // Верифициран запис от coins_verified.json
      market = {
        low: verified.market.low,
        avg: verified.market.avg,
        high: verified.market.high
      };
      valueSource = 'verified_database';
    } else if (identConf <= 2) {
      market = { low: 0, avg: 0, high: 0 };
      valueSource = 'uncertain';
    } else {
      const baseAvg = rarity >= 5 ? caps.rare * 2 :
                      rarity === 4 ? caps.rare * 0.6 :
                      rarity === 3 ? caps.uncommon * 0.5 :
                      rarity === 2 ? caps.common * 0.7 :
                                     caps.common * 0.35;
      market = safeValuation(rarity, nominal, baseAvg);
      valueSource = 'ai_capped';
    }

    const confidences = calcConfidences(identConf, legendary, rarity, nomKey);
    const fmt = v => v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : Math.round(v).toString();
    const estimatedValue = valueSource === 'uncertain' ? '?' :
      market.low > 0 ? `${fmt(market.low)}–${fmt(market.high)} EUR` : '';

    const id = stableId(coinData, `coin_${Date.now()}`);

    const result = {
      id, name: coinData.name,
      rarity_score: rarity, condition_score: condition,
      score: calcScore(rarity, condition), is_rare: rarity >= 4,
      confidence: identConf,
      confidence_levels: {
        identity: confidences.identity,
        match: confidences.match,
        value: confidences.value,
        label: (valueSource === 'legendary_verified' || valueSource === 'verified_database') ? 'verified' :
               valueSource === 'uncertain' ? 'uncertain' :
               confidences.value >= 75 ? 'estimated' : 'low_confidence'
      },
      market, estimated_value: estimatedValue, value_source: valueSource,
      fingerprint,
      legendary_verified: !!legendary, legendary_id: legendary?.id || null,
      details: { ...coinData.details, coin_type: coinData.coin_type || 'circulation' },
      deep: coinData.deep || {},
      both_sides_analyzed: bothSides || false,
      response_language: language, vision_used: !!visionData,
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

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: `Return ONLY valid JSON array. No markdown.

Identify ALL coins visible. IDENTIFICATION ONLY — no prices.

[{
  "name": "Exact name",
  "coin_x": 0.0-1.0, "coin_y": 0.0-1.0,
  "identity_confidence": 1-5,
  "rarity_score": 1-5, "condition_score": 1-5,
  "coin_type": "circulation|commemorative|proof|error",
  "details": { "country": "English", "year": "", "nominal": "", "metal": "", "history": "2 sentences in ${selectedLang}" },
  "deep": { "fun_fact": "in ${selectedLang}", "collector_note": "in ${selectedLang}", "mintage": "" }
}]

RARITY: 1=common circulation, 2=less common, 3=commemorative, 4=rare/error, 5=legendary
Most coins are 1-2. Be CONSERVATIVE.` }
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
      const rarity    = Math.min(5, Math.max(1, coin.rarity_score || 1));
      const condition = Math.min(5, Math.max(1, coin.condition_score || 3));
      const identConf = Math.min(5, Math.max(1, coin.identity_confidence || 3));
      const nominal   = coin.details?.nominal || '';
      const country   = coin.details?.country || '';
      const year      = coin.details?.year || '';
      const key       = `${(coin.name || '').toLowerCase()}_${year}`;

      const legendary   = matchLegendary(coin.name);
      const verified    = !legendary ? lookupVerified(country, nominal, year, coin.name) : null;
      const fingerprint = normalizeFingerprint(country, nominal, year);
      const nomKey      = getNominalKey(nominal);
      const caps        = NOMINAL_CAPS[nomKey] || NOMINAL_CAPS['default'];

      let market, valueSource;
      if (legendary) {
        market = { low: legendary.market.low, avg: legendary.market.avg, high: legendary.market.high };
        valueSource = 'legendary_verified';
      } else if (verified) {
        market = { low: verified.market.low, avg: verified.market.avg, high: verified.market.high };
        valueSource = 'verified_database';
      } else if (identConf <= 2) {
        market = { low: 0, avg: 0, high: 0 };
        valueSource = 'uncertain';
      } else {
        const baseAvg = rarity >= 5 ? caps.rare * 2 :
                        rarity === 4 ? caps.rare * 0.6 :
                        rarity === 3 ? caps.uncommon * 0.5 :
                        rarity === 2 ? caps.common * 0.7 :
                                       caps.common * 0.35;
        market = safeValuation(rarity, nominal, baseAvg);
        valueSource = 'ai_capped';
      }

      const confidences = calcConfidences(identConf, legendary, rarity, nomKey);
      const fmt = v => v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : Math.round(v).toString();
      const estimatedValue = valueSource === 'uncertain' ? '?' :
        market.low > 0 ? `${fmt(market.low)}–${fmt(market.high)} EUR` : '';

      const result = {
        id: stableId(coin, `coin_${i}`), name: coin.name || 'Unknown',
        coin_x: Math.min(0.95, Math.max(0.05, coin.coin_x || 0.5)),
        coin_y: Math.min(0.95, Math.max(0.05, coin.coin_y || 0.5)),
        rarity_score: rarity, condition_score: condition,
        score: calcScore(rarity, condition), is_rare: rarity >= 4,
        confidence: identConf,
        confidence_levels: {
          identity: confidences.identity, match: confidences.match, value: confidences.value,
          label: (valueSource === 'legendary_verified' || valueSource === 'verified_database') ? 'verified' :
                 valueSource === 'uncertain' ? 'uncertain' :
                 confidences.value >= 75 ? 'estimated' : 'low_confidence'
        },
        market, estimated_value: estimatedValue, value_source: valueSource,
        fingerprint, legendary_verified: !!legendary, legendary_id: legendary?.id || null,
        details: { ...coin.details, coin_type: coin.coin_type || 'circulation' },
        deep: coin.deep || {},
      };

      if (!seen[key]) { seen[key] = result; return result; }
      return { ...seen[key], id: stableId(coin, `coin_${i}`), coin_x: result.coin_x, coin_y: result.coin_y };
    });

    enriched.sort((a, b) => b.score - a.score);

    // Summary — с per-coin caps
    let totalLow = 0, totalHigh = 0;
    for (const coin of enriched) {
      const nomKey = getNominalKey(coin.details?.nominal || '');
      const caps = NOMINAL_CAPS[nomKey] || NOMINAL_CAPS['default'];
      const maxH = coin.rarity_score <= 1 ? caps.common :
                   coin.rarity_score === 2 ? caps.uncommon * 0.5 :
                   coin.rarity_score === 3 ? caps.uncommon : caps.rare;
      const high = Math.min(coin.market?.high || 0, maxH);
      const low  = Math.min(coin.market?.low || 0, high * 0.6);
      totalLow += low; totalHigh += high;
    }

    const fmt = v => v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : Math.round(v).toString();

    res.json({
      success: true, data: enriched,
      top: enriched.slice(0, 2), bulk: enriched.slice(2),
      collection_summary: {
        total_coins: enriched.length,
        rare_coins: enriched.filter(c => c.rarity_score >= 4).length,
        total_estimate: totalLow > 0 ? `${fmt(totalLow)}–${fmt(totalHigh)}` : '?',
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

  const CODE_1D  = process.env.CODE_1D  || 'TREASURE1D';
  const CODE_7D  = process.env.CODE_7D  || 'TREASURE7D';
  const CODE_30D = process.env.CODE_30D || 'TREASURE30D';
  if (input === CODE_1D)  return res.json({ valid: true, type: 'premium', days: 1 });
  if (input === CODE_7D)  return res.json({ valid: true, type: 'premium', days: 7 });
  if (input === CODE_30D) return res.json({ valid: true, type: 'premium', days: 30 });

  const KRIS777     = process.env.CODE_KRIS777     || 'KRIS777';
  const TREASUREGOD = process.env.CODE_TREASUREGOD || 'TREASUREGOD';
  const BADGEKING   = process.env.CODE_BADGEKING   || 'BADGEKING';
  const GRACEKELLY  = process.env.CODE_GRACEKELLY  || 'GRACEKELLY';
  const KRIS2014    = process.env.CODE_KRIS2014    || 'KRIS2014';

  if (input === KRIS777)     return res.json({ valid: true, type: 'scans',   amount: 500 });
  if (input === TREASUREGOD) return res.json({ valid: true, type: 'godmode', xp: 5000, level: 50 });
  if (input === BADGEKING)   return res.json({ valid: true, type: 'badges',  count: 20 });
  if (input === GRACEKELLY)  return res.json({ valid: true, type: 'legendary' });
  if (input === KRIS2014)    return res.json({ valid: true, type: 'family',  scans: 500, xp: 5000, level: 50, days: 30 });

  res.json({ valid: false, type: 'invalid' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TreasureScan v201 running on port ${PORT}`));
