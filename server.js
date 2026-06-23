import express from 'express'
import cors from 'cors'
import fetch from 'node-fetch'

const app = express()
const PORT = process.env.PORT || 3001

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

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WealthDashboard/1.0)',
        'Accept': 'application/json',
      },
    })

    if (!response.ok) {
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

    // Convert to CHF if needed (simplified: USD → CHF via a fixed approximation)
    // For production: use a real FX API
    const usdChfRate = 0.91 // Approximate — update if needed
    const priceChf = currency === 'CHF' ? price : price * usdChfRate

    res.json({
      symbol: symbol.toUpperCase(),
      price: Math.round(priceChf * 100) / 100,
      priceOriginal: price,
      currency,
      changePercent: Math.round(change * 100) / 100,
      timestamp: Date.now(),
    })
  } catch (err) {
    console.error(`[/api/price] Error for ${symbol}:`, err.message)
    res.status(500).json({ error: 'Failed to fetch stock price', details: err.message })
  }
})

// ── GET /api/crypto?id=bitcoin ────────────────────────────────────────────────
// Fetches crypto price via CoinGecko free API
app.get('/api/crypto', async (req, res) => {
  const { id } = req.query
  if (!id) return res.status(400).json({ error: 'id required (CoinGecko ID, e.g. bitcoin)' })

  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=chf&include_24hr_change=true`
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'x-cg-demo-api-key': process.env.COINGECKO_API_KEY || '',
      },
    })

    if (!response.ok) {
      return res.status(502).json({ error: `CoinGecko returned ${response.status}` })
    }

    const data = await response.json()

    if (!data[id]) {
      return res.status(404).json({ error: `No data for coin ${id}` })
    }

    const price = data[id].chf
    const change = data[id].chf_24h_change

    res.json({
      id,
      price: Math.round(price * 100) / 100,
      currency: 'CHF',
      change24h: Math.round(change * 100) / 100,
      timestamp: Date.now(),
    })
  } catch (err) {
    console.error(`[/api/crypto] Error for ${id}:`, err.message)
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
      const ids = cryptos.join(',')
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=chf&include_24hr_change=true`
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
      })
      if (response.ok) {
        const data = await response.json()
        Object.entries(data).forEach(([id, vals]) => {
          result[id.toUpperCase()] = {
            price: Math.round(vals.chf * 100) / 100,
            change24h: Math.round((vals.chf_24h_change || 0) * 100) / 100,
          }
        })
      }
    } catch (err) {
      console.error('[/api/prices] Crypto batch error:', err.message)
    }
  }

  // Individual stocks (Yahoo doesn't support batch easily)
  for (const symbol of stocks) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      })
      if (response.ok) {
        const data = await response.json()
        const meta = data?.chart?.result?.[0]?.meta
        if (meta) {
          const price = meta.regularMarketPrice || meta.previousClose
          const currency = meta.currency || 'USD'
          const usdChfRate = 0.91
          result[symbol.toUpperCase()] = {
            price: Math.round((currency === 'CHF' ? price : price * usdChfRate) * 100) / 100,
            change24h: Math.round((meta.regularMarketChangePercent || 0) * 100) / 100,
          }
        }
      }
    } catch (err) {
      console.error(`[/api/prices] Stock error for ${symbol}:`, err.message)
    }
  }

  res.json({ prices: result, timestamp: Date.now() })
})

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Wealth Backend running on port ${PORT}`)
  console.log(`   Stock prices: /api/price?symbol=AAPL`)
  console.log(`   Crypto prices: /api/crypto?id=bitcoin`)
  console.log(`   Batch: /api/prices?stocks=AAPL,VWRL&cryptos=bitcoin`)
})
