import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {seg} from '../../../utils.js'

export default class CompileThreadDelete extends BaseCommand {
  static description = "Delete a thread and its messages. To withdraw it from the face while KEEPING the material, use " +
    'compile:thread:reset instead: that withdraws what it contributed and keeps the thread, so it can be ' +
    'recompiled without re-uploading.'

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({description: 'Skip confirmation', default: false}),
  }

  static args = {
    thread_id: Args.string({description: 'Thread ID', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CompileThreadDelete)
    const client = this.makeClient(flags)

    await this.confirmOrRefuse(`Delete thread '${args.thread_id}'? This cannot be undone.`, flags.yes)

    let data: unknown
    try {
      data = await client.delete(`/v1/compile/threads/${seg(args.thread_id)}`)
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) this.printHuman(data)
    return data
  }

}
