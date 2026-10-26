import {FacesAPIError, FacesClient} from './client.js'
import {seg, usd} from './utils.js'

/**
 * A benchmark compares a face against a reference model on the face's own
 * material, over many rounds, and says which sounds more like the person, by
 * how much and how sure. It runs off-request: start it, then poll.
 */
export const BENCHMARK_RUNS = '/v1/benchmark/runs'

export interface BenchmarkRun {
  run_id: string
  self_face?: string
  status?: string
  model?: string
  reference_model?: string
  progress?: {rounds_done?: number; rounds_total?: number} | null
  result?: Record<string, unknown> | null
  error?: string | null
  created_at?: string | null
}

const num = (v: unknown, places = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(places) : '-')
const signed = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}` : '-')

function interval(ci: unknown): string {
  const c = ci as {lo?: unknown; hi?: unknown; resolved?: unknown} | null | undefined
  if (!c) return ''
  return ` (95% interval ${signed(c.lo)} to ${signed(c.hi)}${c.resolved ? '' : ', too close to call'})`
}

function winnerOf(w: unknown): string {
  return w === 'face' ? 'the face' : w === 'reference' ? 'the reference model' : 'neither, too close to call'
}

/** One slice (a length or a medium) on one line. */
function sliceLine(name: string, s: Record<string, unknown>): string {
  const parts = [`face ${num(s.face)}`, `reference ${num(s.reference)}`]
  if (s.gap !== undefined) parts.push(`gap ${signed(s.gap)}`)
  if (s.winner) parts.push(`won by ${s.winner}`)
  return `  ${name}: ${parts.join(', ')} (${s.rounds ?? 0} rounds)`
}

/** A finished result, in labelled lines. */
export function resultLines(r: Record<string, unknown>): string[] {
  const lines = [
    `winner:     ${winnerOf(r.winner)}`,
    `gap:        ${signed(r.gap)}${interval(r.ci95)}`,
    `scores:     face ${num(r.face)}, reference ${num(r.reference)}`,
    `rounds:     ${r.rounds_fought ?? '-'} of ${r.rounds_requested ?? '-'}${r.stopped_early ? ', stopped early at the spend cap' : ''}`,
  ]
  const usage = (r.usage ?? {}) as Record<string, unknown>
  if (usage.spend_usd !== undefined) {
    lines.push(`spent:      ${usd(usage.spend_usd)}${usage.budget_usd ? ` of a ${usd(usage.budget_usd)} cap` : ''}`)
  }
  if (r.seed !== undefined && r.seed !== null) lines.push(`seed:       ${r.seed}  (pass --seed ${r.seed} to draw the same rounds again)`)
  for (const [label, key] of [['by length', 'by_length'], ['by medium', 'by_medium']] as const) {
    const slices = Object.entries((r[key] ?? {}) as Record<string, Record<string, unknown>>)
    if (slices.length === 0) continue
    lines.push(`${label}:`)
    for (const [name, s] of slices) lines.push(sliceLine(name, s))
  }
  for (const w of (r.warnings as string[] | undefined) ?? []) lines.push(`warning: ${w}`)
  return lines
}

/** A run's state in labelled lines, with the result once there is one. */
export function runLines(run: BenchmarkRun): string[] {
  const lines = [
    `run:        ${run.run_id}`,
    `face:       ${run.self_face ?? '-'} on ${run.model ?? '-'}`,
    `reference:  ${run.reference_model ?? '-'}`,
    `status:     ${run.status ?? '-'}`,
  ]
  const p = run.progress
  if (p?.rounds_total) lines.push(`progress:   ${p.rounds_done ?? 0} of ${p.rounds_total} rounds`)
  if (run.error) lines.push(`error:      ${run.error}`)
  if (run.result) lines.push('', ...resultLines(run.result))
  return lines
}

/** What to do about a benchmark refusal, or undefined when the server's message is enough. */
export function benchmarkHint(err: FacesAPIError, face?: string): string | undefined {
  const alias = face ?? '<alias>'
  if (err.errorCode === 'benchmark_no_compiled_corpus') return `Add a source with: faces compile:upload ${alias} --file <file>`
  if (err.errorCode === 'benchmark_no_style') return `Build its style with: faces style:make ${alias} --all`
  if (err.errorCode === 'benchmark_insufficient_credit') return 'Lower --rounds or --max-spend, or add credit: faces billing:topup --amount <usd>'
  if (err.statusCode === 400 && /model/i.test(err.message)) return 'List the models with: faces models:list'
  return undefined
}

export function benchmarkError(err: FacesAPIError, face?: string): string {
  const hint = benchmarkHint(err, face)
  return `HTTP ${err.statusCode}: ${err.message}${hint ? `\n${hint}` : ''}`
}

/**
 * Poll a run until it is done or failed, every 10s. A failed run sets a
 * non-zero exit code: a script reading 0 would take it for a result.
 */
export async function followRun(client: FacesClient, id: string, onProgress: (line: string) => unknown): Promise<BenchmarkRun> {
  let last = ''
  for (;;) {
    const run = (await client.get(`${BENCHMARK_RUNS}/${seg(id)}`)) as BenchmarkRun
    if (run.status === 'done' || run.status === 'failed') {
      if (run.status === 'failed') process.exitCode = 1
      return run
    }
    const p = run.progress
    const now = p?.rounds_total ? `${p.rounds_done ?? 0}/${p.rounds_total} rounds` : String(run.status)
    if (now !== last) onProgress(now)
    last = now
    await new Promise((r) => setTimeout(r, 10_000))
  }
}
