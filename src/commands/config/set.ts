import {Args} from '@oclif/core'
import {BaseCommand} from '../../base.js'
import {resolveBaseUrl, saveCredentials, setConfigKey} from '../../config.js'

const KNOWN_KEYS = ['base_url', 'api_key', 'token', 'user_id', 'catalog', 'catalog_model', 'credentials_base_url']

export default class ConfigSet extends BaseCommand {
  static description = 'Set a config value (e.g. base_url, api_key, token)'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static args = {
    key: Args.string({description: 'Config key', required: true}),
    value: Args.string({description: 'Config value', required: true}),
  }

  async run(): Promise<unknown> {
    const {args} = await this.parse(ConfigSet)

    // A typo used to be saved and reported as set, then every call failed
    // with a 401 that never mentioned the typo.
    if (!KNOWN_KEYS.includes(args.key)) {
      const close = KNOWN_KEYS.find((k) => k.replace(/_/g, '') === args.key.toLowerCase().replace(/[-_]/g, ''))
      this.error(`Unknown config key "${args.key}".${close ? ` Did you mean ${close}?` : ''} Keys: ${KNOWN_KEYS.join(', ')}`)
    }

    if (args.key === 'base_url') {
      let url: URL | undefined
      try {
        url = new URL(args.value)
      } catch {
        // reported below
      }

      if (!url || !['http:', 'https:'].includes(url.protocol)) {
        this.error(`base_url must be an http(s) URL, such as https://api.faces.sh (got "${args.value}").`)
      }
    }

    // Validate api_key prefix
    if (args.key === 'api_key' && args.value && !args.value.startsWith('sk-faces-')) {
      this.error('Faces API keys start with sk-faces-. This does not look like a Faces API key.')
    }

    // A credential set by hand belongs to the API it is used with now.
    if (args.key === 'api_key' || args.key === 'token') {
      saveCredentials({[args.key]: args.value}, resolveBaseUrl())
    } else {
      setConfigKey(args.key, args.value)
    }
    this.log(`Set ${args.key}.`)
    return {key: args.key, status: 'set'}
  }
}
