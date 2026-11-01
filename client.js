/**
 * Client half of @local/dsh-web-cost: a dock chip beside the shipped usage entry.
 * Reads `/api/web-cost/summary` (same origin) and opens a detail dialog on click.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-web-cost',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const API = '/api/web-cost/summary?days=30'

    const COLORS = {
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      raised: 'var(--dsw-alias-bg-layer-2)',
      accent: 'var(--dsw-alias-brand-primary)',
    }

    const money = (v) => `¥${(v ?? 0).toFixed(2)}`

    function useSummary() {
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(true)
      const load = useCallback(() => {
        setLoading(true)
        fetch(API, { headers: { accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((json) => { setData(json); setError(null) })
          .catch((e) => setError(String(e.message || e)))
          .finally(() => setLoading(false))
      }, [])
      useEffect(() => { load() }, [load])
      return { data, error, loading, reload: load }
    }

    function Row({ label, value, strong }) {
      return h('div', {
        style: {
          display: 'flex', justifyContent: 'space-between', gap: 16,
          padding: '6px 0', fontSize: 13,
          color: strong ? COLORS.text : COLORS.muted,
          fontWeight: strong ? 600 : 400,
        },
      }, h('span', null, label), h('span', { style: { color: COLORS.text, fontVariantNumeric: 'tabular-nums' } }, value))
    }

    function Dialog({ data, error, loading, reload, onClose }) {
      useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])

      const totals = data?.totals
      const days = (data?.perDay ?? []).slice(-14).reverse()

      return h('div', {
        role: 'presentation',
        onClick: onClose,
        style: {
          position: 'fixed', inset: 0, zIndex: 1200,
          background: 'rgba(0,0,0,0.38)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
        },
      }, h('div', {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '网页用量计费',
        onClick: (e) => e.stopPropagation(),
        style: {
          width: 'min(560px, 94vw)', maxHeight: '82vh', overflow: 'auto',
          background: COLORS.surface, color: COLORS.text,
          border: `1px solid ${COLORS.border}`, borderRadius: 14,
          padding: '18px 20px 16px', boxShadow: '0 18px 48px rgba(0,0,0,0.28)',
          fontSize: 13, lineHeight: 1.55,
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 } },
        h('div', null,
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, '网页用量计费'),
          h('div', { style: { color: COLORS.muted, fontSize: 12 } },
            data ? `近 ${data.days} 天 · 截至 ${data.today}` : '读取中…')),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', {
            type: 'button', onClick: reload, disabled: loading,
            style: {
              border: `1px solid ${COLORS.border}`, background: COLORS.raised, color: COLORS.text,
              borderRadius: 8, padding: '4px 10px', cursor: 'pointer', fontSize: 12,
            },
          }, loading ? '刷新中…' : '刷新'),
          h('button', {
            type: 'button', onClick: onClose, 'aria-label': '关闭',
            style: {
              border: `1px solid ${COLORS.border}`, background: 'transparent', color: COLORS.muted,
              borderRadius: 8, padding: '4px 10px', cursor: 'pointer', fontSize: 12,
            },
          }, '关闭'))),

      error ? h('div', { style: { marginTop: 14, color: 'var(--dsw-alias-state-error-primary)' } }, `读取失败：${error}`) : null,

      totals ? h('div', { style: { marginTop: 12 } },
        h('div', { style: { display: 'flex', gap: 10, marginBottom: 4 } },
          h('div', { style: { flex: 1, background: COLORS.raised, borderRadius: 10, padding: '10px 12px' } },
            h('div', { style: { color: COLORS.muted, fontSize: 11 } }, '折合每月'),
            h('div', { style: { fontSize: 20, fontWeight: 700, fontVariantNumeric: 'tabular-nums' } }, money(data.monthly)),
            h('div', { style: { color: COLORS.muted, fontSize: 10 } }, `按计费 ${data.billingDays} 天折算`)),
          h('div', { style: { flex: 1, background: COLORS.raised, borderRadius: 10, padding: '10px 12px' } },
            h('div', { style: { color: COLORS.muted, fontSize: 11 } }, '总计费'),
            h('div', { style: { fontSize: 20, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: COLORS.accent } }, money(data.cost)),
            h('div', { style: { color: COLORS.muted, fontSize: 10 } }, `${data.billingStartDay} 00:00 起 · ${data.billable.queries} 条 query`))),
        h(Row, { label: `计费期 web_search（${data.billingDays} 天）`, value: `${data.billable.search} 次 / ${data.billable.queries} 条` }),
        h(Row, { label: '近 30 天窗口用量（含计费前）', value: `${totals.search} 次 / ${totals.queries} 条` }),
        h(Row, { label: 'web_fetch（本地 HTTP 不计费）', value: `${totals.fetch} 次` }),
        h(Row, { label: '口径', value: '5 元 / 1000 次，只算成功请求' }),
        data.usageBefore > 0 ? h('div', { style: { color: COLORS.muted, fontSize: 11, marginTop: 4 } },
          `${data.billingStartDay} 之前的 ${data.usageBefore} 条 query 不计费。`) : null) : null,

      days.length ? h('div', { style: { marginTop: 14 } },
        h('div', { style: { color: COLORS.muted, fontSize: 12, marginBottom: 4 } }, '最近 14 个有记录的日子'),
        h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12 } },
          h('thead', null, h('tr', null,
            ['日期', 'query', '搜索', '抓取', '计费'].map((t, i) => h('th', {
              key: t,
              style: {
                textAlign: i === 0 ? 'left' : 'right', fontWeight: 500, color: COLORS.muted,
                padding: '3px 0', borderBottom: `1px solid ${COLORS.border}`,
              },
            }, t)))),
          h('tbody', null, days.map((row) => h('tr', { key: row.day },
            h('td', { style: { padding: '3px 0', color: COLORS.text } }, row.day),
            h('td', { style: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }, row.queries),
            h('td', { style: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }, row.search),
            h('td', { style: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }, row.fetch),
            h('td', { style: { textAlign: 'right', color: row.billable ? COLORS.accent : COLORS.muted } }, row.billable ? '是' : '—')))))) : null,

      data?.sessions?.length ? h('div', { style: { marginTop: 14 } },
        h('div', { style: { color: COLORS.muted, fontSize: 12, marginBottom: 2 } }, '用量最高的会话'),
        ...data.sessions.slice(0, 5).map((s) => h('div', {
          key: s.id,
          style: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '2px 0', fontSize: 12, color: COLORS.muted },
        },
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.id.slice(0, 20) + '…'),
        h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, `${s.queries} 条`)))) : null,

      h('div', { style: { marginTop: 14, color: COLORS.muted, fontSize: 11 } },
        '只读本机会话日志；抓取走本地 HTTP 时费用为 0。')))
    }

    function DockChip() {
      const { data, error, loading, reload } = useSummary()
      const [open, setOpen] = useState(false)

      const label = error
        ? '网页用量 —'
        : data
          ? `网页 ${money(data.cost)} 计费 · ${data.billable.queries} query`
          : '网页用量 …'

      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          onClick: () => { reload(); setOpen(true) },
          title: error ? `读取失败：${error}` : '点击查看网页搜索/抓取用量与费用',
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 6,
            border: 'none', background: 'transparent', padding: '2px 4px',
            color: COLORS.muted, fontSize: 12, cursor: 'pointer', lineHeight: 1.4,
            fontVariantNumeric: 'tabular-nums',
          },
        },
        h('span', { 'aria-hidden': true, style: { color: COLORS.accent, fontWeight: 700 } }, '¥'),
        h('span', null, loading && !data ? '网页用量 …' : label)),
        open ? h(Dialog, { data, error, loading, reload, onClose: () => setOpen(false) }) : null)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'web-cost',
          order: 2,
        }, DockChip))
      },
    }
  },
})
