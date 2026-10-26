import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {seg} from '../../utils.js'

interface Member {
  iam_id?: string
  alias?: string | null
  /** False once the owner revoked access or deleted the face. */
  reachable?: boolean | null
  unreachable_reason?: string | null
}

/**
 * Why a member can no longer be reached, in the terms a user can act on.
 *
 * The two are kept apart deliberately: access can be granted again, a deleted
 * face cannot come back. Rendering them the same would tell someone to go and
 * ask for something that no longer exists.
 */
const REASONS: Record<string, string> = {
  unpublished_or_unshared: 'access was revoked by its owner',
  deleted: 'the face was deleted',
}

export default class GroupMembers extends BaseCommand {

  static description =
    'List members of a group. A member you do not own can stop being reachable if its owner revokes ' +
    'access or deletes it; those are listed with the reason rather than dropped.'

  static examples = ['<%= config.bin %> <%= command.id %> GROUP_ID', '<%= config.bin %> <%= command.id %> GROUP_ID --json']

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static args = {
    group_id: Args.string({description: 'Group ID', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(GroupMembers)
    const client = this.makeClient(flags)

    let data: unknown
    try {
      data = await client.get(`/v1/groups/${seg(args.group_id)}/members`)
    } catch (err) {
      if (err instanceof FacesAPIError) {
        if (err.statusCode === 404) this.error(`No group '${args.group_id}'. It does not exist, or is not yours.`)
        this.error(`HTTP ${err.statusCode}: ${err.message}`)
      }
      throw err
    }

    if (this.jsonEnabled()) return data

    const members = ((data as {data?: Member[]}).data ?? (data as Member[])) ?? []
    if (members.length === 0) {
      this.log('This group has no members.')
      this.log(`Add one with: faces group:add ${args.group_id} --face <alias>`)
      return data
    }

    const rows = members.map((m) => ({
      alias: m.alias?.trim() || '(unknown)',
      // reachable is absent on older servers; only an explicit false is a problem.
      status:
        m.reachable === false
          ? `unreachable - ${REASONS[m.unreachable_reason ?? ''] ?? m.unreachable_reason ?? 'reason not given'}`
          : 'ok',
      id: m.iam_id ?? '-',
    }))
    const cols: Array<[string, (r: (typeof rows)[0]) => string]> = [
      ['FACE', (r) => r.alias],
      ['STATUS', (r) => r.status],
      ['ID', (r) => r.id],
    ]
    const w = cols.map(([h, g]) => Math.max(h.length, ...rows.map((r) => g(r).length)))
    const line = (c: string[]) => c.map((x, i) => x.padEnd(w[i])).join('  ').trimEnd()
    this.log(line(cols.map(([h]) => h)))
    for (const r of rows) this.log(line(cols.map(([, g]) => g(r))))

    const lost = members.filter((m) => m.reachable === false)
    this.log('')
    this.log(`${rows.length} member(s).`)
    if (lost.length > 0) {
      // Say it plainly: a group that silently changed shape is the thing this
      // reporting exists to prevent.
      this.log(
        `${lost.length} can no longer be reached and will not answer. They are still listed because the ` +
          'group has not changed; remove them with faces group:remove.',
      )
    }
    return data
  }
}
