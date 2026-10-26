import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {seg} from '../../../utils.js'

export default class CompileDocReset extends BaseCommand {
  static description = 'Withdraw a document from the face while keeping it. What it contributed ' +
    'leaves the face, and it leaves the document itself untouched for recompiling. This is how to undo a ' +
    'compile that went wrong without deleting the material and paying to upload it again.'

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({description: 'Skip confirmation', default: false}),
  }

  static args = {
    doc_id: Args.string({description: 'Document ID', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CompileDocReset)
    const client = this.makeClient(flags)

    let data: unknown
    try {
      data = await client.post(`/v1/compile/documents/${seg(args.doc_id)}/reset`)
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) {
      this.log(`Reset. Recompile with: faces compile:doc:make ${args.doc_id}`)
    }
    return data
  }
}
