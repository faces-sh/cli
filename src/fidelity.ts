import {FacesAPIError, FacesClient} from './client.js'
import {heldDecisionError} from './decisions.js'
import {seg} from './utils.js'

/**
 * Fidelity runs: ten blind turns in which the face's owner writes a message,
 * reads two answers labelled a and b (one the face's, one a competitor model's,
 * in random order), and picks the one that sounds more like the person,
 * accepting it or correcting it. The score, out of 10, is saved on the face.
 *
 * The picks are the owner's to make. Nothing here chooses for them.
 */
export const FIDELITY_TURNS = 10

export interface FidelityTurn {
  n: number
  message?: string
  answers?: {a?: string; b?: string}
  pick?: 'a' | 'b'
  correction?: string | null
  score?: number | null
  /** Which label was the face's, shown once the run is finished. */
  face?: 'a' | 'b'
}

export interface FidelityRun {
  run_id: string
  alias?: string
  status?: string
  competitor?: string
  competitor_texts?: number
  turns_total?: number
  turns_done?: number
  next?: {turn: number; awaiting: 'message' | 'choice'} | null
  score?: number | null
  score_so_far?: number
  thread_id?: string | null
  turns?: FidelityTurn[]
  estimated_usd?: number
}

/**
 * POST a fidelity call. A turn and a graded choice are held open by the
 * server past 40s with keep-alive spaces, and a refusal after that arrives as
 * a 200 carrying the error, so it is turned back into one here.
 */
export async function fidelityPost(client: FacesClient, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const data = (await client.post(path, {body})) as Record<string, unknown>
  const held = heldDecisionError(data)
  if (held) throw held
  return data
}

export async function getRun(client: FacesClient, runId: string): Promise<FidelityRun> {
  return (await client.get(`/v1/fidelity/${seg(runId)}`)) as FidelityRun
}

/** A score out of 10, to one place. */
export function score10(n: unknown): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(1).replace(/\.0$/, '') : '-'
}

/** What to run next on a run, or undefined once it is finished. */
export function nextStep(run: FidelityRun): string | undefined {
  const id = run.run_id
  if (!run.next) {
    return run.thread_id
      ? undefined
      : `Keep the conversation as a thread on the face, to compile: faces fidelity:save-thread ${id}`
  }
  return run.next.awaiting === 'choice'
    ? `Pick the answer that sounds more like the person: faces fidelity:pick ${id} a|b [--correction "..."]`
    : `Send turn ${run.next.turn}'s message: faces fidelity:turn ${id} -m "..."`
}

/** The run's state in labelled lines, without the turns' texts. */
export function runLines(run: FidelityRun): string[] {
  const total = run.turns_total ?? FIDELITY_TURNS
  const done = run.status === 'done'
  const lines = [
    `run:        ${run.run_id}`,
    `face:       ${run.alias ?? '-'}`,
    `status:     ${done ? 'finished' : 'in progress'}`,
  ]
  if (run.competitor) {
    const texts = typeof run.competitor_texts === 'number' ? `, shown ${run.competitor_texts} of the face's texts` : ''
    lines.push(`competitor: ${run.competitor}${texts}`)
  }
  lines.push(`turns:      ${run.turns_done ?? 0} of ${total}`)
  lines.push(
    done ? `score:      ${score10(run.score)} out of ${total}` : `so far:     ${score10(run.score_so_far ?? 0)} out of ${run.turns_done ?? 0}`,
  )
  if (run.thread_id) lines.push(`thread:     ${run.thread_id}`)
  return lines
}

/** One line per chosen turn. Once finished, it says which answer was the face's. */
export function turnLines(run: FidelityRun): string[] {
  const out: string[] = []
  for (const t of run.turns ?? []) {
    if (!t.pick) {
      out.push(`  turn ${t.n}: waiting for a pick`)
      continue
    }
    const how = t.correction ? 'corrected' : 'accepted'
    const side = t.face ? (t.face === t.pick ? ', the face' : ', the competitor') : ''
    out.push(`  turn ${t.n}: picked ${t.pick}${side}, ${how}, scored ${score10(t.score)}`)
  }
  return out
}

/** The two answers of a turn, labelled. */
export function answerLines(turn: number, answers: {a?: unknown; b?: unknown}): string[] {
  return [
    `Turn ${turn} of ${FIDELITY_TURNS}. Which sounds more like the person?`,
    '',
    'a:',
    String(answers.a ?? ''),
    '',
    'b:',
    String(answers.b ?? ''),
  ]
}

/** What to do about a fidelity refusal, or undefined when the server's message is enough. */
export function fidelityHint(err: FacesAPIError, on: {run?: string; alias?: string} = {}): string | undefined {
  const id = on.run ?? '<run>'
  switch (err.errorCode) {
    case 'fidelity_choice_pending':
      return `Pick one first: faces fidelity:pick ${id} a|b`
    case 'fidelity_run_finished':
      return `Read the score: faces fidelity:get ${id}. Start another with faces fidelity:start ${on.alias ?? '<alias>'}.`
    case 'fidelity_run_open':
      return `See where it stands: faces fidelity:get ${id}`
    case 'fidelity_unknown_model':
      return 'List the chat models with: faces models:list'
    case 'fidelity_nothing_compiled':
      return `Add a source with: faces compile:upload ${on.alias ?? '<alias>'} --file <file>`
    case 'fidelity_run_not_found':
      return 'Run ids are printed by faces fidelity:start.'
    default:
      return undefined
  }
}

/** A fidelity refusal as the line to print. */
export function fidelityError(err: FacesAPIError, on: {run?: string; alias?: string} = {}): string {
  const hint = fidelityHint(err, on)
  return `HTTP ${err.statusCode}: ${err.message}${hint ? `\n${hint}` : ''}`
}
