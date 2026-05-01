import predictionTags from './data/prediction-tags.json' with { type: 'json' };

export const EXCLUDE_KEYWORDS = predictionTags.excludeKeywords;

const DAY_MS = 24 * 60 * 60 * 1000;

export const FILTER_CONFIG = {
  min_price: 0.05,
  max_price: 0.5,
  min_volume_24h: 5000,
  min_liquidity: 10000,
  max_spread_pct: 0.05,
  min_days_to_expiry: 3,
  max_days_to_expiry: 90,
  must_be_active: true,
  must_accept_orders: true,
};

export const RELAXED_FILTER_CONFIG = {
  ...FILTER_CONFIG,
  max_price: 0.6,
  min_liquidity: 5000,
  max_spread_pct: 0.08,
  min_days_to_expiry: 2,
  max_days_to_expiry: 120,
};

const LEGACY_SCORING_FILTER_CONFIG = {
  strict: {
    min_price: 0.1,
    max_price: 0.9,
    min_volume_24h: 5000,
  },
  relaxed: {
    min_price: 0.05,
    max_price: 0.95,
    min_volume_24h: 5000,
  },
};

export const MEME_PATTERNS = [
  /\b(lebron|kanye|oprah|swift|rogan|dwayne|kardashian|cardi\s*b)\b/i,
  /\b(alien|ufo|zombie|flat earth)\b/i,
];

export const REGION_PATTERNS = {
  america: /\b(us|u\.s\.|united states|america|trump|biden|congress|federal reserve|canada|mexico|brazil)\b/i,
  eu: /\b(europe|european|eu|nato|germany|france|uk|britain|macron|ecb)\b/i,
  mena: /\b(middle east|iran|iraq|syria|israel|palestine|gaza|saudi|yemen|houthi|lebanon)\b/i,
  asia: /\b(china|japan|korea|india|taiwan|xi jinping|asean)\b/i,
  latam: /\b(latin america|brazil|argentina|venezuela|colombia|chile)\b/i,
  africa: /\b(africa|nigeria|south africa|ethiopia|sahel|kenya)\b/i,
  oceania: /\b(australia|new zealand)\b/i,
};

export function isExcluded(title) {
  const lower = title.toLowerCase();
  return EXCLUDE_KEYWORDS.some(kw => lower.includes(kw));
}

export function isMemeCandidate(title, yesPrice) {
  if (yesPrice >= 15) return false;
  return MEME_PATTERNS.some(p => p.test(title));
}

export function tagRegions(title) {
  return Object.entries(REGION_PATTERNS)
    .filter(([, re]) => re.test(title))
    .map(([region]) => region);
}

export function parseYesPrice(market) {
  try {
    const prices = JSON.parse(market.outcomePrices || '[]');
    if (prices.length >= 1) {
      const p = parseFloat(prices[0]);
      if (!Number.isNaN(p) && p >= 0 && p <= 1) return +(p * 100).toFixed(1);
    }
  } catch {}
  return null;
}

function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function toProbability(price) {
  const n = parseNumber(price);
  if (n === null) return null;
  if (n >= 0 && n <= 1) return n;
  if (n >= 0 && n <= 100) return n / 100;
  return null;
}

function toPricePct(price) {
  const p = toProbability(price);
  return p === null ? null : +(p * 100).toFixed(1);
}

function inferNoPrice(yesPrice, noPrice) {
  const noP = toPricePct(noPrice);
  if (noP !== null) return noP;
  const yesP = toPricePct(yesPrice);
  if (yesP === null) return null;
  return +(100 - yesP).toFixed(1);
}

function pickTruthy(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

export function computeSpreadPct(market) {
  const spread = parseNumber(pickTruthy(market.spreadPct, market.spread, market.spread_percentage));
  if (spread !== null && spread >= 0) {
    return spread > 1 ? spread / 100 : spread;
  }

  const bestBid = parseNumber(pickTruthy(market.bestBid, market.best_bid, market.bid, market.bidPrice));
  const bestAsk = parseNumber(pickTruthy(market.bestAsk, market.best_ask, market.ask, market.askPrice));
  if (bestBid === null || bestAsk === null || bestAsk <= 0 || bestAsk < bestBid) return null;
  return (bestAsk - bestBid) / bestAsk;
}

export function computeDaysToExpiry(endDate, now = Date.now()) {
  if (!endDate) return null;
  const endMs = Date.parse(endDate);
  if (!Number.isFinite(endMs)) return null;
  return (endMs - now) / DAY_MS;
}

export function pickCheaperSide(yesPrice, noPrice) {
  const yes = toPricePct(yesPrice);
  const no = inferNoPrice(yesPrice, noPrice);
  if (yes === null && no === null) return null;
  if (yes === null) return { side: 'no', currentPrice: no, yesPrice: null, noPrice: no };
  if (no === null) return { side: 'yes', currentPrice: yes, yesPrice: yes, noPrice: null };
  if (yes <= no) return { side: 'yes', currentPrice: yes, yesPrice: yes, noPrice: no };
  return { side: 'no', currentPrice: no, yesPrice: yes, noPrice: no };
}

export function normalizeCoarseMarket(raw, now = Date.now()) {
  const sidePick = pickCheaperSide(
    pickTruthy(raw.yesPrice, raw.currentPrice, raw.pYes, raw.yes_price),
    pickTruthy(raw.noPrice, raw.no_price, raw.pNo, raw.no_price),
  );
  if (!sidePick) return null;

  const volume24h = parseNumber(pickTruthy(raw.volume24h, raw.volume_24h, raw.volume24H, raw.volume));
  const liquidity = parseNumber(pickTruthy(raw.liquidity, raw.orderBookDepth, raw.liquidityNum));
  const spreadPct = computeSpreadPct(raw);
  const daysToExpiry = computeDaysToExpiry(raw.endDate, now);
  const isActive = Boolean(
    pickTruthy(raw.isActive, raw.active, raw.mustBeActive, raw.closed === false, raw.is_closed === false),
  );
  const acceptingOrders = Boolean(
    pickTruthy(raw.acceptingOrders, raw.acceptsOrders, raw.enableOrderBook, raw.mustAcceptOrders, true),
  );

  return {
    marketId: String(pickTruthy(raw.marketId, raw.id, raw.conditionId, raw.slug, raw.url, raw.title) ?? ''),
    eventId: String(pickTruthy(raw.eventId, raw.parentEventId, raw.eventSlug, raw.slug, raw.title) ?? ''),
    title: raw.title ?? '',
    source: raw.source ?? 'unknown',
    side: sidePick.side,
    currentPrice: +(sidePick.currentPrice / 100).toFixed(4),
    yesPrice: sidePick.yesPrice,
    noPrice: sidePick.noPrice,
    volume24h,
    liquidity,
    spreadPct,
    daysToExpiry,
    endDate: raw.endDate ?? null,
    isActive,
    acceptingOrders,
    url: raw.url ?? null,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    raw,
  };
}

export function passesCoarseFilter(market, config = FILTER_CONFIG, now = Date.now()) {
  const price = toProbability(market.currentPrice);
  if (price === null || price < config.min_price || price > config.max_price) return false;

  const volume24h = parseNumber(market.volume24h);
  if (volume24h === null || volume24h < config.min_volume_24h) return false;

  const liquidity = parseNumber(market.liquidity);
  if (liquidity === null || liquidity < config.min_liquidity) return false;

  const spreadPct = parseNumber(market.spreadPct);
  if (spreadPct === null || spreadPct < 0 || spreadPct > config.max_spread_pct) return false;

  const daysToExpiry = market.daysToExpiry ?? computeDaysToExpiry(market.endDate, now);
  if (daysToExpiry === null || daysToExpiry < config.min_days_to_expiry || daysToExpiry > config.max_days_to_expiry) {
    return false;
  }

  if (config.must_be_active && market.isActive !== true) return false;
  if (config.must_accept_orders && market.acceptingOrders !== true) return false;

  return true;
}

function module1CandidateScore(market) {
  const priceEdge = 1 - Math.min(Math.abs((market.currentPrice ?? 0) - 0.25) / 0.25, 1);
  const volumeScore = Math.min((parseNumber(market.volume24h) ?? 0) / 50_000, 1);
  const liquidityScore = Math.min((parseNumber(market.liquidity) ?? 0) / 50_000, 1);
  const spreadPenalty = Math.min((parseNumber(market.spreadPct) ?? 1) / 0.1, 1);
  return (priceEdge * 0.45) + (volumeScore * 0.25) + (liquidityScore * 0.2) + ((1 - spreadPenalty) * 0.1);
}

export function dedupeByEventAndCheaperSide(markets) {
  const bestByEvent = new Map();
  for (const market of markets) {
    const eventId = market.eventId || market.marketId;
    if (!eventId) continue;
    const current = bestByEvent.get(eventId);
    if (!current) {
      bestByEvent.set(eventId, market);
      continue;
    }

    if (market.currentPrice < current.currentPrice) {
      bestByEvent.set(eventId, market);
      continue;
    }

    if (market.currentPrice === current.currentPrice) {
      const marketVolume = parseNumber(market.volume24h) ?? 0;
      const currentVolume = parseNumber(current.volume24h) ?? 0;
      if (marketVolume > currentVolume) bestByEvent.set(eventId, market);
    }
  }

  return Array.from(bestByEvent.values());
}

export function buildModule1Candidates(rawMarkets, options = {}) {
  const now = options.now ?? Date.now();
  const config = options.config ?? FILTER_CONFIG;
  const relaxedConfig = options.relaxedConfig ?? RELAXED_FILTER_CONFIG;
  const minTarget = options.minTarget ?? 50;
  const maxCandidates = options.maxCandidates ?? 100;

  const normalized = rawMarkets
    .map(m => normalizeCoarseMarket(m, now))
    .filter(Boolean);

  const strictPassed = normalized.filter(m => passesCoarseFilter(m, config, now));
  let usedRelaxed = false;
  let passed = strictPassed;
  if (passed.length < minTarget && relaxedConfig) {
    const relaxedPassed = normalized.filter(m => passesCoarseFilter(m, relaxedConfig, now));
    if (relaxedPassed.length > passed.length) {
      passed = relaxedPassed;
      usedRelaxed = true;
    }
  }

  const deduped = dedupeByEventAndCheaperSide(passed);

  const candidates = deduped
    .sort((a, b) => module1CandidateScore(b) - module1CandidateScore(a))
    .slice(0, maxCandidates)
    .map(m => ({
      marketId: m.marketId,
      eventId: m.eventId,
      title: m.title,
      source: m.source,
      side: m.side,
      currentPrice: m.currentPrice,
      yesPrice: m.yesPrice,
      noPrice: m.noPrice,
      volume24h: m.volume24h,
      liquidity: m.liquidity,
      spreadPct: m.spreadPct,
      daysToExpiry: m.daysToExpiry,
      endDate: m.endDate,
      url: m.url,
      tags: m.tags,
      metadata: {
        isActive: m.isActive,
        acceptingOrders: m.acceptingOrders,
      },
    }));

  return {
    candidates,
    stats: {
      raw: rawMarkets.length,
      normalized: normalized.length,
      strictPassed: strictPassed.length,
      passed: passed.length,
      deduped: deduped.length,
      usedRelaxed,
    },
  };
}

export function shouldInclude(m, relaxed = false) {
  const profile = relaxed ? LEGACY_SCORING_FILTER_CONFIG.relaxed : LEGACY_SCORING_FILTER_CONFIG.strict;
  const minPrice = profile.min_price * 100;
  const maxPrice = profile.max_price * 100;
  if (m.yesPrice < minPrice || m.yesPrice > maxPrice) return false;
  if (m.volume < profile.min_volume_24h) return false;
  if (isExcluded(m.title)) return false;
  if (isMemeCandidate(m.title, m.yesPrice)) return false;
  return true;
}

export function scoreMarket(m) {
  const uncertainty = 1 - (2 * Math.abs(m.yesPrice - 50) / 100);
  const vol = Math.log10(Math.max(m.volume, 1)) / Math.log10(10_000_000);
  return (uncertainty * 0.6) + (Math.min(vol, 1) * 0.4);
}

export function isExpired(endDate) {
  if (!endDate) return false;
  const ms = Date.parse(endDate);
  return Number.isFinite(ms) && ms < Date.now();
}

export function filterAndScore(candidates, tagFilter, limit = 25) {
  let filtered = candidates.filter(m => !isExpired(m.endDate));
  if (tagFilter) filtered = filtered.filter(tagFilter);

  let result = filtered.filter(m => shouldInclude(m));
  if (result.length < 15) {
    result = filtered.filter(m => shouldInclude(m, true));
  }

  return result
    .map(m => ({ ...m, regions: tagRegions(m.title) }))
    .sort((a, b) => scoreMarket(b) - scoreMarket(a))
    .slice(0, limit);
}
