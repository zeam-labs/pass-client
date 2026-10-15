import { keccak256, toHex, getAddress, parseAbi } from 'viem'

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const UINT = /^(0|[1-9]\d*)$/
const DOMAINS = {
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { name: 'USD Coin', version: '2' },
  '0x036cbd53842c5426634e7929541ec2318f3dcf7e': { name: 'USDC', version: '2' },
}
const tokenAbi = parseAbi(['function name() view returns (string)', 'function version() view returns (string)'])
const TYPES = { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] }
export const CHARGE_LIFE_SECS = 600
const BOUND = ['id', 'realm', 'method', 'intent', 'request', 'expires', 'digest', 'header', 'opaque']

const b64url = (text) => Buffer.from(text, 'utf8').toString('base64url')
const unb64url = (text) => JSON.parse(Buffer.from(String(text), 'base64url').toString('utf8'))

export function parseChallenges(value) {
  const out = []
  const s = String(value ?? '')
  let i = 0
  const ws = () => { while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++ }
  const token = () => { const from = i; while (i < s.length && TOKEN.test(s[i])) i++; return s.slice(from, i) }
  let current = null
  while (i < s.length) {
    ws()
    if (s[i] === ',') { i++; continue }
    const word = token()
    if (word === '') break
    ws()
    if (s[i] !== '=') {
      current = word.toLowerCase() === 'payment' ? {} : null
      if (current !== null) out.push(current)
      continue
    }
    i++
    ws()
    let v = ''
    if (s[i] === '"') {
      i++
      while (i < s.length && s[i] !== '"') { if (s[i] === '\\' && i + 1 < s.length) i++; v += s[i++] }
      i++
    } else v = token()
    if (current !== null && !Object.hasOwn(current, word)) current[word] = v
  }
  return out.filter((c) => typeof c.id === 'string' && c.id !== '' && typeof c.realm === 'string' && typeof c.method === 'string' && typeof c.intent === 'string' && typeof c.request === 'string')
}

export function requestOf(challenge) {
  if (challenge.request !== null && typeof challenge.request === 'object') return challenge.request
  try { return unb64url(challenge.request) } catch { return null }
}

export function evmCharges(challenges, network) {
  const chainId = Number(String(network).split(':')[1])
  const out = []
  for (const challenge of challenges) {
    if (challenge.method !== 'evm' || challenge.intent !== 'charge') continue
    const request = requestOf(challenge)
    const d = request?.methodDetails
    if (!request || !d || Number(d.chainId) !== chainId) continue
    if (!Array.isArray(d.credentialTypes) || !d.credentialTypes.includes('authorization')) continue
    if (Array.isArray(d.splits) && d.splits.length) continue
    if (typeof request.amount !== 'string' || !UINT.test(request.amount)) continue
    let currency, recipient
    try { currency = getAddress(request.currency); recipient = getAddress(request.recipient) } catch { continue }
    if (challenge.expires && !(new Date(challenge.expires).getTime() > Date.now())) continue
    out.push({ challenge, request, amount: BigInt(request.amount), currency, recipient, chainId })
  }
  return out
}

export async function tokenDomain(pub, currency, chainId) {
  const known = DOMAINS[currency.toLowerCase()]
  const [name, version] = known ? [known.name, known.version] : await Promise.all([
    pub.readContract({ address: currency, abi: tokenAbi, functionName: 'name' }),
    pub.readContract({ address: currency, abi: tokenAbi, functionName: 'version' }),
  ])
  return { name, version, chainId, verifyingContract: currency }
}

export const echoOf = (challenge) => {
  const echoed = {}
  for (const k of BOUND) if (challenge[k] !== undefined && challenge[k] !== null) echoed[k] = challenge[k]
  return echoed
}

export const challengeHash = (challenge) => keccak256(toHex(JSON.stringify([challenge.id, challenge.realm])))

export async function payCharge({ signer, pub, offer }) {
  const { challenge, request, currency, recipient, chainId } = offer
  const from = getAddress(signer.address)
  const now = Math.floor(Date.now() / 1000)
  const asked = challenge.expires ? Math.floor(new Date(challenge.expires).getTime() / 1000) : now + 300
  const expires = Math.min(asked, now + CHARGE_LIFE_SECS)
  const nonce = challengeHash(challenge)
  const signature = await signer.signTypedData({
    domain: await tokenDomain(pub, currency, chainId),
    types: TYPES,
    primaryType: 'TransferWithAuthorization',
    message: { from, to: recipient, value: BigInt(request.amount), validAfter: 0n, validBefore: BigInt(expires), nonce },
  })
  return {
    challenge: echoOf(challenge),
    payload: { type: 'authorization', from, to: recipient, value: request.amount, validAfter: '0', validBefore: String(expires), nonce, signature },
    source: `did:pkh:eip155:${chainId}:${from}`,
  }
}

export const credentialHeader = (credential) => `Payment ${b64url(JSON.stringify(credential))}`

export const credentialHeaderName = (challenge) => (challenge.header === 'Payment-Authorization' ? 'payment-authorization' : 'authorization')

export function receiptOf(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  try { return unb64url(value.trim()) } catch { return null }
}
