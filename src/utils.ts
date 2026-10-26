import fs from 'node:fs'
import path from 'node:path'
import {FacesAPIError, FacesClient, heldChatError, type ResponseWithHeaders} from './client.js'
import {MAX_WARM_UP_WAIT_S} from './decisions.js'

/** Max length of a face's profile_addendum (per-face system prompt). Mirrors the backend. */
export const PROFILE_ADDENDUM_MAX_CHARS = 100_000

/**
 * Resolve a face's profile_addendum from the `--profile-addendum` / `--profile-addendum-file`
 * flags. Returns undefined when neither is given (field left unchanged). Throws on a missing
 * file or over-length content so the caller can surface a friendly error.
 */
/**
 * One path segment from user input, encoded so it stays one segment.
 *
 * An id spliced into a route raw can climb out of it: `../../faces/x` turned
 * a document delete into a face delete, because fetch resolves dot segments.
 * `.` and `..` come through encoding unchanged, so they are refused outright.
 */
export function seg(value: string): string {
  if (value === '' || value === '.' || value === '..') {
    throw new Error(`"${value}" is not an id or alias.`)
  }

  return encodeURIComponent(value)
}

/**
 * A dollar amount typed by a person, as a number the API will take.
 *
 * parseFloat reads "1abc" as 1 and "1e6" as a million, and a key's spend cap
 * is the wrong place for either to slip through.
 */
export function parseBudget(raw: string, fail: (message: string) => never, flag = '--budget', max = 999_999): number {
  const s = raw.trim().replace(/^\$/, '')
  if (!/^\d+(\.\d{1,2})?$/.test(s)) fail(`${flag} must be a dollar amount such as 5 or 0.50 (got "${raw}").`)
  const n = Number(s)
  if (n > max) fail(`${flag} can be at most ${max}.`)
  return n
}

/** --temperature as a number from 0 to 2, refused otherwise rather than dropped. */
export function parseTemperature(raw: string, fail: (message: string) => never): number {
  const n = Number(raw.trim())
  if (raw.trim() === '' || !Number.isFinite(n) || n < 0 || n > 2) fail(`--temperature must be a number from 0 to 2 (got "${raw}").`)
  return n
}

/** Whether an alias names the account's own face, which every account has. */
export function isMeAlias(alias: string): boolean {
  return alias.trim().toLowerCase() === 'me'
}

/**
 * What to say when `me` is missing. It is created with the account, so a
 * missing one is the server's fault; pointing at other people's faces, as the
 * general 404 does, sends the user the wrong way.
 */
export const ME_MISSING =
  "Every account has its own face with the alias 'me', created with the account, and this one has none. " +
  'That is not something to fix from here. Please report it: https://github.com/faces-sh/cli/issues'

/**
 * Rows as aligned columns, numbers right-aligned. `right` names the columns
 * holding numbers.
 */
export function table(headers: string[], rows: string[][], right: Set<string> = new Set()): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const line = (cells: string[]) =>
    cells.map((c, i) => (right.has(headers[i]) ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ').trimEnd()
  return [line(headers), ...rows.map(line)]
}

/** A calendar date as YYYY-MM-DD that exists, or undefined. */
export function isCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** Dollars as a person reads them: $0.0133, $12.50. */
export function usd(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '-'
  if (n === 0) return '$0.00'
  return Math.abs(n) >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`
}

/**
 * A similarity score as a person reads it: the number the API sent, never
 * padded. A score rounded to one decimal place (any pair where a face is not
 * yours) must read 0.8, not 0.80, which would claim a precision it does not
 * have. Long exact scores are cut to four places, with trailing zeros dropped.
 */
export function similarityText(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '-'
  return String(Number(v.toFixed(4)))
}

/** File types the text commands cannot read, with where each one should go. */
export const BINARY_HINTS: Record<string, string> = {
  '.pdf': 'PDF is supported, but not by this command. Use: faces compile:upload <alias> --file <path> --kind document',
  '.docx': 'Word documents are supported, but not by this command. Use: faces compile:upload <alias> --file <path> --kind document',
  '.doc': "Legacy '.doc' is not supported. Open it in Word or Pages and save as .docx, then upload that with: faces compile:upload <alias> --file <path> --kind document",
  '.pages': 'Pages documents are not supported. Export it as text or PDF first.',
  '.rtf': 'RTF is not supported. Convert it to plain text first (e.g. `textutil -convert txt file.rtf`).',
  '.key': 'Keynote files are not supported. Export the text first.',
  '.pptx': 'PowerPoint files are not supported. Export the text first.',
  '.xlsx': 'Excel files are not supported. Export as .csv first.',
  '.zip': 'Archives are not supported. Extract it and pass the text files.',
  '.epub': 'EPUB is not supported. Convert it to text first.',
}

/**
 * Read a file as text, refusing binary before it reaches the API.
 *
 * `compile:doc` posts its content as a text field, so a binary file used to
 * travel all the way to the server and come back as a 500 ("A string literal
 * cannot contain NUL (0x00) characters") that named neither the file nor the
 * cause. The NUL scan is the general check; the extension table only makes the
 * message more useful for formats people actually try.
 */
export function readTextFile(file: string): string {
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`)

  const stat = fs.statSync(file)
  if (stat.isDirectory()) throw new Error(`Not a file: ${file}`)

  // Extension first, and independent of the byte scan: a small PDF can contain
  // no NUL at all and would otherwise be posted as mojibake. A known format
  // always gets the answer for that format.
  const hint = BINARY_HINTS[path.extname(file).toLowerCase()]
  if (hint) throw new Error(hint)

  const buf = fs.readFileSync(file)
  if (buf.includes(0)) throw new Error('Looks like a binary file, not text. Convert it to text first.')

  // Latin-1 and other legacy encodings decoded as UTF-8 come out with
  // characters replaced by "\ufffd", silently; say so instead.
  let content: string
  try {
    content = new TextDecoder('utf-8', {fatal: true}).decode(buf)
  } catch {
    throw new Error(`${file} is not UTF-8 text. Convert it first, for example: iconv -f latin1 -t utf-8 ${file} > out.txt`)
  }

  if (content.trim() === '') throw new Error(`${file} is empty, or only whitespace.`)
  return content
}

/**
 * The speaker labels of a text that reads as a labelled exchange between
 * speakers ("Interviewer: ...", "Ada: ..."), or null when it does not.
 *
 * A document is read as one author's writing, every line of it. A transcript
 * uploaded that way is compiled as the face saying everyone's lines, so the
 * document commands warn and point at the thread upload. Deliberately strict:
 * at least two labels, each opening two or more lines, and labelled lines
 * making up a good share of the text, so an essay with a "Note:" in it stays
 * silent.
 */
export function transcriptSpeakers(text: string): string[] | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) return null
  const counts = new Map<string, number>()
  const order: string[] = []
  let labelled = 0
  for (const line of lines) {
    const m = /^([A-Za-z][\w.'-]*(?: [\w.'-]+){0,3}):\s+\S/.exec(line)
    if (!m) continue
    labelled++
    const label = m[1]
    if (!counts.has(label)) order.push(label)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const speakers = order.filter((l) => (counts.get(l) ?? 0) >= 2)
  if (speakers.length < 2 || labelled < 4 || labelled / lines.length < 0.3) return null
  return speakers
}

/**
 * The warning for a document that reads as a transcript, naming the thread
 * upload that keeps only the face's turns. Empty when the text is not one.
 */
export function transcriptWarningLines(text: string, alias: string, file?: string): string[] {
  const speakers = transcriptSpeakers(text)
  if (!speakers) return []
  const shown = speakers.slice(0, 4).join(', ') + (speakers.length > 4 ? ', ...' : '')
  return [
    `Warning: ${file ?? 'this text'} reads as an exchange between speakers (${shown}).`,
    'A document is the face\'s own writing, so every line in it, other speakers included, is read as the face\'s words.',
    'Upload an interview, transcript or dialogue as a thread instead, naming the face\'s speaker:',
    threadUploadCommand(alias, file),
  ]
}

/** A saved document's body without its `warnings`, for printing beside them. */
export function withoutWarnings(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  const {warnings: _warnings, ...rest} = data as Record<string, unknown>
  return rest
}

/** The command that uploads `file` as a thread, keeping only the face's turns. */
function threadUploadCommand(alias: string, file?: string): string {
  return `  faces compile:upload ${alias} --file ${file ?? 'FILE'} --kind thread --face-speaker NAME`
}

/**
 * What to print about a document the server has just saved, from the
 * `warnings` it answered with.
 *
 * The server's own sentence is printed as it is, and a transcript warning is
 * followed by the thread upload for this file. A server that sends no
 * `warnings` field at all says nothing either way, so the text is checked
 * here instead ({@link transcriptWarningLines}). An empty list is the server
 * saying there is nothing to report, and nothing is printed.
 */
export function documentWarningLines(
  result: unknown,
  text: string | undefined,
  alias: string,
  file?: string,
): string[] {
  const body = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>
  if (!Array.isArray(body.warnings)) return text === undefined ? [] : transcriptWarningLines(text, alias, file)
  const lines: string[] = []
  for (const raw of body.warnings as unknown[]) {
    const w = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const code = typeof w.code === 'string' ? w.code : undefined
    const message = typeof w.message === 'string' && w.message.trim() ? w.message.trim() : undefined
    if (code === 'looks_like_transcript') {
      lines.push(`Warning: ${message ?? 'This looks like a conversation between several speakers. Upload it as a thread instead of a document.'}`)
      lines.push(threadUploadCommand(alias, file))
      continue
    }
    if (message) lines.push(`Warning: ${message}`)
    else if (typeof raw === 'string' && raw.trim()) lines.push(`Warning: ${raw.trim()}`)
    else if (code) lines.push(`Warning: ${code}`)
  }
  return lines
}

/**
 * Why a display name cannot be used, or undefined. A 5,000-character name and
 * a right-to-left override were both accepted, and each broke every listing
 * that printed them: one padded rows past 5,000 columns, the other reversed
 * the rest of its row.
 */
/**
 * What is wrong with --tool names, or undefined. The API publishes no list of
 * tools and stores any string, so only the shape is checked: a name with a
 * space or a repeat is a typo, never a tool.
 */
/** The compile price, per million source tokens, when the catalog cannot be read. */
export const COMPILE_USD_PER_MILLION = 25

/** A compile costing this much or more on credits is worth saying before it starts. */
export const LARGE_COMPILE_USD = 1

/** The compile price per million source tokens, from the model catalog. */
export async function compileRate(client: FacesClient): Promise<number> {
  try {
    const raw = (await client.get('/v1/models', {params: {kind: 'compile'}})) as Record<string, unknown>
    const rows = (Array.isArray(raw) ? raw : (raw.data ?? [])) as Array<Record<string, unknown>>
    const rate = rows.find((m) => m.kind === 'compile')?.input_cost_per_million_tokens
    if (typeof rate === 'number' && rate > 0) return rate
  } catch {
    // the published price, rather than nothing
  }
  return COMPILE_USD_PER_MILLION
}

/**
 * What compiling a source of this size costs on credits, or undefined when it
 * is too small to be worth a line. Connect and Pro spend the month's compile
 * allowance first, so for them it may cost nothing.
 */
export function compileCostNote(tokens: unknown, ratePerMillion: number): string | undefined {
  if (typeof tokens !== 'number' || tokens <= 0) return undefined
  const usdCost = (tokens / 1_000_000) * ratePerMillion
  if (usdCost < LARGE_COMPILE_USD) return undefined
  return (
    `This source is ${tokens.toLocaleString('en-US')} tokens. Compiling it costs about $${usdCost.toFixed(2)} on credits ` +
    `($${ratePerMillion} per million source tokens); on Connect or Pro the month's compile allowance is used first ` +
    '(see faces compile:stats).'
  )
}

export function badToolNames(names: string[]): string | undefined {
  const seen = new Set<string>()
  for (const raw of names) {
    const name = raw.trim()
    if (!name) return 'A --tool name is empty.'
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(name)) return `'${raw}' is not a tool name: use letters, digits, _ . : or -, with no spaces.`
    if (seen.has(name)) return `'${name}' is given twice.`
    seen.add(name)
  }
  return undefined
}

export function badFaceName(name: string): string | undefined {
  if (!name.trim()) return 'The name is empty.'
  if (name.length > 200) return `The name is ${name.length} characters; keep it to 200 or fewer.`
  if (/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(name)) return 'The name contains control or text-direction characters.'
  return undefined
}

/** An object without its null and undefined fields, for printing. */
export function compact(obj: unknown): unknown {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj
  return Object.fromEntries(Object.entries(obj as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined))
}

export function resolveProfileAddendum(text: string | undefined, file: string | undefined): string | undefined {
  let value: string | undefined
  if (file !== undefined) {
    if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`)
    value = fs.readFileSync(file, 'utf8')
  } else if (text !== undefined) {
    value = text
  }
  if (value !== undefined && value.length > PROFILE_ADDENDUM_MAX_CHARS) {
    throw new Error(`--profile-addendum is ${value.length} chars; max is ${PROFILE_ADDENDUM_MAX_CHARS}.`)
  }
  return value
}

/**
 * The face's cause for this turn, written by the caller: `--cause` or
 * `--cause-file`. The face answers on it instead of working out its own, so
 * no cause is worked out or charged for. Undefined when neither is given or the
 * text is blank, which the server would ignore anyway (the face then gives its own
 * cause as usual). Throws on a missing file. Over 30,000 tokens is the server's to
 * refuse, since only it counts tokens the way it bills them.
 */
export function resolveCause(text: string | undefined, file: string | undefined): string | undefined {
  let value = text
  if (file !== undefined) {
    if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`)
    value = fs.readFileSync(file, 'utf8')
  }
  return value !== undefined && value.trim() ? value : undefined
}

export const CAUSE_FLAG_DESCRIPTION =
  'Supply this turn\'s cause yourself, at most 30,000 tokens. The model answers on it in place of the ' +
  'face\'s own, and no cause is charged. Needs a model named (alias@model). It comes back where a cause ' +
  'normally does.'

export const CAUSE_FILE_FLAG_DESCRIPTION = 'Read --cause from a file.'

/** The refusal for --cause on a face named alone, said before a request is sent. */
export function causeNeedsModel(face: string): string {
  return (
    `--cause needs a model to answer on it: ${face}@<model>. A face named alone returns only its own ` +
    'cause, so there is nothing to supply.'
  )
}

/**
 * Flatten basic_facts/attributes from API's nested {value, status, identification} format
 * to simple {key: value} strings.
 */
export function flattenAttributes(facts: Record<string, unknown>): Record<string, string> {
  const flat: Record<string, string> = {}
  for (const [k, v] of Object.entries(facts)) {
    if (typeof v === 'object' && v !== null && 'value' in v) {
      flat[k] = String((v as {value: unknown}).value)
    } else {
      flat[k] = String(v)
    }
  }
  return flat
}

/** @deprecated Use flattenAttributes */
export const flattenBasicFacts = flattenAttributes

/**
 * Rename basic_facts → attributes in a face response object.
 * Mutates the object in place and returns it.
 */
export function renameFaceFields(face: Record<string, unknown>): Record<string, unknown> {
  if (face.basic_facts !== undefined) {
    face.attributes = typeof face.basic_facts === 'object' && face.basic_facts !== null
      ? flattenAttributes(face.basic_facts as Record<string, unknown>)
      : face.basic_facts
    delete face.basic_facts
  }
  return face
}

/**
 * Extract a streamed text delta from a parsed SSE event, regardless of which
 * API family produced it. A request posted to /v1/chat/completions may be
 * re-routed by the backend to /v1/messages or /v1/responses, so a stream
 * consumer must handle all three event shapes:
 *   - Anthropic Messages:    { type: 'content_block_delta', delta: {text} }
 *   - OpenAI Responses:      { type: 'response.output_text.delta', delta }
 *   - OpenAI Chat Completions: { choices: [{delta: {content}}] }
 */
export function extractStreamDelta(parsed: Record<string, unknown>): string {
  if (parsed.type === 'content_block_delta') {
    return String((parsed.delta as Record<string, unknown> | undefined)?.text ?? '')
  }
  if (parsed.type === 'response.output_text.delta') {
    return String(parsed.delta ?? '')
  }
  const choices = parsed.choices as Array<Record<string, unknown>> | undefined
  return String((choices?.[0]?.delta as Record<string, unknown> | undefined)?.content ?? '')
}

/**
 * The face's cause from a streamed event, or '' when the event carries none.
 *
 * A face's cause comes before its answer in the stream, marked as the face's:
 *   - Chat Completions: `delta.cause`
 *   - Responses: `response.reasoning_summary_text.delta` on an `rs_faces_` item
 *   - Messages: a `thinking` delta on content block 0
 * A reasoning model's own working is separate and never taken for the face's:
 * `reasoning_content` on chat, other reasoning items, later thinking blocks.
 */
export function extractStreamReasoning(parsed: Record<string, unknown>): string {
  if (parsed.type === 'content_block_delta') {
    if (parsed.index !== 0) return ''
    return String((parsed.delta as Record<string, unknown> | undefined)?.thinking ?? '')
  }
  if (parsed.type === 'response.reasoning_summary_text.delta') {
    const item = parsed.item_id
    if (typeof item === 'string' && !item.startsWith('rs_faces_')) return ''
    return String(parsed.delta ?? '')
  }
  const choices = parsed.choices as Array<Record<string, unknown>> | undefined
  return String((choices?.[0]?.delta as Record<string, unknown> | undefined)?.cause ?? '')
}

/** Signature on the Messages thinking block that holds a face's cause. */
export const FACES_THINKING_SIGNATURE = 'faces-reasoning'

/** Id prefix of the Responses reasoning item that holds a face's cause. */
export const FACES_REASONING_ITEM_PREFIX = 'rs_faces_'

/**
 * The face's cause from a whole reply, by the endpoint that
 * answered, with the Responses item id that carried it. Empty when there is
 * none. Only what is marked as the face's is taken, never a model's own.
 */
export function extractCause(body: Record<string, unknown>, endpoint: string): {text: string; id?: string} {
  if (endpoint === '/v1/messages') {
    const block = (body.content as Array<Record<string, unknown>> | undefined)?.find(
      (b) => b.type === 'thinking' && b.signature === FACES_THINKING_SIGNATURE,
    )
    return {text: block ? String(block.thinking ?? '') : ''}
  }
  if (endpoint === '/v1/responses') {
    const item = (body.output as Array<Record<string, unknown>> | undefined)?.find(
      (o) => o.type === 'reasoning' && String(o.id ?? '').startsWith(FACES_REASONING_ITEM_PREFIX),
    )
    if (!item) return {text: ''}
    const text = ((item.summary as Array<Record<string, unknown>> | undefined) ?? []).map((s) => String(s.text ?? '')).join('\n')
    return {text, id: String(item.id)}
  }
  const choices = body.choices as Array<Record<string, unknown>> | undefined
  return {text: String((choices?.[0]?.message as Record<string, unknown> | undefined)?.cause ?? '')}
}

/** The face's cause from a whole reply, by the endpoint that answered. '' when there is none. */
export function extractReasoning(body: Record<string, unknown>, endpoint: string): string {
  return extractCause(body, endpoint).text
}

export const REASONING_FLAG_DESCRIPTION =
  'Also show the face\'s cause: the principal why behind its response in this context. Printed to ' +
  'stderr ahead of the reply, so the reply alone still goes to stdout.'

/** The heading the face's cause is shown under, on stderr, apart from the reply. */
export function reasoningHeading(face: string): string {
  return `${face.replace(/@.*$/, '')}'s cause:`
}

/**
 * What to say when a reply came back with a cause and no answer.
 *
 * A bare alias asks for the face's cause alone, and the server no longer
 * answers it on the face's default model. Nothing failed, so this is a note,
 * with the way to get a reply.
 */
export function reasoningOnlyNote(face: string, llmFlag = true): string {
  const bare = face.replace(/@.*$/, '')
  return `That is ${bare}'s cause alone: a face named without a model gives no reply. ` +
    `For one, name the model: ${bare}@<model>${llmFlag ? ', or add --llm <model>' : ''}.`
}

/**
 * Print a whole reply: the face's cause to stderr when asked for, then the
 * reply to stdout. With no reply the cause is the answer, so it goes to
 * stdout instead, followed by `note` on stderr when there is one.
 */
export function writeReply(model: string, reasoning: string, text: string, showReasoning: boolean, note?: string): void {
  if (!text && reasoning) {
    process.stdout.write(`${reasoning}\n`)
    if (note) process.stderr.write(`\n${note}\n`)
    return
  }
  if (showReasoning && reasoning) process.stderr.write(`${reasoningHeading(model)}\n${reasoning}\n\n`)
  process.stdout.write(`${text}\n`)
}

export const STREAM_FLAG_DESCRIPTION =
  'Stream the reply as it is written (the default). --no-stream waits for the whole reply instead. ' +
  'Either way a face has up to 300s to answer; past that the request is stopped and can be asked again. ' +
  '--json is never streamed.'

/**
 * Send a chat that is not streamed to `endpoint`, and turn a refusal that
 * arrives in a held response's body into the error it is.
 *
 * A face chat that runs long is answered 200 with `X-Faces-Held: 1` before
 * it is done, so a refusal after that comes as the body ({@link heldChatError})
 * rather than as the status. Thrown here, it is printed like any other
 * refusal instead of as an empty reply.
 */
export async function postChat(client: FacesClient, endpoint: string, payload: Record<string, unknown>): Promise<ResponseWithHeaders> {
  const res = await client.postWithHeaders(endpoint, {body: payload})
  const held = heldChatError(res.data)
  if (held) throw held
  return res
}

/**
 * Send a request that is not streamed, and if the server answers 503 with
 * `Retry-After`, wait that long and send it once more.
 *
 * A 503 naming a wait is refused before any work, so asking again costs
 * nothing. Once, because a second refusal means something other than a
 * passing one, and a wait past the ceiling is not worth holding a caller for.
 */
export async function retryOnceOnWarmUp<T>(send: () => Promise<T>, say?: (seconds: number) => void): Promise<T> {
  try {
    return await send()
  } catch (err) {
    if (!(err instanceof FacesAPIError) || err.statusCode !== 503 || err.retryable === false) throw err
    const wait = err.retryAfter
    if (wait === undefined || wait > MAX_WARM_UP_WAIT_S) throw err
    say?.(wait)
    await new Promise((r) => setTimeout(r, wait * 1000))
    return send()
  }
}

/**
 * Stream a chat, asking again with `max_completion_tokens` if the model
 * refuses `max_tokens`, as newer OpenAI models do. That refusal comes with
 * the status, before a line is read, so asking again is clean. Mutates
 * `payload` to the form that was accepted.
 */
export async function* streamChat(
  client: FacesClient,
  endpoint: string,
  payload: Record<string, unknown>,
  onHeaders?: (headers: Record<string, string>) => void,
): AsyncGenerator<string> {
  let lines = client.stream(endpoint, payload, {onHeaders})
  let first: IteratorResult<string>
  try {
    first = await lines.next()
  } catch (err) {
    if (!(err instanceof FacesAPIError) || !isMaxTokensRenameError(err.message) || payload.max_tokens === undefined) throw err
    payload.max_completion_tokens = payload.max_tokens
    delete payload.max_tokens
    lines = client.stream(endpoint, payload, {onHeaders})
    first = await lines.next()
  }
  if (first.done) return
  yield first.value
  yield* lines
}

/** What a wait before asking again looks like on stderr. */
export function sayWarmUp(seconds: number): void {
  process.stderr.write(`Not ready yet. Asking again in ${seconds}s.\n`)
}

/**
 * What a face that cannot reason yet needs, by the kind of face it is: a
 * formula has no sources of its own, so it is the faces in it that need them.
 * `recompile` is a face compiled before causes launched, not one with
 * nothing compiled.
 */
export function compileHint(face: string, recompile: boolean, verb = 'answer'): string {
  if (/[|&^()]/.test(face) || /\S\s+\S/.test(face)) {
    return recompile
      ? `Every face in ${face} needs recompiling before it can ${verb}: compile one of each one's sources again.`
      : `Every face in ${face} needs something compiled: faces compile:upload <alias> --file <file> for each.`
  }
  if (face.includes(':')) {
    return recompile ? `${face} needs recompiling by its owner before it can ${verb}.` : `${face} has nothing compiled yet; that is for its owner to do.`
  }
  return recompile
    ? `${face} needs recompiling before it can ${verb}: compile one of its sources again ` +
        `(list them with: faces face:sources ${face}). Asking again as it is will not help.`
    : `Give it a first source: faces compile:upload ${face} --file <file>. A saved composite needs one on each face in its formula.`
}

/**
 * What to do about a refusal of a chat with a face, or undefined when there
 * is nothing to add to the server's message.
 *
 * A face's answer always comes with its cause, so where that cannot be given
 * the chat is refused rather than answered without it:
 *   - 409: compiled before causes launched. Recompiling fixes it; asking
 *     again does not. Also asked for the cause alone of a face with nothing
 *     compiled, which needs a first source.
 *   - 504: the face did not finish within 300 seconds. Asking again may work.
 *   - 503: asking again may work, after the wait when one is named.
 *   - 400 with --style: the face has no style in that medium. Build one.
 */
export function faceRefusalHint(err: FacesAPIError, model: string, style?: string): string | undefined {
  const face = model.replace(/@[^@]*$/, '')
  // A face with no style, or none in the medium asked for, is refused rather
  // than answered in its ordinary voice. The server names the media it has.
  if (style && (err.errorCode === 'style_medium_unavailable' || /has no (styles? yet|.* style)/i.test(err.message))) {
    return `Build one: faces style:make ${face} --all\nOr leave out --style to answer without a built style.`
  }
  if (err.statusCode === 409) {
    // A face with nothing compiled still chats, from its name and attributes,
    // but has no cause to give alone. That wants a first source, not a
    // recompile.
    return compileHint(face, !/nothing compiled/i.test(err.message))
  }
  // Every account has a `me` face; a missing one is the server's fault.
  if (err.statusCode === 404 && isMeAlias(face)) return ME_MISSING
  if (err.statusCode === 504) return 'The face did not finish within 300 seconds. Ask again.'
  if (err.statusCode === 503) {
    // false: the same request fails again; the server's message says what to change.
    if (err.retryable === false) return undefined
    return err.retryAfter !== undefined ? `Try again in ${err.retryAfter}s.` : 'Try again.'
  }
  return undefined
}

/**
 * OpenAI's Responses API rejects an output cap below this. Checked client-side
 * because the round trip tells the user nothing they could not be told sooner.
 */
export const MIN_MAX_OUTPUT_TOKENS = 16

/**
 * True when a provider 400 is the `max_tokens` → `max_completion_tokens` rename
 * that newer OpenAI models require.
 *
 * The backend forwards the provider's rejection verbatim rather than rewriting
 * the parameter, so the client is what has to adapt. Matched on the message
 * because the set of models that require it grows, and a model list here would
 * be stale the day a new one ships.
 */
export function isMaxTokensRenameError(message: string): boolean {
  return /max_completion_tokens/.test(message) && /max_tokens/.test(message)
}

/**
 * The eleven values, spelled exactly. Whether omitting one is allowed depends
 * on the command.
 *
 * The parentheses describe which value to reach for; they are not spellings
 * that work. `transcript`, `keynote`, `sms` and the other 32 aliases used to
 * fold and are now each a 422, so naming them as inputs here would be sending
 * people into one.
 */
const MEDIUM_LIST =
  'What sort of writing this is, spelled exactly: email, text message, social post, essay, ' +
  'academic paper, blog post, legal document, thread reply, conversation, lecture, other. ' +
  'Reach for lecture for sustained speech nobody interrupts (a talk, a sermon, a keynote), and ' +
  'other for writing that is none of the named forms, read as prose with no form-specific ' +
  'conventions assumed. Those descriptions are not accepted inputs: send the value itself.'

/**
 * Said wherever a document is created: what belongs in one, and where an
 * exchange between speakers goes instead.
 */
export const DOCUMENT_VS_THREAD =
  'A document is the face\'s own writing (an essay, letter, paper, book or poem), and every word ' +
  'in it is read as theirs. An interview, transcript or dialogue is a thread: upload it with ' +
  'faces compile:upload ALIAS --file FILE --kind thread --face-speaker NAME, so only the face\'s ' +
  'turns are used.'

/**
 * `--style` on the chat commands: apply the face's built style for one medium.
 * The server checks the medium, so an unknown word is refused naming all eleven.
 */
export const STYLE_FLAG_DESCRIPTION =
  'Apply the style the face has built for this medium, one of: email, text message, social post, essay, ' +
  'academic paper, blog post, legal document, thread reply, conversation, lecture, other. Leave it out and ' +
  'no built style is applied. A face with no style in that medium is refused, naming the ones it has ' +
  '(see them with faces face:get). Needs a single face and a model. Adds roughly 2,000 to 3,500 input ' +
  'tokens per request. Sets --medium too. Chat commands only: causes and decide do not use a style.'

/** `--medium` on the chat commands: say what the reply is. Needs no build and is never refused. */
export const MEDIUM_FLAG_DESCRIPTION =
  'What the reply is, so it is shaped for it: email, text message, social post, essay, academic paper, ' +
  'blog post, legal document, thread reply, conversation, lecture, other. Needs no built style. Leave it ' +
  'out and the medium is inferred from your message. With --style, leave it out or give the same medium.'

export const SESSION_FLAG_DESCRIPTION =
  'Add this turn to a session, by id (from faces session:create). The session must be with this face.'

export const COMPACTION_FLAG_DESCRIPTION =
  'Read a compaction, by id (from faces session:compact), alongside the messages sent. It must be of a ' +
  'session with this face.'

/** The request fields for --style, --medium, --session and --compaction, when given. */
export function chatExtras(flags: {style?: string; medium?: string; session?: string; compaction?: string}): Record<string, string> {
  const out: Record<string, string> = {}
  if (flags.style) out.style = flags.style
  if (flags.medium) out.medium = flags.medium
  if (flags.session) out.session = flags.session
  if (flags.compaction) out.compaction = flags.compaction
  return out
}

/**
 * For the document commands, where leaving it out is not a choice any more.
 *
 * A compile reads writing differently per medium and the server refuses to
 * infer one, so the old "omit it if you do not know" would send someone
 * straight into a refusal. Asking is the answer, not guessing.
 */
/** --medium on an edit: optional, and leaving it out keeps what is there. */
export const MEDIUM_EDIT_DESCRIPTION = () => MEDIUM_LIST + ' Omit it to leave the medium as it is.'

export const MEDIUM_REQUIRED_DESCRIPTION =
  MEDIUM_LIST +
  ' ' + DOCUMENT_VS_THREAD +
  ' A document cannot be saved without saying what it is, so this is required rather than ' +
  'optional. Here the spelling is held to exactly: case and surrounding spaces are forgiven and ' +
  'nothing else is, so an unknown word is refused naming all eleven rather than being folded into ' +
  'a near match. Do not guess one: a wrong medium is not flagged afterwards. If none of the ' +
  'named forms fit, that is what other is for. If one of them ' +
  'does fit and you simply have not been told which, ask.'

/**
 * The refusal for a document created with no --medium, said before anything is
 * sent.
 *
 * The server refuses the create itself without one, so there is no creating
 * it now and declaring it later. Do not guess one either: the server declines
 * to infer precisely because a wrong medium is wrong silently, and nothing
 * afterwards says it happened.
 */
export const MEDIUM_MISSING_MESSAGE =
  'Say what this writing is with --medium: a document cannot be saved without one.\n' +
  'One of: email, text message, social post, essay, academic paper, blog post, legal document, ' +
  'thread reply, conversation, lecture, other.\n' +
  '`other` is for writing that is none of those: it compiles, and is read as prose with no ' +
  'form-specific conventions assumed. It is the honest answer when nothing fits, and the wrong ' +
  'answer for a letter or a memo, which are forms with rules of their own.\n' +
  'A document saved before this was required is declared with: faces compile:doc:edit <id> --medium <medium>.'

/**
 * Warn when the server dropped request parameters before forwarding.
 *
 * The ChatGPT plan route strips params it rejects (`max_output_tokens`,
 * `temperature`), so the same flag is honoured on the paid path and ignored on
 * the free one: a difference the caller cannot see and did not choose. The
 * server announces it in `x-faces-dropped-params`; without that header a client
 * could only guess, since which route ran is decided per request.
 */
export function warnDroppedParams(headers: Record<string, string>, flagFor: Record<string, string>): void {
  const raw = headers['x-faces-dropped-params']
  if (!raw) return
  const flags = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => flagFor[p] ?? `--${p.replaceAll('_', '-')}`)
  if (flags.length === 0) return
  process.stderr.write(
    `Note: ${flags.join(' and ')} had no effect. This request ran on your linked ChatGPT account, ` +
      'which does not accept them. Use --no-oauth-only to run on the paid API instead.\n',
  )
}

/** Maps the server's parameter names back to the flags a user actually typed. */
export const CHAT_PARAM_FLAGS: Record<string, string> = {
  max_output_tokens: '--max-tokens',
  max_tokens: '--max-tokens',
  max_completion_tokens: '--max-tokens',
  temperature: '--temperature',
}

/** A face the account can reach, and whether it owns it. */
export interface ResolvedFace {
  face: Record<string, unknown>
  /** False for a published or shared face: reachable, but someone else's. */
  owned: boolean
  /** The address that works everywhere: a bare alias for your own, owner:alias otherwise. */
  handle: string
  /** Account that owns it, when that is not you. */
  owner?: string
}

/**
 * Look up a face by `alias` or `owner:alias`.
 *
 * `GET /v1/faces/{alias}` only serves faces the account owns. It answers 404
 * for a qualified name it does not parse and 403 for someone else's bare
 * alias, so the two ways of naming the same reachable face fail differently
 * and neither says what is actually true. The listing does serve published and
 * shared faces, so it is used as the fallback and the caller gets one answer:
 * here is the face, and you do not own it.
 *
 * Throws the original error when the face genuinely cannot be reached.
 */
export async function resolveFace(
  client: {get: (path: string) => Promise<unknown>},
  spec: string,
  include = 'profile',
): Promise<ResolvedFace> {
  const at = spec.indexOf(':')
  const owner = at === -1 ? undefined : spec.slice(0, at)
  const alias = at === -1 ? spec : spec.slice(at + 1)
  const q = `include=${encodeURIComponent(include)}`

  // A bare name is yours until the server says otherwise. It can also answer
  // with someone else's published face of that name, so check the owner.
  if (!owner) {
    try {
      const face = (await client.get(`/v1/faces/${seg(alias)}?${q}`)) as Record<string, unknown>
      const me = await currentUsername(client)
      const by = typeof face.owned_by === 'string' ? face.owned_by : undefined
      if (me && by && by !== me) return {face, owned: false, handle: `${by}:${alias}`}
      return {face, owned: true, handle: alias}
    } catch (err) {
      // 403 means it exists and is not yours. Find who owns it so the caller
      // can name it the way that works, rather than reporting a typo.
      if (!(err instanceof FacesAPIError) || err.statusCode !== 403) throw err
      const found = await findForeignFace(client, alias, undefined, q)
      if (found) return found
      throw err
    }
  }

  const found = await findForeignFace(client, alias, owner, q)
  if (found) return found
  throw new FacesAPIError(404, `Face ${spec} not found`)
}

let usernameCache: Promise<string | undefined> | undefined

/** The signed-in account's username, asked once per run; undefined if it cannot be read. */
export function currentUsername(client: {get: (path: string) => Promise<unknown>}): Promise<string | undefined> {
  usernameCache ??= (async () => {
    try {
      const me = (await client.get('/auth/me')) as Record<string, unknown>
      const data = (me.data ?? me) as Record<string, unknown>
      return typeof data.username === 'string' ? data.username : undefined
    } catch {
      return undefined
    }
  })()
  return usernameCache
}

/**
 * Whether a face named on the command line is the caller's own: by the owner
 * part of `owner:alias`, or by the face's owned_by. Undefined when it cannot
 * be told, which callers treat as their own, as before.
 */
export async function ownsFace(client: {get: (path: string) => Promise<unknown>}, spec: string): Promise<boolean | undefined> {
  const me = await currentUsername(client)
  if (!me) return undefined
  const at = spec.indexOf(':')
  if (at !== -1) return spec.slice(0, at) === me
  try {
    const face = (await client.get(`/v1/faces/${seg(spec)}`)) as Record<string, unknown>
    return typeof face.owned_by === 'string' ? face.owned_by === me : undefined
  } catch {
    return undefined
  }
}

/** Search the listing, which unlike the single-face route serves other people's faces. */
async function findForeignFace(
  client: {get: (path: string) => Promise<unknown>},
  alias: string,
  owner: string | undefined,
  q: string,
): Promise<ResolvedFace | undefined> {
  const parts = [q, 'include_published=true', 'include_shared=true']
  if (owner) parts.push(`from_users=${encodeURIComponent(owner)}`)
  let rows: Array<Record<string, unknown>>
  try {
    const data = await client.get(`/v1/faces?${parts.join('&')}`)
    rows = ((data as {data?: Array<Record<string, unknown>>}).data ??
      (data as Array<Record<string, unknown>>)) as Array<Record<string, unknown>>
  } catch {
    return undefined
  }

  const hit = rows.find(
    (f) => f.alias === alias && (owner === undefined || f.owned_by === owner),
  )
  if (!hit) return undefined
  const ownedBy = hit.owned_by as string | undefined
  return {
    face: hit,
    owned: false,
    handle: ownedBy ? `${ownedBy}:${alias}` : alias,
    owner: ownedBy,
  }
}

/**
 * A description this large is not a description.
 *
 * The escaping bug this bound exists to catch grew one field to 128 MiB by
 * doubling it on every unrelated write. A ceiling turns a silent geometric
 * corruption into one complaint on the first doubling, and stops a value that
 * is already corrupt from being carried forward forever.
 */
export const MAX_FRONTMATTER_VALUE = 64 * 1024

/**
 * Quote a YAML scalar, escaping what would otherwise break the line.
 *
 * Paired with {@link unquoteYaml}. The two must stay exact inverses: if one
 * escapes and the other does not unescape, every read-modify-write doubles the
 * backslashes in the value, which is invisible until a catalog is measured in
 * hundreds of megabytes.
 */
export function quoteYaml(value: string): string {
  if (/[:#[\]{}&*!|>'"%@`\n]/.test(value) || value !== value.trim() || value === '') {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return value
}

/**
 * Reverse {@link quoteYaml}: strip the surrounding quotes, then unescape.
 *
 * The unescape is a single left-to-right pass, not two sequential replaces.
 * `\\` and `\"` have to be consumed in the order they appear, or a value
 * containing a literal backslash before a quote comes back wrong.
 */
export function unquoteYaml(raw: string): string {
  const trimmed = raw.trim()
  const m = /^"([\S\s]*)"$/.exec(trimmed)
  if (!m) return trimmed
  return m[1].replace(/\\(["\\])/g, '$1')
}

/**
 * The media a face has a built style for, from its `styles` field. Empty
 * means it has none; each one listed can be asked for with --style.
 */
export function faceStyles(face: {styles?: unknown}): string[] {
  return Array.isArray(face.styles) ? face.styles.filter((m): m is string => typeof m === 'string') : []
}

/**
 * Why a source cannot be compiled, and what the caller can do about it.
 *
 * These arrive as `error_code` on a 400 from /make, and as
 * `compile_blocked_reason` on any source row, so the same set answers both
 * "why was this refused" and "should I offer the action at all". The server writes the diagnosis; this adds the
 * repair, which it does not know.
 *
 * The set is open. An unrecognised code means the source cannot be compiled,
 * which is the safe reading: offering an action the server will refuse is
 * worse than withholding one it might have allowed.
 */
const CORPUS_THREAD_FIX =
  'This is a corpus thread, uploaded material for building a style rather than a thread to compile. Build a ' +
  'style from it with faces style:make, or upload the same material with --kind thread to compile it.'

export const COMPILE_BLOCKED_FIX: Record<string, string> = {
  no_medium: 'Say what it is, then compile again: faces compile:doc:edit <id> --medium essay',
  empty: 'There is nothing to compile. Add content with: faces compile:doc:edit <id> --file <path>',
  no_user_messages:
    'Nothing in it was written by the subject, so there is nothing to compile. A fresh interview holds ' +
    'only the interviewer question; it becomes compilable on the first answer.',
  corpus_thread: CORPUS_THREAD_FIX,
  // A second /make of an unchanged, compiled source; nothing was charged.
  already_compiled:
    'To compile it again: edit it, or faces compile:doc:reset <id> (compile:thread:reset for a thread) ' +
    'and then make it.',
}

/** Short phrase for a blocked reason, for a table cell rather than a sentence. */
export function compileBlockedLabel(reason: string | null | undefined): string {
  if (!reason) return ''
  const words: Record<string, string> = {
    no_medium: 'no medium declared',
    empty: 'no content',
    no_user_messages: 'nothing by the subject',
    corpus_thread: 'corpus thread',
    too_short: 'under 50 words',
  }
  return words[reason] ?? reason
}

/** Whether a source's compile is current with its text. */
export type Freshness = 'current' | 'stale' | 'unknown'

/**
 * Compare what was compiled against what the source now says.
 *
 * `synced` only ever meant "a compile ran at some point against some
 * revision". It could not tell a source whose compile is current from one
 * rewritten since, so an agent that edited a source after compiling it was
 * told the compile was current when none of it was.
 *
 * Two states have to be reported as unknown rather than guessed, and both are
 * common: a source compiled before revisions were recorded has `synced_at`
 * with no `synced_version`, and a
 * revision that was never stamped is absent rather than zero. Reporting either
 * as current would be the bug these fields exist to end; reporting them stale
 * would send people to recompile work that is fine.
 */
export function freshnessOf(s: {version?: number | null; synced_version?: number | null}): Freshness {
  const {version, synced_version: syncedVersion} = s
  if (version === null || version === undefined) return 'unknown'
  if (syncedVersion === null || syncedVersion === undefined) return 'unknown'
  return syncedVersion < version ? 'stale' : 'current'
}

/** How many revisions behind, when that is known and non-zero. */
export function revisionsBehind(s: {version?: number | null; synced_version?: number | null}): number | null {
  if (freshnessOf(s) !== 'stale') return null
  return (s.version as number) - (s.synced_version as number)
}

/**
 * Messages a compile never read, by instant.
 *
 * A thread is stale per message rather than wholesale, so an agent that edited
 * message 4 of 500 can see that message 4 alone needs recompiling. A null
 * timestamp means the instant was never recorded, which is not the same as
 * edited, so those are left out rather than counted as stale.
 */
export function messagesAfterSync(
  messages: Array<{timestamp?: string | null}> | null | undefined,
  syncedAt: string | null | undefined,
): {newer: number; unknown: number} {
  if (!messages?.length || !syncedAt) return {newer: 0, unknown: 0}
  const sync = toEpoch(syncedAt)
  if (sync === null) return {newer: 0, unknown: messages.length}

  let newer = 0
  let unknown = 0
  for (const m of messages) {
    const t = m.timestamp ? toEpoch(m.timestamp) : null
    if (t === null) unknown++
    else if (t > sync) newer++
  }
  return {newer, unknown}
}

/**
 * An API timestamp as milliseconds, or null if it will not parse.
 *
 * The compile routes serve naive ISO strings (`2026-09-07T08:28:05.809735`),
 * which `Date.parse` reads as local time. A `Z`-suffixed value mixed into the
 * same comparison would otherwise shift by the local offset and invent newer
 * messages, so the zone marker is dropped and every value is read on one
 * clock. Comparing the raw strings instead would have the same flaw.
 */
function toEpoch(iso: string): number | null {
  const naive = iso.trim().replace(/(?:Z|[+-]\d{2}:?\d{2})$/, '')
  const ms = Date.parse(naive)
  return Number.isNaN(ms) ? null : ms
}

/**
 * The lines that say whether a compile still reflects the source text, and
 * whether a fresh compile would even be accepted. Empty when there is nothing
 * to report, so a caller can append the result unconditionally.
 *
 * Only known staleness speaks up. A source compiled before revisions were
 * recorded reads unknown, and calling that stale would send someone to pay for
 * a recompile they may not need.
 */
export function freshnessLines(
  s: {
    version?: number | null
    synced_version?: number | null
    compilable?: boolean | null
    compile_blocked_reason?: string | null
  },
  recompile: string,
  id?: string,
): string[] {
  const lines: string[] = []
  const behind = revisionsBehind(s)
  if (behind !== null) {
    lines.push(`Stale: the text is ${behind} revision(s) ahead of the last compile.`)
    if (s.compilable !== false) lines.push(`  Bring the compile up to date with: ${recompile}`)
  }

  if (s.compilable === false) {
    lines.push(`A compile would be refused: ${compileBlockedLabel(s.compile_blocked_reason)}.`)
    const fix = s.compile_blocked_reason ? COMPILE_BLOCKED_FIX[s.compile_blocked_reason] : undefined
    // The canned fix carries an `<id>` placeholder so the list commands can
    // print it once for many rows; a single source knows its own id, and a
    // line someone has to hand-edit before running is half a line.
    if (fix) lines.push(`  ${id ? fix.replaceAll('<id>', id) : fix}`)
  }

  return lines
}

/**
 * The same reading across a list: how many rows are stale, and how many the
 * server would refuse, grouped by reason.
 */
export function freshnessSummary(
  items: Array<{
    version?: number | null
    synced_version?: number | null
    compilable?: boolean | null
    compile_blocked_reason?: string | null
  }>,
  noun: string,
): string[] {
  let stale = 0
  const blocked = new Map<string, number>()
  for (const s of items) {
    if (revisionsBehind(s) !== null) stale++
    if (s.compilable === false) {
      const why = compileBlockedLabel(s.compile_blocked_reason) || 'refused'
      blocked.set(why, (blocked.get(why) ?? 0) + 1)
    }
  }

  const lines: string[] = []
  if (stale > 0) lines.push(`${stale} ${noun}(s) changed since the last compile and need recompiling.`)
  if (blocked.size > 0) {
    const parts = [...blocked.entries()].sort((a, b) => b[1] - a[1]).map(([why, n]) => `${n} ${why}`)
    lines.push(`${[...blocked.values()].reduce((a, b) => a + b, 0)} the server would refuse: ${parts.join(', ')}.`)
  }

  return lines
}

/**
 * What an upload warning means, and what to do about it.
 *
 * An upload answers 200 with a plausible `message_count` whether or not every
 * part of the file became a message, which is how one import bug survived
 * 2,843 room uploads: the only way to catch it was to re-read each thread
 * afterwards and count the turns. `warnings` is the server telling us instead,
 * so it has to be said out loud rather than left in --json.
 */
export const UPLOAD_WARNING_HELP: Record<string, {says: string; fix?: string}> = {
  unattributed_lines: {
    says: 'lines before the first recognised "Speaker:" prefix. They are not in the thread.',
    fix: 'If they matter, give them a speaker prefix and upload again.',
  },
  face_speaker_not_found: {
    says: 'the name given as --face-speaker matched nobody in the file, so this face has no turns of its own.',
    fix: 'Check how the name is spelled in the file and re-upload with --face-speaker set to that.',
  },
}

/**
 * The lines an upload should print about what did not make it in.
 *
 * `warning_count` is exact while the itemised list is capped, so the count is
 * read from the count and the items are only ever used to explain it.
 */
export function uploadWarningLines(result: {warnings?: unknown; warning_count?: unknown}): string[] {
  const items = Array.isArray(result.warnings) ? (result.warnings as Array<Record<string, unknown>>) : []
  const count = typeof result.warning_count === 'number' ? result.warning_count : items.length
  if (count === 0 && items.length === 0) return []

  const lines = [`Warning: ${count} part(s) of the file did not become messages.`]
  for (const w of items) {
    const code = typeof w.code === 'string' ? w.code : 'unknown'
    const help = UPLOAD_WARNING_HELP[code]

    // The server's own message carries the counts and the names, so it is the
    // better sentence. Ours stands in only when there is none, which the
    // open-ended entry shape allows. The remaining keys stay in --json rather
    // than being dumped here; this has to stay readable to be read.
    const said = typeof w.message === 'string' && w.message !== '' ? w.message : help?.says
    lines.push(`  ${code}: ${said ?? 'see --json for detail.'}`)
    if (help?.fix) lines.push(`    ${help.fix}`)
  }

  if (count > items.length) {
    lines.push(`  Showing ${items.length} of ${count}; the rest are in the same shape.`)
  }

  return lines
}

/**
 * Turn a pattern-shaped 422 into the sentence it was trying to be.
 *
 * A rejected enum comes back as `query → sort: String should match pattern
 * '^(created|alias|relevance|usage)$'`, which is the valid set and is also the
 * least readable way to say it. Rewritten rather than replaced by a local
 * allow-list, so a value the server adds tomorrow still works today.
 *
 * Returns the message unchanged when it is not that shape.
 */
export function readablePatternError(message: string): string {
  const m = /^(?:query|body) → ([a-z_]+): String should match pattern '\^\(([^)]+)\)\$'$/.exec(message.trim())
  if (!m) return message

  const [, field, alternatives] = m
  const values = alternatives.split('|').filter(Boolean)
  if (values.length === 0) return message

  return `--${field.replaceAll('_', '-')} must be one of: ${values.join(', ')}`
}

/**
 * The compile states the server publishes. Anything else is a state added
 * after this release, and the server says to read it as still running: a
 * newer value must never read as finished or as failed.
 */
const COMPILE_STATUSES = new Set([
  'not_compiled',
  'transcribing',
  'queued',
  'compiling',
  'compiled',
  'paused',
  'failed',
])

export function compileStatusOf(status: unknown): string | null {
  if (status === null || status === undefined || status === '') return null
  const s = String(status)
  return COMPILE_STATUSES.has(s) ? s : 'compiling'
}

/**
 * How far along a compile is, in words.
 *
 * `progress` runs from 0 to 1. A source that is `queued` is waiting behind its
 * face's other sources, or was interrupted and resumes on its own, so it reads
 * "queued" and never "0%": nothing is wrong and nothing is needed.
 *
 * `measurable` gates a percentage for a GROUP, a face or the whole account. The
 * server sends `progress: null` with `measurable: false` while a group cannot
 * be measured, during a transcription for one, and this does not invent a
 * number for it. A single source carries no `measurable` and does not need one.
 */
export function compileProgressLabel(g: {
  status?: string | null
  progress?: number | null
  measurable?: boolean | null
  starts_at?: string | null
  rush?: boolean | null
}, now: number = Date.now()): string {
  const status = compileStatusOf(g.status)
  if (status === 'queued') {
    // A queued compile with a scheduled start says when; a rush says it is one.
    const at = startsAtMs(g.starts_at)
    if (g.rush === true) return 'queued, rush'
    if (at !== undefined && at > now) return `queued, starts ${localTime(g.starts_at)}`
    return 'queued'
  }
  if (status === 'compiled' || status === 'not_compiled') {
    return status.replace('_', ' ')
  }

  // undefined means the field is absent, which is a source. false means a
  // group said not to. The two must not collapse into one test.
  const gated = g.measurable === undefined ? true : Boolean(g.measurable)
  const word = status ?? ''
  if (gated && typeof g.progress === 'number' && Number.isFinite(g.progress)) {
    const pct = `${Math.floor(Math.min(1, Math.max(0, g.progress)) * 100)}%`
    return word ? `${word}, ${pct}` : pct
  }

  return word || 'working, progress not known yet'
}

/**
 * A limit as a person reads it. The API spells unlimited as a negative
 * number, on the compile quota and the Connect allowance alike, and printed
 * raw that reads as "-1 tokens remaining": out, when the truth is the opposite.
 * Applied to human output only; --json keeps the number, which is the contract.
 */
export function readableLimit(n: unknown, unit = ''): string {
  if (typeof n !== 'number') return n === null || n === undefined ? '-' : String(n)
  if (n < 0) return 'unlimited'
  return unit ? `${n} ${unit}` : String(n)
}


/** --rush, on every command that compiles. */
export const RUSH_FLAG_DESCRIPTION =
  'Start the compile now, at the rush rate, rather than at its scheduled start. faces compile:stats shows ' +
  'both rates. A rush covered by a plan\'s compile allowance pays only the difference, from credit. Where ' +
  'a compile starts at once anyway, this changes nothing and costs nothing extra.'

/** Milliseconds for an API timestamp, or undefined. One with no zone is UTC, as the API means it. */
function startsAtMs(iso: unknown): number | undefined {
  if (typeof iso !== 'string' || !iso) return undefined
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`
  const ms = Date.parse(zoned)
  return Number.isNaN(ms) ? undefined : ms
}

/** "2026-10-22 15:00 PDT": an API timestamp in the local time zone. */
export function localTime(iso: unknown): string {
  const ms = startsAtMs(iso)
  if (ms === undefined) return typeof iso === 'string' ? iso : '-'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  const tz = new Intl.DateTimeFormat('en-US', {timeZoneName: 'short'}).formatToParts(d)
    .find((x) => x.type === 'timeZoneName')?.value
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}${tz ? ` ${tz}` : ''}`
}

/** "in 38 min", "in 1 h 5 min", or "now". */
function untilText(ms: number): string {
  const mins = Math.ceil(ms / 60_000)
  if (mins <= 0) return 'now'
  if (mins < 60) return `in ${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `in ${h} h ${m} min` : `in ${h} h`
}

/**
 * When a compile starts, for a person, from `starts_at`. Undefined when it is
 * null: the compile starts at once. A time still ahead is the scheduled start;
 * one already past is when it started.
 */
export function startsAtLine(iso: unknown, now: number = Date.now()): string | undefined {
  const ms = startsAtMs(iso)
  if (ms === undefined) return undefined
  return ms > now
    ? `Scheduled start: ${localTime(iso)} (${untilText(ms - now)})`
    : `Started: ${localTime(iso)}`
}

/**
 * Milliseconds until a compile's scheduled start, or 0 when it has none or it
 * has passed. A wait for a compile adds this to its timeout, which counts from
 * the start.
 */
export function msUntilStart(iso: unknown, now: number = Date.now()): number {
  const ms = startsAtMs(iso)
  return ms === undefined ? 0 : Math.max(0, ms - now)
}

/**
 * The lines a /make answer adds for a person: its scheduled start, and what
 * became of --rush.
 */
export function makeScheduleLines(resp: {starts_at?: unknown; rush?: unknown}, askedRush: boolean, now: number = Date.now()): string[] {
  const lines: string[] = []
  if (resp.rush === true) {
    lines.push('Rush: it starts now, at the rush rate.')
  } else {
    const start = startsAtLine(resp.starts_at, now)
    if (start) lines.push(start)
    if (askedRush && (resp.starts_at === null || resp.starts_at === undefined)) {
      lines.push('It starts now at the standard rate, so --rush changed nothing and costs nothing extra.')
    }
  }
  return lines
}

/**
 * The message for a refused /make, with what the CLI adds: the fix for a
 * blocked source, or the rush premium the API names when there is not enough
 * credit for a rush.
 */
export function makeRefusalMessage(err: FacesAPIError, id: string): string {
  const fix = err.errorCode ? COMPILE_BLOCKED_FIX[err.errorCode] : undefined
  if (fix) return `${err.message}\n${fix.replace('<id>', id)}`
  if (err.errorCode === 'insufficient_credit_for_rush') {
    const premium = err.details?.rush_premium_usd
    const line = typeof premium === 'number' ? `\nRush premium: ${usd(premium)}, paid from credit.` : ''
    return `${err.message}${line}`
  }
  // --rush on a compile that is already running: too late, and nothing changed.
  if (err.errorCode === 'compile_already_started') {
    return (
      `${err.message.split('\n')[0]}\n` +
      'It has already started, so --rush no longer applies: it carries on as it is, and nothing extra was charged.'
    )
  }
  // A plain make on a compile already queued. A rush is what moves it.
  if (err.statusCode === 409 && /already in progress/i.test(err.message)) {
    return `HTTP 409: ${err.message}\nIf it is waiting for its scheduled start, make it again with --rush to start it now.`
  }
  return `HTTP ${err.statusCode}: ${err.message}`
}

/**
 * A compile allowance figure as a person reads it. The API sends 0 for a plan
 * with no compile allowance and -1 for unlimited; printed raw they read as
 * "0 of 0" and "-1".
 */
export function compileLimitText(n: unknown): string {
  if (typeof n !== 'number') return n === null || n === undefined ? '-' : String(n)
  if (n < 0) return 'unlimited'
  if (n === 0) return 'none on this plan (compiles are paid per source token)'
  return `${n.toLocaleString('en-US')} source tokens`
}

/**
 * How a compile field reads in human output, or undefined to print it as it
 * is. `null` leaves the line out: a null `starts_at` means it starts at once,
 * and `rush: false` is the ordinary case.
 */
export function compileFieldLine(key: string, value: unknown, now: number = Date.now()): string | null | undefined {
  switch (key) {
    case 'tokens_limit':
      return typeof value === 'number' ? `compile allowance this month: ${compileLimitText(value)}` : undefined
    case 'tokens_used':
      return typeof value === 'number' ? `compiled this month: ${value.toLocaleString('en-US')} source tokens` : undefined
    case 'starts_at': {
      if (value === null || value === undefined) return null
      const line = startsAtLine(value, now)
      return line ? line.replace(/^Scheduled start:/, 'scheduled start:').replace(/^Started:/, 'started:') : undefined
    }
    case 'rush':
      if (value === false) return null
      return value === true ? 'rush: yes, at the rush rate' : undefined
    case 'rush_premium_usd':
      // Only while it waits for its scheduled start: what --rush adds now.
      if (value === null || value === undefined) return null
      if (typeof value !== 'number') return undefined
      return value === 0
        ? 'rush now: no extra charge on this plan (make again with --rush)'
        : `rush now: ${usd(value)} from credit (make again with --rush)`
    default:
      return undefined
  }
}
