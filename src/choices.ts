import {parseModel} from './model.js'

/** POST /v1/choices: a face proposes the options it would weigh, or the question it would ask. */

export const CHOICES_PATH = '/v1/choices'

/** The maestros a choices model is written with, the default first. */
export {MAESTROS as CHOICES_MAESTROS} from './model.js'

/** The most options one request returns. */
export const MAX_CHOICES = 32

/** The most prose `state` takes, in tokens. */
export const MAX_STATE_TOKENS = 3000

export interface ChoicesResponse {
  object?: string
  /** The upstream model, `@alice:maestro-1`, as sent. */
  model?: string
  /** With `state_id` and a question, each option has an `id` (`opt_...`) to name in a `depends_on`. */
  choices?: Array<{id?: string; name?: string; description?: string; premise?: string}>
  /** With `state_id` and a question: the id (`cho_...`) of the options as added to the state. */
  choices_item?: string
  /** With `into`: the premise the options were written under, the kind of the edges, and the side node. */
  into?: {premise?: string; kind?: string; side_node?: string}
  warnings?: string[]
  question?: string
  alternatives?: string[]
  usage?: {input_tokens?: number; output_tokens?: number}
}

/** The face part of an upstream model: `@alice` from `@alice:maestro-1`. */
function faceOf(model?: string): string | undefined {
  return model ? parseModel(model).faces ?? model : undefined
}

/** A choices response as lines a person reads. */
export function choicesLines(data: ChoicesResponse): string[] {
  const lines: string[] = []
  if (data.object === 'choices.question') {
    lines.push(`${faceOf(data.model) ?? 'The face'} would ask: ${data.question ?? '-'}`)
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
      lines.push(`${i + 1}. ${c.name ?? '-'}${c.id ? `   [${c.id}]` : ''}`)
      if (c.description) lines.push(`   ${c.description}`)
      if (c.premise && c.premise !== c.name) lines.push(`   premise: ${c.premise}`)
    })
    if (data.into?.premise) {
      lines.push('', `Written into the state as premises that ${data.into.premise} rests on (${data.into.kind ?? 'or'} edges, ` +
        `side node ${data.into.side_node ?? '-'}). Weigh them: faces decide <model> --conversation <id> --weigh ` +
        `${JSON.stringify(data.into.premise)}`)
    } else if (data.choices_item) {
      lines.push('', `Added to the state as ${data.choices_item}. Name an option id (or ${data.choices_item} for all of them) ` +
        'in --premise-depends-on or decide --depends-on.')
    }
  }
  for (const w of data.warnings ?? []) lines.push('', `Warning: ${w}`)
  const u = data.usage
  if (u && (typeof u.input_tokens === 'number' || typeof u.output_tokens === 'number')) {
    lines.push('', `${data.model ?? 'model'}: ${(u.input_tokens ?? 0).toLocaleString('en-US')} input, ${(u.output_tokens ?? 0).toLocaleString('en-US')} output tokens`)
  }
  return lines
}

/** What to add to a choices refusal, or undefined when the server's message says it all. */
export function choicesHint(status: number, message: string, model: string): string | undefined {
  const face = (parseModel(model).faces ?? model).replace(/^@/, '').replace('~', ':')
  if (status === 422 && /at most 3,000/.test(message)) {
    return 'Put the situation in a state, one premise per fact (faces state:create, then faces state:add), and pass --state-id.'
  }
  if (status === 409 && /nothing compiled/i.test(message)) return `Give it a first source: faces compile:upload ${face} --file <file>.`
  if (status === 409 && /compiled before/i.test(message)) return `Recompile one of its sources (list them with: faces face:sources ${face}).`
  if (status === 422 && /depends_on` names no premise or decision/.test(message)) {
    return 'Name premise keys, decision ids and choices ids already in the state (faces state:items <id>).'
  }
  if (status === 404 && /state/i.test(message)) return 'A state expires 30 days after it was last used. Start another with: faces state:create'
  return undefined
}
