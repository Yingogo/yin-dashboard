const MARKETS = [
  { symbol: "NQ=F", ticker: "MNQ", name: "Micro E-mini Nasdaq-100 Futures", english: "CME EQUITY INDEX", accent: "#39a0ff", decimals: 2 },
  { symbol: "GC=F", ticker: "MGC", name: "Micro Gold Futures", english: "COMEX PRECIOUS METALS", accent: "#ffbd2e", decimals: 2 },
  { symbol: "MCL=F", ticker: "MCL", name: "Micro WTI Crude Oil Futures", english: "NYMEX ENERGY", accent: "#d58d66", decimals: 2 }
];

const state = { analyses: [], context: null, loading: false };

function ema(values, period) {
  if (!values.length) return [];
  const multiplier = 2 / (period + 1);
  const result = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    result.push(values[index] * multiplier + result[index - 1] * (1 - multiplier));
  }
  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  for (let index = values.length - period; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  return losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
}

function atr(bars, period = 14) {
  if (bars.length <= period) return 0;
  return bars.slice(-period).reduce((sum, bar, index, sliced) => {
    const originalIndex = bars.length - period + index;
    const previous = bars[originalIndex - 1]?.close ?? sliced[0].open;
    return sum + Math.max(bar.high - bar.low, Math.abs(bar.high - previous), Math.abs(bar.low - previous));
  }, 0) / period;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function marketStructure(bars, lookback = 80) {
  const sample = bars.slice(-lookback);
  const swingHighs = [];
  const swingLows = [];

  for (let index = 2; index < sample.length - 2; index += 1) {
    const bar = sample[index];
    const isSwingHigh = bar.high > sample[index - 1].high &&
      bar.high >= sample[index - 2].high &&
      bar.high > sample[index + 1].high &&
      bar.high >= sample[index + 2].high;
    const isSwingLow = bar.low < sample[index - 1].low &&
      bar.low <= sample[index - 2].low &&
      bar.low < sample[index + 1].low &&
      bar.low <= sample[index + 2].low;

    if (isSwingHigh) swingHighs.push(bar.high);
    if (isSwingLow) swingLows.push(bar.low);
  }

  if (swingHighs.length < 2 || swingLows.length < 2) {
    return { label: "結構不足", tone: "neutral", score: 0 };
  }

  const highPattern = swingHighs.at(-1) > swingHighs.at(-2) ? "HH" : "LH";
  const lowPattern = swingLows.at(-1) > swingLows.at(-2) ? "HL" : "LL";

  if (highPattern === "HH" && lowPattern === "HL") {
    return { label: "HH / HL 多方結構", tone: "positive", score: 100 };
  }
  if (highPattern === "LH" && lowPattern === "LL") {
    return { label: "LH / LL 空方結構", tone: "negative", score: -100 };
  }
  if (highPattern === "HH" && lowPattern === "LL") {
    return { label: "HH / LL 擴張震盪", tone: "neutral", score: 0 };
  }
  return { label: "LH / HL 收斂震盪", tone: "neutral", score: 0 };
}

function aggregateBars(bars, hours = 4) {
  const bucketSize = hours * 60 * 60 * 1000;
  const buckets = new Map();

  bars.forEach((bar) => {
    const key = Math.floor(bar.time / bucketSize) * bucketSize;
    const current = buckets.get(key);
    if (!current) {
      buckets.set(key, { ...bar, time: key });
      return;
    }
    current.high = Math.max(current.high, bar.high);
    current.low = Math.min(current.low, bar.low);
    current.close = bar.close;
    current.volume += bar.volume || 0;
  });

  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

function momentumScore(momentum) {
  if (Math.abs(momentum) < 0.02) return 0;
  return momentum > 0
    ? clamp(momentum * 35, 20, 100)
    : clamp(momentum * 35, -100, -20);
}

function scoreTimeframe(bars) {
  const closes = bars.map((bar) => bar.close);
  const last = closes.at(-1);
  const ema9 = ema(closes, 9).at(-1);
  const ema21 = ema(closes, 21).at(-1);
  const ema50 = ema(closes, 50).at(-1);
  const rsi14 = rsi(closes);
  const momentum = closes.length > 6 ? ((last / closes.at(-6)) - 1) * 100 : 0;
  const structure = marketStructure(bars);
  const score = structure.score * 0.85 + momentumScore(momentum) * 0.15;
  return {
    score: Math.round(clamp(score, -100, 100)),
    rsi: rsi14,
    ema9,
    ema21,
    ema50,
    momentum,
    momentumScore: momentumScore(momentum),
    structure
  };
}

function newYorkKey(timestamp) {
  const shifted = timestamp + 6 * 60 * 60 * 1000;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(shifted));
}

function sessionStats(bars) {
  const latestKey = newYorkKey(bars.at(-1).time);
  const session = bars.filter((bar) => newYorkKey(bar.time) === latestKey);
  const active = session.length ? session : bars.slice(-78);
  let weighted = 0;
  let volume = 0;
  active.forEach((bar) => {
    const typical = (bar.high + bar.low + bar.close) / 3;
    weighted += typical * bar.volume;
    volume += bar.volume;
  });
  const vwap = volume > 0 ? weighted / volume : active.reduce((sum, bar) => sum + bar.close, 0) / active.length;
  const firstHour = active.slice(0, Math.min(12, active.length));
  return {
    vwap,
    high: Math.max(...active.map((bar) => bar.high)),
    low: Math.min(...active.map((bar) => bar.low)),
    open: active[0].open,
    openingHigh: Math.max(...firstHour.map((bar) => bar.high)),
    openingLow: Math.min(...firstHour.map((bar) => bar.low))
  };
}

function label(score) {
  if (score >= 45) return { text: "偏多", tone: "positive" };
  if (score <= -45) return { text: "偏空", tone: "negative" };
  return { text: "中性", tone: "neutral" };
}

function impactLabel(score) {
  if (score >= 20) return { text: "偏多", tone: "positive" };
  if (score <= -20) return { text: "偏空", tone: "negative" };
  return { text: "中性", tone: "neutral" };
}

function weightedTimeframeScore(scores, picker) {
  return picker(scores.m5) * 0.15 + picker(scores.m15) * 0.35 + picker(scores.h1) * 0.4 + picker(scores.d1) * 0.1;
}

function vwapScore(last, session) {
  if (!Number.isFinite(last) || !Number.isFinite(session?.vwap) || !session.vwap) return 0;
  const distance = (last / session.vwap - 1) * 100;
  if (Math.abs(distance) < 0.05) return 0;
  return distance > 0 ? 100 : -100;
}

function technicalScore(scores, last, session) {
  const structure = weightedTimeframeScore(scores, (item) => item.structure?.score ?? 0);
  const momentum = weightedTimeframeScore(scores, (item) => item.momentumScore ?? 0);
  return structure * 0.7 + vwapScore(last, session) * 0.2 + momentum * 0.1;
}

function marketBias(item) {
  const weights = {
    MNQ: { fundamental: 0.3, technical: 0.7 },
    MGC: { fundamental: 0.4, technical: 0.6 },
    MCL: { fundamental: 0.5, technical: 0.5 }
  }[item.ticker];
  const neutralStructure = { score: 0, label: "震盪", tone: "neutral" };
  const structureScores = [
    { name: "Daily", structure: item.scores.d1.structure || neutralStructure, weight: 0.25 },
    { name: "4H", structure: item.scores.h4.structure || neutralStructure, weight: 0.25 },
    { name: "1H", structure: item.scores.h1.structure || neutralStructure, weight: 0.25 },
    { name: "15M", structure: item.scores.m15.structure || neutralStructure, weight: 0.15 },
    { name: "5M", structure: item.scores.m5.structure || neutralStructure, weight: 0.1 }
  ].map((entry) => ({
    ...entry,
    value: entry.structure.score ?? 0
  }));
  const structureScore = structureScores.reduce((sum, entry) => sum + entry.value * entry.weight, 0);
  const connectedFundamentals = predictiveFactors(item.factors);
  const fundamentalScore = connectedFundamentals.length ? combinedScore(connectedFundamentals) : 0;
  const rawScore = structureScore * weights.technical + fundamentalScore * weights.fundamental;
  const score = Math.round(clamp(rawScore / 10, -10, 10));
  const conclusion = score >= 5
    ? { label: "偏多", english: "Bullish", tone: "positive" }
    : score >= 2
      ? { label: "稍微偏多", english: "Slightly Bullish", tone: "positive" }
      : score <= -5
        ? { label: "偏空", english: "Bearish", tone: "negative" }
        : score <= -2
          ? { label: "稍微偏空", english: "Slightly Bearish", tone: "negative" }
          : { label: "不交易", english: "No Trade", tone: "neutral" };
  const structureReasons = structureScores.map((entry) => {
    const points = Math.round(entry.value * entry.weight * weights.technical / 10);
    return {
      name: entry.name,
      detail: entry.structure.label || "震盪",
      tone: entry.structure.tone || (points > 0 ? "positive" : points < 0 ? "negative" : "neutral"),
      points
    };
  });
  const fundamentalReasons = connectedFundamentals
    .map((factor) => ({
      name: factor.name,
      points: Math.round(factor.score * factor.weight / 100 * weights.fundamental / 10)
    }))
    .filter((entry) => entry.points !== 0)
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
    .slice(0, 3)
    .map((entry) => ({
      ...entry,
      detail: entry.points > 0 ? "偏多因子" : "偏空因子",
      tone: entry.points > 0 ? "positive" : "negative"
    }));

  return {
    score,
    ...conclusion,
    structureReasons,
    fundamentalReasons,
    weights
  };
}

function buildFactors(market, scores, context, session, last) {
  const technical = technicalScore(scores, last, session);
  const hasData = (item) => Number.isFinite(item?.value) && Number.isFinite(item?.change5d);
  const dxyScore = hasData(context.dxy) ? clamp(-context.dxy.change5d * 35, -100, 100) : null;
  const yieldScore = hasData(context.treasury10y) ? clamp(-context.treasury10y.change5d * 28, -100, 100) : null;
  const formatSigned = (value, digits = 2) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
  const marketFactor = (name, item, score, weight, source = "Yahoo Finance") => ({
    name,
    value: hasData(item) ? item.value.toFixed(2) : "暫無資料",
    detail: hasData(item) ? `5日 ${formatSigned(item.change5d)}` : "不參與分數",
    score: hasData(item) ? score : null,
    weight: hasData(item) ? weight : 0,
    source: hasData(item) ? source : `${source}｜受限`
  });
  const common = {
    technical: {
      name: "多週期價格結構", value: `${Math.round(technical) > 0 ? "+" : ""}${Math.round(technical)}`,
      detail: "HH/HL 70% · VWAP 20% · 動能 10%", score: technical, source: "Yahoo Finance"
    },
    dxy: {
      name: "美元指數 DXY", value: hasData(context.dxy) ? context.dxy.value.toFixed(2) : "暫無資料",
      detail: hasData(context.dxy) ? `5日 ${formatSigned(context.dxy.change5d)}` : "不參與分數",
      score: dxyScore, source: hasData(context.dxy) ? "Yahoo Finance" : "Yahoo Finance｜受限"
    },
    yield: {
      name: "美國 10Y 殖利率", value: hasData(context.treasury10y) ? `${context.treasury10y.value.toFixed(3)}%` : "暫無資料",
      detail: hasData(context.treasury10y) ? `5日 ${formatSigned(context.treasury10y.change5d)}` : "不參與分數",
      score: yieldScore, source: hasData(context.treasury10y) ? "Yahoo Finance" : "Yahoo Finance｜受限"
    }
  };
  const rateProxy = context.nq.rateProxy;
  const rateProxyAvailable = Number.isFinite(rateProxy?.impliedRate) && Number.isFinite(rateProxy?.effr);
  const rateSpreadBps = rateProxyAvailable ? (rateProxy.effr - rateProxy.impliedRate) * 100 : null;
  const rateProxyScore = rateProxyAvailable
    ? clamp(rateSpreadBps * 4 + (rateProxy.futureChange5d || 0) * 300, -100, 100)
    : null;
  const rateProxyBias = rateProxyAvailable
    ? rateSpreadBps >= 12.5
      ? "偏向降息"
      : rateSpreadBps <= -12.5
        ? "偏向升息"
        : "接近持平"
    : "暫無資料";
  const rateProxyFactor = {
    name: "Fed 利率預期代理",
    value: rateProxyBias,
    detail: rateProxyAvailable
      ? `ZQ 隱含 ${rateProxy.impliedRate.toFixed(3)}%｜EFFR ${rateProxy.effr.toFixed(2)}%`
      : "ZQ / EFFR 暫無資料",
    score: rateProxyScore,
    weight: rateProxyAvailable ? 12 : 0,
    source: "自動：ZQ / NY Fed｜人工：MacroMicro",
    links: [
      { label: "CME Fed Funds", url: "https://www.cmegroup.com/markets/interest-rates/stirs/30-day-federal-fund.html" },
      { label: "NY Fed EFFR", url: "https://www.newyorkfed.org/markets/reference-rates/effr" },
      { label: "MacroMicro", url: "https://www.macromicro.me/charts/127852/probability-fed-rate-hike" }
    ]
  };

  if (market.ticker === "MNQ") {
    const vixScore = !hasData(context.nq.vix)
      ? null
      : context.nq.vix.value < 18
      ? 65
      : context.nq.vix.value > 25
        ? -85
        : clamp((21.5 - context.nq.vix.value) * 18, -60, 60);
    const cpiAvailable = Number.isFinite(context.nq.cpi.monthlyPercent);
    const payrollAvailable = Number.isFinite(context.nq.payrolls.changeThousands);
    const cpiScore = !cpiAvailable
      ? null
      : context.nq.cpi.monthlyPercent <= 0.2
      ? 45
      : context.nq.cpi.monthlyPercent >= 0.4
        ? -55
        : 0;
    const payrollScore = !payrollAvailable
      ? null
      : context.nq.payrolls.changeThousands < 100
      ? 25
      : context.nq.payrolls.changeThousands > 250
        ? -35
        : 0;
    return [
      { ...common.technical, weight: 28 },
      marketFactor("VIX 恐慌指數", context.nq.vix, vixScore, 12, "延遲市場序列"),
      { ...common.yield, weight: 14 },
      { ...common.dxy, weight: 7 },
      marketFactor("SOXX 半導體 ETF", context.nq.soxx, hasData(context.nq.soxx) ? clamp(context.nq.soxx.change5d * 30, -100, 100) : null, 12),
      marketFactor("NVDA", context.nq.nvda, hasData(context.nq.nvda) ? clamp(context.nq.nvda.change5d * 25, -100, 100) : null, 10),
      marketFactor("QQQ ETF", context.nq.qqq, hasData(context.nq.qqq) ? clamp(context.nq.qqq.change5d * 32, -100, 100) : null, 7),
      {
        name: "CPI 月增趨勢", value: cpiAvailable ? `${context.nq.cpi.monthlyPercent >= 0 ? "+" : ""}${context.nq.cpi.monthlyPercent.toFixed(2)}%` : "暫無資料",
        detail: cpiAvailable ? `${context.nq.cpi.period}｜${context.nq.cpi.sourceStatus}｜無共識值` : "不參與分數",
        score: cpiScore, weight: cpiAvailable ? 5 : 0, source: "BLS 官方 API"
      },
      {
        name: "非農新增趨勢", value: payrollAvailable ? `${context.nq.payrolls.changeThousands >= 0 ? "+" : ""}${context.nq.payrolls.changeThousands.toFixed(0)}K` : "暫無資料",
        detail: payrollAvailable ? `${context.nq.payrolls.period}｜${context.nq.payrolls.sourceStatus}｜無共識值` : "不參與分數",
        score: payrollScore, weight: payrollAvailable ? 5 : 0, source: "BLS 官方 API"
      },
      rateProxyFactor,
      { name: "Fed 官員 / 重大新聞", value: "未接入", detail: "不參與分數", score: null, weight: 0, source: "Fed / Reuters" }
    ];
  }

  if (market.ticker === "MGC") {
    return [
      { ...common.technical, weight: 45 },
      { ...common.dxy, weight: 15 },
      { ...common.yield, weight: 15 },
      { ...rateProxyFactor, weight: rateProxyAvailable ? 15 : 0 },
      {
        name: "全球黃金需求", value: `${context.goldDemand.totalTonnes.toLocaleString()} 噸`,
        detail: `${context.goldDemand.period} 年增 +${context.goldDemand.yearChangePercent}%`,
        score: 35, weight: 10, source: "World Gold Council"
      },
      { name: "地緣政治 / 經濟事件", value: "未接入", detail: "不參與分數", score: null, weight: 0, source: "Reuters / Calendar" }
    ];
  }

  const stocks = context.oil.crudeStocks;
  const production = context.oil.crudeProduction;
  const gasoline = context.oil.gasolineDemand;
  const eiaAvailable = (item) => Number.isFinite(item?.value) && Number.isFinite(item?.change);
  const stocksPct = eiaAvailable(stocks) ? stocks.change / stocks.previous * 100 : null;
  const productionPct = eiaAvailable(production) ? production.change / production.previous * 100 : null;
  const gasolinePct = eiaAvailable(gasoline) ? gasoline.change / gasoline.previous * 100 : null;
  return [
    { ...common.technical, weight: 35 },
    {
      name: "EIA 原油庫存", value: eiaAvailable(stocks) ? `${(stocks.value / 1000).toFixed(1)}M bbl` : "暫無資料",
      detail: eiaAvailable(stocks) ? `週變 ${stocks.change >= 0 ? "+" : ""}${(stocks.change / 1000).toFixed(1)}M` : "不參與分數",
      score: eiaAvailable(stocks) ? clamp(-stocksPct * 30, -100, 100) : null,
      weight: eiaAvailable(stocks) ? 20 : 0,
      source: eiaAvailable(stocks) ? `${stocks.sourceStatus || "EIA"} ${stocks.period}` : "EIA｜受限",
      links: [
        { label: "EIA 週報", url: "https://www.eia.gov/petroleum/supply/weekly/" },
        { label: "EIA 歷史值", url: "https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?n=PET&s=WCESTUS1&f=W" },
        { label: "Investing 預期", url: "https://www.investing.com/economic-calendar/eia-crude-oil-inventories-75" }
      ]
    },
    {
      name: "美國原油產量", value: eiaAvailable(production) ? `${(production.value / 1000).toFixed(2)}M bpd` : "暫無資料",
      detail: eiaAvailable(production) ? `週變 ${production.change >= 0 ? "+" : ""}${production.change.toFixed(0)}K` : "不參與分數",
      score: eiaAvailable(production) ? clamp(-productionPct * 80, -100, 100) : null,
      weight: eiaAvailable(production) ? 10 : 0,
      source: eiaAvailable(production) ? `${production.sourceStatus || "EIA"} ${production.period}` : "EIA｜受限",
      links: [{ label: "EIA 產量", url: "https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?n=PET&s=WCRFPUS2&f=W" }]
    },
    {
      name: "美國汽油需求", value: eiaAvailable(gasoline) ? `${(gasoline.value / 1000).toFixed(2)}M bpd` : "暫無資料",
      detail: eiaAvailable(gasoline) ? `週變 ${gasoline.change >= 0 ? "+" : ""}${gasoline.change.toFixed(0)}K` : "不參與分數",
      score: eiaAvailable(gasoline) ? clamp(gasolinePct * 18, -100, 100) : null,
      weight: eiaAvailable(gasoline) ? 5 : 0,
      source: eiaAvailable(gasoline) ? `${gasoline.sourceStatus || "EIA"} ${gasoline.period}` : "EIA｜受限",
      links: [{ label: "EIA 汽油需求", url: "https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?n=PET&s=WGFUPUS2&f=W" }]
    },
    { ...common.dxy, weight: 5 },
    marketFactor(
      "Brent 全球油價代理",
      context.oil.brent,
      hasData(context.oil.brent) ? clamp(context.oil.brent.change5d * 25, -100, 100) : null,
      10,
      "Yahoo Finance｜Brent"
    ),
    marketFactor(
      "XLE 能源股確認",
      context.oil.energyEquity,
      hasData(context.oil.energyEquity) ? clamp(context.oil.energyEquity.change5d * 25, -100, 100) : null,
      10,
      "Yahoo Finance｜XLE"
    ),
    marketFactor(
      "FXI 中國需求代理",
      context.oil.chinaProxy,
      hasData(context.oil.chinaProxy) ? clamp(context.oil.chinaProxy.change5d * 22, -100, 100) : null,
      5,
      "Yahoo Finance｜FXI"
    ),
    { name: "API 庫存", value: "未接入", detail: "資料需授權或人工輸入", score: null, weight: 0, source: "American Petroleum Institute" },
    {
      name: "OPEC+ / 中東消息", value: "人工確認", detail: "事件文字，尚未自動計分",
      score: null, weight: 0, source: "OPEC / Reuters",
      links: [{ label: "OPEC 月報", url: "https://publications.opec.org/" }]
    },
    {
      name: "WTI 期限結構", value: "人工確認", detail: "近遠月授權報價尚未接入",
      score: null, weight: 0, source: "CME WTI",
      links: [{ label: "CME WTI Quotes", url: "https://www.cmegroup.com/markets/energy/crude-oil/light-sweet-crude.quotes.html" }]
    }
  ];
}

function combinedScore(factors) {
  const connected = factors.filter((factor) => factor.score !== null && factor.weight > 0);
  const totalWeight = connected.reduce((sum, factor) => sum + factor.weight, 0);
  return connected.reduce((sum, factor) => sum + factor.score * factor.weight, 0) / totalWeight;
}

function factorCoverage(factors) {
  if (!factors.length) return 0;
  return factors.filter((factor) => factor.score !== null && factor.weight > 0).length / factors.length;
}

function predictiveFactors(factors) {
  return factors.slice(1).filter((factor) => factor.score !== null && factor.weight > 0);
}

function predictiveTimeframes(factors) {
  const available = predictiveFactors(factors);
  const score = available.length ? combinedScore(available) : 0;
  return {
    m5: { score: Math.round(clamp(score * 0.35, -100, 100)) },
    m15: { score: Math.round(clamp(score * 0.55, -100, 100)) },
    h1: { score: Math.round(clamp(score * 0.8, -100, 100)) },
    d1: { score: Math.round(clamp(score, -100, 100)) }
  };
}

function scenarioWeights(score, coverage, eventRisk) {
  const directional = clamp(score, -100, 100);
  let bullish = 34 + directional * 0.34;
  let bearish = 34 - directional * 0.34;
  let neutral = 32 - Math.abs(directional) * 0.16;
  if (eventRisk) {
    bullish += 4;
    bearish += 4;
    neutral -= 8;
  }
  const uncertainty = (1 - coverage) * 22;
  neutral += uncertainty;
  bullish -= uncertainty / 2;
  bearish -= uncertainty / 2;
  bullish = Math.max(8, bullish);
  bearish = Math.max(8, bearish);
  neutral = Math.max(10, neutral);
  const total = bullish + bearish + neutral;
  return {
    bullish: Math.round(bullish / total * 100),
    neutral: Math.round(neutral / total * 100),
    bearish: 100 - Math.round(bullish / total * 100) - Math.round(neutral / total * 100)
  };
}

function buildForwardForecast(market, factors, context, coverage) {
  const inputs = predictiveFactors(factors);
  const score = inputs.length ? combinedScore(inputs) : 0;
  const upcoming = (context.events || context.nq.events || [])
        .filter((event) => !event.markets || event.markets.includes(market.ticker))
        .map((event) => ({ ...event, distance: new Date(event.at).getTime() - Date.now() }))
        .filter((event) => event.distance > 0)
        .sort((a, b) => a.distance - b.distance)[0];
  const eventRisk = Boolean(upcoming && upcoming.distance <= 4 * 24 * 60 * 60 * 1000);
  const weights = scenarioWeights(score, coverage, eventRisk);
  const available = inputs
    .map((factor) => ({ ...factor, contribution: factor.score * factor.weight }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const leaders = available.slice(0, 3).map((factor) => `${factor.name}${impactLabel(factor.score).text}`);
  const dominant = weights.bullish >= weights.bearish && weights.bullish >= weights.neutral
    ? { label: "偏多情境較高", tone: "positive" }
    : weights.bearish >= weights.bullish && weights.bearish >= weights.neutral
      ? { label: "偏空情境較高", tone: "negative" }
      : { label: "震盪情境較高", tone: "neutral" };
  const invalidation = score < -10
    ? "若價格重新站回 VWAP、殖利率轉跌或領導資產轉強，數據分析（預測資料）的偏空判斷需下修。"
    : score > 10
      ? "若價格跌破 VWAP、殖利率急升或領導資產轉弱，數據分析（預測資料）的偏多判斷需下修。"
      : "若多週期與跨市場因素開始同向，數據分析（預測資料）的震盪判斷將失效。";
  const confidence = Math.round(clamp(Math.abs(score), 20, 85));
  const strengthLabel = directionStrength(dominant.tone, confidence);

  return {
    ...weights,
    ...dominant,
    score,
    confidence,
    strengthLabel,
    horizon: eventRisk ? `${upcoming.name}公布前` : "下一交易時段",
    basis: leaders.length ? leaders.join("、") : "目前可用因素不足",
    event: eventRisk ? `${upcoming.name}尚未公布，結果可能造成方向跳變。` : "目前沒有四天內的已接入重大事件。",
    invalidation
  };
}

function directionStrength(tone, confidence, insufficient = false) {
  if (insufficient) return "資料不足";
  if (tone === "neutral" || confidence < 25) return "多空拉鋸";
  const side = tone === "positive" ? "偏多" : "偏空";
  if (confidence < 40) return `稍微${side}`;
  if (confidence < 60) return side;
  if (confidence < 80) return `強烈${side}`;
  return `極度${side}`;
}

function weightRegime(market, context) {
  const rules = {
    MNQ: /Nonfarm|CPI|FOMC|ISM/i,
    MGC: /Nonfarm|CPI|FOMC/i,
    MCL: /EIA Crude|OPEC|API Crude/i
  };
  const now = Date.now();
  const event = (context.events || context.nq.events || [])
    .map((item) => ({ ...item, distance: new Date(item.at).getTime() - now }))
    .filter((item) =>
      item.distance > 0 &&
      item.distance <= 3 * 24 * 60 * 60 * 1000 &&
      (!item.markets || item.markets.includes(market.ticker)) &&
      rules[market.ticker].test(item.name)
    )
    .sort((a, b) => a.distance - b.distance)[0];
  const dxyMove = market.ticker === "MGC" && Math.abs(context.dxy?.change5d || 0) >= 1;
  const yieldMove = market.ticker === "MGC" && Math.abs(context.treasury10y?.change5d || 0) >= 2;
  const triggers = [
    event ? `${event.name} 進入 72 小時窗口` : "",
    dxyMove ? "DXY 五日變動達 1%" : "",
    yieldMove ? "10Y Yield 五日變動達 2%" : ""
  ].filter(Boolean);
  const major = triggers.length > 0;
  return {
    currentWeight: major ? 0.4 : 0.7,
    forecastWeight: major ? 0.6 : 0.3,
    major,
    trigger: major ? triggers.join("、") : "目前沒有指定重大事件或異常變動"
  };
}

function buildCombinedDecision(market, forecast, scores, context, session, last) {
  const technical = technicalScore(scores, last, session);
  const regime = weightRegime(market, context);
  const score = forecast.score * regime.forecastWeight + technical * regime.currentWeight;
  const tone = score >= 20 ? "positive" : score <= -20 ? "negative" : "neutral";
  const confidence = Math.round(clamp(Math.abs(score), 20, 85));
  const finalLabel = directionStrength(tone, confidence);
  const technicalTone = technical >= 20 ? "偏多" : technical <= -20 ? "偏空" : "中性";
  const forecastTone = forecast.score >= 20 ? "偏多" : forecast.score <= -20 ? "偏空" : "中性";
  const agreement = technicalTone === forecastTone && technicalTone !== "中性";
  const conflict = technicalTone !== "中性" && forecastTone !== "中性" && technicalTone !== forecastTone;
  const statusShort = agreement ? "同向" : conflict ? "分歧" : "尚未同向";
  const statusTone = agreement ? "aligned" : conflict ? "conflict" : "mixed";
  const status = agreement
    ? `數據分析（預測資料）與技術分析（目前資料）同向，綜合結果為「${finalLabel}」。`
    : conflict
      ? `數據分析（預測資料）與技術分析（目前資料）分歧，但依權重後綜合結果為「${finalLabel}」。`
      : `部分訊號尚未同向，依權重後綜合結果為「${finalLabel}」。`;
  return {
    ...regime,
    score,
    tone,
    confidence,
    strengthLabel: finalLabel,
    statusShort,
    statusTone,
    status,
    reason: `數據分析（預測資料）${forecastTone}（${Math.round(regime.forecastWeight * 100)}%），技術分析（目前資料）${technicalTone}（${Math.round(regime.currentWeight * 100)}%）`
  };
}

function buildAlerts(market, context) {
  const alerts = [];
  const now = Date.now();
  const nextEvent = (context.events || context.nq.events || [])
    .filter((event) => !event.markets || event.markets.includes(market.ticker))
    .map((event) => ({ ...event, distance: new Date(event.at).getTime() - now }))
    .filter((event) => event.distance > 0)
    .sort((a, b) => a.distance - b.distance)[0];
  if (nextEvent && nextEvent.distance <= 4 * 24 * 60 * 60 * 1000) {
    const hours = Math.ceil(nextEvent.distance / (60 * 60 * 1000));
    alerts.push({
      tone: "warning",
      title: `${nextEvent.name} 事件風險`,
      detail: `${hours <= 24 ? `${hours} 小時內` : `${Math.ceil(hours / 24)} 天內`}公布，波動與跳空風險提高`
    });
  }
  const yieldData = context.treasury10y;
  if (Number.isFinite(yieldData?.change5d) && yieldData.change5d > 1) {
    alerts.push({ tone: "danger", title: "殖利率壓力", detail: `10Y 五日上升 ${yieldData.change5d.toFixed(2)}%，高估值科技股承壓` });
  }
  const leaders = [context.nq.soxx, context.nq.nvda, context.nq.qqq]
    .filter((item) => Number.isFinite(item?.change5d));
  if (leaders.length >= 2 && leaders.filter((item) => item.change5d < 0).length >= 2) {
    alerts.push({ tone: "danger", title: "科技領導轉弱", detail: "SOXX / NVDA / QQQ 多數五日動能為負" });
  }
  if (Number.isFinite(context.nq.vix?.value) && context.nq.vix.value >= 20) {
    alerts.push({ tone: "warning", title: "波動升溫", detail: `VIX ${context.nq.vix.value.toFixed(2)}，高於平靜區間` });
  }
  return alerts.slice(0, 4);
}

function eventUrgency(distance) {
  if (distance <= 60 * 60 * 1000) return { label: "1 小時內", tone: "danger" };
  if (distance <= 24 * 60 * 60 * 1000) return { label: "24 小時內", tone: "warning" };
  if (distance <= 3 * 24 * 60 * 60 * 1000) return { label: "3 天內", tone: "soon" };
  return { label: "行事曆", tone: "normal" };
}

function eventCountdown(distance) {
  const minutes = Math.max(0, Math.floor(distance / 60000));
  if (minutes < 60) return `${minutes} 分鐘`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小時 ${minutes % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小時`;
}

function highImpactEventInfo(event) {
  const name = event.name || "";
  if (/Consumer Price Index|CPI/i.test(name)) {
    return {
      importance: 5,
      higherLabel: "高於預期",
      lowerLabel: "低於預期",
      higher: { MNQ: "Bearish", MGC: "Bearish", MCL: "Neutral" },
      lower: { MNQ: "Bullish", MGC: "Bullish", MCL: "Neutral" }
    };
  }
  if (/Nonfarm|NFP/i.test(name)) {
    return {
      importance: 5,
      higherLabel: "高於預期",
      lowerLabel: "低於預期",
      higher: { MNQ: "Bearish", MGC: "Bearish", MCL: "Slightly Bullish" },
      lower: { MNQ: "Bullish", MGC: "Bullish", MCL: "Slightly Bearish" }
    };
  }
  if (/FOMC/i.test(name)) {
    return {
      importance: 5,
      higherLabel: "偏鷹／利率路徑較高",
      lowerLabel: "偏鴿／利率路徑較低",
      higher: { MNQ: "Bearish", MGC: "Bearish", MCL: "Bearish" },
      lower: { MNQ: "Bullish", MGC: "Bullish", MCL: "Bullish" }
    };
  }
  if (/Core PCE|PCE/i.test(name)) {
    return {
      importance: 4,
      higherLabel: "高於預期",
      lowerLabel: "低於預期",
      higher: { MNQ: "Bearish", MGC: "Bearish", MCL: "Neutral" },
      lower: { MNQ: "Bullish", MGC: "Bullish", MCL: "Neutral" }
    };
  }
  if (/EIA Crude Oil Inventories/i.test(name)) {
    return {
      importance: 5,
      higherLabel: "庫存高於預期",
      lowerLabel: "庫存低於預期",
      higher: { MNQ: "Neutral", MGC: "Neutral", MCL: "Bearish" },
      lower: { MNQ: "Neutral", MGC: "Neutral", MCL: "Bullish" }
    };
  }
  if (/OPEC/i.test(name)) {
    return {
      importance: 5,
      higherLabel: "增產／供給高於預期",
      lowerLabel: "減產／供給低於預期",
      higher: { MNQ: "Neutral", MGC: "Neutral", MCL: "Bearish" },
      lower: { MNQ: "Neutral", MGC: "Neutral", MCL: "Bullish" }
    };
  }
  if (/Middle East|Geopolitical/i.test(name)) {
    return {
      importance: 5,
      higherLabel: "風險升高",
      lowerLabel: "風險降溫",
      higher: { MNQ: "Bearish", MGC: "Bullish", MCL: "Bullish" },
      lower: { MNQ: "Bullish", MGC: "Bearish", MCL: "Bearish" }
    };
  }
  return null;
}

function impactTone(value) {
  if (/Bullish/i.test(value)) return "positive";
  if (/Bearish/i.test(value)) return "negative";
  return "neutral";
}

function renderEventCalendar() {
  const board = document.querySelector("#event-calendar");
  if (!board) return;
  const now = Date.now();
  const events = (state.context?.events || state.context?.nq?.events || [])
    .map((event) => ({
      ...event,
      distance: new Date(event.at).getTime() - now,
      impact: highImpactEventInfo(event)
    }))
    .filter((event) => event.impact)
    .filter((event) => event.distance > -60 * 60 * 1000)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 12);
  if (!events.length) {
    board.innerHTML = `<div class="event-empty">目前沒有已接入的高影響事件。</div>`;
    return;
  }
  const nextToday = events.find((event) =>
    event.distance > 0 &&
    event.distance <= 24 * 60 * 60 * 1000 &&
    /CPI|Nonfarm|NFP|FOMC|EIA Crude/i.test(event.name)
  );
  const highImpactBanner = nextToday
    ? `<div class="high-impact-banner">
        <span>HIGH IMPACT EVENT TODAY</span>
        <strong>${nextToday.name}</strong>
        <b>倒數 ${eventCountdown(nextToday.distance)}</b>
      </div>`
    : "";
  const impactLine = (label, values) => `<div class="event-impact-line">
    <strong>${label}</strong>
    ${["MNQ", "MGC", "MCL"].map((ticker) =>
      `<span class="${impactTone(values[ticker])}">${ticker}：${values[ticker]}</span>`
    ).join("")}
  </div>`;
  const eventRow = (event) => {
    const urgency = eventUrgency(event.distance);
    const date = new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit",
      weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false
    }).format(new Date(event.at));
    const markets = (event.markets || ["MNQ", "MGC", "MCL"]).join(" · ");
    const stars = "★".repeat(event.impact.importance) + "☆".repeat(5 - event.impact.importance);
    const previousValue = event.previous ?? "未接共識來源";
    const expectedValue = event.expected ?? "未接共識來源";
    const actualValue = event.actual ?? (event.distance <= 0 ? "需人工確認" : "待公布");
    return `<article class="event-row major-event ${urgency.tone}">
      <div class="event-time"><strong>${date}</strong><span>台灣時間</span></div>
      <div class="event-name"><strong><a href="${event.url}" target="_blank" rel="noopener noreferrer">${event.name}</a></strong><span>${event.source} · 影響 ${markets}</span></div>
      <div class="event-values">
        <div><span>前值</span><b>${previousValue}</b></div>
        <div><span>預期值</span><b>${expectedValue}</b></div>
        <div><span>實際值</span><b>${actualValue}</b></div>
        <div><span>重要度</span><b class="event-stars">${stars}</b></div>
      </div>
      <div class="event-impact">
        ${impactLine(`如果${event.impact.higherLabel}`, event.impact.higher)}
        ${impactLine(`如果${event.impact.lowerLabel}`, event.impact.lower)}
      </div>
      <div class="event-reminder"><b>${urgency.label}</b><span>倒數 ${eventCountdown(event.distance)}</span></div>
    </article>`;
  };
  const nearEvents = events.filter((event) => event.distance <= 3 * 24 * 60 * 60 * 1000);
  const laterEvents = events.filter((event) => event.distance > 3 * 24 * 60 * 60 * 1000);
  const nearHtml = nearEvents.length
    ? nearEvents.map(eventRow).join("")
    : `<div class="event-empty">未來 3 天內沒有已接入的重要數據。</div>`;
  const laterHtml = laterEvents.length
    ? `<details class="later-events">
        <summary>查看 3 天後的數據（${laterEvents.length}）</summary>
        <div class="later-event-grid">${laterEvents.map(eventRow).join("")}</div>
      </details>`
    : "";
  board.innerHTML = `${highImpactBanner}<div class="near-event-grid">${nearHtml}</div>${laterHtml}`;
}

function finalDecision(scores, last, session, atrPercent, stale, factors) {
  const weighted = combinedScore(factors);
  const aboveVwap = last > session.vwap;
  const stretched = atrPercent > 1.2;
  if (stale) {
    const lastBias = weighted >= 25 ? "最後偏多" : weighted <= -25 ? "最後偏空" : "最後中性";
    const staleTone = weighted >= 25 ? "positive" : weighted <= -25 ? "negative" : "neutral";
    return { action: `休市｜${lastBias}`, tone: staleTone, confidence: Math.round(clamp(Math.abs(weighted), 20, 85)), reason: "目前沒有新 K 棒，僅顯示上一交易時段狀態" };
  }
  if (weighted >= 25 && aboveVwap && !stretched) return { action: "目前偏多", tone: "positive", confidence: Math.round(clamp(weighted, 35, 95)), reason: "已接入因素加權偏多，且價格位於 VWAP 上方" };
  if (weighted <= -25 && !aboveVwap && !stretched) return { action: "目前偏空", tone: "negative", confidence: Math.round(clamp(Math.abs(weighted), 35, 95)), reason: "已接入因素加權偏空，且價格位於 VWAP 下方" };
  if (stretched) return { action: "方向不明", tone: "neutral", confidence: 35, reason: "盤中波動明顯擴張，方向可靠度降低" };
  return { action: "方向不明", tone: "neutral", confidence: Math.round(clamp(Math.abs(weighted), 20, 55)), reason: "週期或 VWAP 訊號尚未共振" };
}

function analyze(market, payload, context) {
  const series = payload.series;
  const scores = {
    m5: scoreTimeframe(series.m5),
    m15: scoreTimeframe(series.m15),
    h4: scoreTimeframe(aggregateBars(series.h1, 4)),
    h1: scoreTimeframe(series.h1),
    d1: scoreTimeframe(series.d1)
  };
  const bars = series.m5;
  const last = bars.at(-1).close;
  const session = sessionStats(bars);
  const atrValue = atr(series.m15);
  const atrPercent = atrValue / last * 100;
  const updatedTime = bars.at(-1).time;
  const stale = Date.now() - updatedTime > 45 * 60 * 1000;
  const factors = buildFactors(market, scores, context, session, last);
  const predictionInputs = predictiveFactors(factors);
  const observedFactor = [{ score: technicalScore(scores, last, session), weight: 100 }];
  const decision = finalDecision(scores, last, session, atrPercent, stale, observedFactor);
  const coverage = factorCoverage(factors);
  const predictiveCoverage = predictionInputs.length / Math.max(1, factors.slice(1).length);
  const forecast = buildForwardForecast(market, factors, context, predictiveCoverage);
  const combined = buildCombinedDecision(market, forecast, scores, context, session, last);
  decision.reason += "｜只使用已形成的價格與技術資料";
  decision.strengthLabel = directionStrength(decision.tone, decision.confidence);
  const previousDay = series.d1.at(-2)?.close || session.open;
  return {
    ...market, scores, last, session, atrValue, atrPercent, decision,
    changePercent: (last / previousDay - 1) * 100,
    bars,
    updatedTime, factors, factorScore: predictionInputs.length ? combinedScore(predictionInputs) : 0, coverage,
    alerts: buildAlerts(market, context),
    forecast,
    combined,
    predictiveScores: predictiveTimeframes(factors),
    stale
  };
}

function formatPrice(value, decimals = 2) {
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: decimals, maximumFractionDigits: decimals
  });
}

function sparkline(bars) {
  const values = bars.slice(-72).map((bar) => bar.close);
  const min = Math.min(...values);
  const range = Math.max(...values) - min || 1;
  const points = values.map((value, index) =>
    `${(index / (values.length - 1) * 320).toFixed(1)},${(64 - (value - min) / range * 56).toFixed(1)}`
  ).join(" ");
  return `<svg class="sparkline" viewBox="0 0 320 72" preserveAspectRatio="none">
    <polygon class="area" points="0,72 ${points} 320,72"></polygon>
    <polyline class="line" points="${points}"></polyline>
  </svg>`;
}

function timeframeChip(key, title, data, method) {
  const signal = label(data.score);
  const structure = data.structure
    ? `<i class="structure-tag ${data.structure.tone}">${data.structure.label}</i>`
    : "";
  return `<div class="tf-chip">
    <span>${title}</span><em>${method}</em>
    <strong class="${signal.tone}">${signal.text}</strong>
    <small>${data.score > 0 ? "+" : ""}${data.score}</small>
    ${structure}
  </div>`;
}

function renderMarketBiasLegacy(item) {
  const bias = marketBias(item);
  const rows = bias.reasons.length
    ? bias.reasons.map((reason) => `<li><span>${reason.name}</span><b>${reason.points > 0 ? "+" : ""}${reason.points}</b></li>`).join("")
    : `<li><span>可用評分不足</span><b>0</b></li>`;
  return `<section class="market-bias ${bias.tone}">
    <div class="bias-head">
      <div><span>${item.ticker} 方向判斷</span><strong>${bias.label}</strong><small>${bias.english}</small></div>
      <div class="bias-score"><span>總分</span><b>${bias.score > 0 ? "+" : ""}${bias.score}</b></div>
    </div>
    <ul>${rows}</ul>
    <p>這是主要判斷。權重：數據分析 ${(bias.weights.fundamental * 100).toFixed(0)}% / 市場結構 ${(bias.weights.technical * 100).toFixed(0)}%。+5 以上偏多，-5 以下偏空，-1 到 +1 不交易。</p>
  </section>`;
}

function renderMarketBias(item) {
  const bias = marketBias(item);
  const renderReason = (reason) => `<li class="${reason.tone || "neutral"}"><span><strong>${reason.name}</strong><small>${reason.detail}</small></span><b>${reason.points > 0 ? "+" : ""}${reason.points}</b></li>`;
  const structureRows = bias.structureReasons.map(renderReason).join("");
  const factorRows = bias.fundamentalReasons.length
    ? bias.fundamentalReasons.map(renderReason).join("")
    : `<li class="neutral"><span><strong>數據因子</strong><small>目前沒有明確加減分</small></span><b>0</b></li>`;

  return `<section class="market-bias ${bias.tone}">
    <div class="bias-head">
      <div><span>${item.ticker} 主要方向</span><strong>${bias.label}</strong><small>市場結構 + 數據分析</small></div>
      <div class="bias-score"><span>總分</span><b>${bias.score > 0 ? "+" : ""}${bias.score}</b><small>${bias.label}</small></div>
    </div>
    <div class="bias-section-title">市場結構</div>
    <ul class="bias-structure-list">${structureRows}</ul>
    <div class="bias-section-title">數據分析原因</div>
    <ul class="bias-factor-list">${factorRows}</ul>
    <p>權重：數據分析 ${(bias.weights.fundamental * 100).toFixed(0)}% / 市場結構 ${(bias.weights.technical * 100).toFixed(0)}%。+5 以上偏多，+2 到 +4 稍微偏多，-1 到 +1 不交易，-2 到 -4 稍微偏空，-5 以下偏空。</p>
  </section>`;
}

function shortTermWarning(item) {
  const m5 = item.scores.m5?.score ?? 0;
  const m15 = item.scores.m15?.score ?? 0;
  const h1 = item.scores.h1?.score ?? 0;
  const vwap = vwapScore(item.last, item.session);
  const data = item.forecast?.score ?? item.factorScore ?? 0;
  const score = m5 * 0.25 + m15 * 0.35 + vwap * 0.25 + data * 0.15;
  const tone = score >= 20 ? "positive" : score <= -20 ? "negative" : "neutral";
  const confidence = Math.round(clamp(Math.abs(score), 20, 85));
  const label = directionStrength(tone, confidence);
  const details = [
    `5M ${impactLabel(m5).text}`,
    `15M ${impactLabel(m15).text}`,
    `VWAP ${vwap > 0 ? "站上" : vwap < 0 ? "跌破" : "貼近"}`,
    `數據分析 ${impactLabel(data).text}`
  ];
  const caution = h1 >= 20 && tone === "negative"
    ? "但 1H 尚偏多，這屬於短線轉弱預警，需等結構延續。"
    : h1 <= -20 && tone === "positive"
      ? "但 1H 尚偏空，這屬於短線反彈預警，需等結構延續。"
      : "若 5M/15M 與 VWAP 持續同向，預警可信度提高。";
  return { score, tone, confidence, label, details, caution };
}

function renderShortTermWarning(item) {
  const warning = shortTermWarning(item);
  return `<div class="short-warning ${warning.tone}">
    <div>
      <span>短線預警｜5M + 15M + VWAP + 數據分析</span>
      <strong>${warning.label}</strong>
      <p>${warning.details.join("｜")}；預警分數 ${warning.score >= 0 ? "+" : ""}${Math.round(warning.score)}。</p>
    </div>
    <small>${warning.caution}</small>
  </div>`;
}

function renderDecisionSupport(item) {
  return `<section class="decision-support decision-primary">
    <div class="support-body">
      <div class="support-summary ${item.combined.tone}">
        <span>綜合結果</span>
        <strong class="combined-final">${item.combined.strengthLabel}</strong>
        <b>${item.combined.statusShort}｜${item.combined.status}</b>
        <p>${item.combined.reason}；綜合分數 ${item.combined.score >= 0 ? "+" : ""}${Math.round(item.combined.score)}，綜合強度 ${item.combined.confidence}%。</p>
      </div>
      ${renderShortTermWarning(item)}
      <div class="signal-comparison signal-comparison-primary">
        ${timeframeBlock("技術分析（目前資料）", "CURRENT", "HH/HL、LH/LL、VWAP、動能", item.scores)}
      </div>
      <details class="asset-more">
        <summary><span>數據分析與總體經濟預測</span><strong>FORECAST</strong></summary>
        <div class="asset-more-body">
        ${timeframeBlock("數據分析（預測資料）", "FORECAST", "重大事件、殖利率、美元、VIX、領導資產", item.predictiveScores, true)}
          <div class="forecast-box">
            <div class="forecast-head">
              <div><span>總體經濟預測</span><strong class="${item.forecast.tone}">${item.forecast.label}</strong></div>
              <small>模型情境權重，非勝率</small>
            </div>
            <div class="scenario-bars">
              <div class="bullish" style="--scenario:${item.forecast.bullish}%"><span>偏多<em>總體經濟預測</em></span><i></i><b>${item.forecast.bullish}%</b></div>
              <div class="sideways" style="--scenario:${item.forecast.neutral}%"><span>震盪<em>總體經濟預測</em></span><i></i><b>${item.forecast.neutral}%</b></div>
              <div class="bearish" style="--scenario:${item.forecast.bearish}%"><span>偏空<em>總體經濟預測</em></span><i></i><b>${item.forecast.bearish}%</b></div>
            </div>
            <p><b>因為：</b>${item.forecast.basis}。${item.forecast.event}</p>
            <p class="forecast-invalidation"><b>失效條件：</b>${item.forecast.invalidation}</p>
          </div>
        </div>
      </details>
    </div>
  </section>`;
}

function timeframeBlock(title, badge, description, scores, predicted = false) {
  return `<section class="timeframe-block ${predicted ? "predicted" : "observed"}">
    <div class="timeframe-heading">
      <div><strong>${title}</strong><span>${description}</span></div>
      <b>${badge}</b>
    </div>
    <div class="timeframe-grid">
      ${timeframeChip("m5", "5 分", scores.m5, predicted ? "數據分析（預測資料）" : "技術分析（目前資料）")}
      ${timeframeChip("m15", "15 分", scores.m15, predicted ? "數據分析（預測資料）" : "技術分析（目前資料）")}
      ${timeframeChip("h1", "1 小時", scores.h1, predicted ? "數據分析（預測資料）" : "技術分析（目前資料）")}
      ${timeframeChip("d1", "日線", scores.d1, predicted ? "數據分析（預測資料）" : "技術分析（目前資料）")}
    </div>
  </section>`;
}

function strengthFromScore(score) {
  const tone = score >= 20 ? "positive" : score <= -20 ? "negative" : "neutral";
  const confidence = Math.round(clamp(Math.abs(score), 20, 85));
  return {
    tone,
    confidence,
    text: directionStrength(tone, confidence)
  };
}

function renderHistoryCard(market, payload) {
  const scores = {
    m5: scoreTimeframe(payload.series.m5),
    m15: scoreTimeframe(payload.series.m15),
    h1: scoreTimeframe(payload.series.h1),
    d1: scoreTimeframe(payload.series.d1)
  };
  const historyBars = payload.series.m5;
  const historyLast = historyBars.at(-1).close;
  const historySession = sessionStats(historyBars);
  const technical = technicalScore(scores, historyLast, historySession);
  const strength = strengthFromScore(technical);
  const atText = new Date(payload.at).toLocaleString("zh-TW", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
  return `<article class="history-card" style="--accent:${market.accent}">
    <div class="history-card-head">
      <div><span>${market.ticker}</span><strong>${market.name}</strong><small>${atText}｜台灣時間</small></div>
      <div class="history-score ${strength.tone}"><b>${strength.text}</b><em>${technical >= 0 ? "+" : ""}${Math.round(technical)}</em></div>
    </div>
    <div class="timeframe-grid history-timeframes">
      ${timeframeChip("m5", "5 分", scores.m5, "歷史 K 線")}
      ${timeframeChip("m15", "15 分", scores.m15, "歷史 K 線")}
      ${timeframeChip("h1", "1 小時", scores.h1, "歷史 K 線")}
      ${timeframeChip("d1", "日線", scores.d1, "歷史 K 線")}
    </div>
    <p>技術分析權重：HH/HL、LH/LL 價格結構 70%＋VWAP 20%＋動能 10%。此回顧不納入當時新聞、FedWatch 或 Fear & Greed 歷史值。</p>
  </article>`;
}

function setHistoryDefaults() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(Math.floor(now.getMinutes() / 5) * 5).padStart(2, "0");
  document.querySelector("#history-date").value = `${yyyy}-${mm}-${dd}`;
  document.querySelector("#history-time").value = `${hh}:${min}`;
}

function clearHistoryReview() {
  const results = document.querySelector("#history-results");
  results.innerHTML = `<p class="history-empty">尚未回顧。時間以台灣時間計算，只使用該時間點以前的 K 線。</p>`;
}

async function loadHistoryReview() {
  const button = document.querySelector("#history-button");
  const results = document.querySelector("#history-results");
  const date = document.querySelector("#history-date").value;
  const time = document.querySelector("#history-time").value;
  const selected = document.querySelector("#history-market").value;
  if (!date || !time) {
    results.innerHTML = `<p class="history-empty">請先選擇日期與時間。</p>`;
    return;
  }
  const at = new Date(`${date}T${time}:00`);
  if (!Number.isFinite(at.getTime())) {
    results.innerHTML = `<p class="history-empty">時間格式不正確。</p>`;
    return;
  }
  const targets = MARKETS.filter((market) => selected === "ALL" || market.ticker === selected);
  button.disabled = true;
  button.textContent = "回顧中";
  results.innerHTML = `<p class="history-empty">正在讀取歷史 K 線...</p>`;
  const cards = await Promise.all(targets.map(async (market) => {
    try {
      const response = await fetch(`/api/history?symbol=${encodeURIComponent(market.symbol)}&at=${encodeURIComponent(at.toISOString())}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "歷史資料讀取失敗");
      if (!payload.series?.m5?.length || !payload.series?.h1?.length || !payload.series?.d1?.length) {
        throw new Error("該時間點歷史 K 線不足");
      }
      return renderHistoryCard(market, payload);
    } catch (error) {
      return `<article class="history-card error-card" style="--accent:${market.accent}">
        <div><p class="eyebrow">${market.ticker} HISTORY ERROR</p><h2>${market.name}</h2><p>${error.message}</p></div>
      </article>`;
    }
  }));
  results.innerHTML = cards.join("");
  button.disabled = false;
  button.textContent = "回顧多空";
}

function buildLogicSummary(item) {
  const available = item.factors
    .filter((factor) => factor.score !== null && factor.weight > 0)
    .map((factor) => ({
      ...factor,
      contribution: factor.score * factor.weight,
      impact: impactLabel(factor.score)
    }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const missing = item.factors.filter((factor) => factor.score === null).map((factor) => factor.name);
  const coverageText = `資料覆蓋率 ${Math.round(item.coverage * 100)}%`;

  if (item.coverage < 0.45) {
    const missingText = missing.slice(0, 3).join("、");
    return `因為目前只有少部分因素有有效資料${missingText ? `，${missingText}等資料尚未接入或暫時受限` : ""}，所以目前標示為資料不足，無法客觀判斷偏多或偏空。`;
  }

  const directionSign = item.factorScore >= 20 ? 1 : item.factorScore <= -20 ? -1 : 0;
  const aligned = directionSign === 0
    ? available.slice(0, 3)
    : available.filter((factor) => Math.sign(factor.score) === directionSign).slice(0, 3);
  const opposite = directionSign === 0
    ? []
    : available.filter((factor) => Math.sign(factor.score) === -directionSign).slice(0, 1);
  const alignedText = aligned.map((factor) => `${factor.name}${factor.impact.text}`).join("、");
  const oppositeText = opposite.map((factor) => `${factor.name}${factor.impact.text}`).join("、");
  const pricePosition = item.last >= item.session.vwap ? "價格位於 VWAP 上方" : "價格位於 VWAP 下方";
  const marketStatus = item.stale ? "目前休市且沒有新 K 棒" : "目前行情仍在更新";

  if (directionSign === 0) {
    return `因為主要多空因素彼此抵銷，${alignedText || "加權分數接近中性"}，加上${pricePosition}，所以目前方向不明；${marketStatus}，${coverageText}。`;
  }

  const conclusion = directionSign > 0 ? "偏多" : "偏空";
  return `因為${alignedText || `已接入因素整體${conclusion}`}，${pricePosition}${oppositeText ? `；雖然${oppositeText}` : ""}，所以目前判斷${conclusion}。${item.stale ? "這是上一交易時段的最後狀態，需等待新 K 棒確認；" : ""}${coverageText}。`;
}

function renderFactorDetails(item) {
  const connected = item.factors.filter((factor) => factor.score !== null);
  const alerts = item.alerts?.length
    ? `<div class="risk-stack">${item.alerts.map((alert) =>
        `<div class="risk-alert ${alert.tone}"><strong>${alert.title}</strong><span>${alert.detail}</span></div>`
      ).join("")}</div>`
    : "";
  const rows = item.factors.map((factor) => {
    const impact = factor.score === null ? { text: "未接入", tone: "offline" } : impactLabel(factor.score);
    const strength = factor.score === null ? 0 : Math.min(100, Math.abs(factor.score));
    const sourceLinks = factor.links || (factor.url ? [{ label: factor.source, url: factor.url }] : []);
    const source = sourceLinks.length
      ? `<span class="source-name">${factor.source}</span><span class="source-links">${sourceLinks.map((link) =>
          `<a href="${link.url}" target="_blank" rel="noopener noreferrer">${link.label} ↗</a>`
        ).join("")}</span>`
      : factor.source;
    return `<div class="factor-row ${impact.tone}">
      <div class="factor-identity"><strong>${factor.name}</strong><small>${source}</small></div>
      <div class="factor-value"><b>${factor.value}</b><small>${factor.detail}</small></div>
      <div class="factor-impact">
        <span class="impact-pill ${impact.tone}">${impact.text}</span>
        <em>影響因素</em>
        <div class="micro-track"><i style="width:${strength}%"></i></div>
      </div>
      <div class="factor-weight">${factor.weight ? `${factor.weight}%` : "—"}</div>
    </div>`;
  }).join("");
  return `<details class="embedded-factors">
    <summary>
      <span><b>影響因素與資料來源</b><small>點擊展開完整因素、權重及風險警示</small></span>
      <strong>${connected.length} / ${item.factors.length} 已接入</strong>
    </summary>
    <div class="embedded-factor-content">
      ${alerts}
      <div class="factor-columns"><span>因素 / 來源</span><span>目前狀態</span><span>方向影響</span><span>權重</span></div>
      <div class="factor-rows">${rows}</div>
      <div class="factor-summary">
        <span>數據分析（預測資料）加權分數</span>
        <strong class="${impactLabel(item.factorScore).tone}">${item.factorScore >= 0 ? "+" : ""}${Math.round(item.factorScore)} · ${impactLabel(item.factorScore).text}</strong>
      </div>
    </div>
  </details>`;
}

function renderCard(item) {
  const changeTone = item.changePercent >= 0 ? "positive" : "negative";
  const vwapTone = item.last >= item.session.vwap ? "positive" : "negative";
  return `<article class="market-card" style="--accent:${item.accent}">
    <div class="asset-head">
      <div class="asset-name"><span>${item.english}</span><h2>${item.name}</h2></div>
      <div class="ticker">${item.ticker}</div>
    </div>
    ${renderDecisionSupport(item)}
    <details class="asset-more">
      <summary><span>價格、VWAP 與完整影響因素</span><strong>DETAILS</strong></summary>
      <div class="asset-more-body">
        <div class="price-line">
          <strong class="last-price">${formatPrice(item.last, item.decimals)}</strong>
          <span class="daily-change ${changeTone}">${item.changePercent >= 0 ? "▲" : "▼"} ${Math.abs(item.changePercent).toFixed(2)}%</span>
        </div>
        ${sparkline(item.bars)}
        <div class="levels intraday-levels">
          <div class="level"><span>VWAP</span><b class="${vwapTone}">${formatPrice(item.session.vwap, item.decimals)}</b></div>
          <div class="level"><span>今日高 / 低</span><b>${formatPrice(item.session.high, item.decimals)} / ${formatPrice(item.session.low, item.decimals)}</b></div>
          <div class="level"><span>開盤區間高</span><b>${formatPrice(item.session.openingHigh, item.decimals)}</b></div>
          <div class="level"><span>開盤區間低</span><b>${formatPrice(item.session.openingLow, item.decimals)}</b></div>
        </div>
        <div class="card-foot">${item.stale ? "休市 / 延遲資料" : "行情更新中"} · 15m ATR ${formatPrice(item.atrValue, item.decimals)} · 最新 K 棒 ${new Date(item.updatedTime).toLocaleString("zh-TW", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</div>
        ${renderFactorDetails(item)}
      </div>
    </details>
  </article>`;
}

function renderError(market, message) {
  return `<article class="market-card error-card" style="--accent:${market.accent}">
    <div><p class="eyebrow">${market.ticker} DATA ERROR</p><h2>${market.name}</h2><p>${message}</p></div>
  </article>`;
}

function renderSummary() {
  const valid = state.analyses.filter((item) => !item.error);
  const longCount = valid.filter((item) => item.combined.tone === "positive").length;
  const shortCount = valid.filter((item) => item.combined.tone === "negative").length;
  const aligned = longCount + shortCount;
  const direction = longCount > shortCount ? "綜合偏多" : shortCount > longCount ? "綜合偏空" : "綜合分歧";
  document.querySelector("#market-regime").textContent = direction;
  document.querySelector("#aligned-count").textContent = `${aligned} / ${valid.length || 3}`;
  const highVol = valid.filter((item) => item.atrPercent > 1.2).length;
  document.querySelector("#risk-level").textContent = highVol ? `${highVol} 個市場擴張` : "正常";
  document.querySelector("#updated-at").textContent = new Date().toLocaleTimeString("zh-TW", { hour12: false });
}

function fearGreedState(score) {
  if (score <= 24) return { label: "極度恐慌", english: "Extreme Fear", tone: "extreme-fear", color: "#ff3f62" };
  if (score <= 44) return { label: "恐慌", english: "Fear", tone: "fear", color: "#ff7a45" };
  if (score <= 55) return { label: "中性", english: "Neutral", tone: "neutral", color: "#ffbd2e" };
  if (score <= 74) return { label: "貪婪", english: "Greed", tone: "greed", color: "#80df91" };
  return { label: "極度貪婪", english: "Extreme Greed", tone: "extreme-greed", color: "#19f2a2" };
}

function polarPoint(cx, cy, radius, degrees) {
  const radians = degrees * Math.PI / 180;
  return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) };
}

function gaugeArc(start, end, color) {
  const startPoint = polarPoint(125, 119, 91, start);
  const endPoint = polarPoint(125, 119, 91, end);
  return `<path d="M ${startPoint.x.toFixed(2)} ${startPoint.y.toFixed(2)} A 91 91 0 0 1 ${endPoint.x.toFixed(2)} ${endPoint.y.toFixed(2)}"
    fill="none" stroke="${color}" stroke-width="24" stroke-linecap="butt"></path>`;
}

function renderFearGreed(data) {
  const widget = document.querySelector("#fear-greed-widget");
  if (!widget) return;
  widget.classList.remove("loading");
  if (!data || !Number.isFinite(data.score)) {
    widget.innerHTML = `<a class="fg-unavailable" href="https://edition.cnn.com/markets/fear-and-greed" target="_blank" rel="noopener noreferrer">
      <span>CNN FEAR & GREED</span><strong>暫無資料</strong><small>前往 CNN 人工確認 ↗</small>
    </a>`;
    return;
  }

  const score = clamp(data.score, 0, 100);
  const stateInfo = fearGreedState(score);
  const angle = -180 + score * 1.8;
  const needle = polarPoint(125, 119, 70, angle);
  const comparisons = [
    ["前一日", data.previousClose],
    ["一週前", data.previousWeek],
    ["一月前", data.previousMonth],
    ["一年前", data.previousYear]
  ];
  widget.style.setProperty("--fg-color", stateInfo.color);
  widget.innerHTML = `
    <div class="fg-heading">
      <a href="https://edition.cnn.com/markets/fear-and-greed" target="_blank" rel="noopener noreferrer">
        <span>CNN MARKET SENTIMENT</span>
        <strong>Fear & Greed Index</strong>
      </a>
      <div class="fg-current"><b>${Math.round(score)}</b><span>${stateInfo.label}</span></div>
    </div>
    <div class="fg-content">
      <div class="fg-gauge">
        <svg viewBox="0 0 250 135" role="img" aria-label="Fear and Greed score ${Math.round(score)}">
          ${gaugeArc(-180, -146, "#ff3f62")}
          ${gaugeArc(-144, -110, "#ff7645")}
          ${gaugeArc(-108, -72, "#ffbd2e")}
          ${gaugeArc(-70, -36, "#80df91")}
          ${gaugeArc(-34, 0, "#19f2a2")}
          <line x1="125" y1="119" x2="${needle.x.toFixed(2)}" y2="${needle.y.toFixed(2)}" class="fg-needle"></line>
          <circle cx="125" cy="119" r="8" class="fg-hub"></circle>
          <text x="21" y="126" class="fg-scale">0</text>
          <text x="118" y="33" class="fg-scale">50</text>
          <text x="218" y="126" class="fg-scale">100</text>
          <text x="125" y="105" text-anchor="middle" class="fg-score">${Math.round(score)}</text>
        </svg>
        <div class="fg-zone-labels">
          <span>極度恐慌</span><span>恐慌</span><span>中性</span><span>貪婪</span><span>極度貪婪</span>
        </div>
      </div>
      <div class="fg-history">
        ${comparisons.map(([label, value]) => {
          const info = fearGreedState(value);
          return `<div><span>${label}<small>${info.label}</small></span><b style="--history-color:${info.color}">${Math.round(value)}</b></div>`;
        }).join("")}
      </div>
    </div>
    <div class="fg-updated">CNN · ${new Date(data.timestamp).toLocaleString("zh-TW", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</div>`;
}

async function loadMarkets() {
  if (state.loading) return;
  state.loading = true;
  const button = document.querySelector("#refresh-button");
  button.disabled = true;
  button.textContent = "讀取中";
  document.querySelector("#market-grid").innerHTML = MARKETS.map((market) =>
    `<article class="market-card loading" style="--accent:${market.accent}"></article>`
  ).join("");

  try {
    const contextResponse = await fetch("/api/context");
    const contextPayload = await contextResponse.json();
    if (!contextResponse.ok) throw new Error(contextPayload.error || "背景資料讀取失敗");
    state.context = contextPayload;
    renderFearGreed(state.context.fearGreed);
    renderEventCalendar();
  } catch (error) {
    renderFearGreed(null);
    document.querySelector("#market-grid").innerHTML = MARKETS.map((market) =>
      renderError(market, `背景因素無法讀取：${error.message}`)
    ).join("");
    button.disabled = false;
    button.textContent = "立即更新";
    state.loading = false;
    return;
  }

  state.analyses = await Promise.all(MARKETS.map(async (market) => {
    try {
      const response = await fetch(`/api/market?symbol=${encodeURIComponent(market.symbol)}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "行情讀取失敗");
      if (!payload.series?.m5?.length || !payload.series?.h1?.length) throw new Error("盤中資料不足");
      return analyze(market, payload, state.context);
    } catch (error) {
      return { ...market, error: error.message };
    }
  }));

  document.querySelector("#market-grid").innerHTML = state.analyses.map((item) =>
    item.error ? renderError(item, item.error) : renderCard(item)
  ).join("");
  renderSummary();
  renderEventCalendar();
  button.disabled = false;
  button.textContent = "立即更新";
  state.loading = false;
}

function updateClock() {
  document.querySelector("#ny-clock").textContent = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(new Date());
}

document.querySelector("#refresh-button").addEventListener("click", loadMarkets);
document.querySelector("#history-button").addEventListener("click", loadHistoryReview);
document.querySelector("#history-clear-button").addEventListener("click", clearHistoryReview);
setInterval(updateClock, 1000);
setInterval(renderEventCalendar, 60 * 1000);
setInterval(loadMarkets, 15 * 60 * 1000);
setHistoryDefaults();
updateClock();
loadMarkets();
