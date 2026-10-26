import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {seg, ownsFace} from '../../utils.js'

interface ShareResponse {
  alias: string
  shared_with: string[]
  handle: string | null
}

export default class FaceShare extends BaseCommand {
  static description =
    'Share a face so named accounts can chat with it. Sharing grants chat and nothing else: no reading its ' +
    'documents, no compiling, no re-sharing. Sharing does not show its profile addendum, though the model ' +
    'answering as the face can be asked to repeat it. --add keeps the current list; --with replaces it.'

  static examples = [
    '<%= config.bin %> <%= command.id %> alice --list',
    '<%= config.bin %> <%= command.id %> alice --add dana',
    '<%= config.bin %> <%= command.id %> alice --with dana --with sam@example.com',
    '<%= config.bin %> <%= command.id %> alice --none --yes',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    list: Flags.boolean({description: 'Show who the face is shared with, and change nothing', default: false}),
    add: Flags.string({
      description: 'Add an account, keeping everyone already on the list. Username or email (repeatable)',
      multiple: true,
      exclusive: ['with', 'none'],
    }),
    with: Flags.string({
      description: 'Set the list to exactly these accounts, dropping anyone else (repeatable)',
      multiple: true,
      exclusive: ['add', 'none'],
    }),
    none: Flags.boolean({description: 'Revoke everyone', default: false, exclusive: ['add', 'with']}),
    yes: Flags.boolean({description: 'Skip the confirmation shown when someone would lose access', default: false}),
  }

  static args = {
    alias: Args.string({description: 'Face alias', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(FaceShare)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()

    // Who a face is shared with is its owner's to see and change; for anyone
    // else the list reads as empty, and "not shared with anyone" is false.
    if ((await ownsFace(client, args.alias)) === false) {
      this.error(`'${args.alias}' belongs to another account. Only its owner can see or change who it is shared with.`)
    }

    const current = await this.readList(client, args.alias)

    if (flags.list) {
      if (!json) this.report(args.alias, current)
      return {alias: args.alias, shared_with: current}
    }

    if (!flags.add && !flags.with && !flags.none) {
      this.error('Provide --list, --add <account>, --with <account> (replaces), or --none.')
    }

    // The endpoint replaces rather than appends, so every form sends a full list.
    // --add exists because "add one person" is the common intent and expressing it
    // as a replace is the easiest way to revoke everyone else by accident.
    let next: string[]
    if (flags.none) next = []
    else if (flags.add) next = [...new Set([...current, ...flags.add])]
    else next = [...new Set(flags.with as string[])]

    // Compare case-insensitively: stored values are canonical usernames, and a
    // caller may well retype one with different capitalisation.
    const lower = new Set(next.map((u) => u.toLowerCase()))
    const removed = current.filter((u) => !lower.has(u.toLowerCase()))

    if (removed.length > 0 && !flags.yes) {
      this.error(
        `This removes ${removed.length} account(s) from '${args.alias}': ${removed.join(', ')}.\n` +
          'Revocation is immediate. Re-run with --yes, or use --add to keep them.',
      )
    }

    let data: ShareResponse
    try {
      data = (await client.patch(`/v1/faces/${seg(args.alias)}/share`, {
        body: {shared_with: next},
      })) as ShareResponse
    } catch (err) {
      // Unknown accounts are rejected atomically, so the previous list survives
      // and the caller can fix the name and re-run.
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (json) return data
    if (removed.length > 0) this.log(`Revoked: ${removed.join(', ')}`)
    this.report(args.alias, data.shared_with ?? [], data.handle)
    return data
  }

  private async readList(client: ReturnType<typeof this.makeClient>, alias: string): Promise<string[]> {
    try {
      const face = (await client.get(`/v1/faces/${seg(alias)}`)) as {shared_with?: string[]}
      return face.shared_with ?? []
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }
  }

  private report(alias: string, users: string[], handle?: string | null): void {
    if (users.length === 0) {
      this.log(`'${alias}' is not shared with anyone.`)
      return
    }
    this.log(`'${alias}' is shared with ${users.length} account(s):`)
    for (const u of users) this.log(`  ${u}`)
    if (handle) this.log(`\nThey chat with it as: ${handle}@<model>`)
  }
}
