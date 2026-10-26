import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {seg, MEDIUM_EDIT_DESCRIPTION} from '../../../utils.js'

export default class CompileThreadEdit extends BaseCommand {
  static description =
    'Edit a thread: its label, what medium it is read as, and/or which speaker is the face.'

  static examples = [
    '<%= config.bin %> <%= command.id %> THREAD_ID --label "Interview"',
    '<%= config.bin %> <%= command.id %> THREAD_ID --medium lecture',
    '<%= config.bin %> <%= command.id %> THREAD_ID --clear-medium',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    label: Flags.string({description: 'New thread label'}),
    'face-speaker': Flags.string({
      description: 'Reassign face speaker: set this speaker to role=user, all others to role=assistant',
    }),
    medium: Flags.string({
      description:
        'What this thread should be read as. ' +
        MEDIUM_EDIT_DESCRIPTION() +
        ' This is a correction that sticks: it overrides what an imported corpus arrived as, without ' +
        'changing the record of what that was.',
      exclusive: ['clear-medium'],
    }),
    'clear-medium': Flags.boolean({
      description: 'Remove a medium correction, so the thread is read as whatever it arrived as.',
      default: false,
      exclusive: ['medium'],
    }),
  }

  static args = {
    thread_id: Args.string({description: 'Thread ID', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CompileThreadEdit)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()

    if (!flags.label && !flags['face-speaker'] && !flags.medium && !flags['clear-medium']) {
      this.error('Provide at least one of --label, --medium, --clear-medium or --face-speaker')
    }

    // If --face-speaker, fetch messages, remap roles, PATCH back
    if (flags['face-speaker']) {
      const speaker = flags['face-speaker']

      // Fetch current thread
      let thread: Record<string, unknown>
      try {
        thread = await client.get(`/v1/compile/threads/${seg(args.thread_id)}`) as Record<string, unknown>
      } catch (err) {
        if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
        throw err
      }

      const messages = thread.messages as Array<{role: string; content: string; name?: string}> | undefined
      if (!messages || messages.length === 0) {
        this.error('Thread has no messages to remap')
      }

      // Remap roles: case-insensitive exact match against speaker label
      let remapped = 0
      const speakerLower = speaker.toLowerCase()
      const updated = messages.map((m) => {
        const isFace = (m.name ?? '').toLowerCase() === speakerLower
        const newRole = isFace ? 'user' : 'assistant'
        if (m.role !== newRole) remapped++
        return {role: newRole, content: m.content, name: m.name}
      })

      // PATCH messages
      try {
        await client.patch(`/v1/compile/threads/${seg(args.thread_id)}/messages`, {
          body: {messages: updated},
        })
      } catch (err) {
        if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
        throw err
      }

      if (!json) {
        const userCount = updated.filter((m) => m.role === 'user').length
        const assistantCount = updated.filter((m) => m.role === 'assistant').length
        process.stderr.write(
          `Remapped ${remapped} messages: "${speaker}" → user (${userCount}), all others → assistant (${assistantCount})\n`,
        )
      }
    }

    // Label and medium go in one partial patch. Null is meaningful for medium
    // and distinct from absent, which is how a correction is cleared.
    if (flags.label || flags.medium || flags['clear-medium']) {
      const body: Record<string, unknown> = {}
      if (flags.label) body.label = flags.label
      if (flags.medium) body.medium = flags.medium
      if (flags['clear-medium']) body.medium = null

      try {
        await client.patch(`/v1/compile/threads/${seg(args.thread_id)}`, {body})
      } catch (err) {
        if (err instanceof FacesAPIError) {
          // The derived value is read-only and the server names the field to
          // send instead; pass that through rather than restating it.
          this.error(`HTTP ${err.statusCode}: ${err.message}`)
        }
        throw err
      }

      if (!json) {
        if (flags.label) process.stderr.write(`Label updated to "${flags.label}"\n`)
        if (flags.medium) process.stderr.write(`Now read as: ${flags.medium}\n`)
        if (flags['clear-medium']) process.stderr.write('Medium correction removed.\n')
      }
    }

    // Fetch final state and return
    let data: unknown
    try {
      data = await client.get(`/v1/compile/threads/${seg(args.thread_id)}`)
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    if (!json) this.printHuman(data)
    return data
  }
}
