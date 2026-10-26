import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {FacesAPIError} from '../../client.js'
import {resolveBaseUrl, saveCredentials} from '../../config.js'
import {parseBudget} from '../../utils.js'

export default class KeysCreate extends BaseCommand {
  static description =
    'Create a new API key (JWT required). The new key is saved to ~/.faces/config.json as api_key by default; pass --no-save to skip.'

  static flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({description: 'Key name/label', required: true}),
    'expires-days': Flags.integer({description: 'Expiry in days, 1 to 36500 (omit for no expiry)', min: 1, max: 36500}),
    budget: Flags.string({description: 'Lifetime spend cap in USD, e.g. 5 or 0.50 (omit for no cap)'}),
    face: Flags.string({
      description: 'Only chat with this face alias (repeatable). Other faces are refused for chat; their details can still be read.',
      multiple: true,
    }),
    model: Flags.string({description: 'Only use this model (repeatable)', multiple: true}),
    save: Flags.boolean({
      description: 'Save the new key to ~/.faces/config.json as api_key (default: true; use --no-save to skip)',
      default: true,
      allowNo: true,
    }),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(KeysCreate)
    const client = this.makeClient(flags)

    const payload: Record<string, unknown> = {name: flags.name}
    if (flags['expires-days'] !== undefined) payload.expires_in_days = flags['expires-days']
    if (flags.budget !== undefined) payload.budget_usd = parseBudget(flags.budget, (m) => this.error(m))
    if (flags.face && flags.face.length > 0) payload.allowed_face_ids = flags.face
    if (flags.model && flags.model.length > 0) payload.allowed_llm_models = flags.model

    let data: Record<string, unknown>
    try {
      data = (await client.post('/v1/auth/api-keys', {
        requireJwt: true,
        body: payload,
      })) as Record<string, unknown>
    } catch (err) {
      if (err instanceof FacesAPIError) this.error(`HTTP ${err.statusCode}: ${err.message}`)
      throw err
    }

    // The plaintext secret is returned exactly once: here. keys:list only ever
    // returns it truncated, so it must be saved or copied now.
    const apiKey = (data.key ?? data.api_key ?? data.secret) as string | undefined
    let saved = false
    if (flags.save && apiKey) {
      saveCredentials({api_key: apiKey}, resolveBaseUrl(flags['base-url']))
      saved = true
    }

    if (this.jsonEnabled()) {
      data._saved_to_config = saved
      return data
    }

    this.printHuman(data)
    this.log('')
    this.log('⚠  The full key is shown only once. `faces keys:list` returns it truncated by design.')
    if (saved) {
      this.log('✓  Saved to ~/.faces/config.json as api_key. Faces commands will use it automatically.')
    } else if (!flags.save) {
      this.log('   Not saved (--no-save). Copy the key above now.')
    } else {
      this.warn('Could not find the key in the response. Nothing was saved. Copy it manually.')
    }
    return data
  }
}
