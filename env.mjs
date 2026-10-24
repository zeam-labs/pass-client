export const SETTINGS = ['PRIVATE_KEY', 'MCP_URL', 'UPSTREAM', 'NETWORK', 'ASSET', 'NAME', 'GRANT', 'STATE_DIR', 'RPC_URL', 'RELAY_URL', 'MAX_SPEND', 'DEPOSIT_MULTIPLIER', 'PAYER_ADDRESS', 'SALT', 'LINE', 'LINE_AHEAD_MS', 'LINE_IDLE_MS', 'EXIT_WAIT_MS', 'AUTO_FAST_RUN', 'AUTO_GAP_MS', 'SESSION', 'SESSION_ESCROW', 'SESSION_FACTORY', 'SESSION_SPLIT']

export const TAG = '[zeam-pass]'

export const nameInForce = (name, env = process.env) =>
  env[`PASS_${name}`] === undefined && env[`X402_${name}`] !== undefined ? `X402_${name}` : `PASS_${name}`
const said = new Set()

export function setting(name, env = process.env, say = (m) => console.error(TAG, m)) {
  if (!SETTINGS.includes(name)) throw new Error(`no setting named ${name}`)
  const now = env[`PASS_${name}`]
  const old = env[`X402_${name}`]
  if (now === undefined) return old
  if (old !== undefined && old !== now && !said.has(name)) {
    said.add(name)
    say(`PASS_${name} and X402_${name} are both set and differ: using PASS_${name}`)
  }
  return now
}
