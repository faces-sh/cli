/**
 * `model`: the one parameter that names what answers, on every endpoint.
 *
 * An UPSTREAM model is ours: a face, or a composite of faces, with a maestro
 * (`@alice:maestro-1`). A DOWNSTREAM model is the model that generates the
 * answer (`gpt-5.4`, `jev-latest`). The `/` reads like a fraction, the
 * upstream model over the downstream one:
 *
 *   @alice:maestro-1                    faces choices (our model answers)
 *   @alice:maestro-1/gpt-5.4            chat, decide (a downstream model answers)
 *   @dana~alice:maestro-1/gpt-5.4       another account's face
 *   (@alice | @bob):maestro-1-flash     a composite
 *
 * The prefix is ours only when `:maestro-N` ends it before the first `/`.
 * Everything after that `/` is the downstream id, verbatim, so its own `/`,
 * `:` or `@` never matter (`google/gemma-4-31b-it`).
 *
 * The server checks the grammar and answers a 422 that shows the right form;
 * this only splits what it needs to route a request, and gives the hint a
 * person needs before anything is sent.
 */

/** The maestros, the default first. */
export const MAESTROS = ['maestro-1', 'maestro-1-flash'] as const
export const DEFAULT_MAESTRO = MAESTROS[0]

export interface ModelName {
  /** Our part, `@alice:maestro-1`, or undefined when there is none. */
  upstream?: string
  /** The face expression, `@alice` or `(@alice | @bob)`. */
  faces?: string
  maestro?: string
  /** The model after the first `/`, verbatim, or undefined. */
  downstream?: string
}

const MAESTRO_END = /:\s*(maestro-[^\s:/()@|&^~]*)\s*$/i

/** `model` taken apart, as far as the CLI needs it. Never throws: the server judges the grammar. */
export function parseModel(raw: string): ModelName {
  const s = raw.trim()
  const slash = s.indexOf('/')
  const prefix = slash >= 0 ? s.slice(0, slash) : s
  const m = MAESTRO_END.exec(prefix)
  if (!m || !/^[@(]/.test(prefix.trim())) return {downstream: s || undefined}
  const faces = prefix.slice(0, m.index).trim()
  return {
    upstream: `${faces}:${m[1]}`,
    faces,
    maestro: m[1],
    downstream: slash >= 0 ? s.slice(slash + 1).trim() || undefined : undefined,
  }
}

/** `alice` or `dana~alice` as a face in the grammar: `@alice`, `@dana~alice`. Anything already marked is left as it is. */
export function asFace(face: string): string {
  const f = face.trim()
  return /^[@(]/.test(f) ? f : `@${f}`
}

/**
 * What to say before sending a `model` that cannot be right, or undefined.
 * `needs` is what the command sends: the upstream model alone (choices), or
 * the upstream model over a downstream one (chat, decide).
 */
export function modelProblem(raw: string, needs: 'upstream' | 'both', example = 'gpt-5.4'): string | undefined {
  const s = raw.trim()
  if (!s) return 'Name the model: @<face>:maestro-1' + (needs === 'both' ? `/<model>, e.g. @alice:maestro-1/${example}` : ', e.g. @alice:maestro-1')
  const p = parseModel(s)
  if (!p.upstream) {
    // The old forms, each with the new one.
    const at = s.indexOf('@')
    if (at > 0 && !s.startsWith('(')) {
      const face = s.slice(0, at)
      const down = s.slice(at + 1)
      return `face@model is gone: write ${asFace(face)}:${DEFAULT_MAESTRO}${needs === 'both' ? `/${down}` : ''}`
    }
    if (/^[@(]/.test(s)) {
      const faces = s.split('/')[0].trim()
      const rest = s.includes('/') ? s.slice(s.indexOf('/') + 1) : needs === 'both' ? '<model>' : ''
      return `Name the maestro after the face: ${faces}:${DEFAULT_MAESTRO}${rest ? `/${rest}` : ''}`
    }
    if (/^[a-z0-9][a-z0-9~:-]*$/i.test(s) && !/^maestro-/i.test(s) && needs === 'upstream') {
      return `Write the face as ${asFace(s.replace(':', '~'))}:${DEFAULT_MAESTRO}`
    }
    if (needs === 'both' && /^[a-z0-9][a-z0-9-]*$/i.test(s)) {
      return `Add a face: @<face>:${DEFAULT_MAESTRO}/${s}, or, if ${s} is a face, @${s}:${DEFAULT_MAESTRO}/<model>`
    }
    return `Add a face: @<face>:${DEFAULT_MAESTRO}${needs === 'both' ? `/${s}` : ''}`
  }
  if (needs === 'upstream' && p.downstream) return `faces choices takes the upstream model alone, with no model after it: ${p.upstream}`
  if (needs === 'both' && !p.downstream) return `Name the model that answers after the maestro: ${p.upstream}/<model>, e.g. ${p.upstream}/${example}`
  return undefined
}
