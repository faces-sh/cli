import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {seg} from '../../utils.js'

interface FollowResponse {
  username: string
  is_following: boolean
  counts?: {following?: number; followers?: number | null}
}

export default class UserFollow extends BaseCommand {
  static description = 'Follow an account'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static args = {
    username: Args.string({description: 'Account to follow', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(UserFollow)
    const client = this.makeClient(flags)

    let data: FollowResponse
    try {
      data = (await client.post(`/v1/users/${seg(args.username)}/follow`)) as FollowResponse
    } catch (err) {
      if (err instanceof FacesAPIError) {
        if (err.statusCode === 404) this.error(`No account '${args.username}'.`)
        this.error(`HTTP ${err.statusCode}: ${err.message}`)
      }
      throw err
    }

    if (!this.jsonEnabled()) {
      // The route is idempotent, so this states where things stand rather than
      // claiming a change that may not have happened.
      this.log(
        data.is_following
          ? `You follow ${data.username}.`
          : `${data.username} is not followed. The server reported no change.`,
      )
      const followers = data.counts?.followers
      if (typeof followers === 'number') this.log(`  they now have ${followers} follower(s)`)
    }

    return data
  }
}
