import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../../base.js'
import {MEDIUM_MISSING_MESSAGE, MEDIUM_REQUIRED_DESCRIPTION, readTextFile, documentWarningLines, withoutWarnings} from '../../../utils.js'
import {FacesAPIError} from '../../../client.js'

export default class CompileDocCreate extends BaseCommand {
  static description =
    'Submit a document to a face. A document is the face\'s own writing, and every word in it is read ' +
    'as theirs. An interview, transcript or dialogue is a thread: upload it with ' +
    'faces compile:upload ALIAS --file FILE --kind thread --face-speaker NAME.'

  static flags = {
    ...BaseCommand.baseFlags,
    label: Flags.string({description: 'Document label/title'}),
    content: Flags.string({description: 'Inline text content', exclusive: ['file']}),
    file: Flags.string({description: 'Read content from file'}),
    medium: Flags.string({description: MEDIUM_REQUIRED_DESCRIPTION}),
    perspective: Flags.string({description: 'Perspective (first-person or third-person)', options: ['first-person', 'third-person'], default: 'first-person'}),
  }

  static args = {
    face_id: Args.string({description: 'Face alias', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CompileDocCreate)
    const client = this.makeClient(flags)

    let content = flags.content
    if (flags.file) {
      try {
        content = readTextFile(flags.file)
      } catch (err) {
        this.error(err instanceof Error ? err.message : String(err))
      }
    }

    if (content === undefined) this.error('Provide --content or --file.')
    if (!content.trim()) this.error('--content is empty, or only whitespace.')
    // The server will not save a document that has not said what it is, so
    // refuse before sending it.
    if (!flags.medium) this.error(MEDIUM_MISSING_MESSAGE)

    const payload: Record<string, unknown> = {alias: args.face_id, content, medium: flags.medium}
    if (flags.label) payload.label = flags.label
    if (flags.perspective) payload.perspective = flags.perspective

    let data: unknown
    try {
      data = await client.post('/v1/compile/documents', {body: payload})
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    // The warnings are printed on their own, below, rather than twice.
    if (!this.jsonEnabled()) this.printHuman(withoutWarnings(data))
    // The document is saved either way. A transcript sent as one is read as
    // the face saying every line, so say so and name the thread upload.
    for (const line of documentWarningLines(data, content, args.face_id, flags.file)) process.stderr.write(`${line}\n`)
    return data
  }
}
