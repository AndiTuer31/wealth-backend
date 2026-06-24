import express from 'express'
import cors from 'cors'
import fetch from 'node-fetch'
import Anthropic from '@anthropic-ai/sdk'

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
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=chf&include_24hr_change=true${keyParam}`
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          ...(apiKey ? { 'x-cg-demo-api-key': apiKey } : {}),
        },
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

// ── POST /api/chat ────────────────────────────────────────────────────────────
// Body: { messages: [{role, content}], context: { positions, goals, cashflow, totalNetworth, ... } }
app.post('/api/chat', express.json(), async (req, res) => {
  const { messages, context } = req.body
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' })
  }

  // Build system prompt with portfolio context
  const ctx = context || {}
  const fmtCHF = (v) => `CHF ${Math.round(v).toLocaleString('de-CH')}`

  let systemPrompt = `Du bist ein persönlicher Finanzassistent für Rico, der ein persönliches Finance-Dashboard namens "Wealth." nutzt.
Du bist direkt, klar und motivierend. Antworte auf Deutsch, präzise und ohne unnötige Ausschmückung.
Du kennst Ricos aktuelle Finanzsituation und kannst konkrete Insights und Empfehlungen geben.

AKTUELLER PORTFOLIO-STAND:`

  if (ctx.totalNetworth) {
    systemPrompt += `\n- Nettovermögen: ${fmtCHF(ctx.totalNetworth)}`
    systemPrompt += `\n- Portfolio (investiert): ${fmtCHF(ctx.totalPortfolio || 0)}`
    systemPrompt += `\n- Cash: ${fmtCHF(ctx.totalCash || 0)}`
    systemPrompt += `\n- Gesamtperformance: ${ctx.totalPnlPct ? ctx.totalPnlPct.toFixed(2) + '%' : 'n/a'}`
  }

  if (ctx.positions && ctx.positions.length > 0) {
    systemPrompt += `\n\nPOSITIONEN:`
    ctx.positions.forEach(p => {
      const pnl = p.pnlPct ? ` (${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(1)}%)` : ''
      systemPrompt += `\n- ${p.name} (${p.symbol}): ${fmtCHF(p.currentValue)}${pnl} | Kategorie: ${p.category}`
    })
  }

  if (ctx.goals && ctx.goals.length > 0) {
    systemPrompt += `\n\nZIELE:`
    ctx.goals.forEach(g => {
      const ref = g.linkedTo === 'portfolio' ? ctx.totalPortfolio : g.linkedTo === 'cash' ? ctx.totalCash : ctx.totalNetworth
      const pct = ref && g.targetAmount ? Math.min(((ref / g.targetAmount) * 100), 100).toFixed(0) : 0
      systemPrompt += `\n- ${g.title}: ${pct}% von ${fmtCHF(g.targetAmount)} | Zieldatum: ${g.targetDate}`
    })
  }

  if (ctx.latestCashflow) {
    const cf = ctx.latestCashflow
    const saved = (cf.income || 0) - (cf.expenses || 0)
    const rate = cf.income > 0 ? Math.round((saved / cf.income) * 100) : 0
    systemPrompt += `\n\nLETZTER CASHFLOW-EINTRAG (${cf.month}):`
    systemPrompt += `\n- Einnahmen: ${fmtCHF(cf.income)}, Ausgaben: ${fmtCHF(cf.expenses)}, Gespart: ${fmtCHF(saved)} (Sparquote: ${rate}%)`
  }

  systemPrompt += `\n\nBeantworte Fragen zu diesem Portfolio präzise und hilfreich. Wenn du konkrete Zahlen nennst, beziehe dich auf die obigen Daten.`

  try {
    const anthropic = new Anthropic({ apiKey, timeout: 60000 })

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: systemPrompt,
      messages: messages.slice(-6),
    })

    const reply = response.content[0]?.text || ''
    res.json({ reply, usage: response.usage })
  } catch (err) {
    console.error('[/api/chat] Anthropic error:', err.message)
    res.status(500).json({ error: 'Chat request failed', details: err.message })
  }
})

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Wealth Backend running on port ${PORT}`)
  console.log(`   Stock prices: /api/price?symbol=AAPL`)
  console.log(`   Crypto prices: /api/crypto?id=bitcoin`)
  console.log(`   Batch: /api/prices?stocks=AAPL,VWRL&cryptos=bitcoin`)
})
