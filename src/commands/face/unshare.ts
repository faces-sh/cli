import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {seg} from '../../utils.js'

export default class FaceUnshare extends BaseCommand {
  static description = 'Revoke access to a shared face. Takes effect immediately. There is no grace period.'

  static examples = [
    '<%= config.bin %> <%= command.id %> alice --from dana --yes',
    '<%= config.bin %> <%= command.id %> alice --all --yes',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    from: Flags.string({description: 'Account to revoke (repeatable)', multiple: true, exclusive: ['all']}),
    all: Flags.boolean({description: 'Revoke everyone', default: false, exclusive: ['from']}),
    yes: Flags.boolean({description: 'Skip confirmation', default: false}),
  }

  static args = {
    alias: Args.string({description: 'Face alias', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(FaceUnshare)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()

    if (!flags.from && !flags.all) this.error('Provide --from <account> (repeatable) or --all.')

    let current: string[]
    try {
      const face = (await client.get(`/v1/faces/${seg(args.alias)}`)) as {shared_with?: string[]}
      current = face.shared_with ?? []
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (current.length === 0) {
      if (!json) this.log(`'${args.alias}' is not shared with anyone.`)
      return {alias: args.alias, shared_with: []}
    }

    const drop = new Set((flags.from ?? []).map((u) => u.toLowerCase()))
    const next = flags.all ? [] : current.filter((u) => !drop.has(u.toLowerCase()))
    const removed = current.filter((u) => !next.includes(u))

    if (removed.length === 0) {
      // The list stores canonical usernames, so an email that granted access will
      // not match here. Say that rather than reporting a bare "not found".
      this.error(
        `None of those accounts are on '${args.alias}'. Currently shared with: ${current.join(', ')}.\n` +
          'The list stores usernames, so revoke by username even if you shared by email.',
      )
    }

    if (!flags.yes) {
      this.error(`This revokes ${removed.join(', ')} from '${args.alias}', immediately. Re-run with --yes.`)
    }

    let data: unknown
    try {
      data = await client.patch(`/v1/faces/${seg(args.alias)}/share`, {body: {shared_with: next}})
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (json) return data
    this.log(`Revoked: ${removed.join(', ')}`)
    this.log(next.length > 0 ? `Still shared with: ${next.join(', ')}` : `'${args.alias}' is no longer shared with anyone.`)
    return data
  }
}
