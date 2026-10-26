import {Args, Flags} from '@oclif/core'
import fs from 'node:fs'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {seg} from '../../../utils.js'

/**
 * One message as the API takes it.
 *
 * `name` is the speaker label and the only spelling the API accepts. It was
 * also `from` until 2026-09-11, and sending the old name is now a 422 rather
 * than a silent drop, so nobody loses labels behind a 200.
 */
interface ThreadMessage {
  role: 'user' | 'assistant'
  content: string
  name?: string
}

export default class CompileThreadReplace extends BaseCommand {
  static description =
    "Replace every message in a thread from a file, keeping the thread's id. For a conversation that " +
    'grows, this is what keeps it one thread: send the whole transcript again and compile it, rather ' +
    'than uploading each new stretch as another thread. Nothing is generated and nothing is billed; ' +
    'this only writes content. Run compile:thread:make afterwards to compile it.'

  static examples = [
    '<%= config.bin %> <%= command.id %> THREAD_ID --file transcript.txt --face-speaker Alice',
    '<%= config.bin %> <%= command.id %> THREAD_ID --file messages.json',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    file: Flags.string({
      description:
        'Transcript ("SPEAKER: line" per turn) or a JSON array of {role, content, name}. Which one it ' +
        'is is detected and reported, so a wrong guess is visible before you compile. A `from` key in a ' +
        'JSON file is still read as the speaker label.',
      required: true,
    }),
    'face-speaker': Flags.string({
      description:
        "Speaker whose lines are the face's own. Everyone else becomes the other side. Required for a " +
        'transcript unless it has only one speaker; for a JSON file it overrides the roles given.',
    }),
  }

  static args = {
    thread_id: Args.string({description: 'Thread ID', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CompileThreadReplace)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()

    if (!fs.existsSync(flags.file)) this.error(`File not found: ${flags.file}`)
    const raw = fs.readFileSync(flags.file, 'utf8')

    const parsed = parseMessages(raw, flags['face-speaker'])
    if (parsed.messages.length === 0) {
      // Replacing with nothing would empty the thread. That is never what a
      // caller means by "replace", and it is not recoverable from here.
      this.error(
        `No messages found in ${flags.file}, so there is nothing to replace with.\n` +
          'A transcript needs one "SPEAKER: text" line per turn; a JSON file needs an array of ' +
          '{role, content}. The thread was left alone.',
      )
    }

    const speakers = [...new Set(parsed.messages.map((m) => m.name).filter(Boolean))] as string[]
    if (parsed.format === 'transcript' && !flags['face-speaker'] && speakers.length > 1) {
      this.error(
        `${flags.file} has more than one speaker (${speakers.join(', ')}) and none is marked as the face.\n` +
          'Say which with --face-speaker, or every line will be read as somebody else talking.',
      )
    }

    // A --face-speaker that names nobody made every line someone else's, and
    // reported success with "0 from the face".
    if (parsed.format === 'transcript' && flags['face-speaker'] && !parsed.messages.some((m) => m.role === 'user')) {
      this.error(
        `No speaker in ${flags.file} is called "${flags['face-speaker']}". The speakers are: ${speakers.join(', ') || 'none found'}.\n` +
          'The thread was left alone.',
      )
    }

    let data: unknown
    try {
      data = await client.patch(`/v1/compile/threads/${seg(args.thread_id)}/messages`, {
        body: {messages: parsed.messages},
      })
    } catch (err) {
      if (err instanceof FacesAPIError) {
        if (err.statusCode === 404) this.error(`No thread '${args.thread_id}'. It does not exist, or is not yours.`)
        if (err.statusCode === 409) {
          this.error(`HTTP 409: ${err.message}\nThe thread or its face may be locked, or a compile may be running.`)
        }
        this.error(`HTTP ${err.statusCode}: ${err.message}`)
      }
      throw err
    }

    if (json) return {thread_id: args.thread_id, format: parsed.format, messages: parsed.messages.length, speakers}

    const mine = parsed.messages.filter((m) => m.role === 'user').length
    this.log(`Replaced with ${parsed.messages.length} message(s) read as ${parsed.format}.`)
    this.log(`${mine} from the face, ${parsed.messages.length - mine} from others.`)
    this.log(`Compile it: faces compile:thread:make ${args.thread_id}`)
    return data as Record<string, unknown>
  }
}

/** A speaker-labelled line: `NAME: text`. The label runs to the first colon. */
const SPEAKER_LINE = /^([^\n:]{1,64}):\s?(.*)$/

/**
 * Read messages from either shape.
 *
 * A JSON array is taken as written. Anything else is read as a transcript, the
 * same `SPEAKER: text` shape `compile:upload --kind thread` accepts, so a caller
 * with a transcript does not need a second serialisation of it.
 *
 * Detection is by content rather than by extension, and the result is reported,
 * because a file read as the wrong shape should be visible before it is
 * compiled rather than after.
 */
export function parseMessages(
  raw: string,
  faceSpeaker?: string,
): {messages: ThreadMessage[]; format: 'json' | 'transcript'} {
  const trimmed = raw.trim()
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed) as Array<Record<string, unknown>>
      if (Array.isArray(arr) && arr.every((m) => typeof m?.content === 'string')) {
        return {format: 'json', messages: arr.map((m) => toMessage(m, faceSpeaker))}
      }
    } catch {
      // Not JSON after all; fall through and read it as a transcript.
    }
  }

  const messages: ThreadMessage[] = []
  for (const line of raw.split('\n')) {
    const m = SPEAKER_LINE.exec(line)
    if (m) {
      messages.push({role: 'assistant', content: m[2].trim(), name: m[1].trim()})
      continue
    }
    // A line with no speaker continues the turn above it, so a multi-line
    // answer stays one message instead of becoming several unattributed ones.
    const last = messages.at(-1)
    if (last && line.trim()) last.content = `${last.content}\n${line.trim()}`.trim()
  }

  const lower = faceSpeaker?.trim().toLowerCase()
  for (const msg of messages) {
    msg.role = lower && msg.name?.toLowerCase() === lower ? 'user' : 'assistant'
  }
  return {format: 'transcript', messages: messages.filter((m) => m.content)}
}

function toMessage(m: Record<string, unknown>, faceSpeaker?: string): ThreadMessage {
  // A caller's JSON file may still say `from`; only the wire field is fixed.
  const name = (m.name ?? m.from) as string | undefined
  const lower = faceSpeaker?.trim().toLowerCase()
  const role = lower ? (name?.toLowerCase() === lower ? 'user' : 'assistant') : m.role === 'user' ? 'user' : 'assistant'
  return {role, content: String(m.content ?? ''), ...(name ? {name} : {})}
}
