const http = require("http");
const fs = require("fs");
const path = require("path");
const https = require("https");

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, "public");
const SYMBOLS = new Set(["NQ=F", "GC=F", "MCL=F"]);
let contextCache = null;
const LAST_KNOWN_BLS = {
  cpi: {
    period: "2026 April",
    index: 332.407,
    monthlyPercent: 0.6400377846336402,
    sourceStatus: "最近成功讀取"
  },
  payrolls: {
    period: "2026 May",
    levelThousands: 159001,
    changeThousands: 172,
    sourceStatus: "最近成功讀取"
  }
};
const TIMEFRAMES = [
  { key: "m5", interval: "5m", range: "5d" },
  { key: "m15", interval: "15m", range: "10d" },
  { key: "h1", interval: "1h", range: "1mo" },
  { key: "d1", interval: "1d", range: "1y" }
];

function send(res, status, body, contentType) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 FuturesDashboard/2.0",
        Accept: "application/json"
      }
    }, (response) => {
      let data = "";
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          fetchJson(response.headers.location).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`行情服務回應 ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error("行情資料格式錯誤"));
        }
      });
    });
    request.setTimeout(12000, () => request.destroy(new Error("行情讀取逾時")));
    request.on("error", reject);
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 FuturesDashboard/3.0", Accept: "text/html" }
    }, (response) => {
      let data = "";
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`資料服務回應 ${response.statusCode}`));
          return;
        }
        resolve(data);
      });
    });
    request.setTimeout(15000, () => request.destroy(new Error("資料讀取逾時")));
    request.on("error", reject);
  });
}

function fetchCnnFearGreed() {
  return new Promise((resolve, reject) => {
    const request = https.get(
      "https://production.dataviz.cnn.io/index/fearandgreed/graphdata",
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136 Safari/537.36",
          Accept: "application/json, text/plain, */*",
          Referer: "https://edition.cnn.com/markets/fear-and-greed",
          Origin: "https://edition.cnn.com",
          "Cache-Control": "no-cache"
        }
      },
      (response) => {
        let data = "";
        response.on("data", (chunk) => { data += chunk; });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error(`CNN Fear & Greed 回應 ${response.statusCode}`));
            return;
          }
          try {
            const payload = JSON.parse(data);
            const current = payload?.fear_and_greed;
            if (!Number.isFinite(Number(current?.score))) throw new Error("CNN Fear & Greed 資料不足");
            resolve({
              score: Number(current.score),
              rating: current.rating,
              timestamp: current.timestamp,
              previousClose: Number(current.previous_close),
              previousWeek: Number(current.previous_1_week),
              previousMonth: Number(current.previous_1_month),
              previousYear: Number(current.previous_1_year)
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.setTimeout(12000, () => request.destroy(new Error("CNN Fear & Greed 讀取逾時")));
    request.on("error", reject);
  });
}

function parseChart(payload) {
  const result = payload?.chart?.result?.[0];
  if (!result) throw new Error(payload?.chart?.error?.description || "沒有可用行情");
  const quote = result.indicators?.quote?.[0] || {};
  const bars = (result.timestamp || []).map((time, index) => ({
    time: time * 1000,
    open: quote.open?.[index],
    high: quote.high?.[index],
    low: quote.low?.[index],
    close: quote.close?.[index],
    volume: quote.volume?.[index] || 0
  })).filter((bar) => [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite));
  return { bars, meta: result.meta || {} };
}

async function fetchTimeframe(symbol, timeframe) {
  const dataSymbol = symbol === "MCL=F" && timeframe.key === "d1" ? "CL=F" : symbol;
  const endpoint =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(dataSymbol)}` +
    `?range=${timeframe.range}&interval=${timeframe.interval}&includePrePost=true&events=div%2Csplits`;
  return parseChart(await fetchJson(endpoint));
}

async function fetchChartWindow(symbol, interval, startMs, endMs) {
  const endpoint =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=${Math.floor(startMs / 1000)}&period2=${Math.floor(endMs / 1000)}` +
    `&interval=${interval}&includePrePost=true&events=div%2Csplits`;
  return parseChart(await fetchJson(endpoint));
}

function bucketBars(bars, minutes) {
  const bucketMs = minutes * 60 * 1000;
  const buckets = new Map();
  bars.forEach((bar) => {
    const time = Math.floor(bar.time / bucketMs) * bucketMs;
    let bucket = buckets.get(time);
    if (!bucket) {
      bucket = { time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: 0 };
      buckets.set(time, bucket);
    }
    bucket.high = Math.max(bucket.high, bar.high);
    bucket.low = Math.min(bucket.low, bar.low);
    bucket.close = bar.close;
    bucket.volume += bar.volume || 0;
  });
  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

function utcDateKey(time) {
  return new Date(time).toISOString().slice(0, 10);
}

async function fetchHistoricalSeries(symbol, atMs) {
  const intradaySymbol = symbol;
  const dailySymbol = symbol === "MCL=F" ? "CL=F" : symbol;
  const intradayStart = atMs - 10 * 24 * 60 * 60 * 1000;
  const intradayEnd = atMs + 5 * 60 * 1000;
  const dailyStart = atMs - 370 * 24 * 60 * 60 * 1000;
  const dailyEnd = atMs + 24 * 60 * 60 * 1000;
  const [intraday, daily] = await Promise.all([
    fetchChartWindow(intradaySymbol, "5m", intradayStart, intradayEnd),
    fetchChartWindow(dailySymbol, "1d", dailyStart, dailyEnd)
  ]);
  const m5 = intraday.bars.filter((bar) => bar.time <= atMs);
  const m15 = bucketBars(m5, 15).filter((bar) => bar.time <= atMs);
  const h1 = bucketBars(m5, 60).filter((bar) => bar.time <= atMs);
  const targetDate = utcDateKey(atMs);
  const previousDaily = daily.bars.filter((bar) => utcDateKey(bar.time) < targetDate);
  const targetDayBars = m5.filter((bar) => utcDateKey(bar.time) === targetDate);
  const d1 = previousDaily.slice();
  if (targetDayBars.length) {
    d1.push({
      time: atMs,
      open: targetDayBars[0].open,
      high: Math.max(...targetDayBars.map((bar) => bar.high)),
      low: Math.min(...targetDayBars.map((bar) => bar.low)),
      close: targetDayBars.at(-1).close,
      volume: targetDayBars.reduce((sum, bar) => sum + (bar.volume || 0), 0)
    });
  }
  return {
    series: { m5, m15, h1, d1 },
    meta: intraday.meta
  };
}

async function fetchDailyContext(symbol) {
  const endpoint =
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    "?range=1mo&interval=1d&includePrePost=false";
  const result = parseChart(await fetchJson(endpoint));
  const closes = result.bars.map((bar) => bar.close);
  const latest = closes.at(-1);
  const previous = closes.at(-6) || closes[0];
  return {
    value: latest,
    change5d: ((latest / previous) - 1) * 100,
    updatedAt: result.bars.at(-1)?.time
  };
}

async function fetchEiaSeries(series) {
  const apiKey = process.env.EIA_API_KEY || "DEMO_KEY";
  const endpoint =
    "https://api.eia.gov/v2/petroleum/sum/sndw/data/" +
    `?api_key=${encodeURIComponent(apiKey)}&frequency=weekly&data[0]=value&facets[series][]=${series}` +
    "&sort[0][column]=period&sort[0][direction]=desc&length=3";
  const payload = await fetchJson(endpoint);
  const rows = payload?.response?.data || [];
  if (rows.length < 2) throw new Error(`EIA ${series} 資料不足`);
  return {
    period: rows[0].period,
    value: Number(rows[0].value),
    previous: Number(rows[1].value),
    change: Number(rows[0].value) - Number(rows[1].value),
    units: rows[0].units
  };
}

async function fetchEiaHtmlSeries(series) {
  const html = await fetchText(
    `https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?n=PET&s=${encodeURIComponent(series)}&f=W`
  );
  const observations = [];
  const monthRows = html.matchAll(/(\d{4})-([A-Z][a-z]{2})<\/td>([\s\S]*?)<\/tr>/g);
  const monthNumbers = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
  for (const match of monthRows) {
    const year = match[1];
    const month = monthNumbers[match[2]];
    const cells = [...match[3].matchAll(/<td class='B5'>(\d{2})\/(\d{2})&nbsp;<\/td>\s*<td class='B3'>([\d,.-]+)&nbsp;/g)];
    cells.forEach((cell) => {
      const value = Number(cell[3].replace(/,/g, ""));
      if (Number.isFinite(value)) {
        observations.push({ period: `${year}-${month}-${cell[2]}`, value });
      }
    });
  }
  if (observations.length < 2) throw new Error(`EIA 官網 ${series} 資料不足`);
  const latest = observations.at(-1);
  const previous = observations.at(-2);
  return {
    period: latest.period,
    value: latest.value,
    previous: previous.value,
    change: latest.value - previous.value,
    units: "",
    sourceStatus: "EIA 官網備援"
  };
}

async function fetchEiaWithFallback(series) {
  try {
    const result = await fetchEiaSeries(series);
    return { ...result, sourceStatus: "EIA API" };
  } catch {
    return fetchEiaHtmlSeries(series);
  }
}

async function fetchEffr() {
  const payload = await fetchJson("https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json");
  const row = payload?.refRates?.[0];
  if (!row || !Number.isFinite(Number(row.percentRate))) throw new Error("EFFR 資料不足");
  return {
    value: Number(row.percentRate),
    date: row.effectiveDate,
    targetFrom: Number(row.targetRateFrom),
    targetTo: Number(row.targetRateTo)
  };
}

async function fetchBlsSeries(series) {
  const payload = await fetchJson(`https://api.bls.gov/publicAPI/v2/timeseries/data/${series}`);
  const rows = payload?.Results?.series?.[0]?.data || [];
  const monthly = rows.filter((row) => /^M\d{2}$/.test(row.period)).slice(0, 3);
  if (monthly.length < 2) throw new Error(`BLS ${series} 資料不足`);
  return monthly.map((row) => ({
    year: Number(row.year),
    period: row.period,
    periodName: row.periodName,
    value: Number(row.value),
    latest: row.latest === "true"
  }));
}

async function handleContextData(res) {
  if (contextCache && Date.now() - contextCache.cachedAt < 5 * 60 * 1000) {
    send(res, 200, JSON.stringify(contextCache.payload), "application/json; charset=utf-8");
    return;
  }
  try {
    const marketContext = {};
    for (const [key, symbol] of [
      ["dxy", "DX-Y.NYB"],
      ["treasury10y", "^TNX"],
      ["vix", "^VIX"],
      ["soxx", "SOXX"],
      ["nvda", "NVDA"],
      ["qqq", "QQQ"],
      ["fedFundsFuture", "ZQ=F"],
      ["brent", "BZ=F"],
      ["energyEquity", "XLE"],
      ["chinaProxy", "FXI"]
    ]) {
      try {
        marketContext[key] = await fetchDailyContext(symbol);
      } catch (error) {
        marketContext[key] = { error: error.message || "市場資料暫時無法取得" };
      }
    }
    const backgroundResults = await Promise.allSettled([
      fetchBlsSeries("CUSR0000SA0"),
      fetchBlsSeries("CES0000000001"),
      fetchEffr(),
      fetchCnnFearGreed(),
      fetchEiaWithFallback("WCESTUS1"),
      fetchEiaWithFallback("WCRFPUS2"),
      fetchEiaWithFallback("WGFUPUS2")
    ]);
    const resultValue = (index) => backgroundResults[index].status === "fulfilled"
      ? backgroundResults[index].value
      : null;
    const cpiRows = resultValue(0);
    const payrollRows = resultValue(1);
    const effr = resultValue(2);
    const fearGreed = resultValue(3);
    const crudeStocks = resultValue(4);
    const crudeProduction = resultValue(5);
    const gasolineDemand = resultValue(6);
    const cpiData = cpiRows
      ? {
          period: `${cpiRows[0].year} ${cpiRows[0].periodName}`,
          index: cpiRows[0].value,
          monthlyPercent: (cpiRows[0].value / cpiRows[1].value - 1) * 100,
          sourceStatus: "即時讀取"
        }
      : LAST_KNOWN_BLS.cpi;
    const payrollData = payrollRows
      ? {
          period: `${payrollRows[0].year} ${payrollRows[0].periodName}`,
          levelThousands: payrollRows[0].value,
          changeThousands: payrollRows[0].value - payrollRows[1].value,
          sourceStatus: "即時讀取"
        }
      : LAST_KNOWN_BLS.payrolls;
    const responsePayload = {
      dxy: marketContext.dxy,
      treasury10y: marketContext.treasury10y,
      fearGreed,
      events: [
        {
          name: "U.S. Trade Balance",
          at: "2026-06-09T12:30:00Z",
          source: "BEA",
          url: "https://www.bea.gov/news/schedule",
          markets: ["MNQ", "MGC", "MCL"]
        },
        {
          name: "API Crude Oil Inventories",
          at: "2026-06-09T20:30:00Z",
          source: "API",
          url: "https://www.api.org/products-and-services/statistics/api-weekly-statistical-bulletin",
          markets: ["MCL"]
        },
        {
          name: "U.S. Consumer Price Index (CPI)",
          at: "2026-06-10T12:30:00Z",
          source: "BLS",
          url: "https://www.bls.gov/schedule/news_release/cpi.htm",
          markets: ["MNQ", "MGC", "MCL"]
        },
        {
          name: "EIA Crude Oil Inventories",
          at: "2026-06-10T14:30:00Z",
          source: "EIA",
          url: "https://www.eia.gov/petroleum/supply/weekly/schedule.php",
          markets: ["MCL"]
        },
        {
          name: "U.S. Producer Price Index (PPI)",
          at: "2026-06-11T12:30:00Z",
          source: "BLS",
          url: "https://www.bls.gov/schedule/2026/",
          markets: ["MNQ", "MGC", "MCL"]
        },
        {
          name: "FOMC Rate Decision & Projections",
          at: "2026-06-17T18:00:00Z",
          source: "Federal Reserve",
          url: "https://www.federalreserve.gov/monetarypolicy.htm",
          markets: ["MNQ", "MGC", "MCL"]
        },
        {
          name: "U.S. GDP & Core PCE",
          at: "2026-06-25T12:30:00Z",
          source: "BEA",
          url: "https://www.bea.gov/news/schedule",
          markets: ["MNQ", "MGC", "MCL"]
        },
        {
          name: "U.S. JOLTS Job Openings",
          at: "2026-06-30T14:00:00Z",
          source: "BLS",
          url: "https://www.bls.gov/schedule/2026/",
          markets: ["MNQ", "MGC"]
        },
        {
          name: "ISM Manufacturing PMI",
          at: "2026-07-01T14:00:00Z",
          source: "ISM",
          url: "https://www.ismworld.org/supply-management-news-and-reports/reports/rob-report-calendar/",
          markets: ["MNQ"]
        },
        {
          name: "U.S. Nonfarm Payrolls (NFP)",
          at: "2026-07-02T12:30:00Z",
          source: "BLS",
          url: "https://www.bls.gov/schedule/2026/",
          markets: ["MNQ", "MGC", "MCL"]
        },
        {
          name: "ISM Services PMI",
          at: "2026-07-06T14:00:00Z",
          source: "ISM",
          url: "https://www.ismworld.org/supply-management-news-and-reports/reports/rob-report-calendar/",
          markets: ["MNQ"]
        }
      ],
      nq: {
        vix: marketContext.vix,
        soxx: marketContext.soxx,
        nvda: marketContext.nvda,
        qqq: marketContext.qqq,
        rateProxy: {
          futurePrice: marketContext.fedFundsFuture?.value ?? null,
          futureChange5d: marketContext.fedFundsFuture?.change5d ?? null,
          impliedRate: Number.isFinite(marketContext.fedFundsFuture?.value)
            ? 100 - marketContext.fedFundsFuture.value
            : null,
          effr: effr?.value ?? null,
          effrDate: effr?.date ?? null
        },
        events: [
          {
            name: "美國 CPI",
            at: "2026-06-10T12:30:00Z",
            source: "BLS"
          },
          {
            name: "FOMC 利率決議",
            at: "2026-06-17T18:00:00Z",
            source: "Federal Reserve"
          }
        ],
        cpi: cpiData,
        payrolls: payrollData
      },
      oil: {
        crudeStocks,
        crudeProduction,
        gasolineDemand,
        brent: marketContext.brent,
        energyEquity: marketContext.energyEquity,
        chinaProxy: marketContext.chinaProxy
      },
      goldDemand: {
        period: "2026 Q1",
        totalTonnes: 1231,
        yearChangePercent: 2,
        centralBankTonnes: 244,
        sourceDate: "2026-04-29"
      },
      fetchedAt: Date.now()
    };
    contextCache = { cachedAt: Date.now(), payload: responsePayload };
    send(res, 200, JSON.stringify(responsePayload), "application/json; charset=utf-8");
  } catch (error) {
    send(res, 502, JSON.stringify({ error: error.message || "無法讀取市場背景資料" }), "application/json; charset=utf-8");
  }
}

async function handleMarketData(res, url) {
  const symbol = url.searchParams.get("symbol");
  if (!SYMBOLS.has(symbol)) {
    send(res, 400, JSON.stringify({ error: "不支援此商品" }), "application/json; charset=utf-8");
    return;
  }

  try {
    const datasets = await Promise.all(TIMEFRAMES.map((timeframe) => fetchTimeframe(symbol, timeframe)));
    const series = Object.fromEntries(TIMEFRAMES.map((timeframe, index) => [
      timeframe.key,
      datasets[index].bars
    ]));
    const meta = datasets[0].meta;
    send(res, 200, JSON.stringify({
      symbol,
      currency: meta.currency || "USD",
      exchange: meta.exchangeName || "",
      regularMarketPrice: meta.regularMarketPrice,
      series,
      fetchedAt: Date.now()
    }), "application/json; charset=utf-8");
  } catch (error) {
    send(res, 502, JSON.stringify({
      error: error.message || "無法讀取即時行情"
    }), "application/json; charset=utf-8");
  }
}

async function handleHistoryData(res, url) {
  const symbol = url.searchParams.get("symbol");
  const at = url.searchParams.get("at");
  const atMs = Date.parse(at);
  if (!SYMBOLS.has(symbol)) {
    send(res, 400, JSON.stringify({ error: "不支援的商品" }), "application/json; charset=utf-8");
    return;
  }
  if (!Number.isFinite(atMs)) {
    send(res, 400, JSON.stringify({ error: "請提供有效時間" }), "application/json; charset=utf-8");
    return;
  }
  try {
    const { series, meta } = await fetchHistoricalSeries(symbol, atMs);
    send(res, 200, JSON.stringify({
      symbol,
      at: atMs,
      currency: meta.currency || "USD",
      exchange: meta.exchangeName || "",
      series,
      fetchedAt: Date.now(),
      note: "歷史回顧僅使用指定時間以前的 K 線資料"
    }), "application/json; charset=utf-8");
  } catch (error) {
    send(res, 502, JSON.stringify({
      error: error.message || "歷史資料讀取失敗"
    }), "application/json; charset=utf-8");
  }
}

function serveStatic(res, pathname) {
  const requestPath = pathname === "/" ? "/index.html" : pathname;
  const normalized = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, normalized);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    send(res, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, "Not found", "text/plain; charset=utf-8");
      return;
    }
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8"
    };
    send(res, 200, data, types[path.extname(filePath)] || "application/octet-stream");
  });
}

function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/api/market") {
    handleMarketData(res, url);
    return;
  }
  if (url.pathname === "/api/history") {
    handleHistoryData(res, url);
    return;
  }
  if (url.pathname === "/api/context") {
    handleContextData(res);
    return;
  }
  serveStatic(res, url.pathname);
}

module.exports = { requestHandler };

if (require.main === module) {
  http.createServer(requestHandler).listen(PORT, "127.0.0.1", () => {
    console.log(`Intraday dashboard: http://127.0.0.1:${PORT}`);
  });
}
