import express from 'express'
import cors from 'cors'
import fetch from 'node-fetch'

const app = express()
const PORT = process.env.PORT || 3001

// ── In-memory price cache (5 min TTL) ────────────────────────────────────────
const priceCache = new Map() // key → { data, ts }
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

function getCached(key) {
  const entry = priceCache.get(key)
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data
  return null
}
function setCache(key, data) {
  priceCache.set(key, { data, ts: Date.now() })
}

// ── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    'https://rico-finance-dashboard.web.app',
    'https://rico-finance-dashboard.firebaseapp.com',
    'http://localhost:5173',
    'http://localhost:4173',
  ],
  methods: ['GET'],
}))

app.use(express.json())

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'wealth-backend', version: '1.0.0' })
})

// ── GET /api/price?symbol=AAPL ────────────────────────────────────────────────
// Fetches stock/ETF price via Yahoo Finance (unofficial scrape)
app.get('/api/price', async (req, res) => {
  const { symbol } = req.query
  if (!symbol) return res.status(400).json({ error: 'symbol required' })

  const cacheKey = `stock:${symbol.toUpperCase()}`
  const cached = getCached(cacheKey)
  if (cached) {
    console.log(`[/api/price] Cache hit for ${symbol}`)
    return res.json({ ...cached, fromCache: true })
  }

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WealthDashboard/1.0)',
        'Accept': 'application/json',
      },
    })

    if (!response.ok) {
      console.error(`[/api/price] Yahoo returned ${response.status} for ${symbol}`)
      // Return cached stale data if available
      const stale = priceCache.get(cacheKey)
      if (stale) return res.json({ ...stale.data, fromCache: true, stale: true })
      return res.status(502).json({ error: `Yahoo Finance returned ${response.status}` })
    }

    const data = await response.json()
    const result = data?.chart?.result?.[0]
    if (!result) {
      return res.status(404).json({ error: `No data for symbol ${symbol}` })
    }

    const meta = result.meta
    const price = meta.regularMarketPrice || meta.previousClose
    const currency = meta.currency || 'USD'
    const change = meta.regularMarketChangePercent || 0

    const usdChfRate = 0.91
    const priceChf = currency === 'CHF' ? price : price * usdChfRate

    const payload = {
      symbol: symbol.toUpperCase(),
      price: Math.round(priceChf * 100) / 100,
      priceOriginal: price,
      currency,
      changePercent: Math.round(change * 100) / 100,
      timestamp: Date.now(),
    }
    setCache(cacheKey, payload)
    res.json(payload)
  } catch (err) {
    console.error(`[/api/price] Error for ${symbol}:`, err.message)
    const stale = priceCache.get(cacheKey)
    if (stale) return res.json({ ...stale.data, fromCache: true, stale: true })
    res.status(500).json({ error: 'Failed to fetch stock price', details: err.message })
  }
})

// ── GET /api/crypto?id=bitcoin ────────────────────────────────────────────────
// Fetches crypto price via CoinGecko free API
app.get('/api/crypto', async (req, res) => {
  const { id } = req.query
  if (!id) return res.status(400).json({ error: 'id required (CoinGecko ID, e.g. bitcoin)' })

  const cacheKey = `crypto:${id}`
  const cached = getCached(cacheKey)
  if (cached) {
    console.log(`[/api/crypto] Cache hit for ${id}`)
    return res.json({ ...cached, fromCache: true })
  }

  const apiKey = process.env.COINGECKO_API_KEY || ''
  // API key can be sent as header OR query param — use both for reliability
  const keyParam = apiKey ? `&x_cg_demo_api_key=${encodeURIComponent(apiKey)}` : ''
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=chf&include_24hr_change=true${keyParam}`

  try {
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        ...(apiKey ? { 'x-cg-demo-api-key': apiKey } : {}),
      },
    })

    console.log(`[/api/crypto] CoinGecko status ${response.status} for ${id}`)

    if (!response.ok) {
      // Return stale cache on error rather than 502
      const stale = priceCache.get(cacheKey)
      if (stale) {
        console.log(`[/api/crypto] Using stale cache for ${id}`)
        return res.json({ ...stale.data, fromCache: true, stale: true })
      }
      return res.status(502).json({ error: `CoinGecko returned ${response.status}` })
    }

    const data = await response.json()

    if (!data[id]) {
      return res.status(404).json({ error: `No data for coin ${id}` })
    }

    const price = data[id].chf
    const change = data[id].chf_24h_change

    const payload = {
      id,
      price: Math.round(price * 100) / 100,
      currency: 'CHF',
      change24h: Math.round((change || 0) * 100) / 100,
      timestamp: Date.now(),
    }
    setCache(cacheKey, payload)
    res.json(payload)
  } catch (err) {
    console.error(`[/api/crypto] Error for ${id}:`, err.message)
    const stale = priceCache.get(cacheKey)
    if (stale) return res.json({ ...stale.data, fromCache: true, stale: true })
    res.status(500).json({ error: 'Failed to fetch crypto price', details: err.message })
  }
})

// ── GET /api/prices — Batch prices ───────────────────────────────────────────
// ?stocks=AAPL,VWRL&cryptos=bitcoin,ethereum
app.get('/api/prices', async (req, res) => {
  const stocks = req.query.stocks ? req.query.stocks.split(',') : []
  const cryptos = req.query.cryptos ? req.query.cryptos.split(',') : []
  const result = {}

  // Batch crypto
  if (cryptos.length > 0) {
    try {
      const apiKey = process.env.COINGECKO_API_KEY || ''
      const keyParam = apiKey ? `&x_cg_demo_api_key=${encodeURIComponent(apiKey)}` : ''
      const ids = cryptos.join(',')
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=chf&include_24hr_change=true${keyParam}