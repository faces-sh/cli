import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {RESPONSES_ENDPOINT, chatFlags, MODEL_ARG_DESCRIPTION} from '../../chat.js'
import {ChatCommand} from '../../chat-command.js'

export default class ChatChat extends ChatCommand {
  static description =
    'Chat with a face. Name the upstream model over the downstream model: @alice:maestro-1/gpt-5.4. The face ' +
    'steers, and the downstream model writes the reply. Routes to /v1/chat/completions, /v1/responses or ' +
    '/v1/messages from the model catalog (--responses forces /v1/responses). The face\'s style is chosen for ' +
    'each request. Add --conversation to take the turn in a state (see faces state:create). The steering is ' +
    'billed per input token plus a small fee per call (faces models:list --kind upstream), and the downstream ' +
    'model at its listed price.'

  static examples = [
    '<%= config.bin %> <%= command.id %> @socrates:maestro-1/gpt-5.4 -m "What is virtue?"',
    '<%= config.bin %> <%= command.id %> @head~socrates:maestro-1-flash/claude-sonnet-4-6 -m "What is virtue?"',
    '<%= config.bin %> <%= command.id %> "(@socrates | @nietzsche):maestro-1/gpt-5.4" -m "What is virtue?"',
    '<%= config.bin %> <%= command.id %> @alice:maestro-1/gpt-5.4 -m "So what do I tell them tomorrow?" --conversation fs_STATE_ID',
    '<%= config.bin %> <%= command.id %> @alice:maestro-1/gpt-5.4 -m "Is this vendor worth a closer look?" --conversation fs_STATE_ID ' +
      '--premise budget_usd=50000 --premise-description budget_usd="the most we can spend this year"',
  ]

  static args = {
    model: Args.string({description: MODEL_ARG_DESCRIPTION, required: true}),
  }

  static flags = {
    ...BaseCommand.baseFlags,
    ...chatFlags(),
    responses: Flags.boolean({description: 'Send it to /v1/responses whatever the catalog says (routing is automatic otherwise).', default: false}),
  }

  protected forcedEndpoint(flags: Record<string, unknown>): string | undefined {
    return flags.responses ? RESPONSES_ENDPOINT : undefined
  }
}
