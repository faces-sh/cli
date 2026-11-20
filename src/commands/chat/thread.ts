import {Args, Flags} from '@oclif/core'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {conversationFields, conversationTurnFlags} from '../../conversation.js'
import {MODEL_ARG_DESCRIPTION, chatModelProblem, chatPayload, sendChat, type Turn} from '../../chat.js'
import {parseModel} from '../../model.js'
import {resolveEndpoint} from '../../routing.js'
import {COMPACTION_FLAG_DESCRIPTION, SESSION_FLAG_DESCRIPTION, STREAM_FLAG_DESCRIPTION, parseTemperature} from '../../utils.js'
import {chatRefusal} from '../../chat-command.js'

const THREADS_DIR = path.join(os.homedir(), '.faces', 'threads')

interface ThreadMessage extends Turn {
  ts: string
}

interface Thread {
  id: string
  /** The whole model, `@alice:maestro-1/gpt-5.4`. */
  model: string
  /** The endpoint the thread runs on, fixed when it starts. */
  endpoint?: string
  system?: string
  created_at: string
  updated_at: string
  messages: ThreadMessage[]
}

function newThreadId(): string {
  return 't_' + crypto.randomBytes(6).toString('hex')
}

function threadPath(id: string): string {
  // The id names a file, so it must not be able to name any other one:
  // `--id ../config --delete` removed the saved credentials.
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`"${id}" is not a thread id. List them with: faces chat:thread --list`)
  return path.join(THREADS_DIR, `${id}.json`)
}

function loadThread(id: string): Thread | null {
  const p = threadPath(id)
  if (!fs.existsSync(p)) return null
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Thread
}

function saveThread(t: Thread): void {
  if (!fs.existsSync(THREADS_DIR)) fs.mkdirSync(THREADS_DIR, {recursive: true, mode: 0o700})
  t.updated_at = new Date().toISOString()
  fs.writeFileSync(threadPath(t.id), JSON.stringify(t, null, 2), {mode: 0o600})
}

function listThreads(): Thread[] {
  if (!fs.existsSync(THREADS_DIR)) return []
  const out: Thread[] = []
  for (const f of fs.readdirSync(THREADS_DIR)) {
    if (!f.endsWith('.json')) continue
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(THREADS_DIR, f), 'utf8')) as Thread)
    } catch { /* skip a corrupt file */ }
  }
  out.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
  return out
}

export default class ChatThread extends BaseCommand {
  static description =
    'A multi-turn chat with a face, kept under ~/.faces/threads/<id>.json. Start one with the model ' +
    '(@alice:maestro-1/gpt-5.4) and a message, then go on with --id. The whole thread is sent each turn, ' +
    'unless the turn is in a state (--conversation), which holds the history: then only the new message goes.'

  static examples = [
    '<%= config.bin %> <%= command.id %> @socrates:maestro-1/gpt-5.4 -m "What is justice?"',
    '<%= config.bin %> <%= command.id %> --id t_abc123 -m "Say more about that"',
    '<%= config.bin %> <%= command.id %> --list',
    '<%= config.bin %> <%= command.id %> --id t_abc123 --show',
    '<%= config.bin %> <%= command.id %> --id t_abc123 --delete',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({description: 'Go on with a saved thread, by id.'}),
    message: Flags.string({char: 'm', description: 'Your message.'}),
    file: Flags.string({description: 'Read the message from a file.'}),
    system: Flags.string({description: 'System prompt (only when starting a thread).'}),
    'max-tokens': Flags.integer({description: 'The most tokens the reply may take (at least 1).', min: 1}),
    temperature: Flags.string({description: 'Temperature (0.0-2.0).'}),
    stream: Flags.boolean({description: STREAM_FLAG_DESCRIPTION, default: true, allowNo: true}),
    ...conversationTurnFlags({suffix: 'For this turn only. Only the new message is sent: the state holds the rest.'}),
    session: Flags.string({description: `${SESSION_FLAG_DESCRIPTION} For this turn only.`}),
    compaction: Flags.string({description: `${COMPACTION_FLAG_DESCRIPTION} For this turn only.`}),
    'oauth-only': Flags.boolean({description: 'On a linked ChatGPT plan, run there or fail: never fall back to credits.', default: false}),
    list: Flags.boolean({description: 'List saved threads.', default: false}),
    show: Flags.boolean({description: 'Show a thread (needs --id).', default: false}),
    delete: Flags.boolean({description: 'Delete a thread (needs --id).', default: false}),
    yes: Flags.boolean({description: 'Skip the confirmation for --delete.', default: false}),
  }

  static args = {
    model: Args.string({description: `${MODEL_ARG_DESCRIPTION} Needed to start a thread; a saved thread keeps its own.`, required: false}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(ChatThread)
    if (flags.list) return this.handleList()
    if (flags.delete) return this.handleDelete(flags.id, flags.yes)
    if (flags.show) return this.handleShow(flags.id)

    let message: string
    if (flags.file) {
      if (!fs.existsSync(flags.file)) this.error(`File not found: ${flags.file}`)
      message = fs.readFileSync(flags.file, 'utf8')
    } else if (flags.message) {
      message = flags.message
    } else {
      this.error('Provide --message/-m or --file.')
    }

    let turn: Record<string, unknown>
    try {
      turn = conversationFields(flags)
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err))
    }
    // In a state the server holds the history and reads it before the new
    // message: replaying the thread would add its earlier messages again.
    const newOnly = Boolean(flags.conversation || flags.session)

    let thread: Thread
    if (flags.id) {
      let existing: Thread | null
      try {
        existing = loadThread(flags.id)
      } catch (err) {
        this.error(err instanceof Error ? err.message : String(err))
      }
      if (!existing) this.error(`Thread not found: ${flags.id}`)
      thread = existing
      if (args.model && args.model.trim() !== thread.model) this.warn(`A thread keeps its model; going on with ${thread.model}.`)
      if (flags.system) this.warn('--system is ignored when going on with a thread.')
    } else {
      if (!args.model) this.error('Name the model to start a thread (e.g. faces chat:thread @socrates:maestro-1/gpt-5.4 -m "..."), or --id to go on with one.')
      const now = new Date().toISOString()
      thread = {id: newThreadId(), model: args.model.trim(), system: flags.system, created_at: now, updated_at: now, messages: []}
    }
    // A thread saved before the model grammar changed holds `alias@model`.
    const problem = chatModelProblem(thread.model)
    if (problem) this.error(`${problem}\nThis thread was saved with the old form; start a new one with the new model.`)

    const client = this.makeClient(flags)
    if (!thread.endpoint) thread.endpoint = (await resolveEndpoint(client, parseModel(thread.model).downstream as string)).endpoint
    const endpoint = thread.endpoint

    thread.messages.push({role: 'user', content: message, ts: new Date().toISOString()})
    const sent = newOnly ? thread.messages.slice(-1) : thread.messages
    const json = this.jsonEnabled()
    let payload: Record<string, unknown>
    try {
      payload = chatPayload(endpoint, thread.model, sent.map((m) => ({role: m.role, content: m.content})), {
        system: thread.system,
        maxTokens: flags['max-tokens'],
        temperature: flags.temperature === undefined ? undefined : parseTemperature(flags.temperature, (m) => this.error(m)),
        stream: flags.stream && !json,
        oauthOnly: flags['oauth-only'],
        session: flags.session,
        compaction: flags.compaction,
        turn,
      })
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err))
    }

    try {
      const res = await sendChat(client, endpoint, payload, (d) => process.stdout.write(d), json)
      // Nothing answered means nothing saved, so the same message can be sent again.
      if (!res.text) this.error('No answer came back. Run it again with --no-stream to see what the server said.')
      thread.messages.push({role: 'assistant', content: res.text, ts: new Date().toISOString()})
      saveThread(thread)
      if (json) return {thread_id: thread.id, model: thread.model, endpoint, assistant: res.text, turns: thread.messages.length}
      if (payload.stream) process.stdout.write('\n')
      else this.log(res.text)
      this.log(`\n[thread ${thread.id}  ·  ${thread.messages.length} turns]`)
      return {thread_id: thread.id, assistant: res.text}
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(await chatRefusal(err, thread.model, endpoint, false, client))
      throw err
    }
  }

  private handleList(): unknown {
    const threads = listThreads()
    if (this.jsonEnabled()) {
      return threads.map((t) => ({id: t.id, model: t.model, turns: t.messages.length, created_at: t.created_at, updated_at: t.updated_at}))
    }
    if (threads.length === 0) {
      this.log('(no threads)')
      return {}
    }
    for (const t of threads) {
      const last = t.messages.at(-1)
      this.log(`${t.id}  ${t.model}  (${t.messages.length} turns, updated ${t.updated_at})`)
      if (last) this.log(`  ${last.role}: ${last.content.slice(0, 60).replace(/\s+/g, ' ')}${last.content.length > 60 ? '…' : ''}`)
    }
    return {}
  }

  private async handleDelete(id: string | undefined, yes: boolean): Promise<unknown> {
    if (!id) this.error('--delete needs --id <thread-id>')
    let p: string
    try {
      p = threadPath(id)
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err))
    }
    if (!fs.existsSync(p)) this.error(`Thread not found: ${id}`)
    await this.confirmOrRefuse(`Delete thread ${id} and its history?`, yes)
    fs.unlinkSync(p)
    if (!this.jsonEnabled()) this.log(`Deleted thread ${id}`)
    return {deleted: id}
  }

  private handleShow(id?: string): unknown {
    if (!id) this.error('--show needs --id <thread-id>')
    let t: Thread | null
    try {
      t = loadThread(id)
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err))
    }
    if (!t) this.error(`Thread not found: ${id}`)
    if (this.jsonEnabled()) return t
    this.log(`Thread ${t.id}  (${t.model})`)
    this.log(`Created: ${t.created_at}`)
    this.log(`Updated: ${t.updated_at}`)
    if (t.system) this.log(`---\nsystem: ${t.system}`)
    for (const m of t.messages) this.log(`---\n${m.role} [${m.ts}]:\n${m.content}`)
    return t
  }
}
