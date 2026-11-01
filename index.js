/**
 * `web_usage` — measure DeepSeek web_search / web_fetch usage across every local session
 * (all workspaces) and estimate the Search / Fetch API bill.
 *
 * Two faces:
 * - the model-facing `web_usage` tool;
 * - `GET /api/web-cost/summary?days=N` for the dock chip in the Web UI.
 *
 * Data source: the session log, through `ctx.sessionPersistence` (raw, append-only, so a
 * session's numbers are cached under its event count and only recomputed when it grows).
 * No network access and no session mutation.
 *
 * @module @local/dsh-web-cost
 */

export const name = 'web-cost'
export const inject = ['tools', 'sessionPersistence', 'webServer']

/** Beijing time offset: billing days are Beijing days. */
const BJ_OFFSET = 8 * 3600 * 1000
const DEFAULT_RATE = 5 // CNY per 1,000 successful requests, Search and Fetch each (2026-11-01)
/** Billing starts at 00:00 Beijing time on this day; earlier calls are free. */
const BILLING_START_DAY = '2026-11-01'
const CACHE_LIMIT = 4096

/** Per-session fold cache: sessionId → { eventCount, days }. */
const cache = new Map()

const toDay = (time) => new Date(time + BJ_OFFSET).toISOString().slice(0, 10)
const fmt = (time) => new Date(time + BJ_OFFSET).toISOString().replace('T', ' ').slice(0, 16)

/** Extract one session's web-tool usage, reusing the cached fold when the log is unchanged. */
async function foldSession(persistence, snapshot) {
  const id = snapshot.header.id
  const known = cache.get(id)
  if (known && snapshot.eventCount !== undefined && known.eventCount === snapshot.eventCount) {
    return known.days
  }

  let handle
  let events = []
  try {
    handle = await persistence.open(id, 'read')
    const page = await handle.read()
    events = page?.events ?? []
  } catch {
    return known?.days ?? new Map()
  } finally {
    if (handle) { try { await handle.close() } catch { /* ignore */ } }
  }

  const calls = new Map()
  const days = new Map()
  const bucket = (time) => {
    const day = toDay(time)
    let row = days.get(day)
    if (!row) { row = { search: 0, queries: 0, fetch: 0, fetchErrors: 0, searchErrors: 0 }; days.set(day, row) }
    return row
  }

  for (const event of events) {
    const data = event?.data
    if (!data) continue
    if (event.type === 'tool/call') {
      const tool = data.name
      if (tool !== 'web_search' && tool !== 'web_fetch') continue
      let queries = 1
      if (tool === 'web_search') {
        try {
          const args = JSON.parse(data.arguments || '{}')
          if (Array.isArray(args.queries)) queries = args.queries.length
          else if (typeof args.query === 'string') queries = 1
        } catch { /* keep 1 */ }
      }
      calls.set(data.callId, { tool, time: event.time, queries, ok: true })
      const row = bucket(event.time)
      if (tool === 'web_search') { row.search += 1; row.queries += queries } else { row.fetch += 1 }
    } else if (event.type === 'tool/result') {
      const callId = data.message?.toolCallId
      const call = callId ? calls.get(callId) : undefined
      if (!call) continue
      if (data.message?.isError === true || data.error !== undefined) {
        call.ok = false
        const row = bucket(call.time)
        if (call.tool === 'web_search') row.searchErrors += 1
        else row.fetchErrors += 1
      }
    }
  }

  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(id, { eventCount: snapshot.eventCount, days })
  return days
}

/** Aggregate every session's cached folds over the last `days` Beijing days. */
async function collect(persistence, days, searchRate, fetchRate, billedFetch) {
  const now = Date.now()
  const cutoffDay = toDay(now - (days - 1) * 86400000)

  const snapshots = await persistence.list()
  const perSession = []
  const perDay = new Map()
  const billable = { queries: 0, search: 0, fetch: 0, fetchErrors: 0 }
  let earliestDay = null

  for (const snapshot of snapshots) {
    const daysMap = await foldSession(persistence, snapshot)
    let queries = 0
    let search = 0
    let fetch = 0
    let fetchErrors = 0
    for (const [day, row] of daysMap) {
      if (day < cutoffDay) continue
      if (earliestDay === null || day < earliestDay) earliestDay = day
      queries += row.queries
      search += row.search
      fetch += row.fetch
      fetchErrors += row.fetchErrors
      if (day >= BILLING_START_DAY) {
        billable.queries += row.queries
        billable.search += row.search
        billable.fetch += row.fetch
        billable.fetchErrors += row.fetchErrors
      }
      const agg = perDay.get(day) ?? { day, queries: 0, search: 0, fetch: 0, billable: false }
      agg.queries += row.queries
      agg.search += row.search
      agg.fetch += row.fetch
      agg.billable = agg.day >= BILLING_START_DAY
      perDay.set(day, agg)
    }
    if (search || fetch) {
      perSession.push({
        id: String(snapshot.header.id),
        createdAt: snapshot.header.createdAt,
        cwd: snapshot.header.cwd ?? '',
        queries, search, fetch, fetchErrors,
      })
    }
  }

  const totals = perSession.reduce((acc, s) => {
    acc.queries += s.queries; acc.search += s.search; acc.fetch += s.fetch; acc.fetchErrors += s.fetchErrors
    return acc
  }, { queries: 0, search: 0, fetch: 0, fetchErrors: 0 })

  const searchCost = (billable.queries * searchRate) / 1000
  const fetchCost = billedFetch ? (((billable.fetch - billable.fetchErrors) * fetchRate) / 1000) : 0
  const cost = searchCost + fetchCost

  // 计费从 2026-11-01 00:00（北京时间）开始：只有这一天的零点及之后的 query 才收费。
  const today = toDay(now)
  const billingStart = Math.max(Date.parse(BILLING_START_DAY), Date.parse(cutoffDay))
  const billingDays = today < BILLING_START_DAY
    ? 0
    : Math.round((Date.parse(today) - billingStart) / 86400000) + 1
  const monthly = billingDays > 0 ? (cost / billingDays) * 30 : 0
  const monthlyQueries = billingDays > 0 ? Math.round((billable.queries / billingDays) * 30) : 0

  return {
    generatedAt: now,
    days,
    today,
    billingStartDay: BILLING_START_DAY,
    sessionsOnDisk: snapshots.length,
    sessions: perSession.sort((a, b) => b.queries - a.queries),
    totals,
    billable,
    searchCost,
    fetchCost,
    cost,
    billedFetch,
    billingDays,
    earliestDay,
    monthly,
    monthlyQueries,
    usageBefore: totals.queries - billable.queries,
    perDay: [...perDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
  }
}

/** The model-facing prose report. */
function report(data, detail) {
  const { totals, billable, cost, days, perDay, sessions } = data
  const lines = []
  lines.push(`网页搜索/抓取用量 · 近 ${days} 天（北京时间，截至 ${data.today}）`)
  lines.push(`会话 ${sessions.length} 个有记录（本机共 ${data.sessionsOnDisk} 个）。`)
  lines.push('')
  lines.push(`计费自 ${data.billingStartDay} 00:00 起，已计费 ${data.billingDays} 天：`)
  lines.push(`  总计费 ${cost.toFixed(2)} 元（计费期内 ${billable.queries} 条 query）`)
  lines.push(`  折合每月 ${data.monthly.toFixed(2)} 元/月（${data.monthlyQueries} 条 query/月；总量 ÷ 计费天数 × 30）`)
  lines.push('')
  lines.push(`web_search : 窗口内 ${totals.search} 次调用 / ${totals.queries} 条 query（${(totals.queries / Math.max(totals.search, 1)).toFixed(2)} 条/次），其中计费期 ${billable.search} 次 / ${billable.queries} 条`)
  lines.push(`web_fetch  : 窗口内 ${totals.fetch} 次（失败 ${totals.fetchErrors}），计费期 ${billable.fetch} 次`)
  if (data.usageBefore > 0) {
    lines.push(`  ${data.billingStartDay} 之前的 ${data.usageBefore} 条 query 不计费。`)
  }

  if (detail !== 'summary') {
    lines.push('')
    lines.push('日期         query  search  fetch  计费')
    for (const row of perDay) {
      lines.push(`${row.day}  ${String(row.queries).padStart(5)}  ${String(row.search).padStart(6)}  ${String(row.fetch).padStart(5)}  ${row.billable ? '是' : '—'}`)
    }
  }

  if (detail === 'sessions') {
    lines.push('')
    lines.push('最费 query 的会话（整个窗口）：')
    for (const s of sessions.slice(0, 10)) {
      const when = s.createdAt ? fmt(s.createdAt) : '?'
      const where = s.cwd ? s.cwd.split(/[\\/]/).pop() : ''
      lines.push(`- ${s.queries} 条 / ${s.search} 次搜索 / ${s.fetch} 次抓取 · ${when} · ${where || '?'} · ${s.id.slice(0, 18)}…`)
    }
  }

  lines.push('')
  lines.push('口径：一条 query 就是一次 Search 请求，5 元/1000 次；失败请求不计费。数据只读自本机会话日志。')
  return lines.join('\n')
}

export function apply(ctx) {
  const persistence = ctx.sessionPersistence

  const tool = {
    name: 'web_usage',
    description:
      'Report DeepSeek web_search / web_fetch usage across ALL local sessions (every workspace) and estimate the '
      + 'Search / Fetch API bill (5 CNY per 1,000 successful requests each, billed from 2026-11-01 Beijing time). '
      + 'Reads session logs only; costs nothing and contacts no network. Use it to answer "how much have I spent on '
      + 'web tools" or to check the month\'s usage before it grows.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        days: { type: 'integer', description: 'Look-back window in days, Beijing calendar days. Default 30.' },
        detail: {
          type: 'string',
          enum: ['summary', 'daily', 'sessions'],
          description: 'summary (default) | daily adds a per-day table | sessions adds the busiest sessions.',
        },
        searchRate: { type: 'number', description: 'CNY per 1,000 Search requests. Default 5.' },
        fetchRate: { type: 'number', description: 'CNY per 1,000 Fetch requests. Default 5.' },
        billedFetch: {
          type: 'boolean',
          description: 'Count web_fetch as billed (only true when the fetch provider is the DeepSeek Fetch API). Default false.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'queries', 'searches', 'fetches', 'cost'],
        properties: {
          text: { type: 'string' },
          queries: { type: 'integer' },
          searches: { type: 'integer' },
          fetches: { type: 'integer' },
          cost: { type: 'number' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 180000,
    async execute(args) {
      const days = Math.min(Math.max(Number.isInteger(args.days) ? args.days : 30, 1), 3650)
      const detail = args.detail === 'daily' || args.detail === 'sessions' ? args.detail : 'summary'
      const searchRate = Number.isFinite(args.searchRate) && args.searchRate >= 0 ? args.searchRate : DEFAULT_RATE
      const fetchRate = Number.isFinite(args.fetchRate) && args.fetchRate >= 0 ? args.fetchRate : DEFAULT_RATE
      const billedFetch = args.billedFetch === true

      const data = await collect(persistence, days, searchRate, fetchRate, billedFetch)
      return {
        text: report(data, detail),
        queries: data.billable.queries,
        searches: data.billable.search,
        fetches: data.billable.fetch,
        cost: Number(data.cost.toFixed(4)),
      }
    },
  }

  ctx.effect(() => ctx.tools.register(tool), 'web-cost: register web_usage')

  // JSON endpoint for the dock chip. Same origin, no credentials, no session data beyond counts.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/web-cost/summary',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const days = Math.min(Math.max(Number.parseInt(url.searchParams.get('days') ?? '30', 10) || 30, 1), 3650)
      let payload
      try {
        const data = await collect(persistence, days, DEFAULT_RATE, DEFAULT_RATE, false)
        payload = JSON.stringify({
          generatedAt: data.generatedAt,
          days: data.days,
          today: data.today,
          billingStartDay: data.billingStartDay,
          billingDays: data.billingDays,
          totals: data.totals,
          billable: data.billable,
          cost: Number(data.cost.toFixed(4)),
          monthly: Number(data.monthly.toFixed(4)),
          monthlyQueries: data.monthlyQueries,
          usageBefore: data.usageBefore,
          sessions: data.sessions.slice(0, 12).map((s) => ({
            id: s.id, queries: s.queries, search: s.search, fetch: s.fetch, createdAt: s.createdAt,
          })),
          perDay: data.perDay,
        })
      } catch (error) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: String(error?.message ?? error) }))
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(payload)
    },
  }), 'web-cost: register /api/web-cost/summary')
}
