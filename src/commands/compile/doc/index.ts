import {Args, Flags} from '@oclif/core'
import fs from 'node:fs'
import path from 'node:path'
import {BaseCommand} from '../../../base.js'
import {MEDIUM_MISSING_MESSAGE, MEDIUM_REQUIRED_DESCRIPTION, RUSH_FLAG_DESCRIPTION, compileCostNote, compileRate, compileStatusOf, makeRefusalMessage, makeScheduleLines, seg, readTextFile, documentWarningLines} from '../../../utils.js'
import {FacesAPIError} from '../../../client.js'
import {pollCompileProgress, PollProgress, progressLine} from '../../../poll.js'

/** One input source, resolved to text before anything is sent. */
interface Source {
  /** Display name: the file path, or "(--content)" for inline text. */
  name: string
  content?: string
  /** Set when the file could not be read; the slot is kept so order survives. */
  readError?: string
}

/** Per-source outcome, reported in input order so a caller can line them up. */
interface DocResult {
  file: string
  document_id?: string
  /** What /make answered: `queued` when it waits behind the face's other sources. */
  status?: string
  /** The scheduled start /make answered; null when it starts at once. */
  starts_at?: string | null
  /** Queued as a rush. */
  rush?: boolean
  error?: string
  /** The document exists even though its compile was refused. */
  saved?: boolean
  /** What the server said about the saved document, as it said it. */
  warnings?: unknown[]
  /** Final poll result, kept so a single-source call can echo it at the top level. */
  compiled?: Record<string, unknown>
}

export default class CompileDoc extends BaseCommand {
  static description =
    'Compile one or more documents into a face (create → make in one step). ' +
    'Repeat --file to submit several documents in a single command; each file becomes its own ' +
    'document rather than being concatenated. A document is the face\'s own writing, and every word in ' +
    'it is read as theirs. An interview, transcript or dialogue is a thread: upload it with ' +
    'faces compile:upload ALIAS --file FILE --kind thread --face-speaker NAME.'

  static examples = [
    '<%= config.bin %> <%= command.id %> alice --file notes.txt',
    '<%= config.bin %> <%= command.id %> alice --file a.txt --file b.txt --file c.txt --no-wait --json',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    label: Flags.string({description: 'Document label/title (single document only; with several files each is labelled by its filename)'}),
    content: Flags.string({description: 'Inline text content', exclusive: ['file']}),
    file: Flags.string({description: 'Read content from file (repeatable; each file becomes its own document)', multiple: true}),
    medium: Flags.string({description: MEDIUM_REQUIRED_DESCRIPTION}),
    perspective: Flags.string({
      description:
        'Who wrote it. first-person (default) means the subject did; third-person means it is ABOUT ' +
        'them. Get this wrong and someone else\'s writing is compiled as the subject\'s own. Third-person ' +
        'material compiles, but never goes into a style.',
      options: ['first-person', 'third-person'],
      default: 'first-person',
    }),
    timeout: Flags.integer({description: 'Compile timeout in seconds, per document, counted from its start', default: 600}),
    rush: Flags.boolean({description: RUSH_FLAG_DESCRIPTION, default: false}),
    'no-wait': Flags.boolean({
      description: 'Create and trigger compilation, then return immediately without polling.',
      default: false,
    }),
  }

  static args = {
    face_id: Args.string({description: 'Face alias', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CompileDoc)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()

    const files = flags.file ?? []
    if (files.length === 0 && !flags.content) this.error('Provide --content or --file.')
    if (flags.label && files.length > 1) {
      this.error('--label applies to a single document. With several --file flags each document is labelled by its filename.')
    }

    // Refused before reading or creating anything: the server will not save
    // a document that has not said what it is.
    if (!flags.medium) this.error(MEDIUM_MISSING_MESSAGE)

    // Read every source up front, keeping failures in place rather than
    // collecting them separately: results must come back in input order so a
    // caller can line them up against what it passed. A file that cannot be
    // used is a per-file failure, not a reason to abandon the files that are
    // fine: a whole-call failure leaves the caller unable to tell which file
    // was at fault.
    const sources: Source[] = files.map((file) => {
      try {
        return {name: file, content: readTextFile(file)}
      } catch (err) {
        return {name: file, readError: err instanceof Error ? err.message : String(err)}
      }
    })
    if (flags.content) sources.push({name: '(--content)', content: flags.content})

    const results: DocResult[] = []
    const multi = files.length > 1
    const started: Array<{source: Source; docId: string; status?: string; startsAt?: string | null}> = []

    let rate: number | undefined
    for (const source of sources) {
      if (source.readError !== undefined) {
        results.push({file: source.name, error: source.readError})
        continue
      }
      // Set once the document exists, so a compile refused afterwards is
      // reported as saved-but-not-compiled rather than as not accepted.
      let savedId: string | undefined
      let warnings: unknown[] | undefined
      try {
        const payload: Record<string, unknown> = {alias: args.face_id, content: source.content}
        if (flags.label) payload.label = flags.label
        else if (multi) payload.label = path.basename(source.name)
        payload.medium = flags.medium
        if (flags.perspective) payload.perspective = flags.perspective

        if (!json) process.stderr.write(`Creating document${multi ? ` (${source.name})` : ''}... `)
        const doc = (await client.post('/v1/compile/documents', {body: payload})) as Record<string, unknown>
        const docId = String(doc.document_id ?? doc.id ?? '')
        if (!docId) throw new Error('Server did not return a document_id')
        savedId = docId
        if (!json) process.stderr.write(`done (${docId})\n`)
        // Saved either way. A transcript sent as a document is read as the
        // face saying every line, so say so and name the thread upload.
        const file = source.name === '(--content)' ? undefined : source.name
        for (const line of documentWarningLines(doc, source.content, args.face_id, file)) process.stderr.write(`${line}\n`)
        if (Array.isArray(doc.warnings) && doc.warnings.length > 0) warnings = doc.warnings
        // The size is exact once the document exists, and nothing is billed yet.
        if (typeof doc.token_count === 'number' && doc.token_count >= 10_000) {
          const note = compileCostNote(doc.token_count, (rate ??= await compileRate(client)))
          if (note) process.stderr.write(`${note}\n`)
        }

        const makeResponse = (await client.post(
          `/v1/compile/documents/${seg(docId)}/make`,
          flags.rush ? {body: {rush: true}} : {},
        )) as Record<string, unknown>
        const status = compileStatusOf(makeResponse.status) ?? undefined
        const startsAt = typeof makeResponse.starts_at === 'string' ? makeResponse.starts_at : null
        if (!json) for (const line of makeScheduleLines(makeResponse, flags.rush)) process.stderr.write(`${line}\n`)

        started.push({source, docId, status, startsAt})
        const result: DocResult = {file: source.name, document_id: docId, status}
        if (warnings) result.warnings = warnings
        if ('starts_at' in makeResponse) result.starts_at = startsAt
        if (typeof makeResponse.rush === 'boolean') result.rush = makeResponse.rush
        results.push(result)
      } catch (err) {
        if (!json) process.stderr.write('failed\n')
        // A refused /make carries the fix, or the rush premium; a refused create does not.
        const message = err instanceof FacesAPIError
          ? (savedId ? makeRefusalMessage(err, savedId) : `HTTP ${err.statusCode}: ${err.message}`)
          : err instanceof Error ? err.message : String(err)
        results.push(savedId
          ? {file: source.name, document_id: savedId, saved: true, error: `saved, but not compiled: ${message}`, ...(warnings ? {warnings} : {})}
          : {file: source.name, error: message})
      }
    }

    if (started.length === 0) {
      // Nothing was accepted: report every reason, then fail.
      for (const r of results) if (r.error) process.stderr.write(`${r.file}: ${r.error}\n`)
      const saved = results.filter((r) => r.saved).length
      if (saved > 0) {
        this.error(
          `${saved} of ${results.length} document(s) were saved but none could be compiled; the reasons are above. ` +
            `They are listed in: faces face:sources ${args.face_id}`,
        )
      }
      this.error(results.length === 1 ? 'Document was not accepted.' : 'No documents were accepted.')
    }

    if (!json) for (const r of results) if (r.error) process.stderr.write(`${r.file}: ${r.error}\n`)

    if (flags['no-wait']) {
      if (!json) {
        for (const s of started) {
          process.stderr.write(`Compilation started in background${s.status === 'queued' ? ' (queued)' : ''}: ${s.docId}\n`)
        }
        process.stderr.write(`Poll with: faces compile:doc:get <id> --json\n`)
      }
      return this.shape(results)
    }

    for (const s of started) {
      if (!json) process.stderr.write(`Compiling${multi ? ` ${s.source.name}` : ''}:\n`)
      try {
        const result = (await pollCompileProgress(client, s.docId, {
          timeoutMs: flags.timeout * 1000,
          startsAt: s.startsAt,
          onProgress: (p: PollProgress) => {
            if (!json) process.stderr.write(`  ${progressLine(p)}\n`)
          },
        })) as Record<string, unknown>
        const hit = results.find((r) => r.document_id === s.docId)
        if (hit) hit.compiled = result
      } catch (err) {
        const hit = results.find((r) => r.document_id === s.docId)
        if (hit) hit.error = err instanceof Error ? err.message : String(err)
        if (!json) process.stderr.write(`${s.source.name}: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    }

    if (!json) process.stderr.write('Done.\n')
    return this.shape(results)
  }

  /**
   * `documents` is always present and always in input order. For a single
   * source the compiled/started body is also spread at the top level, so
   * callers that already read `.document_id` keep working.
   */
  private shape(results: DocResult[]): Record<string, unknown> {
    const documents = results.map((r) => {
      const out: Record<string, unknown> = {file: r.file}
      if (r.document_id) out.document_id = r.document_id
      if (r.status !== undefined) out.status = r.status
      if (r.starts_at !== undefined) out.starts_at = r.starts_at
      if (r.rush !== undefined) out.rush = r.rush
      if (r.error) out.error = r.error
      if (r.warnings) out.warnings = r.warnings
      return out
    })

    const body: Record<string, unknown> = {documents}
    if (results.length === 1) {
      const only = results[0]
      Object.assign(body, only.compiled ?? {}, only.document_id ? {document_id: only.document_id} : {})
      if (only.status !== undefined && body.status === undefined) body.status = only.status
      if (only.starts_at !== undefined && body.starts_at === undefined) body.starts_at = only.starts_at
      if (only.rush !== undefined && body.rush === undefined) body.rush = only.rush
      body.documents = documents
    }
    return body
  }
}

/** Extensions the compile-documents endpoint takes as inline text. */
