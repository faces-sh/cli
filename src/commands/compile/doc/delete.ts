import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {seg} from '../../../utils.js'

export default class CompileDocDelete extends BaseCommand {
  static description = "Delete a document and its content. To withdraw it from the face while KEEPING the material, use " +
    'compile:doc:reset instead: that withdraws what it contributed and keeps the document, so it can be ' +
    'recompiled without re-uploading.'

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({description: 'Skip confirmation', default: false}),
  }

  static args = {
    doc_id: Args.string({description: 'Document ID', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CompileDocDelete)
    const client = this.makeClient(flags)
    await this.confirmOrRefuse(`Delete document '${args.doc_id}' and its content? This cannot be undone.`, flags.yes)

    let data: unknown
    try {
      data = await client.delete(`/v1/compile/documents/${seg(args.doc_id)}`)
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) this.printHuman(data)
    return data
  }
}
