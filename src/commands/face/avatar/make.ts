import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {seg} from '../../../utils.js'

interface AvatarSave {
  version: number
  stale?: boolean
  rows: number
  cols: number
  bytes: number
  seed?: number | null
  alias: string
  amount_charged_usd: number
}

export default class FaceAvatarMake extends BaseCommand {
  static description =
    'Generate a new avatar version for a face. This bills, so it needs --allow-paid. Reading an existing ' +
    'avatar with face:avatar:get is free.'

  static flags = {
    ...BaseCommand.baseFlags,
    'allow-paid': Flags.boolean({
      description:
        'Permit the charge. Generating an avatar always bills; without this flag nothing is sent and ' +
        'nothing is charged.',
      default: false,
    }),
    seed: Flags.integer({
      description: 'Fix the seed to reproduce a particular avatar (0-999999999).',
      min: 0,
      max: 999_999_999,
    }),
  }

  static args = {
    face_id: Args.string({description: 'Face alias (must be one of yours)', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(FaceAvatarMake)
    const client = this.makeClient(flags)

    // Refuse before the request, not after. There is no free route for this, so
    // the only way to not charge somebody who did not mean to is to not call.
    if (!flags['allow-paid']) {
      this.error(
        'Generating an avatar bills your account. Re-run with --allow-paid if you meant to pay.\n' +
          `To see the versions this face already has, which is free: faces face:avatar:list ${args.face_id}\n` +
          `To download one: faces face:avatar:get ${args.face_id}`,
      )
    }

    const params = new URLSearchParams()
    if (flags.seed !== undefined) params.set('seed', String(flags.seed))
    const query = params.toString() ? `?${params.toString()}` : ''

    let data: AvatarSave
    try {
      data = (await client.post(`/v1/faces/${seg(args.face_id)}/avatar${query}`)) as AvatarSave
    } catch (err) {
      // A face with nothing compiled has nothing to draw from; refused before
      // anything is charged.
      if (err instanceof FacesAPIError && err.statusCode === 422 && /compiled/i.test(err.message)) {
        this.error(
          `HTTP 422: ${err.message}\nNothing was charged. Give it a first source, then try again: ` +
            `faces compile:upload ${args.face_id} --file <file>`,
        )
      }
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!this.jsonEnabled()) {
      // By this point the account has been charged. Nothing below may throw on
      // a field that came back in an unexpected shape, or the charge lands and
      // the caller sees a stack trace instead of what they paid for.
      const num = (v: unknown): string => (typeof v === 'number' ? v.toLocaleString() : String(v ?? '?'))

      this.log(`Generated version ${data.version ?? '?'} for ${data.alias ?? args.face_id}`)
      this.log(`  ${num(data.cols)}x${num(data.rows)} grid, ${num(data.bytes)} bytes`)
      if (data.seed !== null && data.seed !== undefined) {
        this.log(`  seed ${data.seed}  (pass --seed ${data.seed} to generate this one again)`)
      }

      // Say the amount every time, including when it is zero. A paid action that
      // prints nothing about the charge is how a bill becomes a surprise.
      this.log(
        typeof data.amount_charged_usd === 'number'
          ? `  charged $${data.amount_charged_usd.toFixed(4)}`
          : '  charged: the response did not say how much; check faces billing:balance',
      )
      this.log('')
      this.log(`Download it with: faces face:avatar:get ${args.face_id}`)
    }

    return data
  }
}
