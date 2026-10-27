import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {codexEligible} from '../../routing.js'
import {
  BUILDS_PATH,
  LIVE_THREAD_MEDIUM,
  Selectable,
  SourceRef,
  formatBuildReport,
  jobFailureMessage,
  jobMedium,
  listSelectable,
  parseSourceArg,
  pollStyleJob,
  publicJob,
  chatgptLinked,
  styleCreditRefusal,
} from '../../style.js'

export default class StyleMake extends BaseCommand {
  static description =
    'Build a style for a face from its own writing, one per medium, and install it. Building does not ' +
    'apply it: chat with --style <medium> to use it. Name the sources with --source, or take everything ' +
    'ready with --all. On Connect or Pro with ChatGPT linked, a build runs there at no charge. Anywhere ' +
    'else it is charged to credits, which needs --allow-paid.'

  static examples = [
    '<%= config.bin %> <%= command.id %> alice --all',
    '<%= config.bin %> <%= command.id %> alice --source 1a2b3c4d --source 5e6f7a8b',
    '<%= config.bin %> <%= command.id %> alice --source 1a2b3c4d:essay',
    '<%= config.bin %> <%= command.id %> alice --all --medium essay --no-wait',
  ]

  static flags = {
    ...BaseCommand.baseFlags,
    source: Flags.string({
      description:
        'A document or thread to build from, by id (repeatable). Append :<medium> to declare what it ' +
        'is, e.g. --source 1a2b3c4d:essay, when the source does not already say.',
      multiple: true,
    }),
    all: Flags.boolean({
      description: 'Use every source on the face that is ready. Anything skipped is listed.',
      default: false,
    }),
    medium: Flags.string({
      description:
        'Medium for selected sources that do not already declare one. It does not override a source ' +
        'that does. Each medium\'s style is built separately.',
    }),
    model: Flags.string({
      description:
        'The model the build runs on through your linked ChatGPT account. Leave it out for the default. ' +
        'A named model is used only when it can run on ChatGPT (see faces models:list --chatgpt). ' +
        'A build charged to credits always runs on the default build model, whatever is named here.',
    }),
    'allow-paid': Flags.boolean({
      description:
        'Permit a build charged to credits, at the build model\'s listed price. Without it a build runs ' +
        'only on a linked ChatGPT account, at no charge, or does not start. Needed on Free, and on ' +
        'Connect or Pro without ChatGPT linked.',
      default: false,
    }),
    compile: Flags.boolean({
      description:
        'Compile any named source that is not compiled yet, before the build, billed as an ordinary ' +
        'compile. On by default. --no-compile builds from what is already compiled and never bills for compiling.',
      default: true,
      allowNo: true,
    }),
    'no-wait': Flags.boolean({description: 'Start the build and return the job id without polling.', default: false}),
    timeout: Flags.integer({description: 'How long to wait, in seconds', default: 3600}),
  }

  static args = {
    alias: Args.string({description: 'Face alias', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(StyleMake)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()

    if (!flags.all && (!flags.source || flags.source.length === 0)) {
      this.error(
        'Name what to build from: --source <id> (repeatable), or --all for everything ready.\n' +
          `See what is available with: faces face:sources ${args.alias}`,
      )
    }
    if (flags.all && flags.source?.length) {
      this.error('Pass either --all or --source, not both.')
    }

    const available = await this.load(client, args.alias)
    const {sources, skipped} = this.select(available, flags, args.alias)

    if (flags.model) await this.checkBilling(client, flags.model, flags['allow-paid'])

    const payload: Record<string, unknown> = {
      self_face: args.alias,
      sources,
      compile: flags.compile,
      // Sent either way: left out, the server charges credits for any build
      // that cannot run on the ChatGPT link, without asking.
      oauth_only: !flags['allow-paid'],
    }
    if (flags.model) payload.model = flags.model

    if (!json && skipped.length > 0) {
      for (const line of skipped) process.stderr.write(`skipped: ${line}\n`)
    }
    if (!json) {
      process.stderr.write(
        `Building a style for '${args.alias}' from ${sources.length} source(s)${flags.model ? ` using ${flags.model}` : ''}.\n`,
      )
    }

    let started: Record<string, unknown>
    try {
      started = (await client.post(BUILDS_PATH, {body: payload})) as Record<string, unknown>
    } catch (err) {
      this.reportStartFailure(err)
    }

    const jobId = String(started!.job_id ?? '')
    if (!jobId) this.error('The server accepted the build but returned no job id.')

    if (flags['no-wait']) {
      if (json) return {...started, sources, skipped}
      this.log(`Build started: ${jobId}`)
      this.log(`Read it with: faces style:status ${jobId}`)
      return started!
    }

    const final = await this.awaitJob(client, jobId, flags.timeout, json)
    if (final.status === 'failed') this.error(`Build failed: ${jobFailureMessage(final.error, await chatgptLinked(client), final.error_code)}`)

    if (json) return {...publicJob(final), sources, skipped}
    for (const line of formatBuildReport(final)) this.log(line)
    this.log('')
    // Building a style does not apply it. The face still answers in its
    // ordinary voice; --style is how a caller asks for the style.
    const medium = jobMedium(final)?.split(', ')[0]
    const style = !medium ? '<medium>' : medium.includes(' ') ? `"${medium}"` : medium
    this.log(`'${args.alias}' has built a style. Use it with --style and the medium:`)
    this.log(`  faces chat:chat ${args.alias} --style ${style} -m "..."`)
    this.log(`Without --style, no built style is applied.`)
    this.log(`Go back to the previous style: faces style:revert ${args.alias} --yes`)
    return final
  }

  private async load(client: ReturnType<typeof this.makeClient>, alias: string): Promise<Selectable[]> {
    try {
      return await listSelectable(client, alias)
    } catch (err) {
      if (err instanceof FacesAPIError) {
        if (err.statusCode === 404) this.error(`No face named '${alias}'. It does not exist, or is not yours.`)
        this.error(`HTTP ${err.statusCode}: ${err.message}`)
      }
      throw err
    }
  }

  /**
   * Turn the flags into the wire's source list.
   *
   * The API wants {id, medium, source_type} per source and deliberately refuses
   * to guess the medium. The listing already knows all three for most sources,
   * so a user only has to supply what genuinely cannot be derived.
   */
  private select(
    available: Selectable[],
    flags: {all: boolean; source?: string[]; medium?: string; compile: boolean},
    alias: string,
  ): {sources: SourceRef[]; skipped: string[]} {
    const byId = new Map(available.map((s) => [s.id, s]))
    const skipped: string[] = []
    let chosen: Array<{s: Selectable; declared?: string}>

    if (flags.all) {
      if (available.length === 0) {
        this.error(
          `'${alias}' has no sources to build from. Add some with faces compile:doc or faces style:upload.`,
        )
      }
      chosen = []
      for (const s of available) {
        // Imported material and documents go in whether or not they are
        // compiled: compiling them is part of the build, which is what
        // --compile is for, and a corpus is never compiled at upload time.
        //
        // A live thread is the exception. It compiles as its messages arrive
        // and is billed per message, so sweeping an unfinished one would charge
        // for turns the user did not send. Those wait to be named.
        // The server reports how many messages a style build would actually read.
        // Zero is a guaranteed intake failure, and one bad source fails the
        // whole request, so a sweep must not pull them in.
        if (s.authored === 0) {
          skipped.push(`${s.label} (${s.id}) has nothing written by this person to build from.`)
          continue
        }
        if (s.isCorpus || s.synced) {
          if (!flags.compile && !s.synced) {
            skipped.push(`${s.label} (${s.id}) is not compiled, and --no-compile leaves it out.`)
            continue
          }
          chosen.push({s})
        } else {
          skipped.push(
            `${s.label} (${s.id}) is a thread that is still compiling. Name it with --source once it is done.`,
          )
        }
      }
      if (chosen.length === 0) {
        this.error(
          `Nothing on '${alias}' is ready to build from.\n` +
            (flags.compile
              ? 'Add material with faces style:upload or faces compile:doc, then try again.'
              : '--no-compile only uses sources that are already compiled, and none are. Drop it to compile them as part of this build.'),
        )
      }
    } else {
      chosen = []
      const missing: string[] = []
      // Naming a source twice is accepted by the server and prints it twice,
      // which weights it double in the analysis for no stated reason. A later
      // mention wins so `--source X --source X:essay` declares a medium rather
      // than being a contradiction.
      const seen = new Map<string, string | undefined>()
      for (const raw of flags.source ?? []) {
        const {id, medium} = parseSourceArg(raw)
        if (!byId.has(id)) {
          missing.push(id)
          continue
        }
        if (seen.has(id) && medium === undefined) continue
        seen.set(id, medium ?? seen.get(id))
      }
      for (const [id, medium] of seen) chosen.push({s: byId.get(id)!, declared: medium})
      if (missing.length > 0) {
        this.error(
          `Not a source on '${alias}': ${missing.join(', ')}\n` +
            `List what is there with: faces face:sources ${alias}`,
        )
      }
    }

    const undeclared: Selectable[] = []
    const sources: SourceRef[] = []
    for (const {s, declared} of chosen) {
      // A medium the source already declares is NOT sent. The server resolves it
      // from the source itself, which cannot go stale the way our reading of its
      // fields can: reading a renamed field once filed three corpus rooms as
      // conversations. What we send is only ever what the caller chose.
      //
      // --medium fills gaps and must not override a source that declares one:
      // resubmitting a document that says "essay" as something else leaves a
      // stamp misreporting how it was read.
      //
      // A live thread declares nothing and is a conversation by construction, so
      // that default comes last, after anything the caller asked for.
      const chosenMedium = declared ?? (s.medium ? undefined : flags.medium)
      if (chosenMedium) {
        sources.push({id: s.id, medium: chosenMedium, source_type: s.sourceType})
      } else if (s.medium) {
        sources.push({id: s.id, source_type: s.sourceType})
      } else if (s.isLiveThread) {
        sources.push({id: s.id, medium: LIVE_THREAD_MEDIUM, source_type: s.sourceType})
      } else {
        undeclared.push(s)
      }
    }

    if (undeclared.length > 0) {
      const list = undeclared
        .map((s) => `  ${s.id}  ${s.label}${s.sourceType === 'thread' ? '  (thread)' : ''}`)
        .join('\n')
      const first = undeclared[0]
      const ways = [
        '  --medium email                 applies to every source that does not say',
        `  --source ${first.id}:email   applies to just this one`,
      ]
      // Both kinds can now record it permanently, through different commands.
      ways.push(
        first.sourceType === 'document'
          ? `  faces compile:doc:edit ${first.id} --medium email   records it permanently`
          : `  faces compile:thread:edit ${first.id} --medium email   records it permanently`,
      )
      this.error(
        `These sources do not say what sort of writing they are, and a style build will not guess:\n${list}\n\n` +
          `Declare it, using the real medium rather than the example:\n${ways.join('\n')}\n\n` +
          'A wrong declaration is worse than a missing one: a mislabelled source goes into the wrong ' +
          'medium\'s style, and nothing afterwards says it happened.',
      )
    }

    return {sources, skipped}
  }

  /**
   * Refuse a build on a named model that would be charged without being asked
   * to, and say when a named model will not be the one that runs.
   *
   * A named model is honoured only on the linked ChatGPT account. Anywhere else
   * the build runs on the default build model and is charged to credits, so a
   * model that cannot run on ChatGPT is never used. Reaching for one to work
   * around an expired link turns a fixable login into a charge, which is why
   * this is a refusal and not a warning. The default route needs no check
   * here: `oauth_only` keeps it from being charged.
   */
  private async checkBilling(
    client: ReturnType<typeof this.makeClient>,
    model: string,
    allowPaid: boolean,
  ): Promise<void> {
    const eligible = await codexEligible(client, model)
    if (allowPaid) {
      if (eligible === false && !this.jsonEnabled()) {
        process.stderr.write(
          `'${model}' cannot run on ChatGPT, so this build runs on the default build model, charged to credits.\n`,
        )
      }
      return
    }
    if (eligible === false) {
      this.error(
        `'${model}' cannot run on ChatGPT, so this build would run on the default build model and be charged to credits.\n` +
          'Leave out --model to build on your linked ChatGPT account at no charge, ' +
          'or re-run with --allow-paid if you mean to pay.\n' +
          'If you are here because a build failed on authentication, reconnect instead: faces auth:connect openai',
      )
    }

    // A build that is not charged runs on the linked ChatGPT account, and
    // there is none.
    if ((await chatgptLinked(client)) === false) {
      this.error(
        'No ChatGPT account is linked, so this build has nothing to run on without being charged.\n' +
          'Link one with: faces auth:connect openai (Connect or Pro), ' +
          'or re-run with --allow-paid to pay from credits. Nothing was started.',
      )
    }
  }

  /** Translate a pre-flight refusal into the decision the user has to make. */
  private reportStartFailure(err: unknown): never {
    if (!(err instanceof FacesAPIError)) throw err
    // A style build for this face and medium is already running. Starting another
    // used to run both in full and keep only the later one, so the server now
    // refuses and names the running job. Following it is the whole answer.
    if (err.errorCode === 'build_in_progress') {
      const running = typeof err.details?.job_id === 'string' ? err.details.job_id : undefined
      this.error(
        `${err.message}\n` +
          (running
            ? `Follow that one instead: faces style:status ${running} --wait`
            : 'Find it with: faces style:status --face <alias>') +
          '\nNothing was started, and nothing was charged.',
      )
    }
    // Free has no ChatGPT route, so a build there bills credits and a free one
    // cannot run at all.
    if (err.errorCode === 'oauth_only_unavailable') {
      // Only the server's sentence: the client's own hint is about --oauth-only,
      // a flag this command does not have.
      this.error(
        `HTTP 422: ${err.message.split('\n')[0]}\n` +
          'On the Free plan a style build is charged to credits. Re-run with --allow-paid to pay, ' +
          'or subscribe to Connect or Pro and link ChatGPT, where a build runs at no charge: ' +
          'faces billing:subscription:activate\nNothing was started.',
      )
    }
    // Without --allow-paid a build runs only on the linked ChatGPT account,
    // and this one cannot: none is linked, or the named model cannot run there.
    if (err.errorCode === 'chatgpt_not_linked') {
      this.error(
        'This build cannot run on a linked ChatGPT account: none is linked, or the named --model cannot run there.\n' +
          'Link ChatGPT with: faces auth:connect openai (Connect or Pro), ' +
          'or re-run with --allow-paid to pay from credits.\nNothing was started, and nothing was charged.',
      )
    }
    // Charged to credits, and the balance cannot cover the estimate.
    if (err.errorCode === 'insufficient_credit_for_style_build') {
      this.error(styleCreditRefusal(err.details))
    }
    // Every one of these lands before the job exists, so nothing has started.
    const hint: Record<number, string> = {
      403: 'That source belongs to another account.',
      404: 'Check the id against: faces face:sources <alias>',
      409: 'A source is compiling right now, or the face is locked. Wait for it to finish, or unlock the face.',
      422: 'A named thread has messages that are not compiled yet. Compile it first, or pass --no-compile.',
    }
    const extra = hint[err.statusCode]
    this.error(`HTTP ${err.statusCode}: ${err.message}${extra ? `\n${extra}` : ''}\nNothing was started.`)
  }

  private async awaitJob(
    client: ReturnType<typeof this.makeClient>,
    jobId: string,
    timeout: number,
    json: boolean,
  ): Promise<Record<string, unknown>> {
    let last = ''
    try {
      return await pollStyleJob(client, BUILDS_PATH, jobId, {
        timeoutMs: timeout * 1000,
        onPoll: (d) => {
          if (json) return
          const p = d.progress as {done?: number; total?: number} | undefined
          const status = String(d.status ?? '')
          const key = `${status}:${p?.done ?? ''}/${p?.total ?? ''}`
          if (key === last) return
          last = key
          process.stderr.write(`  ${status}${p?.total ? ` ${p.done ?? 0}/${p.total}` : ''}\n`)
        },
      })
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      this.error(err instanceof Error ? err.message : String(err))
    }
  }
}
