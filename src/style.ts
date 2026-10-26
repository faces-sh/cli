/**
 * Shared helpers for the `style` command family.
 *
 * A style is built from a face's own writing, one per medium, and applied on
 * chat with `style`. It is a separate act from `compile`.
 *
 * The API names a source by a triple: id, medium, source_type. Users should
 * only ever have to give an id, so everything here exists to turn one into the
 * other from what the list endpoints already report.
 */
import {FacesClient, FacesAPIError} from './client.js'
import {seg} from './utils.js'

export const BUILDS_PATH = '/v1/style/builds'
export const VERSIONS_PATH = '/v1/style/versions'
export const STYLE_FACES_PATH = '/v1/style/faces'


/**
 * Medium assumed for a room that declares nothing at all.
 *
 * Only live threads reach this. An imported corpus always reports a
 * `corpus_medium`, so a room with none is a live conversation, and that is the
 * one case where the medium follows from the source type rather than from a
 * guess about content.
 */
export const LIVE_THREAD_MEDIUM = 'conversation'

/**
 * What an import reports when it could not tell what the material is.
 *
 * Not a medium, and must not be sent as one: the build rejects it. It means
 * the same as no answer, except that it came from imported material, where
 * assuming a conversation would be a guess about content rather than a fact
 * about the source type.
 */
const UNIDENTIFIED_CORPUS = 'unknown'

/** Exit code for "no such face", so a caller can tell it from a face with no style. */
export const EXIT_NO_SUCH_FACE = 4

/**
 * Whether a face exists at all.
 *
 * The style routes cannot answer this. `GET /v1/style/versions/{alias}`
 * returns the same 404 for a face that has no style as for a face that does not
 * exist, and `GET /v1/style/builds?self_face=` returns an empty list for
 * both. Those are opposite answers, so the face route is asked directly rather
 * than reporting one as the other.
 */
export async function faceExists(client: FacesClient, alias: string): Promise<boolean> {
  try {
    await client.get(`/v1/faces/${seg(alias)}`)
    return true
  } catch (err) {
    if (err instanceof FacesAPIError && err.statusCode === 404) return false
    // Anything else (network, auth, 5xx) is not evidence of absence.
    throw err
  }
}

/** A source the CLI can name in a build request. */
export interface Selectable {
  id: string
  sourceType: 'thread' | 'document'
  /** What the source itself declares. Undefined means nobody has said. */
  medium?: string
  /** A thread with no imported corpus behind it, i.e. a live conversation. */
  isLiveThread: boolean
  label: string
  synced: boolean
  /**
   * True for imported corpus material. Distinguishes it from a live thread,
   * which is the one source type a build may not compile for free.
   */
  isCorpus: boolean
  /**
   * Messages a capture would actually read, by the same rule intake applies.
   * Zero means the capture fails on this source. Undefined on documents and on
   * servers that predate the field.
   */
  authored?: number
  /** Present once this source has been printed. */
  printedAt?: string
  printedMedium?: string
}

/**
 * What goes on the wire.
 *
 * `medium` is optional and is sent only when the caller chose one. Omitting it
 * lets the server resolve from what the source already declares, which is
 * strictly safer than resolving here: reading the wrong field once filed three
 * corpus rooms as conversations, and a value we do not send cannot be wrong.
 *
 * `kind` was the old name and is refused rather than ignored, so there is no
 * chance of sending it by accident.
 */
export interface SourceRef {
  id: string
  medium?: string
  source_type: 'thread' | 'document'
}

interface RawRow {
  document_id?: string
  thread_id?: string
  label?: string | null
  medium?: string | null
  /** Derived from the thread's own messages, read-only. Absent on live threads. */
  corpus_medium?: string | null
  synced?: boolean | null
  authored_message_count?: number | null
  style?: {medium?: string; captured_at?: string} | null
}

/**
 * The medium a source already declares, or undefined when the caller has to.
 *
 * A live thread is the one case where the medium follows from the source type
 * rather than from a guess: it is a conversation because that is what a thread
 * is. Imported material is not: a corpus the importer could not classify could
 * be anything, and calling it a conversation would teach the wrong voice for a
 * medium with nothing afterwards to signal it happened.
 */
function mediumOf(r: RawRow, sourceType: 'thread' | 'document'): string | undefined {
  if (sourceType === 'document') return r.medium?.trim() || undefined
  // A room carries two: `medium` is the user's correction, `corpus_medium` is
  // what its messages arrived as. The correction wins, which is the same order
  // the server resolves in.
  const declared = r.medium?.trim() || r.corpus_medium?.trim()
  // `unknown` is what an import reports when a message declared nothing. It is
  // not a medium and the server refuses it, so it counts as undeclared here.
  return !declared || declared === UNIDENTIFIED_CORPUS ? undefined : declared
}

function rowToSelectable(r: RawRow, sourceType: 'thread' | 'document'): Selectable {
  const stamp = r.style ?? undefined
  return {
    id: String(r.document_id ?? r.thread_id ?? ''),
    sourceType,
    // A document declares its own medium. A room declares one only when it came
    // from a corpus import; anything else is a live conversation.
    medium: mediumOf(r, sourceType),
    label: r.label?.trim() || '(untitled)',
    synced: Boolean(r.synced),
    isCorpus: sourceType === 'document' || Boolean(r.corpus_medium?.trim()),
    isLiveThread: sourceType === 'thread' && !r.corpus_medium?.trim(),
    authored: r.authored_message_count ?? undefined,
    printedMedium: stamp?.medium,
    printedAt: stamp?.captured_at,
  }
}

function rowsOf(data: unknown): RawRow[] {
  if (Array.isArray(data)) return data as RawRow[]
  const obj = (data ?? {}) as Record<string, unknown>
  for (const key of ['documents', 'threads', 'data', 'items']) {
    if (Array.isArray(obj[key])) return obj[key] as RawRow[]
  }
  return []
}

/**
 * Every source on a face that a build could name.
 *
 * `include_uploads` matters: imported corpus rooms are excluded by default, and
 * they are the main thing a style build is made from.
 */
export async function listSelectable(client: FacesClient, alias: string): Promise<Selectable[]> {
  const a = encodeURIComponent(alias)
  const [docs, threads] = await Promise.all([
    client.get(`/v1/compile/documents?alias=${a}`),
    client.get(`/v1/compile/threads?alias=${a}&include_uploads=true`),
  ])

  const out = [
    ...rowsOf(docs).map((r) => rowToSelectable(r, 'document')),
    ...rowsOf(threads).map((r) => rowToSelectable(r, 'thread')),
  ]
  return out.filter((s) => s.id)
}

/**
 * Parse one `--source` value: `<id>` or `<id>:<medium>`.
 *
 * Ids are UUIDs, so the first colon separates cleanly and a medium containing
 * spaces ("academic paper") survives intact.
 */
export function parseSourceArg(raw: string): {id: string; medium?: string} {
  const at = raw.indexOf(':')
  if (at === -1) return {id: raw.trim()}
  return {id: raw.slice(0, at).trim(), medium: raw.slice(at + 1).trim() || undefined}
}

/**
 * Poll a style build until it stops.
 *
 * Returns the terminal payload including a failed one: whether a failure is an
 * error is the caller's decision, not this function's.
 */
export async function pollStyleJob(
  client: FacesClient,
  basePath: string,
  jobId: string,
  opts: {intervalMs?: number; timeoutMs?: number; onPoll?: (d: Record<string, unknown>) => void} = {},
): Promise<Record<string, unknown>> {
  const interval = opts.intervalMs ?? 3000
  const timeout = opts.timeoutMs ?? 3_600_000
  const start = Date.now()
  const endpoint = `${basePath}/${encodeURIComponent(jobId)}`

  while (true) {
    if (Date.now() - start > timeout) {
      throw new Error(
        `Timed out after ${Math.round(timeout / 1000)}s. The build may still finish; read it later with: faces style:status ${jobId}`,
      )
    }
    await new Promise((r) => setTimeout(r, interval))

    let data: Record<string, unknown>
    try {
      data = (await client.get(endpoint)) as Record<string, unknown>
    } catch (err) {
      // A 5xx mid-poll is transient. Anything else is real and propagates.
      if (err instanceof FacesAPIError && err.statusCode >= 500) continue
      throw err
    }

    opts.onPoll?.(data)
    const status = String(data.status ?? '')
    if (status === 'done' || status === 'failed') return data
  }
}

/**
 * The reference a server fault ends with ("... Reference 1a2b3c4d5e6f."), kept
 * so a report can be traced. A fault is told apart by this, by a 500, or by an
 * internal error code, never by reading the text for anything else: the text is
 * not shown, since it can tell the user nothing they can act on.
 */
const FAULT_REFERENCE = /\bReference ([0-9a-f]{6,})\.?\s*$/i

/** Whether a failure is the server's own fault, and its reference when it gave one. */
export function internalFault(
  error: string,
  status?: number,
  errorCode?: string,
): {reference?: string} | undefined {
  const ref = FAULT_REFERENCE.exec(error.trim())
  const internal = status === 500 || Boolean(ref) || /^INTERNAL/i.test(errorCode ?? '')
  return internal ? {reference: ref?.[1]} : undefined
}

/**
 * Whether a ChatGPT account is linked, or undefined when that cannot be read
 * (the route needs a login, not an API key).
 */
export async function chatgptLinked(client: FacesClient): Promise<boolean | undefined> {
  try {
    const rows = (await client.get('/v1/oauth', {requireJwt: true})) as Array<Record<string, unknown>>
    return Array.isArray(rows) && rows.some((r) => r.provider === 'openai')
  } catch {
    return undefined
  }
}

/** Failure text, with the one hint that is actionable rather than descriptive. */
export function jobFailureMessage(error: unknown, linked?: boolean, errorCode?: unknown, status?: number): string {
  const e = typeof error === 'string' && error ? error : 'unknown error'
  // A failed build names its code in `error_code`; older ones only led the
  // error text with it.
  const code = (typeof errorCode === 'string' && errorCode ? errorCode : e).toUpperCase()

  const fault = internalFault(e, status, typeof errorCode === 'string' ? errorCode : undefined)
  if (fault) {
    const ref = fault.reference ? ` Quote reference ${fault.reference} and` : ' Quote'
    return (
      'the server failed internally, so nothing was installed. This is a fault on the server, not ' +
      `something you did, and re-running is unlikely to help.${ref} the job id from above if you report it.`
    )
  }
  if (code.startsWith('CHATGPT_AUTH')) {
    // The server says "sign-in expired" whether or not anything was linked;
    // telling someone who never linked an account that it expired sends them
    // looking for a link they do not have.
    const cause = linked === false
      ? 'No ChatGPT account is linked, so the build had nothing to run on. Link one with: faces auth:connect openai\n'
      : linked === true
        ? 'The ChatGPT link was refused, most likely expired. Reconnect it with: faces auth:connect openai\n'
        : 'The ChatGPT link was refused: it has expired, or none is linked. Check with: faces auth:connections, then: faces auth:connect openai\n'
    return (
      `${e}\n` +
      cause +
      'Your uploaded material is preserved, so re-running costs nothing extra. Do not switch to a ' +
      'paid model to get around this: it turns a login problem into a bill.'
    )
  }
  // The free route refused, and each code has a different fix. A build is free or it does not run unless the caller
  // passed --allow-paid, so the paid way out is named as a choice, not taken.
  if (code.startsWith('CONNECT_REQUIRED')) {
    return (
      `${e}\n` +
      'A build on the ChatGPT route needs Connect or Pro with ChatGPT linked, and this account is not on ' +
      'either. Re-run with --allow-paid to pay from credits, or subscribe: faces billing:subscription:activate'
    )
  }
  // An automatic build that credit could not cover is not started, and is
  // tried again later. A manual one is refused before it starts instead.
  if (code.startsWith('INSUFFICIENT_CREDIT_FOR_STYLE_BUILD')) {
    return (
      `${e}\n` +
      'Not enough credit for this build, so it was not started and nothing was charged. Top up with: ' +
      'faces billing:topup --amount <usd>. An automatic build is tried again later. On Connect or Pro, a ' +
      'linked ChatGPT account builds at no charge: faces auth:connect openai'
    )
  }
  if (code.startsWith('MODEL_NOT_FREE')) {
    return (
      `${e}\n` +
      'That model is not Codex-eligible, so it cannot run on a linked ChatGPT plan. Leave out --model to build on the default model, or re-run ' +
      'with --allow-paid if you meant to pay.'
    )
  }
  return e
}

/**
 * Fields printed from a build report, and the only ones.
 *
 * A whitelist rather than a filter, because the report carries internal
 * analysis keys that must not reach a user's screen and this package ships its
 * compiled source to npm. Naming the unwanted keys in order to strip them would
 * publish them; naming only the wanted ones cannot.
 */
const REPORT_FIELDS: Array<[string, string]> = [
  ['corpus_threads', 'threads read'],
]

/**
 * Report keys that may leave this CLI, in --json as much as on screen.
 *
 * The report also carries internal analysis keys. Those are excluded by being
 * absent from this list rather than by being named and removed: this package
 * publishes its compiled source to npm, so naming them in order to strip them
 * would publish them.
 */
const REPORT_PUBLIC_KEYS = new Set([
  'corpus_threads',
  'served_by',
  'skipped_third_person',
  'thin_corpus',
  'auto',
])

/**
 * Keys of `report.auto` that may leave, by the same rule as the report itself.
 * These are the ones the docs name; anything added beside them stays behind
 * until someone decides it should not.
 */
const AUTO_PUBLIC_KEYS = ['medium', 'multiple', 'words', 'threshold', 'trigger', 'oauth_only']

/** Keys of a skipped document that may leave, when the server sends objects rather than ids. */
const SKIPPED_PUBLIC_KEYS = ['id', 'document_id', 'label', 'medium']

function pick(obj: unknown, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!obj || typeof obj !== 'object') return out
  for (const k of keys) if (k in (obj as Record<string, unknown>)) out[k] = (obj as Record<string, unknown>)[k]
  return out
}

/**
 * A job payload safe to hand onward, with its report reduced to public fields.
 *
 * Applied to --json too. A machine consumer reading our output is as much a way
 * for an internal key to escape as a terminal is.
 */
export function publicJob(data: Record<string, unknown>): Record<string, unknown> {
  const report = data.report as Record<string, unknown> | null | undefined
  if (!report || typeof report !== 'object') return data
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(report)) {
    if (REPORT_PUBLIC_KEYS.has(k)) clean[k] = v
  }
  // The three new keys are whitelisted one level further down as well. They
  // are open-shaped objects, and an internal key arriving inside one would
  // otherwise ride out on the strength of its parent's name.
  if (clean.auto && typeof clean.auto === 'object') clean.auto = pick(clean.auto, AUTO_PUBLIC_KEYS)
  if (clean.served_by && typeof clean.served_by === 'object') clean.served_by = pick(clean.served_by, ['route', 'model', 'fell_back'])
  if (Array.isArray(clean.skipped_third_person)) {
    clean.skipped_third_person = clean.skipped_third_person.map((d) =>
      d !== null && typeof d === 'object' ? pick(d, SKIPPED_PUBLIC_KEYS) : d,
    )
  }
  if (clean.thin_corpus && typeof clean.thin_corpus === 'object') {
    const thin: Record<string, unknown> = {}
    for (const [medium, v] of Object.entries(clean.thin_corpus as Record<string, unknown>)) {
      thin[medium] = pick(v, ['words', 'threshold'])
    }
    clean.thin_corpus = thin
  }
  return {...data, report: clean}
}

/**
 * What a build is for, in one cell.
 *
 * A job carries `medium` when it was started for exactly one, and `media` for
 * the whole set. `medium` is deliberately null on a job spanning several rather
 * than picking one, so the set is what to fall back to. Jobs created before
 * these were stamped carry neither.
 */
export function jobMedium(job: Record<string, unknown>): string | undefined {
  const one = job.medium
  if (typeof one === 'string' && one.trim()) return one
  const many = job.media
  if (Array.isArray(many) && many.length > 0) return many.join(', ')
  return undefined
}

/** Human-readable build summary. Never dumps the report. */
export function formatBuildReport(data: Record<string, unknown>): string[] {
  const report = (data.report ?? {}) as Record<string, unknown>
  const pairs: Array<[string, unknown]> = [
    ['job', data.job_id ?? '-'],
    ['status', data.status ?? '-'],
  ]
  // Which medium this build is for. Worth showing from the first poll, because
  // a build started elsewhere is otherwise an unnamed thing in progress.
  const medium = jobMedium(data)
  if (medium) pairs.push(['medium', medium])
  if (data.version_id) pairs.push(['version', data.version_id])

  for (const [key, label] of REPORT_FIELDS) {
    const v = report[key]
    if (v !== undefined && v !== null) pairs.push([label, v])
  }

  const served = servedBy(report)
  if (served) pairs.push(['served by', served])

  const auto = autoTrigger(data)
  if (auto) pairs.push(['started by', auto])

  const width = Math.max(...pairs.map(([label]) => label.length)) + 2
  const lines = pairs.map(([label, v]) => `${(label + ':').padEnd(width)}${v}`)
  return [...lines, ...reportWarnings(data)]
}

/**
 * Which route ran the build, in one phrase. On a paid plan with ChatGPT linked
 * it runs through the link at no charge; anywhere else it runs on Faces and is
 * charged to credits. A link that fails part-way carries on with Faces and
 * says it fell back.
 */
export function servedBy(report: Record<string, unknown>): string | undefined {
  const s = report.served_by as Record<string, unknown> | null | undefined
  if (!s || typeof s !== 'object') return undefined
  const where = s.route === 'chatgpt' ? 'your linked ChatGPT account' : s.route === 'faces' ? 'Faces' : String(s.route ?? '-')
  const model = typeof s.model === 'string' ? ` (${s.model})` : ''
  // Off the link a build is charged to credits; after a fall-back, only the
  // part the link did not serve.
  const charged = s.route !== 'faces' ? '' : s.fell_back ? ', the rest charged to credits' : ', charged to credits'
  return `${where}${model}${s.fell_back ? ', after the ChatGPT link failed' : ''}${charged}`
}

/**
 * Why an automatic capture ran, in one phrase, or undefined for a manual one.
 *
 * `report.auto` is the only mark an automatic capture carries. Without it in
 * the output, a style that changed overnight looks like something nobody did.
 */
export function autoTrigger(job: Record<string, unknown>): string | undefined {
  const auto = (job.report as Record<string, unknown> | null | undefined)?.auto as
    | Record<string, unknown>
    | undefined
  if (!auto || typeof auto !== 'object') return undefined
  const parts = ['automatic build']
  if (typeof auto.trigger === 'string') parts.push(`after ${auto.trigger === 'compile' ? 'a compile' : 'an upload'}`)
  if (typeof auto.words === 'number' && typeof auto.threshold === 'number') {
    const at = typeof auto.multiple === 'number' && auto.multiple > 1 ? `${auto.multiple}x ` : ''
    parts.push(`(${auto.words} words, past ${at}the ${auto.threshold}-word threshold)`)
  }
  return parts.join(' ')
}

/**
 * The finished report's two warnings, as sentences.
 *
 * Both describe a style that installed and is weaker than it looks: one left
 * material out, the other rests on a small sample. Neither stops anything,
 * which is exactly why they have to be said rather than left in --json.
 */
export function reportWarnings(job: Record<string, unknown>): string[] {
  const report = (job.report ?? {}) as Record<string, unknown>
  const lines: string[] = []

  const skipped = report.skipped_third_person
  if (Array.isArray(skipped) && skipped.length > 0) {
    const ids = skipped
      .map((d) => (d !== null && typeof d === 'object' ? (d as Record<string, unknown>).id ?? (d as Record<string, unknown>).document_id : d))
      .filter((v) => typeof v === 'string' && v)
    lines.push(
      `Left out ${skipped.length} third-person document(s): writing about this person does not go into a style.` +
        (ids.length > 0 ? ` ${ids.join(', ')}` : ''),
    )
    lines.push('  If one is really their own writing, mark it: faces compile:doc:edit <id> --perspective first-person')
  }

  const thin = report.thin_corpus
  if (thin && typeof thin === 'object') {
    for (const [medium, v] of Object.entries(thin as Record<string, unknown>)) {
      const t = (v ?? {}) as {words?: unknown; threshold?: unknown}
      const n = typeof t.words === 'number' ? `${t.words} words` : 'a small sample'
      const of = typeof t.threshold === 'number' ? ` (the automatic threshold is ${t.threshold})` : ''
      lines.push(`Thin sample for ${medium}: built from ${n}${of}. It is installed, but rests on little writing.`)
    }
  }

  return lines
}

/**
 * A style build refused for want of credit (402
 * `insufficient_credit_for_style_build`), as the decision it leaves: what the
 * build is estimated to cost at most, what the balance is, and the two ways on.
 */
export function styleCreditRefusal(details: Record<string, unknown> | undefined): string {
  const est = details?.estimated_usd
  const bal = details?.balance_usd
  const usd = (n: number) => `$${n.toFixed(2)}`
  const figures = typeof est === 'number' && typeof bal === 'number'
    ? ` It is estimated at up to ${usd(est)}, and your balance is ${usd(bal)}.`
    : typeof est === 'number' ? ` It is estimated at up to ${usd(est)}.` : ''
  const short = typeof est === 'number' && typeof bal === 'number' && est > bal ? Math.ceil(est - bal) : undefined
  return (
    `Not enough credit for this style build, which is charged to credits.${figures}\n` +
    `Top up with: faces billing:topup --amount ${short ?? '<usd>'}` +
    ', or on Connect or Pro link ChatGPT to build there at no charge: faces auth:connect openai\n' +
    'Nothing was started, and nothing was charged.'
  )
}
