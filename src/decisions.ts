import fs from 'node:fs'
/**
 * Helpers for `faces decide`, the client for POST /v1/systemone (Jev's System One format).
 *
 * Kept apart from the command so the parts that decide what a person is told
 * can be checked offline (scripts/check.mjs) without a face to ask.
 */
import {FacesAPIError, FacesClient, readableDetail} from './client.js'

/**
 * The decision models: models that turn a situation into probabilities, as
 * opposed to generative models that write text. The catalog is the source
 * ({@link decisionModels}); this is what is said when it cannot be read.
 */
export const DECISION_MODELS = ['jev-latest', 'clef', 'clef-flash'] as const

/** The decision models the catalog lists now, or the built-in set when it cannot be read. */
export async function decisionModels(client: FacesClient): Promise<string[]> {
  try {
    const raw = (await client.get('/v1/models', {params: {kind: 'decision'}})) as Record<string, unknown>
    const rows = (Array.isArray(raw) ? raw : (raw.data ?? [])) as Array<{id?: unknown}>
    const ids = rows.map((m) => m.id).filter((id): id is string => typeof id === 'string')
    if (ids.length > 0) return ids
  } catch {
    // offline, or an older API: the built-in set
  }
  return [...DECISION_MODELS]
}

/** Which request shape `faces decide` sends: Jev's System One, or OpenAI's Decisions format. */
export const DECISION_FORMATS = ['systemone', 'openai'] as const

/**
 * The same request in OpenAI's Decisions format, for POST /v1/decisions:
 * `input` for the situation and `questions` as an array. A noul is a
 * predicate, a choice's options are `choices`, a score's levels `levels`.
 * Throws for what that format has no place for.
 */
export function toOpenAIDecision(
  model: string | undefined,
  state: unknown,
  questions: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {model, input: typeof state === 'string' ? state : JSON.stringify(state)}
  if (!questions) return body
  body.questions = Object.entries(questions).map(([name, raw]) => {
    const q = (raw ?? {}) as {type?: string; instructions?: string; criteria?: unknown}
    if (q.type === 'noul') {
      if (q.criteria && typeof q.criteria === 'object' && Object.keys(q.criteria).length > 0) {
        throw new Error(`The yes and no descriptions on '${name}' have no place in the OpenAI format. Leave them out, or use --format systemone.`)
      }
      return {type: 'predicate', name, instructions: q.instructions}
    }
    if (q.type === 'choice') {
      const c = (q.criteria ?? {}) as Record<string, unknown>
      return {
        type: 'choice',
        name,
        instructions: q.instructions,
        choices: Object.entries(c).map(([value, description]) => (description ? {value, description: String(description)} : {value})),
      }
    }
    if (q.type === 'score') {
      const levels = Array.isArray(q.criteria) ? q.criteria : []
      return {type: 'score', name, instructions: q.instructions, levels: levels.map((label) => ({label: String(label)}))}
    }
    throw new Error(`'${name}' has a type the OpenAI format does not take: ${String(q.type)}.`)
  })
  return body
}

/**
 * OpenAI-format answers (an array) in the shape {@link decisionLines} prints:
 * keyed by name, a predicate as a noul, probabilities keyed by option or level.
 * Score levels are labelled from the questions that were sent.
 */
export function fromOpenAIAnswers(answers: unknown, questions: Record<string, unknown> = {}): Record<string, unknown> {
  if (!Array.isArray(answers)) return {}
  const out: Record<string, unknown> = {}
  for (const raw of answers) {
    const a = (raw ?? {}) as Record<string, unknown>
    const name = String(a.name ?? `answer ${Object.keys(out).length + 1}`)
    const probs = Array.isArray(a.probabilities) ? (a.probabilities as Array<Record<string, unknown>>) : []
    if (a.type === 'predicate') {
      out[name] = {type: 'noul', noul: a.probability}
    } else if (a.type === 'choice') {
      out[name] = {type: 'choice', choice: a.choice, confidence: a.confidence, probabilities: Object.fromEntries(probs.map((p) => [String(p.value), p.probability]))}
    } else if (a.type === 'score') {
      const sent = (questions[name] as {criteria?: unknown} | undefined)?.criteria
      const labels = Array.isArray(sent) ? sent.map(String) : []
      out[name] = {
        type: 'score',
        score: a.score,
        confidence: a.confidence,
        probabilities: Object.fromEntries(probs.map((p, i) => [String(typeof p.level === 'number' ? p.level : i), p.probability])),
        legend: Object.fromEntries(labels.map((l, i) => [String(i), l])),
      }
    } else {
      out[name] = a
    }
  }
  return out
}

/** The most questions one request takes: fewer with a face, which reasons once per question. */
export const MAX_QUESTIONS = {face: 10, baseline: 32, openaiBaseline: 400}

/** Options a choice takes. */
export const CHOICE_OPTIONS = {min: 2, max: 255}

/**
 * What is wrong with these questions before they are sent, or undefined.
 * The server refuses the same, but only after a face has been asked to reason.
 */
export function questionsProblem(questions: Record<string, unknown>, withFace: boolean, openaiModel = false): string | undefined {
  const n = Object.keys(questions).length
  const max = withFace ? MAX_QUESTIONS.face : openaiModel ? MAX_QUESTIONS.openaiBaseline : MAX_QUESTIONS.baseline
  if (n > max) return `At most ${max} questions ${withFace ? 'with a face' : 'with --baseline'} (got ${n}). Split them across requests.`
  for (const [id, q] of Object.entries(questions)) {
    const o = q as {type?: unknown; criteria?: unknown} | null
    if (o?.type !== 'choice' || !o.criteria || typeof o.criteria !== 'object') continue
    const k = Array.isArray(o.criteria) ? o.criteria.length : Object.keys(o.criteria).length
    if (k < CHOICE_OPTIONS.min || k > CHOICE_OPTIONS.max) {
      return `The choice '${id}' has ${k} option(s); a choice takes ${CHOICE_OPTIONS.min} to ${CHOICE_OPTIONS.max}.`
    }
  }
  return undefined
}

/** The kinds of question a decision model answers: yes or no, pick one, or a place on a scale. */
export const QUESTION_TYPES = ['noul', 'choice', 'score'] as const

/**
 * One `--option` value: `name=description`, or a bare `name`.
 *
 * Split on the first `=`, because a description is a sentence and may well
 * contain one ("signs it = agrees"). A bare name is sent with no description
 * (null), which the API allows; the name then has to carry the meaning.
 */
export function parseDecisionOption(raw: string): {name: string; definition: string | null} | undefined {
  const at = raw.indexOf('=')
  const name = (at === -1 ? raw : raw.slice(0, at)).trim()
  if (!name) return undefined
  if (at === -1) return {name, definition: null}
  const definition = raw.slice(at + 1).trim()
  return {name, definition: definition || null}
}

function bar(p: number, barWidth: number): string {
  return '#'.repeat(Math.round(Math.min(Math.max(p, 0), 1) * barWidth))
}

function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`.padStart(6)
}

/** Probabilities as lines, most likely first, with a percentage and a bar. */
function probabilityLines(probabilities: Record<string, unknown>, label: (key: string) => string, barWidth: number): string[] {
  const entries = Object.entries(probabilities)
    .map(([key, p]) => [label(key), typeof p === 'number' ? p : Number.NaN] as const)
    .sort((a, b) => (Number.isNaN(b[1]) ? -1 : b[1]) - (Number.isNaN(a[1]) ? -1 : a[1]))
  const width = Math.max(...entries.map(([name]) => name.length))
  return entries.map(([name, p]) =>
    Number.isNaN(p) ? `  ${name.padEnd(width)}  -` : `  ${name.padEnd(width)}  ${pct(p)}  ${bar(p, barWidth)}`.trimEnd(),
  )
}

/**
 * The answers as lines: each question, what came back, and the probabilities
 * behind it, most likely first.
 *
 * The order is the reader's, not the server's. What a person asks of this is
 * "which one", and that is the top line. A probability is printed to one
 * decimal place, because 0.995 and 0.9999 are different answers and 100% is
 * not either of them. A score's levels are shown by their description, from
 * the legend, since "2" means nothing on its own.
 */
export function decisionLines(answers: Record<string, unknown>, barWidth = 20): string[] {
  const lines: string[] = []
  for (const [id, raw] of Object.entries(answers)) {
    if (lines.length > 0) lines.push('')
    const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const confidence = typeof a.confidence === 'number' ? `, confidence ${a.confidence.toFixed(2)}` : ''

    if (a.type === 'noul' && typeof a.noul === 'number') {
      lines.push(`${id}: yes ${(a.noul * 100).toFixed(1)}%`)
      lines.push(...probabilityLines({yes: a.noul, no: 1 - a.noul}, (k) => k, barWidth))
      continue
    }

    if (a.type === 'choice') {
      lines.push(`${id}: ${String(a.choice ?? '-')}${confidence}`)
      if (a.probabilities && typeof a.probabilities === 'object') {
        lines.push(...probabilityLines(a.probabilities as Record<string, unknown>, (k) => k, barWidth))
      }
      continue
    }

    if (a.type === 'score') {
      const legend = (a.legend && typeof a.legend === 'object' ? a.legend : {}) as Record<string, unknown>
      const top = Math.max(-1, ...Object.keys(legend).map(Number).filter((n) => !Number.isNaN(n)))
      const score = typeof a.score === 'number' ? a.score.toFixed(2) : '-'
      lines.push(`${id}: ${score}${top >= 0 ? ` on 0 to ${top}` : ''}${confidence}`)
      if (a.probabilities && typeof a.probabilities === 'object') {
        const label = (k: string) => (legend[k] === undefined ? k : `${k} ${String(legend[k])}`)
        lines.push(...probabilityLines(a.probabilities as Record<string, unknown>, label, barWidth))
      }
      continue
    }

    // A type this version does not know: show it rather than drop it.
    lines.push(id, `  ${JSON.stringify(raw)}`)
  }
  return lines
}

/**
 * Longest the CLI will spend waiting when the server names a wait, in
 * seconds, summed over every wait: a ceiling, so a server that keeps asking
 * for one cannot hold a caller forever.
 */
export const MAX_WARM_UP_WAIT_S = 300

/**
 * How long to wait before asking again, or undefined to stop.
 *
 * Only a 503 that carries `Retry-After` is waited out. Those are answered at
 * once, before any work, so waiting the number out and asking again costs
 * nothing, and the number is honoured exactly: sooner is pointless and later
 * is wasted time. A 503 without it is worth retrying too, but by the caller:
 * it may come after work was done, and with no number there is nothing to
 * wait for but a guess.
 */
export function warmUpWait(status: number, retryAfter: number | undefined, waitedS: number): number | undefined {
  if (status !== 503 || retryAfter === undefined) return undefined
  if (waitedS + retryAfter > MAX_WARM_UP_WAIT_S) return undefined
  return retryAfter
}

/** What `/v1/systemone` answers with, as far as the face's cause goes. */
export interface DecisionCauses {
  /** The face's cause: the first question's, or the whole of it for a face asked alone. */
  cause?: string
  /** One per question, keyed by question id, each read from the situation with that question in mind. */
  causes?: Record<string, unknown>
}

/**
 * The face's cause as lines, per question when the questions were asked
 * about apart.
 *
 * With several questions each has its own cause, and a question missing from
 * `causes` falls back to `cause`. When every one is the same text, as with a
 * single question, it is printed once rather than repeated under each id.
 */
export function causeLines(data: DecisionCauses, questionIds: string[]): string[] {
  const cause = typeof data.cause === 'string' ? data.cause : ''
  const per = questionIds.map((id) => {
    const c = data.causes?.[id]
    return [id, typeof c === 'string' && c !== '' ? c : cause] as const
  })
  if (per.length === 0 || per.every(([, c]) => c === cause)) return cause ? [cause] : []
  const lines: string[] = []
  for (const [id, c] of per) {
    if (!c) continue
    if (lines.length > 0) lines.push('')
    lines.push(`${id}:`, c)
  }
  return lines
}

/**
 * The refusal inside a held response, or undefined when the body is an answer.
 *
 * A decision that runs past about 40 seconds is held open: the server sends
 * 200 at once with `X-Faces-Held: 1`, keeps the connection alive with spaces,
 * and writes the JSON when it is done. A JSON parser skips the spaces. By the
 * time the call fails the 200 has gone, so the failure arrives as a body,
 * `{detail, error: {..., status}}`, with no `answers`, and a reader that went
 * straight to `answers` would print an empty decision as though it were one.
 */
export function heldDecisionError(data: unknown): FacesAPIError | undefined {
  if (!data || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  if (!d.error || typeof d.error !== 'object' || 'answers' in d || 'cause' in d) return undefined
  const e = d.error as Record<string, unknown>
  const n = Number(e.status)
  const status = Number.isInteger(n) && n >= 400 && n < 600 ? n : 502
  const said =
    readableDetail(d.detail) ?? (typeof e.message === 'string' && e.message.trim() ? e.message : undefined)
  const code = typeof e.code === 'string' ? e.code : typeof e.type === 'string' ? e.type : undefined
  return new FacesAPIError(status, said ?? 'The request failed after the server held it open.', {
    errorCode: code,
  })
}

/** The situation: text, or from a .json file whatever JSON it holds, since the API takes an object or array too. */
export function readStateFlags(flags: {state?: string; 'state-file'?: string}, fail: (message: string) => never): unknown {
  let state = flags.state
  const path = flags['state-file']
  if (path) {
    if (!fs.existsSync(path)) fail(`File not found: ${path}`)
    state = fs.readFileSync(path, 'utf8')
    if (path.toLowerCase().endsWith('.json')) {
      try {
        return JSON.parse(state)
      } catch (err) {
        fail(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  if (!state?.trim()) fail('Describe the situation with --state or --state-file.')
  return state
}

/** The questions to send, or undefined when none were asked, which with a face asks for its cause alone. */
export function readQuestionFlags(flags: {
  question?: string
  type?: string
  option?: string[]
  level?: string[]
  id?: string
  'questions-file'?: string
}, fail: (message: string) => never): Record<string, unknown> | undefined {
  if (flags['questions-file']) {
    const path = flags['questions-file']
    if (!fs.existsSync(path)) fail(`File not found: ${path}`)
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(path, 'utf8'))
    } catch (err) {
      fail(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
    // A whole request body is an easy thing to have lying around. Take its
    // questions rather than sending the body as a question called "model".
    if (parsed && typeof parsed === 'object' && 'questions' in parsed && 'state' in parsed) {
      parsed = (parsed as {questions: unknown}).questions
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
      fail(`${path} should hold an object of questions: {"<id>": {"type": "...", "instructions": "...", "criteria": ...}}`)
    }
    return parsed as Record<string, unknown>
  }

  if (!flags.question) return undefined

  const options = flags.option ?? []
  const levels = flags.level ?? []
  const type = flags.type ?? (options.length > 0 ? 'choice' : levels.length > 0 ? 'score' : 'noul')
  const question: Record<string, unknown> = {type, instructions: flags.question}

  if (type === 'choice') {
    const criteria: Record<string, string | null> = {}
    for (const raw of options) {
      const parsed = parseDecisionOption(raw)
      if (!parsed) fail(`--option '${raw}' names nothing. Use name="description", or a bare name.`)
      criteria[parsed.name] = parsed.definition
    }
    // The server wants two or more: with one, all of the probability goes
    // to it, an answer known before asking.
    if (Object.keys(criteria).length < 2) fail('A choice needs at least two --option values to choose between.')
    question.criteria = criteria
  } else if (type === 'score') {
    if (levels.length < 2 || levels.length > 10) {
      fail(`A score needs 2 to 10 --level values, lowest first (got ${levels.length}).`)
    }
    question.criteria = levels
  } else if (options.length > 0 || levels.length > 0) {
    fail('A noul is a yes or no and takes no --option or --level. Leave them out, or pick another --type.')
  }

  return {[flags.id ?? 'answer']: question}
}
