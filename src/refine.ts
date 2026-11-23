/**
 * premise:refine, premise:choices and premise:decide: a fixed loop of billed calls to
 * /v1/choices and /v1/decisions, writing into the state through its CRUD routes. /v1/states
 * itself calls no model.
 *
 * The loop (keep its order and texts as they are unless a change is measured):
 *   what it needs: a decision judges whether the premise needs AND (conditions that must all
 *       hold), OR (its meanings), a single test, or the human;
 *   AND the face proposes the conditions (shown the premise, not its children); a proposal is
 *       kept only if it passes BOTH judges, necessity and the gate (predicates on clef); then
 *       the server's duplicate matcher writes what was kept; the gap check proposes what the
 *       listed conditions leave out, judged the same way, at most 3 rounds; each new sub-goal
 *       that only the human can settle awaits them, with a question for them;
 *   OR  the face proposes the meanings, written as candidates; a decision ranks them (p). With
 *       no clear winner the premise awaits the human, with a question for them;
 *   test one test that settles it, unless a test already under it says the same; its "Reads:"
 *       names become its inputs, each matched to a premise by meaning;
 *   recheck a goal whose value was rewritten (its refinement reset to incomplete): each AND
 *       sub-goal is checked against the new value, and one it no longer needs is cut (deleted
 *       when nothing else rests on it); then the gap check.
 */
import {FacesAPIError, FacesClient} from './client.js'
import {CONVERSATIONS_PATH} from './conversation.js'
import {seg} from './utils.js'

// ---- the texts ---------------------------------------------------

/** AND-refinement: the conditions that together make it true. */
export const AND = 'Before anything is done, "{P}" has to be broken into the conditions that together make ' +
  'it true, and the choice here is which conditions to require. Propose each condition as an ' +
  'option, written as "It holds only if: <a statement that is true or false of the finished ' +
  'work>". Each must be needed: if it were false, "{P}" would be false. No two conditions ' +
  'may be the same condition reworded, and none may be "{P}" in other words.'
export const AND_LEAD = 'It holds only if:'

/** OR-refinement: the meanings it could be taken in. */
export const OR = 'Before anything is done, the words "{P}" have to be pinned to one meaning, and the choice ' +
  'here is which meaning to take them in. Propose each meaning they could be taken in as an ' +
  'option, written as "Take it to mean: <a statement that is true or false of the finished ' +
  'work>". Any two meanings must disagree about some concrete case.'
export const OR_LEAD = 'Take it to mean:'

/** The two judges, predicates on clef. */
export const NEEDED = 'Is "{k}: {v}" needed for "{P}"? It is needed if "{P}" would be false without it.'
export const GATE = 'Is "{k}: {v}" a condition on the finished work that covers only part of what "{P}" ' +
  'requires, rather than a step to take or "{P}" in other words?'
export const GAP_ROUNDS = 3

/** Sufficiency, by finding a gap. */
export const GAP_PROPOSE = 'The conditions already listed under "{P}" are required. Before anything is done, ' +
  'the choice here is whether they leave out a condition that "{P}" also needs. ' +
  'Propose each condition they leave out, as an option, written as "It holds only ' +
  'if: <a statement that is true or false of the finished work>". Each must be ' +
  'needed: if it were false, "{P}" would be false even with every listed condition ' +
  'true. None may be a listed condition reworded, and none may be "{P}" in other ' +
  'words.'
export const GAP_MAX = 4

/** What the premise needs. */
export const KIND = 'Before anything is done, "{P}" has to be settled, and the choice here is how it will be settled.'
export const KIND_OPTIONS: Array<[Kind, string, string]> = [
  ['and', 'split it into conditions',
    'Its meaning is clear, but it holds only if several separate things are all true of the ' +
    'finished work.'],
  ['or', 'pin it to one meaning',
    'Its words leave open what exactly would make it true (which cases count, how it is ' +
    'measured, how much is enough), and the possible meanings would change the finished work; ' +
    'they can be listed and one chosen.'],
  ['test', 'one test settles it',
    'It is already precise: one check, true or false of the finished work, settles it.'],
  ['human', 'ask the human',
    'It is about a person\'s own response (whether they accept, like, approve or agree), which ' +
    'no meaning of the words and no check of the work can settle.'],
]

/** The one test that settles a premise. */
export const TEST = 'Before anything is done, "{P}" has to be settled by one test run on the finished work. ' +
  'Propose the test as an option, written as "Passes only if: <a statement that is true or ' +
  'false of the finished work>. Reads: <the items or data it checks, by name>."'
export const TEST_LEAD = 'Passes only if:'

/** The question an await puts. */
export const AWAIT_QUESTION = 'Before anything is done, "{P}" has to be settled by asking {who}, because only ' +
  'they, or someone they can ask, know whether it holds. The choice here is which ' +
  'question to put to {who}. Propose each question as an option, written as "Ask ' +
  '{who}: <one question, ending with a question mark, about this case>, because ' +
  '<why their answer is needed>". Each must be a question {who} can answer, and ' +
  'its answer must settle "{P}".'
export const AWAIT_MAX = 2
export const WHO = 'the human'

/** A rewritten goal's sub-goal, checked again: below 0.5 it is no longer needed. */
export const RECHECK = 'The premise "{P}" was rewritten and now reads: "{new}". Is "{k}: {v}" still a condition ' +
  'it needs, as it now reads?'

/** Appended to every question whose options become keys: a short name per
 * option, the full statement in its description. Not part of the measured texts above. */
export const NAME_LINE = 'Name each option by what it is, in a few words (e.g. the dishes themselves), and put the full statement in its description.'
export function named(question: string): string {
  return `${question}\n${NAME_LINE}`
}

/** Is a proposal the same condition as a premise elsewhere in the state? */
export const SAME = 'Is "{a}" the same condition as "{b}"?'

export const AT = 0.5
/** No clear winner among the candidates: the top p below this, or a lead under CLEAR_MARGIN. */
export const CLEAR_P = 0.6
export const CLEAR_MARGIN = 0.2
/** The duplicate matcher's bar (choices.SIMILAR_AT), for "Reads:" names and a repeated test. */
export const SIMILAR_AT = 0.85
export const DECISION_MODEL = process.env.FACES_REFINE_DECISION_MODEL?.trim() || 'jev-latest'
export const CONDITION_MODEL = process.env.FACES_REFINE_CONDITION_MODEL?.trim() || 'clef'
const MAX_PREDICATES = 10

export type Kind = 'and' | 'or' | 'test' | 'human'
export type Option = {name: string; description: string}

export function fill(t: string, vars: Record<string, string>): string {
  return t.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m))
}

// ---- pure helpers ---------------------------------------------------------------------------

/** `text` without the lead our own question prescribed for it, case aside, the colon optional,
 * the quotes around it dropped when the lead came inside them. */
export function stripLead(text: string, lead: string): string {
  const esc = lead.replace(/:$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`^\\s*(["“]?)\\s*${esc}(?:\\s*:\\s*|\\s+)`, 'i').exec(text)
  if (!m) return text
  let rest = text.slice(m[0].length)
  if (m[1] && /["”]\s*$/.test(rest)) rest = rest.trimEnd().slice(0, -1)
  return rest.trim() || text
}

/** A premise key from a proposal's own words: one line, at most 120 characters cut at a word. */
export function plainKey(text: string, limit = 120): string {
  // eslint-disable-next-line no-control-regex
  let t = text.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim()
  if (t.length > limit) {
    const cut = t.slice(0, limit + 1)
    const at = cut.lastIndexOf(' ')
    t = at > limit / 3 ? cut.slice(0, at) : t.slice(0, limit)
  }
  t = t.replace(/[\s,;:.\-–—]+$/, '').trim()
  // a cut never leaves a parenthesis open: drop the unclosed part
  while ((t.match(/\(/g) ?? []).length > (t.match(/\)/g) ?? []).length) {
    t = t.slice(0, t.lastIndexOf('(')).replace(/[\s,;:.\-–—]+$/, '').trim()
  }
  return t
}

/** Each option with its lead taken off and, when it was written in our form, named by its
 * statement rather than the writer's short label. */
export function stripOptions(opts: Option[], lead = ''): Option[] {
  const base = (n: string) => norm(n).replace(/\s+\d+$/, '')
  const count = new Map<string, number>()
  for (const o of opts) count.set(base(o.name ?? ''), (count.get(base(o.name ?? '')) ?? 0) + 1)
  return opts.map((o) => {
    const bare = lead ? stripLead(o.description ?? o.name, lead) : (o.description ?? o.name)
    const name = plainKey(lead ? stripLead(o.name ?? '', lead) : (o.name ?? ''))
    // keyed by the face's short name for it (NAME_LINE asks for one) when that name is this
    // option's alone; a name several options share ("Safe menu 1", "Safe menu 2") says nothing
    // of what each is, so those are keyed by their statement, cut at a word boundary
    const own = name && count.get(base(o.name ?? '')) === 1
    return {name: (own ? name : plainKey(String(bare ?? '').replace(/\.$/, ''))) || name, description: bare}
  })
}

/** The test's statement (before "Reads:") and the names on its "Reads:" line. */
export function readsOf(definition: string): {statement: string; reads: string[]} {
  const [head, tail] = definition.split(/\bReads:/, 2)
  const statement = head.trim().replace(/\.$/, '').trim()
  if (tail === undefined) return {statement, reads: []}
  const reads = tail.replace(/\.\s*$/, '').split(/\s*[,;]\s*/)
    .map((x) => x.trim().replace(/^and\s+/, '').replace(/^["“]|["”]$/g, '').replace(/\.$/, '').trim())
    .filter(Boolean)
  return {statement, reads}
}

/** A question option as the question itself: "Ask the human: <q>?, because <why>" -> <q>?. */
export function asked(o: Option): string {
  // "Ask the human: <q>?, because ..." as the question prompt asks, or the question alone, quoted or not
  const re = /^\s*(?:Ask [^:,]{1,60}[:,]\s*)?["“‘']?(.+?\?)["”’']?(?:\s*,?\s*because\b[\s\S]*)?\s*$/
  for (const t of [o.description, o.name]) {
    const m = re.exec(t ?? '')
    if (m) return m[1].trim()
  }
  return (o.description || o.name || '').trim()
}

/** The judge's question on one condition: `"{k}: {v}"`, or the statement alone when the key is
 * the statement. */
export function condition(template: string, p: string, o: Option): string {
  const same = norm(o.name) === norm(o.description.replace(/[.\s]+$/, ''))
  return same ? fill(template.replace('"{k}: {v}"', '"{v}"'), {P: p, v: o.description})
    : fill(template, {P: p, k: o.name, v: o.description})
}

function norm(x: string): string {
  return x.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Is one candidate clearly ahead? (top p at least CLEAR_P, ahead of the next by CLEAR_MARGIN) */
export function clearWinner(probs: Record<string, number>): string | undefined {
  const order = Object.keys(probs).sort((a, b) => probs[b] - probs[a])
  if (order.length === 0) return undefined
  const top = probs[order[0]]
  const next = order.length > 1 ? probs[order[1]] : 0
  return top >= CLEAR_P - 1e-9 && top - next >= CLEAR_MARGIN - 1e-9 ? order[0] : undefined
}

// ---- the calls ------------------------------------------------------------------------------

export type Premise = {
  key: string; number: string | null; value: unknown; role: string | null; origin: string | null;
  status: string; truth: string; op: string | null; children: string[]; on: string[];
  refinement: string | null; await: string | null
  messages?: Array<{kind: string | null; author: string}>
}

/** Every call the loop makes, and what it wrote; `log` gets one line per step. */
export class Loop {
  calls = 0
  usage = {input_tokens: 0, output_tokens: 0}
  constructor(
    readonly client: FacesClient, readonly sid: string, readonly face: string,
    readonly as?: string, readonly log: (line: string) => void = () => {},
  ) {}

  private state(route: string): string {
    return `${CONVERSATIONS_PATH}/${seg(this.sid)}${route}`
  }

  async send(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', p: string,
    opts: {body?: Record<string, unknown>; params?: Record<string, string>} = {}): Promise<Record<string, unknown>> {
    const got = await this.client.stateReply(method, p, opts)
    if (!got.ok) throw new FacesAPIError(got.status, String(got.data.error ?? got.data.text ?? 'refused'))
    const u = got.data.usage as {input_tokens?: number; output_tokens?: number} | undefined
    if (u && (p === '/v1/choices' || p === '/v1/decisions')) {
      if ((u.input_tokens ?? 0) + (u.output_tokens ?? 0) > 0) this.calls++
      this.usage.input_tokens += u.input_tokens ?? 0
      this.usage.output_tokens += u.output_tokens ?? 0
    }
    return got.data
  }

  async premises(): Promise<Record<string, Premise>> {
    const d = await this.send('GET', this.state('/proof'), {params: {format: 'json', all: 'true'}})
    const out: Record<string, Premise> = {}
    for (const p of (d.premises as Premise[]) ?? []) out[p.key] = p
    return out
  }

  /** The face's options for `key`, its children hidden from it (`premise`), or with `see` the
   * state shown whole around `key` (the gap check must see what is already listed). */
  async propose(key: string, question: string | undefined, max?: number, see = false): Promise<Option[]> {
    const body: Record<string, unknown> = {model: `${this.face}:maestro-1`, state_id: this.sid}
    if (see) body.depends_on = [key]
    else body.premise = key
    if (question) body.instructions = question
    if (max) body.max_choices = max
    const d = await this.send('POST', '/v1/choices', {body})
    return ((d.choices as Option[]) ?? []).map((c) => ({name: c.name, description: c.description}))
  }

  /** The face's own question for `key` (no question asked). */
  async ownQuestion(key: string): Promise<string> {
    const d = await this.send('POST', '/v1/choices', {body: {model: `${this.face}:maestro-1`, state_id: this.sid, premise: key}})
    return String(d.question ?? '')
  }

  async write(into: string, kind: 'and' | 'or', options: Option[]): Promise<{new: string[]; matched: string[]}> {
    if (options.length === 0) return {new: [], matched: []}
    // an option that says what another says, or what a child already there says, is that one
    // under another name: it is matched, not written (the server's check reads the name too, so
    // a short name of its own would let a copy through)
    const P = await this.premises()
    const said = new Map<string, string>()
    for (const c of P[into]?.children ?? []) if (P[c]) said.set(norm(String(P[c].value ?? '')).replace(/[.\s]+$/, ''), c)
    const send: Option[] = []
    const copies: string[] = []
    for (const o of options) {
      const t = norm(o.description ?? '').replace(/[.\s]+$/, '')
      const was = t ? said.get(t) : undefined
      if (was !== undefined) { copies.push(was); continue }
      if (t) said.set(t, o.name)
      send.push(o)
    }
    if (send.length === 0) return {new: [], matched: copies}
    const out = await this.sameElsewhere(into, send, P)
    const d = await this.send('POST', '/v1/choices', {body: {state_id: this.sid, into, kind, options: out, ...(this.as ? {as: this.as} : {})}})
    for (const k of (d.linked as string[]) ?? []) {
      const p = this.sameP.get(k)
      this.log(`"${k}" already exists; linked it under "${into}"${p === undefined ? '' : ` (the same condition, p ${round(p)})`}.`)
    }
    for (const r of (d.refused as Array<{key: string; why: string}>) ?? []) this.log(`"${r.key}" already exists, and was not linked under "${into}": ${r.why}.`)
    return {new: (d.new as string[]) ?? [], matched: [...copies, ...((d.matched as string[]) ?? [])]}
  }

  /** The p of each same-condition decision that turned an option into a link, by the key linked. */
  sameP = new Map<string, number>()

  /** State-wide duplicates: an option near a premise outside the target's
   * children (the state search, at SIMILAR_AT) goes to a billed decision, "is it the same
   * condition?", on clef; on a yes the option is sent as that premise's exact text, which the
   * server links under the target instead of writing a copy. Among siblings the server's own
   * matcher decides, as before. */
  async sameElsewhere(into: string, options: Option[], P: Record<string, Premise>): Promise<Option[]> {
    const siblings = new Set(P[into]?.children ?? [])
    const above = new Set<string>([into])
    const todo = [into]
    while (todo.length) {
      const x = todo.pop() as string
      for (const [k, p] of Object.entries(P)) if (p.children.includes(x) && !above.has(k)) { above.add(k); todo.push(k) }
    }
    const out: Option[] = []
    for (const o of options) {
      const hits = (await this.search(`${o.name}: ${o.description}`))
        .filter(([k, s]) => s >= SIMILAR_AT && !siblings.has(k) && !above.has(k) && P[k])
      let same: string | undefined
      for (const [k] of hits.slice(0, 3)) {
        const [p] = await this.predicates([fill(SAME, {a: `${o.name}: ${o.description}`, b: `${k}: ${String(P[k].value ?? '')}`})],
          [into, k], `${this.face}:maestro-1/${CONDITION_MODEL}`)
        if (p >= AT) { same = k; this.sameP.set(k, p); break }
      }
      out.push(same ? {name: same, description: String(P[same].value ?? '')} : o)
    }
    return out
  }

  async decide(questions: Array<Record<string, unknown>>, dependsOn: string[], model?: string): Promise<Array<Record<string, unknown>>> {
    const d = await this.send('POST', '/v1/decisions', {body: {
      model: model ?? `${this.face}:maestro-1/${DECISION_MODEL}`, conversation: this.sid, questions, depends_on: dependsOn}})
    return (d.answers as Array<Record<string, unknown>>) ?? []
  }

  async predicates(texts: string[], dependsOn: string[], model?: string): Promise<number[]> {
    const out: number[] = []
    for (let i = 0; i < texts.length; i += MAX_PREDICATES) {
      const part = texts.slice(i, i + MAX_PREDICATES)
      const ans = await this.decide(part.map((t, j) => ({type: 'predicate', name: `q${i + j}`, instructions: t})), dependsOn, model)
      for (let j = 0; j < part.length; j++) {
        const a = ans.find((x) => x.name === `q${i + j}`)
        if (!a || a.type === 'refusal') throw new FacesAPIError(503, `the decision model gave no answer to q${i + j}; retry`)
        out.push(Number(a.probability ?? 0))
      }
    }
    return out
  }

  async choice(name: string, instructions: string, values: Array<[string, string]>, dependsOn: string[]): Promise<Record<string, number>> {
    const ans = await this.decide([{type: 'choice', name, instructions,
      choices: values.map(([value, description]) => ({value, description: description.slice(0, 1000)}))}], dependsOn)
    const a = ans.find((x) => x.name === name)
    if (!a || a.type === 'refusal') throw new FacesAPIError(503, `the decision model gave no answer to ${name}; retry`)
    const probs: Record<string, number> = {}
    for (const p of (a.probabilities as Array<{value: string; probability: number}>) ?? []) probs[p.value] = Number(p.probability)
    return probs
  }

  /** What the premise needs, and its p. */
  async kind(key: string): Promise<[Kind, number]> {
    const probs = await this.choice('kind', fill(KIND, {P: key}), KIND_OPTIONS.map(([, v, d]) => [v, d]), [key])
    const best = Object.keys(probs).sort((a, b) => probs[b] - probs[a])[0]
    const k = KIND_OPTIONS.find(([, v]) => v === best)
    if (!k) throw new FacesAPIError(503, `the decision model chose no refinement for "${key}"; retry`)
    return [k[0], probs[best]]
  }

  /** Each proposal through both judges. -> [kept, dropped names]. */
  async judged(key: string, opts: Option[]): Promise<[Option[], string[]]> {
    if (opts.length === 0) return [[], []]
    const texts = opts.flatMap((o) => [condition(NEEDED, key, o), condition(GATE, key, o)])
    const ps = await this.predicates(texts, [key], `${this.face}:maestro-1/${CONDITION_MODEL}`)
    const kept = opts.filter((_o, i) => Math.min(ps[2 * i], ps[2 * i + 1]) >= AT)
    return [kept, opts.filter((o) => !kept.includes(o)).map((o) => o.name)]
  }

  /** The questions to put to the human, and a decision picks one. */
  async question(key: string, also: string[] = []): Promise<string> {
    const q = fill(AWAIT_QUESTION, {P: key, who: WHO})
    const deps = [key, ...also]
    const d = await this.send('POST', '/v1/choices', {body: {model: `${this.face}:maestro-1`, state_id: this.sid,
      depends_on: deps, instructions: q, max_choices: AWAIT_MAX}})
    const opts = ((d.choices as Option[]) ?? [])
    if (opts.length === 0) throw new FacesAPIError(503, `the face proposed no question about "${key}"; retry`)
    let best = opts[0]
    if (opts.length > 1) {
      const probs = await this.choice('question', q, opts.map((o) => [o.name, o.description ?? '']), deps)
      best = opts.reduce((a, b) => ((probs[b.name] ?? 0) > (probs[a.name] ?? 0) ? b : a))
    }
    return asked(best)
  }

  async edit(key: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.send('PATCH', this.state('/premises'), {body: {key, ...body, ...(this.as ? {as: this.as} : {})}})
  }

  async add(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.send('POST', this.state('/premises'), {body: {...body, ...(this.as ? {as: this.as} : {})}})
  }

  /** The premises that best match `text`, by meaning: [[key, score]], best first. */
  async search(text: string, within?: string): Promise<Array<[string, number]>> {
    const d = within
      ? await this.send('GET', this.state('/premise'), {params: {key: within, query: text, format: 'json'}})
      : await this.send('GET', this.state('/proof'), {params: {query: text, format: 'json'}})
    return ((d.matches as Array<{key: string; score: number}>) ?? []).map((m) => [m.key, m.score])
  }

  async awaitHuman(key: string, also: string[] = []): Promise<string> {
    const q = await this.question(key, also)
    await this.edit(key, {await: 'human', note: q})
    return q
  }

  async weigh(key: string): Promise<Record<string, number>> {
    const d = await this.send('POST', '/v1/decisions', {body: {model: `${this.face}:maestro-1/${DECISION_MODEL}`,
      conversation: this.sid, weigh: {premise: key, kind: 'or', ...(this.as ? {as: this.as} : {})}}})
    const w = (d.weigh as {edges?: Array<{id: string; p: number}>; written?: boolean; reason?: string}) ?? {}
    if (!w.written) throw new FacesAPIError(503, `the ranking was not written: ${w.reason ?? 'retry'}`)
    return Object.fromEntries((w.edges ?? []).map((e) => [e.id, e.p]))
  }
}

// ---- the refine loop ------------------------------------------------------------------------

/** premise:refine: -> the lines it reports. Throws FacesAPIError on a refusal. */
export async function refine(L: Loop, key: string): Promise<string[]> {
  const P = await L.premises()
  const n = P[key]
  if (!n) throw new FacesAPIError(404, `no premise "${key}" in this state`)
  if (n.role === 'test') throw new FacesAPIError(422, `"${key}" is a test: it is a leaf, settled by its runs (premise:edit --status --tested)`)
  if (n.role === null && n.origin === 'human') throw new FacesAPIError(422, `"${key}" is the human's word, an axiom: nothing refines it`)
  if (n.refinement === 'incomplete' && n.op === 'and' && n.children.length > 0) return recheck(L, key, P)
  // a premise already refined one way keeps its one operator: no needs decision, the same kind again
  if (n.op === 'and') return refineAnd(L, key)
  if (n.op === 'or') return refineOr(L, key)
  const [kind, p] = await L.kind(key)
  L.log(`"${key}" needs ${({and: 'an AND-refinement', or: 'an OR-refinement', test: 'one test', human: 'the human'})[kind]} (p ${round(p)}).`)
  if (kind === 'and') return refineAnd(L, key)
  if (kind === 'or') return refineOr(L, key)
  if (kind === 'test') return refineTest(L, key, P)
  const q = await L.awaitHuman(key)
  return [`Only the human can settle "${key}": it awaits their answer to: ${q}`]
}

function round(p: number): string {
  return String(Math.round(p * 100) / 100)
}

async function refineAnd(L: Loop, key: string): Promise<string[]> {
  const out: string[] = []
  const opts = stripOptions(await L.propose(key, named(fill(AND, {P: key}))), AND_LEAD)
  const [kept, dropped] = await L.judged(key, opts)
  const w = await L.write(key, 'and', kept)
  out.push(`The face proposed ${opts.length} condition(s); ${kept.length} passed both judges.` +
    (dropped.length ? ` Not written: ${dropped.map((d) => `"${d}"`).join(', ')}.` : '') +
    (w.matched.length ? ` Matched one already there: ${w.matched.map((d) => `"${d}"`).join(', ')}.` : ''))
  const gap = await gapLoop(L, key)
  out.push(...gap.lines)
  for (const c of [...w.new, ...gap.added]) {
    const [ck, cp] = await L.kind(c)
    if (ck === 'human') {
      const q = await L.awaitHuman(c)
      out.push(`Only the human can settle "${c}" (p ${round(cp)}): it awaits their answer to: ${q}`)
    } else if (ck === 'or') {
      out.push(`"${c}" needs alternatives (premise:refine "${c}").`)
    }
  }
  if (gap.empty) return out
  out.push(gap.sufficient ? `Together they are sufficient for "${key}".`
    : `After ${GAP_ROUNDS} rounds the gap check still finds conditions they leave out: its refinement is incomplete.`)
  return out
}

/** The gap check, under the two judges: what the listed conditions leave out, judged, written, until
 * a round adds nothing (at most GAP_ROUNDS); it records the refinement. */
async function gapLoop(L: Loop, key: string): Promise<{added: string[]; sufficient: boolean; lines: string[]; empty?: boolean}> {
  const added: string[] = []
  const lines: string[] = []
  let sufficient = false
  for (let round = 1; round <= GAP_ROUNDS; round++) {
    const gaps = stripOptions(await L.propose(key, named(fill(GAP_PROPOSE, {P: key})), GAP_MAX, true), AND_LEAD)
    const [passing] = await L.judged(key, gaps)
    if (passing.length === 0) { sufficient = true; break }
    const more = await L.write(key, 'and', passing)
    if (more.new.length === 0) { sufficient = true; break }
    lines.push(`The gap check added ${more.new.map((d) => `"${d}"`).join(', ')}.`)
    added.push(...more.new)
  }
  if ((await L.premises())[key]?.children.length === 0) {
    // nothing passed: there is no refinement to call sufficient
    lines.push(`No condition passed both judges, so "${key}" has no refinement; nothing was recorded.`)
    return {added, sufficient: false, lines, empty: true}
  }
  await L.edit(key, {refinement: sufficient ? 'complete' : 'incomplete', refined_by: 'refine'})
  return {added, sufficient, lines}
}

async function refineOr(L: Loop, key: string): Promise<string[]> {
  const out: string[] = []
  const opts = stripOptions(await L.propose(key, named(fill(OR, {P: key}))), OR_LEAD)
  const w = await L.write(key, 'or', opts)
  out.push(`Wrote ${w.new.length} candidate(s) under "${key}"` + (w.matched.length ? `; ${w.matched.length} matched one already there.` : '.'))
  await L.edit(key, {refinement: 'complete', refined_by: 'refine'})
  const P = await L.premises()
  if (P[key].children.length < 2) return out
  out.push(...(await rank(L, key, true)))
  return out
}

/** A decision ranks the candidates: the top one is next to try, and its tests settle it. With
 * `awaitOnTie` (refine's meanings, where which meaning is meant is the human's to say), no clear winner
 * makes the premise await the human. */
export async function rank(L: Loop, key: string, awaitOnTie = false): Promise<string[]> {
  const probs = await L.weigh(key)
  const order = Object.keys(probs).sort((a, b) => probs[b] - probs[a])
  const out = [`Ranked: ${order.map((k) => `"${k}" (p ${round(probs[k])})`).join(', ')}.`]
  if (awaitOnTie && !clearWinner(probs)) {
    const q = await L.awaitHuman(key)
    out.push(`No candidate is clearly ahead, so only the human can settle which is meant: "${key}" awaits their answer to: ${q}`)
  }
  return out
}

async function refineTest(L: Loop, key: string, P: Record<string, Premise>): Promise<string[]> {
  const opts = await L.propose(key, fill(TEST, {P: key}), 1)
  if (opts.length === 0) throw new FacesAPIError(503, `the face proposed no test for "${key}"; retry`)
  const raw = opts[0].description ?? opts[0].name
  const desc = stripLead(raw, TEST_LEAD)
  const {statement, reads} = readsOf(desc)
  const name = (desc !== raw && plainKey(statement)) || plainKey(opts[0].name)
  // a test already under it that says the same is not written again
  const tests = P[key].children.filter((c) => P[c]?.role === 'test')
  if (tests.length > 0) {
    const same = tests.find((t) => norm(t) === norm(statement) || norm(String(P[t].value ?? '')) === norm(statement))
    const hit = same ?? (await L.search(statement, key)).find(([k, s]) => tests.includes(k) && s >= SIMILAR_AT)?.[0]
    if (hit) {
      await L.edit(key, {refinement: 'complete', refined_by: 'refine'})
      return [`"${key}" is settled by one test: the face proposed "${name}", which matches the test already under it, "${hit}". Nothing was written twice.`]
    }
  }
  // its inputs: each "Reads:" name matched by meaning to a premise that is neither below nor above it
  const below = new Set(descendants(P, key).concat(key))
  const above = new Set(ancestors(P, key).concat(key))
  const ins: string[] = []
  const left: string[] = []
  for (const r of reads) {
    const exact = Object.keys(P).find((k) => norm(k) === norm(r))
    let hit = exact && ok(P, exact, below, above) ? exact : undefined
    if (!hit) hit = (await L.search(r)).find(([k, s]) => s >= SIMILAR_AT && ok(P, k, below, above))?.[0]
    if (hit && !ins.includes(hit)) ins.push(hit)
    else if (!hit) left.push(r)
  }
  let tk = name
  for (let i = 2; P[tk]; i++) tk = `${name} (${i})`
  await L.add({key: tk, value: desc, description: `the test of ${key}`, role: 'test', and: key, ...(ins.length ? {on: ins} : {})})
  await L.edit(key, {refinement: 'complete', refined_by: 'refine'})
  return [`"${key}" is settled by one test, "${tk}": ${desc}`,
    ins.length ? `It reads ${ins.map((x) => `"${x}"`).join(', ')}.` : 'It reads no premise of this state.',
    ...(left.length ? [`On its "Reads:" line, ${left.map((x) => `"${x}"`).join(', ')} match no premise of this state.`] : [])]
}

function ok(P: Record<string, Premise>, k: string, below: Set<string>, above: Set<string>): boolean {
  const p = P[k]
  return Boolean(p) && !below.has(k) && !above.has(k) && p.role !== 'goal' && p.role !== 'test'
}

function descendants(P: Record<string, Premise>, k: string): string[] {
  const out: string[] = []
  const todo = [...(P[k]?.children ?? [])]
  while (todo.length) {
    const x = todo.shift() as string
    if (!out.includes(x)) { out.push(x); todo.push(...(P[x]?.children ?? [])) }
  }
  return out
}

function ancestors(P: Record<string, Premise>, k: string): string[] {
  const out: string[] = []
  const todo = Object.keys(P).filter((x) => P[x].children.includes(k))
  while (todo.length) {
    const x = todo.shift() as string
    if (!out.includes(x)) { out.push(x); todo.push(...Object.keys(P).filter((y) => P[y].children.includes(x))) }
  }
  return out
}

/** The recheck: a rewritten goal. Each AND sub-goal checked against the new value; one it no longer needs
 * is cut (deleted when nothing else rests on it); then the gap check, which sets its refinement. */
async function recheck(L: Loop, key: string, P: Record<string, Premise>): Promise<string[]> {
  const out: string[] = []
  const now = String(P[key].value ?? '')
  // only what the agent wrote is cut: never a test, the human's word or what they said, or a
  // sub-goal that has its own refinement
  const human = (c: string) => P[c].origin === 'human' || (P[c].messages ?? []).some((m) => m.author === 'human')
  const kids = P[key].children.filter((c) => P[c] && P[c].role !== 'test' && !human(c) && P[c].children.length === 0)
  if (kids.length) {
    const still = await L.predicates(kids.map((c) => fill(RECHECK, {P: key, new: now, k: c, v: String(P[c].value ?? '')})), [key, ...kids])
    for (const [i, c] of kids.entries()) {
      if (1 - still[i] < AT) continue
      const shared = Object.values(P).some((p) => p.key !== key && (p.children.includes(c) || p.on.includes(c)))
      if (shared) {
        await L.edit(key, {note: `"${c}" may no longer be needed for "${key}" as it now reads (p ${round(1 - still[i])}); other premises rest on it, so it stays.`})
        out.push(`"${c}" may no longer be needed, but other premises rest on it, so it stays (noted).`)
      } else {
        await L.send('DELETE', `${CONVERSATIONS_PATH}/${seg(L.sid)}/premises`, {params: {key: c, ...(L.as ? {as: L.as} : {})}})
        out.push(`Cut "${c}": "${key}" no longer needs it as it now reads (p ${round(1 - still[i])}).`)
      }
    }
  }
  const gap = await gapLoop(L, key)
  out.push(...gap.lines)
  out.push(gap.sufficient ? `Its sub-goals make "${key}" true as it now reads: its refinement is complete again.`
    : `After ${GAP_ROUNDS} rounds the gap check still finds conditions they leave out: its refinement is incomplete.`)
  return out
}

// ---- premise:refine -r ------------------------------------------------------------------------

/** premise:refine -r : breadth first from `root`, down to `depth` levels below it. A
 * branch stops at a test, the human's fact or an await; on an OR premise only its next candidate
 * (the highest p not refuted) is refined. A premise already refined is not refined again: its
 * children are visited. `depth` Infinity: no limit. -> {refined, awaits, beyond: the premises the
 * depth limit left unrefined, when it stopped the walk before every branch ended}. */
export async function refineTree(L: Loop, root: string, depth: number, log: (line: string) => void = () => {})
  : Promise<{refined: string[]; awaits: string[]; beyond: string[]}> {
  const refined: string[] = []
  const beyond: string[] = []
  const awaits = new Set<string>()
  const seen = new Set<string>()
  let level: string[] = [root]
  for (let d = 0; level.length > 0; d++) {
    const next: string[] = []
    for (const key of level) {
      if (seen.has(key)) continue
      seen.add(key)
      let P = await L.premises()
      let n = P[key]
      if (!n || stops(n)) {
        if (n?.await) awaits.add(key)
        continue
      }
      const done = n.refinement === 'complete' && n.children.length > 0
      if (!done && d >= depth) {
        beyond.push(key)
        continue
      }
      if (!done) {
        log(`== ${key}`)
        for (const line of await refine(L, key)) log(line)
        refined.push(key)
        P = await L.premises()
        n = P[key]
      }
      if (!n) continue
      if (n.await) { awaits.add(key); continue }
      if (n.op === 'or') {
        const c = (n as Premise & {next_to_try?: string | null}).next_to_try
        if (c) next.push(c)
      } else if (n.op === 'and') {
        next.push(...n.children.filter((c) => P[c] && !stops(P[c])))
        for (const c of n.children) if (P[c]?.await) awaits.add(c)
      }
    }
    level = next
  }
  return {refined, awaits: [...awaits], beyond}
}

function stops(n: Premise): boolean {
  return n.role === 'test' || (n.role === null && n.origin === 'human') || Boolean(n.await)
}
