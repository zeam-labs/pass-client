import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export const USER_AGENT = `zeam-pass-client/${version} node`

export const withAgent = (fetchFn, agent = USER_AGENT) => (input, init = {}) => {
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
  if (headers.has('user-agent')) return fetchFn(input, init)
  headers.set('user-agent', agent)
  return fetchFn(input, { ...init, headers })
}
