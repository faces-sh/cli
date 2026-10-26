import {FacesAPIError} from './client.js'

export const SESSIONS_PATH = '/v1/sessions'

/** A session as the API returns it. */
export interface Session {
  object?: string
  id?: string
  model?: string
  turns?: number
  status?: string
  created_at?: string
  last_used_at?: string
  expires_at?: string
}

/** The lines a session prints as. */
export function sessionLines(s: Session): string[] {
  const pairs: Array<[string, unknown]> = [
    ['session', s.id],
    ['face', s.model],
    ['status', s.status],
    ['turns', s.turns],
    ['created', s.created_at],
    ['last used', s.last_used_at],
    ['expires', s.expires_at],
  ]
  return pairs.filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${`${k}:`.padEnd(11)}${v}`)
}

/** What to add to a session refusal, or undefined when the server's message says it all. */
export function sessionHint(err: FacesAPIError): string | undefined {
  if (err.statusCode === 404) return 'Sessions expire 30 days after their last turn, and a closed one cannot be used. Start another with: faces session:create <face>'
  return undefined
}
