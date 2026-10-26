import {Args, Flags} from '@oclif/core'
import fs from 'node:fs'
import path from 'node:path'
import {BaseCommand} from '../../base.js'
import {MEDIUM_MISSING_MESSAGE, MEDIUM_REQUIRED_DESCRIPTION, readTextFile, documentWarningLines, withoutWarnings, uploadWarningLines, seg} from '../../utils.js'
import {FacesAPIError} from '../../client.js'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export default class CompileUpload extends BaseCommand {
  static description =
    'Upload a file (text/PDF/Word .docx/audio/video) to compile into a face. A document (the default) ' +
    'is the face\'s own writing, and every word in it is read as theirs. An interview, transcript or ' +
    'dialogue is a thread: upload it with --kind thread --face-speaker NAME, so only the face\'s turns ' +
    'are used.'

  static examples = [
    '<%= config.bin %> <%= command.id %> alice --file essay.txt --medium essay --perspective first-person',
    '<%= config.bin %> <%= command.id %> alice --file interview.txt --kind thread --face-speaker Alice',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    file: Flags.string({description: 'File to upload', required: true}),
    kind: Flags.string({
      description:
        'document: the face\'s own writing (or, with --perspective third-person, writing about them). ' +
        'thread: an exchange between speakers (an interview, transcript or dialogue), with --face-speaker ' +
        'naming the face. A transcript uploaded as a document is read as entirely the face\'s words.',
      options: ['document', 'thread'],
      default: 'document',
    }),
    perspective: Flags.string({
      description:
        'Who wrote it (document only). Defaults to third-person, meaning the file is ABOUT the subject, ' +
        'because an uploaded file is as often somebody else\'s writing. Pass first-person for the ' +
        "subject's own writing, which is the only kind a style can be built from. Note compile:doc " +
        'defaults the other way, since text pasted in is usually theirs.',
      options: ['first-person', 'third-person'],
      default: 'third-person',
    }),
    medium: Flags.string({
      description:
        MEDIUM_REQUIRED_DESCRIPTION +
        ' Required with --kind document, and only valid with it.',
    }),
    'face-speaker': Flags.string({
      description:
        'The speaker who is the face (thread only), as labelled in the file ("Alice" for "Alice: ..." ' +
        'lines, or "A" for a recording). Only that speaker\'s turns are used. If omitted, the speaker ' +
        'matching the face\'s name is used, or else the first speaker, so set it to be sure.',
    }),
    'no-wait': Flags.boolean({
      description: 'Return immediately after upload (do not poll for transcription). Prints the ID for manual polling.',
      default: false,
    }),
  }

  static args = {
    alias: Args.string({description: 'Face alias', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CompileUpload)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()

    if (!fs.existsSync(flags.file)) this.error(`File not found: ${flags.file}`)

    // The API accepts medium for document uploads only: a thread carries a kind
    // per message, derived from the file. Refuse here rather than on a 422.
    if (flags.medium && flags.kind !== 'document') {
      this.error(`--medium applies to --kind document only (got --kind ${flags.kind}); a thread carries a kind per message.`)
    }
    // The server will not save a document that has not said what it is, so
    // refuse before uploading it.
    if (!flags.medium && flags.kind === 'document') this.error(MEDIUM_MISSING_MESSAGE)

    // Plain text, for the transcript check on an older server that does not
    // say whether a document reads as one.
    let text: string | undefined
    if (flags.kind === 'document') {
      try {
        text = readTextFile(flags.file)
      } catch {
        // Not plain text (PDF, Word, audio): nothing to read here.
      }
    }

    const filename = path.basename(flags.file)
    const fileBlob = new Blob([fs.readFileSync(flags.file)], {type: 'application/octet-stream'})
    const form = new FormData()
    form.append('file', fileBlob, filename)

    const params = new URLSearchParams()
    params.set('type', flags.kind)
    if (flags.medium) params.set('medium', flags.medium)
    params.set('perspective', flags.perspective)
    if (flags['face-speaker']) params.set('face_speaker', flags['face-speaker'])

    let data: Record<string, unknown>
    try {
      data = await client.postForm(`/v1/faces/${seg(args.alias)}/upload?${params}`, form) as Record<string, unknown>
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    // The document is saved either way. A transcript sent as one is read as
    // the face saying every line, so say so and name the thread upload.
    if (flags.kind === 'document') {
      for (const line of documentWarningLines(data, text, args.alias, flags.file)) process.stderr.write(`${line}\n`)
    }

    // If transcribing (audio/video upload), poll until complete: unless --no-wait
    if (data.status === 'transcribing' && flags['no-wait']) {
      const id = (data.thread_id ?? data.document_id) as string
      if (!json) {
        process.stderr.write(`Transcription started in background.\n`)
        process.stderr.write(`Poll with: faces compile:${flags.kind === 'thread' ? 'thread' : 'doc'}:get ${id} --json\n`)
      }
      return data
    }

    if (data.status === 'transcribing') {
      const id = (data.thread_id ?? data.document_id) as string
      const endpoint = flags.kind === 'thread'
        ? `/v1/compile/threads/${seg(id)}`
        : `/v1/compile/documents/${seg(id)}`

      if (!json) process.stderr.write('Transcribing...\n')

      const timeout = 3600_000 // 1 hour
      const start = Date.now()
      while (Date.now() - start < timeout) {
        await sleep(5000)
        try {
          const poll = await client.get(endpoint) as Record<string, unknown>
          const status = poll.status as string | null
          if (status !== 'transcribing') {
            data = poll
            if (!json) {
              if (status === 'failed') {
                process.stderr.write('Transcription failed.\n')
              } else {
                const msgCount = poll.message_count ?? 0
                process.stderr.write(`Transcription complete: ${msgCount} messages\n`)
              }
            }
            break
          }
          if (!json) process.stderr.write('Transcribing...\n')
        } catch {
          // Transient error: keep polling
        }
      }
    }

    if (!json) {
      // A document's warnings were printed on their own, above.
      this.printHuman(flags.kind === 'document' ? withoutWarnings(data) : data)

      // Say what did not make it in. The upload reports 200 either way, so
      // silence here is indistinguishable from a clean import.
      // A document's warnings were printed when it was saved.
      const warnings = flags.kind === 'thread' ? uploadWarningLines(data) : []
      if (warnings.length > 0) {
        this.log('')
        for (const line of warnings) this.log(line)
      }

      if (flags.kind === 'thread' && data.thread_id) {
        this.log(`\nReview the transcript:`)
        this.log(`  faces compile:thread:get ${data.thread_id}`)
        this.log(`\nWhen ready to compile:`)
        this.log(`  faces compile:thread:make ${data.thread_id}`)
      } else if (flags.kind === 'document' && data.document_id) {
        this.log(`\nReview the document:`)
        this.log(`  faces compile:doc:get ${data.document_id}`)
        this.log(`\nWhen ready to compile:`)
        this.log(`  faces compile:doc:make ${data.document_id}`)
      }
    }

    return data
  }
}
