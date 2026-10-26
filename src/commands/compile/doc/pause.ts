import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../../../base.js'
import {FacesAPIError} from '../../../client.js'
import {pollUntilPaused} from '../../../poll.js'
import {seg} from '../../../utils.js'

export default class CompileDocPause extends BaseCommand {
  static description =
    'Ask a running document compilation to stop (preserves progress, resume with make). ' +
    'The compile stops within a few seconds; this waits for it unless --no-wait.'

  static flags = {
    ...BaseCommand.baseFlags,
    'no-wait': Flags.boolean({
      description: 'Return as soon as the pause is accepted, without waiting for the compile to stop.',
      default: false,
    }),
    timeout: Flags.integer({description: 'Seconds to wait for the compile to stop', default: 60}),
  }

  static args = {
    doc_id: Args.string({description: 'Document ID', required: true}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CompileDocPause)
    const client = this.makeClient(flags)
    const json = this.jsonEnabled()

    let data: Record<string, unknown>
    try {
      data = await client.post(`/v1/compile/documents/${seg(args.doc_id)}/pause`) as Record<string, unknown>
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    // POST /pause only acknowledges the request: it answers "pausing", not
    // "paused". Reporting it as stopped here would be a guess. `status` is the
    // authority.
    if (flags['no-wait']) {
      if (!json) {
        process.stderr.write(`Pausing. Poll with: faces compile:doc:get ${args.doc_id} --json\n`)
      }
      return data
    }

    if (!json) process.stderr.write('Pausing')
    const status = await pollUntilPaused(client, args.doc_id, {
      timeoutMs: flags.timeout * 1000,
      onTick: () => {
        if (!json && process.stderr.isTTY) process.stderr.write('.')
      },
    })
    if (!json) process.stderr.write('\n')

    if (!json) this.log(this.report(status, args.doc_id, flags.timeout))
    return {...data, status: status ?? null}
  }

  private report(status: string | null | undefined, id: string, timeout: number): string {
    switch (status) {
      case 'paused': {
        return `Paused. Resume with: faces compile:doc:make ${id}`
      }

      case 'compiled': {
        return 'Compile finished before the pause took effect. Nothing to resume.'
      }

      case 'failed': {
        return 'Compile failed before the pause took effect.'
      }

      case 'not_compiled':
      case null: {
        return 'Stopped. The compile is no longer running.'
      }

      default: {
        return `Still stopping after ${timeout}s. Poll with: faces compile:doc:get ${id} --json`
      }
    }
  }
}
