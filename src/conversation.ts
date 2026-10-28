import {Flags} from '@oclif/core'
import {FacesAPIError} from './client.js'

export const CONVERSATIONS_PATH = '/v1/conversations'

/** The most items one request to add to a conversation takes. */
export const MAX_CONVERSATION_ITEMS = 20

/** A premise key, as the API takes it. */
const PREMISE_KEY = /^[A-Za-z0-9_-]{1,64}$/

/** A conversation as the API returns it. */
export interface Conversation {
  object?: string
  id?: string
  model?: string | null
  turns?: number
  items?: number
  causes_visible?: boolean
  status?: string
  created_at?: string
  last_used_at?: string
  expires_at?: string
}

/** A premise as a request sends it. */
export interface Premise {
  key: string
  value: unknown
  description?: string
}

/** A key's current value, as the API returns it. */
export interface PremiseState {
  value?: unknown
  description?: string | null
}

export const CONVERSATION_FLAG_DESCRIPTION =
  'Add this turn to a conversation, by id (from faces conversation:create). Send only the new message: ' +
  'the conversation so far is read before it. A conversation opened with one face takes only that face.'

export const PREMISE_FLAG_DESCRIPTION =
  'A premise, as key=value (repeatable): a named fact the face\'s answers depend on, kept on the ' +
  'conversation. The key is 1 to 64 letters, digits, _ or -. The value is read as JSON when it is JSON ' +
  '(50000, true, null, ["a","b"], {"max":3}) and as text otherwise, so plan=annual is the text "annual". ' +
  'Quote it to keep a number as text: --premise \'code="007"\'. A newer value of a key replaces it from ' +
  'then on. A key used for the first time needs --premise-description.'

export const PREMISE_DESCRIPTION_FLAG_DESCRIPTION =
  'What a --premise means, in plain words, as key="text" (repeatable, one per key), e.g. ' +
  '--premise-description budget_usd="the most we can spend this year". Required the first time a key is ' +
  'used in a conversation, and kept after that.'

export const CAUSES_VISIBLE_TURN_FLAG_DESCRIPTION =
  'Whether the face reads the other faces\' causes on this turn, in a conversation with several faces. ' +
  'Leave it out to follow the conversation (see faces conversation:create --no-causes-visible).'

/**
 * --conversation, --premise, --premise-description and --causes-visible, for
 * every command that takes a turn. `suffix` is added to each description;
 * `exclusive` names flags none of them goes with.
 */
export function conversationTurnFlags(opts: {suffix?: string; exclusive?: string[]} = {}) {
  const d = (text: string) => (opts.suffix ? `${text} ${opts.suffix}` : text)
  const exclusive = opts.exclusive
  return {
    conversation: Flags.string({description: d(CONVERSATION_FLAG_DESCRIPTION), exclusive}),
    premise: Flags.string({description: d(`${PREMISE_FLAG_DESCRIPTION} Needs --conversation.`), multiple: true, exclusive}),
    'premise-description': Flags.string({description: d(PREMISE_DESCRIPTION_FLAG_DESCRIPTION), multiple: true, dependsOn: ['premise'], exclusive}),
    'causes-visible': Flags.boolean({description: d(`${CAUSES_VISIBLE_TURN_FLAG_DESCRIPTION} Needs --conversation.`), allowNo: true, exclusive}),
  }
}

/** The lines a conversation prints as. */
export function conversationLines(c: Conversation): string[] {
  const pairs: Array<[string, unknown]> = [
    ['conversation', c.id],
    ['face', c.model ?? (c.object === 'conversation' ? 'any of your faces' : undefined)],
    ['status', c.status],
    ['turns', c.turns],
    ['items', c.items],
    ['causes', c.causes_visible === undefined ? undefined : c.causes_visible ? 'each face reads the other faces\' causes' : 'each face reads its own only'],
    ['created', c.created_at],
    ['last used', c.last_used_at],
    ['expires', c.expires_at],
  ]
  return pairs.filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${`${k}:`.padEnd(14)}${v}`)
}

/** What to add to a conversation refusal, or undefined when the server's message says it all. */
export function conversationHint(err: FacesAPIError): string | undefined {
  if (err.statusCode === 404) {
    return 'A conversation expires 30 days after it was last used, and a closed one cannot be used. ' +
      'Start another with: faces conversation:create'
  }
  const fresh = err.statusCode === 422 ? /premise '([A-Za-z0-9_-]{1,64})' is new/.exec(err.message) : null
  if (fresh) return `Say what it means: --premise-description ${fresh[1]}="what it means, in plain words"`
  return undefined
}

/**
 * A premise value as typed: JSON when it is JSON, and the text itself otherwise.
 *
 * A number that JSON reads as infinite would go out as null, so it stays text.
 */
export function premiseValue(raw: string): unknown {
  if (raw.trim() === '') return raw
  try {
    const v = JSON.parse(raw) as unknown
    if (typeof v === 'number' && !Number.isFinite(v)) return raw
    return v
  } catch {
    return raw
  }
}

function splitPair(raw: string, flag: string, shape: string): [string, string] {
  const i = raw.indexOf('=')
  if (i <= 0) throw new Error(`${flag} takes ${shape} (got '${raw}').`)
  return [raw.slice(0, i).trim(), raw.slice(i + 1)]
}

function checkKey(key: string, flag: string): void {
  if (!PREMISE_KEY.test(key)) throw new Error(`${flag}: a premise key is 1 to 64 letters, digits, _ or - (got '${key}').`)
}

/**
 * --premise key=value and --premise-description key=text, as the API's list of
 * {key, value, description}. Throws with the sentence to show.
 *
 * Descriptions are matched by key, not by position: oclif does not keep the
 * order of two different flags, and a key is what the API matches on too.
 */
export function parsePremises(premises: string[] = [], descriptions: string[] = []): Premise[] {
  const out: Premise[] = []
  const seen = new Map<string, Premise>()
  for (const raw of premises) {
    const [key, value] = splitPair(raw, '--premise', 'key=value')
    checkKey(key, '--premise')
    if (seen.has(key)) throw new Error(`--premise sets '${key}' twice. Give each key once per request.`)
    const p: Premise = {key, value: premiseValue(value)}
    seen.set(key, p)
    out.push(p)
  }
  const described = new Set<string>()
  for (const raw of descriptions) {
    const [key, text] = splitPair(raw, '--premise-description', 'key="what it means"')
    checkKey(key, '--premise-description')
    const p = seen.get(key)
    if (!p) throw new Error(`--premise-description names '${key}', which no --premise sets. Add --premise ${key}=<value>.`)
    if (described.has(key)) throw new Error(`--premise-description describes '${key}' twice. Give one description per key.`)
    if (text.trim() === '') throw new Error(`--premise-description for '${key}' is empty. Say what it means, in plain words.`)
    described.add(key)
    p.description = text.trim()
  }
  return out
}

/**
 * The conversation fields of a turn (chat, decide, causes): `conversation`,
 * `premises` and `causes_visible`, when given. `session` is sent by
 * chatExtras; it is the old name for the same id and counts as one here.
 * Throws with the sentence to show.
 */
export function conversationFields(flags: {
  conversation?: string
  session?: string
  premise?: string[]
  'premise-description'?: string[]
  'causes-visible'?: boolean
}): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (flags.conversation && flags.session && flags.conversation !== flags.session) {
    throw new Error('--session is the old name for --conversation: pass one of them, not two different ids.')
  }
  const premises = parsePremises(flags.premise, flags['premise-description'])
  const inConversation = Boolean(flags.conversation || flags.session)
  if (!inConversation && (premises.length > 0 || flags['causes-visible'] !== undefined)) {
    throw new Error('Premises and --causes-visible belong to a conversation: add --conversation <id> (from faces conversation:create).')
  }
  if (flags.conversation) out.conversation = flags.conversation
  if (premises.length > 0) out.premises = premises
  if (flags['causes-visible'] !== undefined) out.causes_visible = flags['causes-visible']
  return out
}

/**
 * The items a client adds: its premises first, then its messages, so a
 * message is read with the premises sent alongside it already in force.
 */
export function clientItems(messages: string[] = [], premises: Premise[] = []): Array<Record<string, unknown>> {
  return [...premises.map((p) => ({...p})), ...messages.map((content) => ({type: 'message', role: 'user', content}))]
}

/** A value as it prints: JSON, so the text "50000" and the number 50000 read differently. */
export function shownValue(v: unknown): string {
  return v === undefined ? '-' : JSON.stringify(v)
}

/** The premises in force, one per line. */
export function premiseLines(premises: Record<string, PremiseState> | undefined): string[] {
  const entries = Object.entries(premises ?? {})
  if (entries.length === 0) return ['premises: none']
  const lines = ['premises:']
  for (const [key, p] of entries) {
    lines.push(`  ${key} = ${shownValue(p?.value)}${p?.description ? `   (${p.description})` : ''}`)
  }
  return lines
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' ? String((part as Record<string, unknown>).text ?? '') : String(part ?? '')))
      .join('')
  }
  return content === undefined || content === null ? '' : JSON.stringify(content)
}

function parsed(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string') return {}
  try {
    const v = JSON.parse(raw) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function questionText(q: Record<string, unknown>): string {
  return String(q.instructions ?? q.question ?? q.id ?? '?')
}

function choiceOf(out: Record<string, unknown>): string {
  if (out.choice !== undefined && out.choice !== null) return String(out.choice)
  const answer = out.answer
  if (answer && typeof answer === 'object') {
    const a = answer as Record<string, unknown>
    for (const k of ['choice', 'value', 'score', 'answer']) if (a[k] !== undefined && a[k] !== null) return String(a[k])
  }
  return answer === undefined || answer === null ? '-' : String(answer)
}

/**
 * A conversation's items as lines a person reads: each message, decision and
 * premise once, in order. A decision or premise is two items (the call and
 * its output), printed together at the output, under the output's id.
 */
export function itemLines(items: Array<Record<string, unknown>>): string[] {
  const calls = new Map<string, Record<string, unknown>>()
  const lines: string[] = []
  for (const it of items) {
    const id = String(it.id ?? '')
    const head = id ? `${id.padEnd(7)}` : ''
    const pad = ' '.repeat(head.length)
    if (it.type === 'function_call') {
      calls.set(String(it.call_id ?? ''), it)
      continue
    }
    if (it.type === 'function_call_output') {
      const call = calls.get(String(it.call_id ?? ''))
      const out = parsed(it.output)
      if (call?.name === 'premise') {
        const key = String(parsed(call.arguments).key ?? '?')
        const desc = typeof out.description === 'string' && out.description ? `   (${out.description})` : ''
        lines.push(`${head}premise  ${key} = ${shownValue(out.value)}${desc}`)
      } else if (call?.name === 'decision') {
        const who = String(it.face ?? call.face ?? 'face')
        const model = it.model ?? call.model
        lines.push(`${head}${who}${model ? ` (${model})` : ''} decided: ${questionText(parsed(call.arguments))} -> ${choiceOf(out)}`)
        if (typeof out.cause === 'string' && out.cause) lines.push(`${pad}cause: ${out.cause}`)
      } else {
        lines.push(`${head}${String(call?.name ?? 'output')}: ${typeof it.output === 'string' ? it.output : JSON.stringify(it.output)}`)
      }
      continue
    }
    if (it.type === 'message' || it.role !== undefined) {
      const who = it.role === 'user' ? 'you' : `${String(it.name ?? it.role ?? '?')}${it.model ? ` (${it.model})` : ''}`
      const text = textOf(it.content)
      const cause = typeof it.cause === 'string' && it.cause ? it.cause : ''
      // A turn that asked for the cause alone has no reply, only the cause.
      if (!text && cause) {
        lines.push(`${head}${who}'s cause: ${cause}`)
        continue
      }
      lines.push(`${head}${who}: ${text}`)
      if (cause) lines.push(`${pad}cause: ${cause}`)
      continue
    }
    lines.push(`${head}${String(it.type ?? 'item')}`)
  }
  return lines
}

/** An earlier decision made while a changed key held another value, as the API lists it. */
export interface StaleDecision {
  call_id?: string
  question?: Record<string, unknown>
  choice?: unknown
  face?: string
  changed?: Record<string, {was?: unknown; now?: unknown}>
}

/** decisions_made_under_old_values, as lines; none when the list is empty. */
export function staleDecisionLines(stale: StaleDecision[] | undefined): string[] {
  if (!stale || stale.length === 0) return []
  const lines = [
    `${stale.length === 1 ? '1 earlier decision was' : `${stale.length} earlier decisions were`} made under a value you just changed. Nothing was decided again:`,
  ]
  for (const d of stale) {
    const q = d.question ? questionText(d.question) : '?'
    const choice = d.choice === undefined || d.choice === null ? '-' : String(d.choice)
    lines.push(`  ${d.face ?? 'face'}: ${q} -> ${choice}${d.call_id ? `   [${d.call_id}]` : ''}`)
    for (const [key, c] of Object.entries(d.changed ?? {})) {
      lines.push(`    ${key}: was ${shownValue(c?.was)}, now ${shownValue(c?.now)}`)
    }
  }
  return lines
}
