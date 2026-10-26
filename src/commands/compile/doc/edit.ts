import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../../base.js'
import {MEDIUM_EDIT_DESCRIPTION, seg, readTextFile, documentWarningLines, withoutWarnings} from '../../../utils.js'
import {FacesAPIError} from '../../../client.js'

export default class CompileDocEdit extends BaseCommand {
  static description = 'Edit a document (label, content, or perspective)'

  static flags = {
    ...BaseCommand.baseFlags,
    label: Flags.string({description: 'New label/title'}),
    content: Flags.string({description: 'New inline text content', exclusive: ['file']}),
    file: Flags.string({description: 'Read new content from file'}),
    medium: Flags.string({description: MEDIUM_EDIT_DESCRIPTION()}),
    perspective: Flags.string({description: 'Perspective (first-person or third-person)', options: ['first-person', 'third-person']}),
  }

  static args = {
    doc_id: Args.string({description: 'Document ID', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CompileDocEdit)
    const client = this.makeClient(flags)

    const payload: Record<string, unknown> = {}
    if (flags.label) payload.label = flags.label
    if (flags.medium) payload.medium = flags.medium
    if (flags.perspective) payload.perspective = flags.perspective

    if (flags.file) {
      try {
        payload.content = readTextFile(flags.file)
      } catch (err) {
        this.error(err instanceof Error ? err.message : String(err))
      }
    } else if (flags.content) {
      payload.content = flags.content
    }

    if (Object.keys(payload).length === 0) this.error('Provide at least one field to edit.')

    let data: unknown
    try {
      data = await client.patch(`/v1/compile/documents/${seg(args.doc_id)}`, {body: payload})
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    // The warnings are printed on their own, below, rather than twice.
    if (!this.jsonEnabled()) this.printHuman(withoutWarnings(data))
    // New content can read as a transcript; the edit is saved either way.
    if (typeof payload.content === 'string') {
      const alias = String((data as Record<string, unknown> | null)?.alias ?? 'ALIAS')
      for (const line of documentWarningLines(data, payload.content, alias, flags.file)) process.stderr.write(`${line}\n`)
    }
    return data
  }
}
