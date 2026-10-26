import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {seg} from '../../utils.js'

interface FollowResponse {
  username: string
  is_following: boolean
  counts?: {following?: number; followers?: number | null}
}

export default class UserUnfollow extends BaseCommand {
  static description = 'Stop following an account'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static args = {
    username: Args.string({description: 'Account to stop following', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(UserUnfollow)
    const client = this.makeClient(flags)

    let data: FollowResponse
    try {
      data = (await client.delete(`/v1/users/${seg(args.username)}/follow`)) as FollowResponse
    } catch (err) {
      if (err instanceof FacesAPIError) {
        if (err.statusCode === 404) this.error(`No account '${args.username}'.`)
        this.error(`HTTP ${err.statusCode}: ${err.message}`)
      }
      throw err
    }

    if (!this.jsonEnabled()) {
      this.log(
        data.is_following
          ? `${data.username} is still followed. The server reported no change.`
          : `You no longer follow ${data.username}.`,
      )
      const followers = data.counts?.followers
      if (typeof followers === 'number') this.log(`  they now have ${followers} follower(s)`)
    }

    return data
  }
}
