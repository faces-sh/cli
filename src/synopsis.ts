/**
 * A state's synopsis (GET /v1/states/{id}/synopsis): what to do next, read from its support graph,
 * and the ready work for a swarm of agents, with its claims.
 */

/** One thing that blocks a goal, with the action it needs. */
export interface FrontierItem {
  key: string
  action: string
  reason?: string
  weight?: number
  path?: string[]
  goals?: string[]
  claimed_by?: string
  side_node?: string
  alternatives?: Array<string | {key: string; p: number}>
}

/** A claim: who holds which premise, and until when. */
export interface Claim {
  object?: string
  id: string
  key: string
  agent: string
  since?: string
  expires_at?: string
}

export interface Synopsis {
  object?: string
  done?: boolean
  next?: string | null
  goals?: Array<{key: string; status?: string; achieved?: boolean}>
  frontier?: FrontierItem[]
  ready?: FrontierItem[]
  groups?: Array<{weight?: number; items: Array<{key: string; action: string; weight?: number}>}>
  claims?: Claim[]
  outline?: string
  text?: string
  changed?: Array<Record<string, unknown>>
}

function w(x: number | undefined): string {
  return typeof x === 'number' ? String(Math.round(x * 100) / 100) : '-'
}

/** The synopsis as lines: its own text, then the outline. */
export function synopsisLines(s: Synopsis, outline = true): string[] {
  const lines = (s.text ?? '').split('\n').filter((l) => l !== '')
  if (outline && s.outline) lines.push('', 'Outline:', ...s.outline.split('\n').map((l) => `  ${l}`))
  return lines
}

/**
 * Up to `n` ready items to run at once: the heaviest item of each parallel group, heaviest group
 * first. Items in different groups never rest on each other, share no unverified premise below them
 * and touch no common resource.
 */
export function pickParallel(s: Synopsis, n: number): FrontierItem[] {
  const ready = s.ready ?? []
  const out: FrontierItem[] = []
  for (const g of s.groups ?? []) {
    if (out.length >= n) break
    const first = g.items[0]
    const item = ready.find((r) => r.key === first.key && r.action === first.action)
    if (item) out.push(item)
  }
  return out
}

/** The picked items as lines. */
export function nextLines(s: Synopsis, picked: FrontierItem[], claimed: Claim[] = []): string[] {
  if (s.done) return ['Every goal is achieved: you can stop.']
  if (picked.length === 0) {
    const held = (s.claims ?? []).map((c) => `${c.key} (${c.agent})`)
    return [held.length > 0 ? `Nothing ready: every ready item is claimed: ${held.join(', ')}.` : 'Nothing ready.']
  }
  const lines: string[] = []
  picked.forEach((f, i) => {
    const c = claimed.find((x) => x.key === f.key)
    lines.push(`${i + 1}. ${f.action} ${f.key}   [weight ${w(f.weight)}]${c ? `   claimed ${c.id} until ${c.expires_at ?? '?'}` : ''}`)
    if (f.reason) lines.push(`   ${f.reason}`)
    if (f.path && f.path.length > 1) lines.push(`   for: ${f.path.slice(0, -1).reverse().join(' < ')}`)
  })
  const rest = (s.ready ?? []).length - picked.length
  if (rest > 0) lines.push('', `${rest} more ready item(s); ${(s.groups ?? []).length} parallel group(s) in all.`)
  return lines
}
