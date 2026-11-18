/** POST /v1/choices: a face proposes the options it would weigh, or the question it would ask. */

export const CHOICES_PATH = '/v1/choices'

/** The choices models, the default first. */
export const CHOICES_MODELS = ['maestro-1', 'maestro-1-flash'] as const

/** The most options one request returns. */
export const MAX_CHOICES = 32

/** The most prose `state` takes, in tokens. */
export const MAX_STATE_TOKENS = 3000

export interface ChoicesResponse {
  object?: string
  view?: string
  model?: string
  version?: string
  choices?: Array<{name?: string; description?: string}>
  question?: string
  alternatives?: string[]
  usage?: {input_tokens?: number; output_tokens?: number}
}

/** A face as `view` takes it: `@alias`, whether or not the caller typed the `@`. */
export function asView(face: string): string {
  const f = face.trim()
  return f.startsWith('@') ? f : `@${f}`
}

/** A choices response as lines a person reads. */
export function choicesLines(data: ChoicesResponse): string[] {
  const lines: string[] = []
  if (data.object === 'choices.question') {
    lines.push(`${data.view ?? 'The face'} would ask: ${data.question ?? '-'}`)
    const alts = data.alternatives ?? []
    if (alts.length > 0) {
      lines.push('', 'Or:')
      for (const a of alts) lines.push(`  - ${a}`)
    }
    lines.push('', 'Ask it with --question to get the options.')
  } else {
    const choices = data.choices ?? []
    if (choices.length === 0) lines.push('No options.')
    choices.forEach((c, i) => {
      lines.push(`${i + 1}. ${c.name ?? '-'}`)
      if (c.description) lines.push(`   ${c.description}`)
    })
  }
  const u = data.usage
  if (u && (typeof u.input_tokens === 'number' || typeof u.output_tokens === 'number')) {
    lines.push('', `${data.model ?? 'model'}: ${(u.input_tokens ?? 0).toLocaleString('en-US')} input, ${(u.output_tokens ?? 0).toLocaleString('en-US')} output tokens`)
  }
  return lines
}

/** What to add to a choices refusal, or undefined when the server's message says it all. */
export function choicesHint(status: number, message: string, face: string): string | undefined {
  if (status === 422 && /at most 3,000/.test(message)) {
    return 'Put the situation in a state, one premise per fact (faces state:create, then faces state:add), and pass --state-id.'
  }
  if (status === 409 && /nothing compiled/i.test(message)) return `Give it a first source: faces compile:upload ${face.replace(/^@/, '')} --file <file>.`
  if (status === 409 && /compiled before/i.test(message)) return `Recompile one of its sources (list them with: faces face:sources ${face.replace(/^@/, '')}).`
  if (status === 404 && /state/i.test(message)) return 'A state expires 30 days after it was last used. Start another with: faces state:create'
  return undefined
}
