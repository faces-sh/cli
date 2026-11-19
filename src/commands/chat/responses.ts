import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {RESPONSES_ENDPOINT, chatFlags, MODEL_ARG_DESCRIPTION} from '../../chat.js'
import {ChatCommand} from '../../chat-command.js'

export default class ChatResponses extends ChatCommand {
  static description =
    'Chat with a face in the OpenAI Responses format (/v1/responses). The same as chat:chat --responses. On ' +
    'Connect and Pro with ChatGPT linked, Codex-eligible models (faces models:list --chatgpt) run on the ChatGPT plan.'

  static examples = [
    '<%= config.bin %> <%= command.id %> @socrates:maestro-1/gpt-5.4 -m "What is virtue?"',
    '<%= config.bin %> <%= command.id %> @socrates:maestro-1/gpt-5.4 -m "What is virtue?" --oauth-only',
  ]

  static args = {
    model: Args.string({description: MODEL_ARG_DESCRIPTION, required: true}),
  }

  static flags = {
    ...BaseCommand.baseFlags,
    ...chatFlags(),
  }

  protected forcedEndpoint(): string {
    return RESPONSES_ENDPOINT
  }
}
