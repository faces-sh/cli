import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {seg} from '../../utils.js'

interface UserCard {
  username: string
  name?: string | null
  description?: string | null
  is_following?: boolean | null
}

export default class UserFollowers extends BaseCommand {
  static description = 'List the accounts following someone. Follows the list to the end rather than stopping at the first page.'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static args = {
    username: Args.string({description: 'Account username', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(UserFollowers)
    const client = this.makeClient(flags)

    let all
    try {
      all = await client.getAll(`/v1/users/${seg(args.username)}/followers`)
    } catch (err) {
      if (err instanceof FacesAPIError) {
        if (err.statusCode === 404) this.error(`No account '${args.username}'.`)
        this.error(`HTTP ${err.statusCode}: ${err.message}`)
      }
      throw err
    }

    const rows = all.data as unknown as UserCard[]
    const counts = (all.envelope.counts ?? {}) as {following?: number; followers?: number | null}
    const data = {object: 'list', data: rows, counts, has_more: all.truncated, next_cursor: null}

    if (!this.jsonEnabled()) {
      if (rows.length === 0) {
        this.log(`Nobody follows ${args.username}.`)
        return data
      }

      const width = Math.max(...rows.map((u) => u.username.length))
      for (const u of rows) {
        const name = u.name && u.name !== u.username ? `  ${u.name}` : ''
        // Say which of these you already follow, since that is what decides
        // whether there is anything to do about a row.
        const mine = u.is_following === true ? '  [you follow]' : ''
        this.log(`${u.username.padEnd(width)}${name}${mine}`)
      }

      this.log('')
      this.log(`${rows.length} follower(s)`)
      if (all.truncated) {
        this.log('This list is incomplete: the server had more than could be read in one go.')
      }
    }

    return data
  }
}
