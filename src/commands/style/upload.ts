import {Args, Flags} from '@oclif/core'
import fs from 'node:fs'
import path from 'node:path'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {seg} from '../../utils.js'

export default class StyleUpload extends BaseCommand {
  static description =
    'Load a corpus of a person\'s own writing (a mail export, a message archive) as source material for ' +
    'building a style. This only stores the material: nothing is compiled and nothing is billed. Build ' +
    'the style afterwards with style:make. Each message needs author (self, for the face, or other), ' +
    'sender, date (ISO-8601) and its text in plaintextBody, htmlBody or snippet; body and text are accepted ' +
    'for plaintextBody. The server lists every problem with a refused line, and the fields it accepts. ' +
    'Upload ONE medium per file: a file mixing, say, email and ' +
    'text messages produces threads with no medium at all, which no style can be built from. A message that declares ' +
    'its own `kind` must spell one of the eleven media exactly; an unknown one is refused, naming the ' +
    'message that carried it. The file is passed through as written, so this is the server answering.'

  static examples = [
    '<%= config.bin %> <%= command.id %> alice ./mail.jsonl',
    '<%= config.bin %> <%= command.id %> alice ./thread.json --type thread_json',
    '<%= config.bin %> <%= command.id %> alice ./mail.jsonl --messages-per-thread 100 --strict',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    type: Flags.string({
      description:
        'jsonl: one message per line, split across threads, for any medium (email_jsonl is the same). ' +
        'thread_json: a JSON array that becomes a single thread.',
      options: ['jsonl', 'email_jsonl', 'thread_json'],
      default: 'jsonl',
    }),
    'messages-per-thread': Flags.integer({
      description:
        'Messages per thread for a line-per-message file (1-1000, default: 50). Set this above the length ' +
        'of a conversation you want kept whole in one thread; at 50 a long conversation is cut into slices.',
      default: 50,
      min: 1,
      max: 1000,
    }),
    strict: Flags.boolean({
      description:
        'Reject the whole upload if any message is invalid. By default invalid messages are skipped and ' +
        'reported, and the rest are kept.',
      default: false,
    }),
  }

  static args = {
    alias: Args.string({description: 'Face alias', required: true}),
    file: Args.string({description: 'Corpus file', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(StyleUpload)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()

    if (!fs.existsSync(args.file)) this.error(`File not found: ${args.file}`)

    const form = new FormData()
    form.append(
      'file',
      new Blob([fs.readFileSync(args.file)], {type: 'application/json'}),
      path.basename(args.file),
    )

    const params = new URLSearchParams({type: flags.type})
    // per_thread is the medium-neutral spelling; emails_per_thread still works.
    if (flags.type !== 'thread_json') params.set('per_thread', String(flags['messages-per-thread']))
    if (flags.strict) params.set('strict', 'true')

    let data: Record<string, unknown>
    try {
      data = (await client.postForm(
        `/v1/faces/${seg(args.alias)}/upload?${params}`,
        form,
      )) as Record<string, unknown>
    } catch (err) {
      if (err instanceof FacesAPIError) {
        if (err.statusCode === 404) this.error(`No face named '${args.alias}'. It does not exist, or is not yours.`)
        if (err.statusCode === 422 && flags.strict) {
          this.error(`HTTP 422: ${err.message}\nDrop --strict to skip invalid messages instead of refusing the upload.`)
        }
        this.error(`HTTP ${err.statusCode}: ${err.message}`)
      }
      throw err
    }

    if (json) return data

    const threadIds = (data.thread_ids as string[]) ?? []
    const skipped = data.skipped as unknown[] | undefined
    const medium = data.medium as string | null | undefined
    this.log(`face:     ${data.alias ?? args.alias}`)
    this.log(`messages: ${data.message_count ?? '?'}`)
    this.log(`threads:  ${data.thread_count ?? threadIds.length}`)
    // The medium the threads were actually stamped with, which is derived from
    // the messages rather than anything sent. Null is the one silent failure
    // on this path: those threads teach no writing rules and cannot be asked for
    // by medium later, and nothing downstream says so.
    this.log(`medium:   ${medium ?? 'none'}`)
    // Never let a partial upload read as a complete one.
    if (skipped?.length) {
      this.log(`skipped:  ${skipped.length} message(s) failed validation and were not stored.`)
      this.log('          Re-run with --strict to refuse the whole upload instead.')
    }
    this.log('')
    if (medium) {
      this.log(`Build the style: faces style:make ${args.alias} --all`)
    } else {
      this.log('These threads have NO medium, so no style can be built from them until one is set.')
      this.log('That happens when one file mixes media, or when the messages declared none.')
      this.log('Upload one medium per file, or set it: faces compile:thread:edit <id> --medium <medium>')
      this.log(`Inspect what landed: faces face:sources ${args.alias} --type thread`)
    }
    return data
  }
}
