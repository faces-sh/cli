import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {MESSAGES_ENDPOINT, chatFlags, MODEL_ARG_DESCRIPTION} from '../../chat.js'
import {ChatCommand} from '../../chat-command.js'

export default class ChatMessages extends ChatCommand {
  static description =
    'Chat with a face in the Anthropic Messages format (/v1/messages), whatever the model. chat:chat routes ' +
    'Anthropic models here on its own. Name the model as for chat:chat: @alice:maestro-1/claude-sonnet-4-6.'

  static examples = [
    '<%= config.bin %> <%= command.id %> @socrates:maestro-1/claude-sonnet-4-6 -m "What is virtue?" --max-tokens 400',
  ]

  static args = {
    model: Args.string({description: MODEL_ARG_DESCRIPTION, required: true}),
  }

  static flags = {
    ...BaseCommand.baseFlags,
    ...chatFlags(),
  }

  protected forcedEndpoint(): string {
    return MESSAGES_ENDPOINT
  }
}
