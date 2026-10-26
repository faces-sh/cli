/**
 * Plans, allowances and saved cards: what the billing commands say about them.
 *
 * Kept apart from the commands so the wording can be checked offline: a
 * meter that reads wrong sends someone to pay for something they have.
 */

/** The plans a checkout or a switch can name. Free is the absence of one. */
export const PAID_PLANS = ['connect', 'pro'] as const
export type PaidPlan = (typeof PAID_PLANS)[number]

export const PLAN_PRICE: Record<PaidPlan, string> = {
  connect: '$17/month',
  pro: '$49/month',
}

/** A plan's name as people say it. */
export function planName(plan: unknown): string {
  const p = String(plan ?? '')
  return p ? p[0].toUpperCase() + p.slice(1) : 'unknown'
}

/** What each allowance counts, in the order a meter shows them. */
const ALLOWANCES: Array<[string, string]> = [
  ['cause_5h', 'causes, rolling 5 hours'],
  ['cause_week', 'causes, this week'],
  ['cause_month', 'causes, this month'],
  ['compile_month', 'compile, this month'],
]

interface Allowance {
  limit?: number
  used?: number
  remaining?: number | null
  resets_at?: string | null
}

/** 1234567 as "1.2M", 400000 as "400k": allowances are millions of tokens, and exact counts only blur them. */
export function tokens(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '-'
  // Rounded down, never up: a meter must not read as full while some is left,
  // and up to two decimals so 6.25M is not shown as 6.3M.
  // In whole units of the last digit shown, so float error cannot round 9.95M to 9.94M.
  const millions = () => `${Math.floor(n / 10_000) / 100}M`
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return millions()
  if (abs >= 10_000) return `${Math.floor(n / 100) / 10}k`
  return String(n)
}

/**
 * A share of an allowance: rounded down, so 99.9% never prints as 100%, and
 * "<1%" for a little use, which "0%" would hide.
 */
export function percentUsed(used: number, limit: number): string {
  const pct = Math.floor((used / limit) * 100)
  return pct === 0 && used > 0 ? '<1%' : `${pct}%`
}

/** "2026-10-22 14:00 UTC" from the API's naive UTC timestamp. */
function when(ts: unknown): string | undefined {
  if (typeof ts !== 'string' || !ts) return undefined
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(ts)
  return m ? `${m[1]} ${m[2]} UTC` : ts
}

/**
 * The plan's allowances as a meter, one line each, or [] when there is none
 * to show: Free pays as it goes, so its `allowances` is null.
 *
 * A face's cause, in chat and decisions, is counted in the
 * input tokens it read plus `cause_added_tokens` a turn, with no floor; compile
 * in source tokens each time a source is compiled. The answering model is never part of
 * it. A limit of -1 is unlimited. The 5
 * hour window rolls, so it has no reset.
 */
export function allowanceLines(sub: Record<string, unknown>): string[] {
  const all = sub.allowances as Record<string, Allowance> | null | undefined
  if (!all || typeof all !== 'object') return []

  const rows = ALLOWANCES.filter(([key]) => all[key]).map(([key, label]) => {
    const a = all[key]
    const unlimited = typeof a.limit === 'number' && a.limit < 0
    // 0 is no allowance at all: that use is paid per token, so "0 of 0" would mislead.
    const none = a.limit === 0
    let amount: string
    if (unlimited) {
      amount = `${tokens(a.used)} used, unlimited`
    } else if (none) {
      amount = 'none, paid per token'
    } else {
      const pct = typeof a.used === 'number' && typeof a.limit === 'number' && a.limit > 0
        ? ` (${percentUsed(a.used, a.limit)})`
        : ''
      amount = `${tokens(a.used)} of ${tokens(a.limit)}${pct}`
    }
    const reset = when(a.resets_at)
    return {label, amount, tail: unlimited || none ? '' : (reset ? `resets ${reset}` : 'rolls')}
  })
  // A key this CLI does not know yet still shows, under its own name.
  for (const [key, a] of Object.entries(all)) {
    if (ALLOWANCES.some(([k]) => k === key) || !a || typeof a !== 'object') continue
    // A negative limit is unlimited for every key, not "of -1"; 0 is none, not "0 of 0".
    const amount = typeof a.limit === 'number' && a.limit < 0
      ? `${tokens(a.used)} used, unlimited`
      : a.limit === 0 ? 'none, paid per token' : `${tokens(a.used)} of ${tokens(a.limit)}`
    rows.push({label: key, amount, tail: a.limit !== 0 && when(a.resets_at) ? `resets ${when(a.resets_at)}` : ''})
  }
  if (rows.length === 0) return []

  const lw = Math.max(...rows.map((r) => r.label.length))
  const aw = Math.max(...rows.map((r) => r.amount.length))
  const lines = [`${planName(sub.plan)} allowances (tokens):`]
  for (const r of rows) lines.push(`  ${r.label.padEnd(lw)}  ${r.amount.padEnd(aw)}  ${r.tail}`.trimEnd())

  const unlimited = rows.every((r) => r.amount.endsWith('unlimited'))
  if (!unlimited) {
    const rates = sub.rates as Record<string, unknown> | undefined
    let past = 'Past an allowance, api_fallback on pays from your credits; off refuses with a 429 until it resets.'
    if (rates && typeof rates.cause_usd_per_million_input_tokens === 'number' && typeof rates.compile_usd_per_million_source_tokens === 'number') {
      // Say what a cause token is, or the rate reads as cheaper than it
      // is: each cause counts its input tokens plus a fixed number on top.
      const added = typeof rates.cause_added_tokens === 'number' && rates.cause_added_tokens > 0
        ? `, each cause counting its input tokens plus ${rates.cause_added_tokens.toLocaleString('en-US')},`
        : ''
      const rush = typeof rates.compile_rush_usd_per_million_source_tokens === 'number'
        ? ` ($${rates.compile_rush_usd_per_million_source_tokens} for a rush)`
        : ''
      past +=
        ` Credits pay $${rates.cause_usd_per_million_input_tokens} per million cause tokens${added} and ` +
        `$${rates.compile_usd_per_million_source_tokens} per million compile tokens${rush}.`
    }
    lines.push(`  ${past}`)
  }
  return lines
}

export interface Card {
  id: string
  brand?: string
  last4?: string
  exp_month?: number
  exp_year?: number
  is_default?: boolean
}

/** "visa ending 4242, expires 08/2029  pm_...  (default)" */
export function cardLine(c: Card): string {
  const exp = c.exp_month && c.exp_year ? `, expires ${String(c.exp_month).padStart(2, '0')}/${c.exp_year}` : ''
  return `${c.brand ?? 'card'} ending ${c.last4 ?? '????'}${exp}  ${c.id}${c.is_default ? '  (default)' : ''}`
}

/** Who made the model on a `/v1/billing/llm-costs` row: its `lab`, or empty when it has none. */
export function llmCostLab(row: Record<string, unknown>): string {
  return typeof row.lab === 'string' ? row.lab : ''
}
