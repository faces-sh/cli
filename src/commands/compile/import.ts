import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {MEDIUM_MISSING_MESSAGE, MEDIUM_REQUIRED_DESCRIPTION, seg} from '../../utils.js'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export default class CompileImport extends BaseCommand {
  static description = 'Import a YouTube video into a face via server-side download and transcription'

  static flags = {
    ...BaseCommand.baseFlags,
    url: Flags.string({
      description: 'YouTube URL (youtube.com/watch?v=... or youtu.be/...)',
      required: true,
    }),
    type: Flags.string({
      description:
        '"document" for the face speaking alone (a talk, a lecture, a monologue); "thread" for an interview ' +
        'or any recording with more than one speaker, so only the face\'s turns are used. A recording with ' +
        'other speakers imported as a document is read as entirely the face\'s words.',
      options: ['document', 'thread'],
      default: 'document',
    }),
    perspective: Flags.string({
      description: '"first-person" if the face is the speaker; "third-person" if the video is about the face',
      options: ['first-person', 'third-person'],
      default: 'third-person',
    }),
    medium: Flags.string({
      description: MEDIUM_REQUIRED_DESCRIPTION + ' Required with --type document, and only valid with it.',
    }),
    'face-speaker': Flags.string({
      description: 'For --type thread: the speaker label (e.g. "A") that is the face. Defaults to the first detected speaker.',
    }),
    'no-wait': Flags.boolean({
      description: 'Return immediately after import starts (do not poll for transcription). Prints the ID for manual polling.',
      default: false,
    }),
  }

  static args = {
    face_id: Args.string({description: 'Face alias', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CompileImport)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()

    if (flags['face-speaker'] && flags.type !== 'thread') {
      this.error('--face-speaker is only valid with --type thread')
    }
    if (flags.medium && flags.type !== 'document') {
      this.error(`--medium applies to --type document only (got --type ${flags.type}); a thread carries a kind per message.`)
    }
    // The server will not save a document that has not said what it is, so
    // refuse before starting the import.
    if (!flags.medium && flags.type === 'document') this.error(MEDIUM_MISSING_MESSAGE)

    const payload: Record<string, unknown> = {
      url: flags.url,
      type: flags.type,
      perspective: flags.perspective,
    }
    if (flags['face-speaker']) payload.face_speaker = flags['face-speaker']
    if (flags.medium) payload.medium = flags.medium

    if (!json) process.stderr.write('Importing (downloading + transcribing in background)...\n')

    let data: Record<string, unknown>
    try {
      data = await client.post(`/v1/faces/${seg(args.face_id)}/import`, {body: payload}) as Record<string, unknown>
    } catch (err) {
      if (err instanceof FacesAPIError) {
        if (err.statusCode === 422 && flags.type === 'thread') {
          this.error(`${err.message}. Try again with --type document`)
        }
        this.error(`HTTP ${err.statusCode}: ${err.message}`)
      }
      throw err
    }

    // Poll until transcription completes: unless --no-wait
    if (data.status === 'transcribing' && flags['no-wait']) {
      const id = (data.thread_id ?? data.document_id) as string
      if (!json) {
        process.stderr.write(`Import started in background (downloading + transcribing).\n`)
        process.stderr.write(`Poll with: faces compile:${flags.type === 'thread' ? 'thread' : 'doc'}:get ${id} --json\n`)
      }
      return data
    }

    if (data.status === 'transcribing') {
      const id = (data.thread_id ?? data.document_id) as string
      const endpoint = flags.type === 'thread'
        ? `/v1/compile/threads/${seg(id)}`
        : `/v1/compile/documents/${seg(id)}`

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
                const msgCount = poll.message_count ?? poll.token_count ?? 0
                process.stderr.write(`Transcription complete: ${msgCount} ${flags.type === 'thread' ? 'messages' : 'tokens'}\n`)
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
      if (data.thread_id) {
        this.log(`\nImported as thread: ${data.thread_id}`)
        this.log(`label: ${data.label ?? 'youtube-import'}`)
        this.log(`\nReview the transcript:`)
        this.log(`  faces compile:thread:get ${data.thread_id}`)
        this.log(`\nWhen ready to compile:`)
        this.log(`  faces compile:thread:make ${data.thread_id}`)
      } else if (data.document_id) {
        this.log(`\nImported as document: ${data.document_id}`)
        this.log(`label: ${data.label ?? 'youtube-import'}`)
        this.log(`\nReview the document:`)
        this.log(`  faces compile:doc:get ${data.document_id}`)
        this.log(`\nWhen ready to compile:`)
        this.log(`  faces compile:doc:make ${data.document_id}`)
      }
    }

    return data
  }
}
