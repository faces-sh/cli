import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {seg} from '../../utils.js'

interface UserDetail {
  username: string
  name?: string | null
  description?: string | null
  created?: number | null
  is_following?: boolean | null
  counts?: {following?: number; followers?: number | null}
}

export default class UserGet extends BaseCommand {
  static description = 'Get an account: who they are, how many follow them, and whether you follow them'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static args = {
    username: Args.string({description: 'Account username', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(UserGet)
    const client = this.makeClient(flags)

    let data: UserDetail
    try {
      data = (await client.get(`/v1/users/${seg(args.username)}`)) as UserDetail
    } catch (err) {
      if (err instanceof FacesAPIError) {
        if (err.statusCode === 404) this.error(`No account '${args.username}'.`)
        this.error(`HTTP ${err.statusCode}: ${err.message}`)
      }
      throw err
    }

    if (!this.jsonEnabled()) {
      this.log(`username:  ${data.username}`)
      if (data.name && data.name !== data.username) this.log(`name:      ${data.name}`)
      if (data.description) this.log(`about:     ${data.description}`)
      if (data.created) this.log(`joined:    ${new Date(data.created * 1000).toISOString().slice(0, 10)}`)

      const c = data.counts ?? {}
      this.log(`following: ${c.following ?? '-'}`)
      this.log(`followers: ${c.followers ?? '-'}`)

      // null is the answer for your own account, which you cannot follow. It is
      // not the same as "no", so it is not reported as one.
      if (data.is_following === true) this.log('You follow this account.')
      else if (data.is_following === false) {
        this.log(`You do not follow this account. Follow it with: faces user:follow ${data.username}`)
      }

      this.log('')
      this.log(`Their published faces: faces face:list --public --from-users ${data.username}`)
    }

    return data
  }
}
