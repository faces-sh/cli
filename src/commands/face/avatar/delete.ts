import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {seg} from '../../../utils.js'

export default class FaceAvatarDelete extends BaseCommand {
  static description =
    "Remove the picture you uploaded for a face. The generated avatar versions are not touched, and the " +
    'face goes back to being served one of those.'

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({description: 'Skip the confirmation', default: false}),
  }

  static args = {
    face_id: Args.string({description: 'Face alias (must be one of yours)', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(FaceAvatarDelete)
    const client = this.makeClient(flags)

    // Say what goes and what stays before asking. This removes an upload, not
    // the generated history, and the two are easy to confuse.
    if (!flags.yes) {
      // Refusing is not succeeding: a script reading exit 0 would take the
      // picture for gone.
      this.error(
        `This removes the picture uploaded for '${args.face_id}'. The generated avatar versions stay, ` +
          'and one of them will be served instead.\nRe-run with --yes to go ahead.',
      )
    }

    try {
      await client.delete(`/v1/faces/${seg(args.face_id)}/avatar/upload`)
    } catch (err) {
      if (err instanceof FacesAPIError) {
        this.error(`HTTP ${err.statusCode}: ${err.message}`)
      }
      throw err
    }

    const result = {alias: args.face_id, deleted: true}
    if (!this.jsonEnabled()) {
      // The route answers the same whether there was a picture or not, so this
      // says what is true afterwards rather than claiming something was removed.
      this.log(`${args.face_id} has no uploaded picture now.`)
      this.log(`It is served a generated avatar: faces face:avatar:get ${args.face_id}`)
    }

    return result
  }
}
