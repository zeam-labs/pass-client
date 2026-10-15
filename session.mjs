import { encodeAbiParameters, encodeFunctionData, keccak256, getAddress, parseAbi, zeroAddress } from 'viem'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { parseChallenges, requestOf, tokenDomain, echoOf, credentialHeader, credentialHeaderName, receiptOf } from './mpp.mjs'
import { queue, PAYMENT_ONLY } from './client.mjs'
import { RELAY_URL, gasPaymentProblem, gasWeiOf } from './refund.mjs'

export const SESSION_ESCROWS = Object.freeze({})
export const MCP_CREDENTIAL = 'org.paymentauth/credential'
export const MCP_REQUIRED = 'org.paymentauth/payment-required'
export const MCP_RECEIPT = 'org.paymentauth/receipt'
export { PAYMENT_ONLY }
export const PROBLEM = 'https://paymentauth.org/problems/'
export const MCP_PAYMENT_REQUIRED = -32042
export const MCP_VERIFICATION_FAILED = -32043
export const AUTHORIZATION_LIFE_SECS = 600
export const EXIT_DEADLINE_SECS = 600
export const EXIT_HELD_SECS = 900
export const EXIT_PAYMENT_MARGIN_SECS = 30
export const GAS_PAYMENT_MAX_SECS = AUTHORIZATION_LIFE_SECS
export const GAS_PAYMENT_PENDING = 'gas_payment_pending'
export const GAS_PAYMENT_NEEDED = 'gas_payment_needed'
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
export const SPLIT_FACTORY = '0x6B9118074aB15142d7524E8c4ea8f62A3Bdb98f1'
export const SESSION_MODES = ['auto', 'on', 'off']
export const SENT_NOT_SHOWN = 'sent_not_shown'
export const SELLER_CATCH_UP_MS = 2000
export const RESEND_TIMES = 5
export const RESEND_TOTAL_MS = 15 * SELLER_CATCH_UP_MS
export const RESEND_WAIT_MAX_MS = 5 * SELLER_CATCH_UP_MS
export const LANDED_TRIES = 10
export const LANDED_WAIT_MS = 1000

const UINT = /^(0|[1-9]\d*)$/
const BYTES32 = /^0x[0-9a-fA-F]{64}$/
const SECONDS = /^\d{1,6}$/
const NO_SALT = `0x${'00'.repeat(32)}`
const USDC = new Set(['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '0x036cbd53842c5426634e7929541ec2318f3dcf7e'])
export const VOUCHER_TYPES = { Voucher: [{ name: 'channelId', type: 'bytes32' }, { name: 'cumulativeAmount', type: 'uint128' }] }
export const RECEIVE_TYPES = { ReceiveWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] }
export const TRANSFER_TYPES = { TransferWithAuthorization: RECEIVE_TYPES.ReceiveWithAuthorization }
export const EXIT_FIELDS = [{ name: 'channelId', type: 'bytes32' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }]
export const EXIT = {
  requestClose: { type: 'RequestCloseAuthorization', relayed: 'requestCloseWithAuthorization' },
  withdraw: { type: 'WithdrawAuthorization', relayed: 'withdrawWithAuthorization' },
}

const escrowAbi = parseAbi([
  'struct Channel { bool finalized; uint64 closeRequestedAt; address payer; address payee; address token; address authorizedSigner; uint128 deposit; uint128 settled; }',
  'function getChannel(bytes32 channelId) view returns (Channel)',
  'function CLOSE_GRACE_PERIOD() view returns (uint64)',
  'function TOKEN() view returns (address)',
  'function requestClose(bytes32 channelId)',
  'function withdraw(bytes32 channelId)',
  'function requestCloseWithAuthorization(bytes32 channelId, uint256 nonce, uint256 deadline, bytes payerSignature)',
  'function withdrawWithAuthorization(bytes32 channelId, uint256 nonce, uint256 deadline, bytes payerSignature)',
])
const multicall3Abi = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'function aggregate3(Call3[] calls) payable returns ((bool success, bytes returnData)[])'])
const tokenAbi = parseAbi(['function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)', 'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)'])
const payeeFactoryAbi = parseAbi(['function addressOf(address signer, address split) view returns (address)', 'function escrow() view returns (address)'])
const SPLIT = { type: 'tuple', name: '_split', components: [{ name: 'recipients', type: 'address[]' }, { name: 'allocations', type: 'uint256[]' }, { name: 'totalAllocation', type: 'uint256' }, { name: 'distributionIncentive', type: 'uint16' }] }
const splitFactoryAbi = [{ type: 'function', name: 'isDeployed', stateMutability: 'view', inputs: [SPLIT, { name: '_owner', type: 'address' }, { name: '_salt', type: 'bytes32' }], outputs: [{ type: 'address' }, { type: 'bool' }] }]

const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()
const address = (v) => { try { return getAddress(String(v)) } catch { return null } }
const said = (e) => String(e?.shortMessage ?? e?.message ?? e).split('\n')[0].slice(0, 200)

export class SessionRefusal extends Error {
  constructor(code, message, more = {}) {
    super(message)
    this.code = code
    this.more = more
  }
}

const addresses = (raw, what) => String(raw ?? '').split(/[\s,]+/).filter(Boolean).map((a) => {
  const got = address(a)
  if (!got) throw new Error(`${what} holds ${a}, which is not an address`)
  return got
})

export function sessionTrust({ chainId, escrows = '', factories = '', builtIn = SESSION_ESCROWS } = {}) {
  const all = new Map()
  for (const e of builtIn[chainId] ?? []) all.set(e.escrow.toLowerCase(), { escrow: getAddress(e.escrow), factories: e.factory ? [getAddress(e.factory)] : [], from: 'the built-in list' })
  for (const e of addresses(escrows, 'PASS_SESSION_ESCROW')) if (!all.has(e.toLowerCase())) all.set(e.toLowerCase(), { escrow: e, factories: [], from: 'PASS_SESSION_ESCROW' })
  const given = addresses(factories, 'PASS_SESSION_FACTORY')
  return { any: all.size > 0, list: [...all.values()], of: (escrow) => all.get(String(escrow).toLowerCase()) ?? null, factoriesFor: (escrow) => [...(all.get(String(escrow).toLowerCase())?.factories ?? []), ...given] }
}

export function sessionOffers(challenges, network) {
  const chainId = Number(String(network).split(':')[1])
  const out = []
  for (const challenge of challenges ?? []) {
    if (challenge?.method !== 'evm' || challenge?.intent !== 'session') continue
    const request = requestOf(challenge)
    const d = request?.methodDetails
    if (!request || !d || Number(d.chainId) !== chainId) continue
    if (!Array.isArray(d.credentialTypes) || !d.credentialTypes.includes('authorization') || d.feePayer !== true) continue
    if (request.unitType !== 'request') continue
    if (typeof request.amount !== 'string' || !UINT.test(request.amount)) continue
    const amount = BigInt(request.amount)
    if (d.minVoucherDelta !== undefined && (!UINT.test(String(d.minVoucherDelta)) || BigInt(d.minVoucherDelta) > amount)) continue
    const currency = address(request.currency)
    const recipient = address(request.recipient)
    const escrow = address(d.escrowContract)
    if (!currency || !recipient || !escrow) continue
    if (challenge.expires && !(new Date(challenge.expires).getTime() > Date.now())) continue
    out.push({ challenge, request, amount, channelId: BYTES32.test(String(d.channelId ?? '')) ? String(d.channelId).toLowerCase() : null, suggested: UINT.test(String(request.suggestedDeposit ?? '')) ? BigInt(request.suggestedDeposit) : 0n, currency, recipient, escrow, chainId })
  }
  return out
}

export const channelIdOf = ({ payer, payee, token, salt, authorizedSigner = zeroAddress, escrow, chainId }) => keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
  [getAddress(payer), getAddress(payee), getAddress(token), salt, getAddress(authorizedSigner), getAddress(escrow), BigInt(chainId)]))

export const openNonce = ({ from, payee, token, salt, authorizedSigner = zeroAddress }) => keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'address' }],
  [getAddress(from), getAddress(payee), getAddress(token), salt, getAddress(authorizedSigner)]))

export const topUpNonce = ({ channelId, additionalDeposit, from, salt }) => keccak256(encodeAbiParameters(
  [{ type: 'bytes32' }, { type: 'uint128' }, { type: 'address' }, { type: 'bytes32' }],
  [channelId, BigInt(additionalDeposit), getAddress(from), salt]))

export const saltAt = (base, n) => keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'bytes32' }, { type: 'uint256' }], ['zeam-pass session', base ?? NO_SALT, BigInt(n)]))

export const voucherDomain = (escrow, chainId) => ({ name: 'EVM Payment Channel', version: '1', chainId: Number(chainId), verifyingContract: getAddress(escrow) })

export function voucherProblem(record, cumulative, price = 0n) {
  const c = BigInt(cumulative)
  if (c <= BigInt(record.signed ?? 0)) return null
  if (c > BigInt(record.deposit)) return `a voucher for ${c} is more than the channel's deposit (${record.deposit})`
  if (c > BigInt(record.spent) + BigInt(price)) return `a voucher for ${c} is more than the receipts justify (${record.spent}) plus this call (${price})`
  return null
}

export function receiptProblem(record, receipt) {
  if (!receipt || typeof receipt !== 'object') return 'there is no receipt'
  if (receipt.status !== 'success') return `its status is ${receipt.status}`
  const reference = String(receipt.reference ?? receipt.channelId ?? '').toLowerCase()
  if (reference !== String(record.channelId).toLowerCase()) return `it is for ${reference || 'no channel'}, not for this channel`
  if (receipt.method !== undefined && receipt.method !== 'evm') return `its method is ${receipt.method}`
  if (receipt.intent !== undefined && receipt.intent !== 'session') return `its intent is ${receipt.intent}`
  if (receipt.chainId !== undefined && record.chainId !== undefined && Number(receipt.chainId) !== Number(record.chainId)) return `it is for chain ${receipt.chainId}, not ${record.chainId}`
  if (!UINT.test(String(receipt.spent ?? ''))) return 'it states no amount spent'
  for (const k of ['spent', 'acceptedCumulative']) {
    if (receipt[k] === undefined) continue
    if (!UINT.test(String(receipt[k]))) return `its ${k} is not an amount`
    if (BigInt(receipt[k]) > BigInt(record.signed)) return `it claims ${k} ${receipt[k]}, more than this key has signed (${record.signed})`
  }
  return null
}

export function splitOf(j) {
  if (!j || typeof j !== 'object' || !Array.isArray(j.recipients) || !Array.isArray(j.allocations) || j.recipients.length !== j.allocations.length || !j.recipients.length) return null
  const recipients = j.recipients.map(address)
  if (recipients.some((a) => a === null) || j.allocations.some((a) => !UINT.test(String(a))) || !UINT.test(String(j.totalAllocation ?? '')) || !UINT.test(String(j.distributionIncentive ?? ''))) return null
  return { recipients, allocations: j.allocations.map(String), totalAllocation: String(j.totalAllocation), distributionIncentive: Number(j.distributionIncentive) }
}

export function sellerFacts(terms, network) {
  const row = (Array.isArray(terms?.accepts) ? terms.accepts : []).find((a) => a?.scheme === 'batch-settlement' && a.network === network && address(a.payTo) && address(a.extra?.receiverAuthorizer))
  const told = terms?.session && typeof terms.session === 'object' ? terms.session : {}
  return {
    receiver: address(told.receiver ?? row?.payTo),
    signer: address(told.signer ?? row?.extra?.receiverAuthorizer),
    split: splitOf(told.split),
    salt: BYTES32.test(String(told.salt ?? '')) ? String(told.salt).toLowerCase() : null,
  }
}

export function splitHint(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null
  let j
  try { j = JSON.parse(String(raw)) } catch { throw new Error('PASS_SESSION_SPLIT is not JSON: {"split":{"recipients":[…],"allocations":[…],"totalAllocation":"…","distributionIncentive":0},"salt":"0x…"}') }
  const split = splitOf(j?.split)
  if (!split || !BYTES32.test(String(j?.salt ?? ''))) throw new Error('PASS_SESSION_SPLIT is {"split":{"recipients":[…],"allocations":[…],"totalAllocation":"…","distributionIncentive":0},"salt":"0x…"}')
  return { split, salt: String(j.salt).toLowerCase() }
}

export function sessionStore(dir) {
  const at = join(dir, 'session')
  const file = (id) => join(at, `${String(id).toLowerCase()}.json`)
  const get = (id) => { try { const j = JSON.parse(readFileSync(file(id), 'utf8')); return j && typeof j === 'object' && same(j.channelId, id) ? j : null } catch { return null } }
  const all = () => { try { return readdirSync(at).filter((n) => /^0x[0-9a-f]{64}\.json$/.test(n)).map((n) => get(n.slice(0, -5))).filter(Boolean) } catch { return [] } }
  const put = (r) => {
    mkdirSync(at, { recursive: true })
    const tmp = `${file(r.channelId)}.tmp`
    writeFileSync(tmp, JSON.stringify(r, null, 2))
    renameSync(tmp, file(r.channelId))
    return r
  }
  return { at, get, all, put, open: () => all().filter((r) => !r.closed) }
}

export const answerOf = ({ ok, status = null, receipt = null, body = null, challenges = [], out = null, retryAfter = null }, network) => {
  const kind = body && typeof body === 'object' && typeof body.type === 'string' && body.type.startsWith(PROBLEM) ? body.type.slice(PROBLEM.length) : null
  return { ok, status, receipt: receipt && typeof receipt === 'object' ? receipt : null, problem: kind ? { ...body, kind } : null, offers: sessionOffers(challenges, network), challenges, body, out, retryAfter: SECONDS.test(String(retryAfter ?? '')) ? Number(retryAfter) : null }
}

export function sentNotShown(answer) {
  const p = answer?.problem
  if (!p || answer.receipt || p.kind !== 'verification-failed') return null
  const transaction = BYTES32.test(String(p.txHash ?? '')) ? String(p.txHash).toLowerCase() : null
  const stated = SECONDS.test(String(p.retry_after_seconds ?? '')) ? Number(p.retry_after_seconds) : answer.retryAfter
  if (p.code !== SENT_NOT_SHOWN && !(transaction && stated !== null && stated > 0)) return null
  const waitMs = Math.min(RESEND_WAIT_MAX_MS, Math.max(1, stated ?? SELLER_CATCH_UP_MS / 1000) * 1000)
  return { transaction, waitMs }
}

const pause = (ms, signal = null) => new Promise((ok) => {
  if (signal?.aborted) return ok(false)
  const stop = () => { clearTimeout(timer); ok(false) }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); ok(true) }, ms)
  signal?.addEventListener('abort', stop, { once: true })
})

const MANAGES = new Set(['topUp', 'close'])

const refusalOf = (answer) => {
  if (!answer || answer.ok) return null
  const b = answer.body
  const told = answer.problem?.detail ?? (b && typeof b === 'object' ? b.detail ?? b.message ?? b.error : b)
  return typeof told === 'string' && told.trim() !== '' ? told.trim().slice(0, 600) : null
}

export function httpTransport({ fetchFn, url, method = 'POST', headers = {}, body, signal, network }) {
  const ask = (extra, how, carry) => fetchFn(url, { method: how, headers: { ...headers, ...extra }, ...(carry && body !== undefined ? { body } : {}), ...(signal ? { signal } : {}) })
  const heard = async (res) => {
    const raw = await res.text()
    let parsed
    try { parsed = JSON.parse(raw) } catch { parsed = raw }
    return answerOf({ ok: res.status < 400, status: res.status, receipt: receiptOf(res.headers.get('payment-receipt')), body: parsed, challenges: parseChallenges(res.headers.get('www-authenticate')), out: { status: res.status, body: parsed }, retryAfter: res.headers.get('retry-after') }, network)
  }
  return {
    send: async (challenge, payload, { only = false, key = null } = {}) => heard(await ask({ [credentialHeaderName(challenge)]: credentialHeader({ challenge: echoOf(challenge), payload }), ...(key ? { 'idempotency-key': key } : {}) }, only && !MANAGES.has(payload?.action) ? 'HEAD' : method, !only)),
    fresh: async () => (await heard(await ask({}, method, false))).offers,
  }
}

export function mcpTransport({ callTool, name, args = {}, network }) {
  const heard = (out) => {
    let body = out?.structuredContent
    if (!body || typeof body !== 'object') { try { body = JSON.parse(String(out?.content?.[0]?.text ?? '')) } catch { body = null } }
    const required = out?._meta?.[MCP_REQUIRED]
    if (required?.session && typeof required.session === 'object' && !(body && typeof body === 'object' && body.session)) body = { ...(body && typeof body === 'object' ? body : {}), session: required.session }
    return answerOf({ ok: !out?.isError, status: required ? 402 : null, receipt: out?._meta?.[MCP_RECEIPT] ?? null, body, challenges: Array.isArray(required?.challenges) ? required.challenges : [], out }, network)
  }
  const asked = async (params) => {
    try { return heard(await callTool(params)) } catch (e) {
      const d = e?.data
      if ((e?.code !== MCP_PAYMENT_REQUIRED && e?.code !== MCP_VERIFICATION_FAILED) || !d || !Array.isArray(d.challenges)) throw e
      const body = { ...(d.problem && typeof d.problem === 'object' ? d.problem : {}), ...(d.session && typeof d.session === 'object' ? { session: d.session } : {}) }
      return answerOf({ ok: false, status: 402, body, challenges: d.challenges, out: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'payment_required', message: String(d.failure?.detail ?? d.problem?.detail ?? e.message ?? 'Payment Required') }) }], _meta: { [MCP_REQUIRED]: d } } }, network)
    }
  }
  return {
    send: (challenge, payload, { only = false } = {}) => asked({ name, ...(only ? {} : { arguments: args }), _meta: { [MCP_CREDENTIAL]: { challenge, payload }, ...(only ? { [PAYMENT_ONLY]: true } : {}) } }),
    fresh: async () => (await asked({ name, arguments: {} })).offers,
    probe: () => asked({ name, arguments: args }),
  }
}

export function makeSessions({ signer, pub, network, trust, mode = 'auto', budget = { allows: () => true, spend: () => {} }, depositMultiplier = 40, baseSalt = null, relayUrl = RELAY_URL, relayFetch = fetch, split = null, maxMicroUSD = 0, log = () => {}, now = Date.now, sleep = pause } = {}) {
  const chainId = Number(String(network).split(':')[1])
  const payer = getAddress(signer.address)
  const multiplier = BigInt(Math.max(1, Math.trunc(Number(depositMultiplier)) || 1))
  const seats = new Map()
  const seatFor = (dir) => {
    if (!seats.has(dir)) seats.set(dir, { store: sessionStore(dir), serial: queue(), credit: new Map(), counted: new Map(), seen: new Set(), floors: new Map(), asked: new Set(), credited: new Set(), gasCounted: new Set() })
    return seats.get(dir)
  }
  const factories = new Map()
  const told = new Set()
  const once = (line) => { if (!told.has(line)) { told.add(line); log(line) } }

  const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args })
  const chainOf = async (r, blockNumber = null) => {
    const c = await pub.readContract({ address: r.escrow, abi: escrowAbi, functionName: 'getChannel', args: [r.channelId], ...(blockNumber !== null ? { blockNumber } : {}) })
    return { exists: !same(c.payer, zeroAddress), finalized: c.finalized, closeRequestedAt: Number(c.closeRequestedAt), deposit: BigInt(c.deposit), settled: BigInt(c.settled) }
  }
  const blockOf = (receipt) => (receipt?.blockNumber !== undefined && receipt?.blockNumber !== null ? BigInt(receipt.blockNumber) : null)
  const landed = async (r, receipt, shows) => {
    const block = blockOf(receipt)
    let last = null
    for (let i = 0; i < LANDED_TRIES; i++) {
      if (i > 0 && !(await sleep(LANDED_WAIT_MS))) break
      try {
        if (block !== null && typeof pub.getBlockNumber === 'function' && BigInt(await pub.getBlockNumber({ cacheTime: 0 })) < block) continue
        last = await chainOf(r, block)
        if (shows(last)) return last
      } catch {}
    }
    return last
  }
  const chainSecs = async () => {
    const wall = Math.floor(now() / 1000)
    try { return Math.max(wall, Number((await pub.getBlock()).timestamp)) } catch { return wall }
  }

  const factoryOf = async (escrow) => {
    const key = escrow.toLowerCase()
    if (factories.has(key)) return factories.get(key)
    let found = null
    for (const f of trust.factoriesFor(escrow)) {
      if (same(await read(f, payeeFactoryAbi, 'escrow'), escrow)) { found = f; break }
    }
    factories.set(key, found)
    return found
  }

  const payeeCheck = async (offer, facts) => {
    if (!trust.factoriesFor(offer.escrow).length) return { verified: null, why: 'no payee factory is pinned for this escrow (PASS_SESSION_FACTORY)' }
    if (!facts.receiver || !facts.signer) return { verified: null, why: 'the seller\'s 402 names no split and signer beside the challenge' }
    let factory, payee
    try {
      factory = await factoryOf(offer.escrow)
      if (!factory) return { verified: null, why: 'no pinned payee factory belongs to this escrow' }
      payee = await read(factory, payeeFactoryAbi, 'addressOf', [facts.signer, facts.receiver])
    } catch (e) { return { verified: null, why: `the payee factory could not be read (${said(e)})` } }
    if (!same(payee, offer.recipient)) return { verified: false, factory, why: `the challenge pays ${offer.recipient}, and the factory's payee for the seller's signer ${facts.signer} and split ${facts.receiver} is ${payee}` }
    return { verified: true, factory }
  }

  const splitProven = async (receiver, given) => {
    if (!receiver || !given?.split || !given.salt) return null
    try {
      const tuple = { ...given.split, allocations: given.split.allocations.map(BigInt), totalAllocation: BigInt(given.split.totalAllocation) }
      const [at] = await read(SPLIT_FACTORY, splitFactoryAbi, 'isDeployed', [tuple, zeroAddress, given.salt])
      return same(at, receiver) ? { split: given.split, salt: given.salt } : null
    } catch { return null }
  }

  const creditOf = (seat, r) => seat.credit.get(r.channelId) ?? 0n
  const usdc = (r) => USDC.has(String(r.token).toLowerCase())
  const spend = (r, units) => { if (usdc(r) && units > 0n) budget.spend(Number(units)) }
  const allows = (token, units) => !USDC.has(String(token).toLowerCase()) || units <= 0n || budget.allows(Number(units))
  const deposited = (seat, r, units) => { seat.credit.set(r.channelId, creditOf(seat, r) + units); spend(r, units) }
  const countTo = (seat, r, level) => {
    const from = seat.counted.get(r.channelId) ?? 0n
    if (level <= from) return 0n
    const rose = level - from
    const drawn = rose < creditOf(seat, r) ? rose : creditOf(seat, r)
    seat.credit.set(r.channelId, creditOf(seat, r) - drawn)
    spend(r, rose - drawn)
    seat.counted.set(r.channelId, level)
    return rose
  }

  const voucher = async (seat, r, cumulative, price = 0n) => {
    const why = voucherProblem(r, cumulative, price)
    if (why) throw new SessionRefusal('session_voucher_refused', `Nothing was signed: ${why}.`)
    if (BigInt(cumulative) > BigInt(r.signed)) { r.signed = String(cumulative); seat.store.put(r) }
    return signer.signTypedData({ domain: voucherDomain(r.escrow, chainId), types: VOUCHER_TYPES, primaryType: 'Voucher', message: { channelId: r.channelId, cumulativeAmount: BigInt(cumulative) } })
  }

  const authorize = async (r, value, nonce) => {
    const validBefore = (await chainSecs()) + AUTHORIZATION_LIFE_SECS
    const signature = await signer.signTypedData({
      domain: await tokenDomain(pub, getAddress(r.token), chainId),
      types: RECEIVE_TYPES,
      primaryType: 'ReceiveWithAuthorization',
      message: { from: payer, to: getAddress(r.escrow), value: BigInt(value), validAfter: 0n, validBefore: BigInt(validBefore), nonce },
    })
    return { validBefore, authorization: { from: payer.toLowerCase(), to: String(r.escrow).toLowerCase(), value: String(value), validAfter: '0', validBefore: String(validBefore), nonce }, signature }
  }

  const tookGas = (r, a) => read(getAddress(r.token), tokenAbi, 'authorizationState', [payer, a.nonce]).catch(() => false)
  const livePayment = async (r, at) => {
    for (const g of [r.gasPayment, r.exit?.held]) {
      if (!g?.nonce || Number(g.until) <= at) continue
      if ((await read(getAddress(r.token), tokenAbi, 'authorizationState', [payer, g.nonce]).catch(() => null)) !== true) return g
    }
    return null
  }
  const pendingWhy = (g) => `a gas payment of ${g.gas} this key signed for this channel stays valid until ${new Date(Number(g.until) * 1000).toISOString()} and the token shows it unused. No other is signed while that one can still be taken; run --refund again after then`
  const signedGas = (seat, r, g) => { r.gasPayment = g; seat.store.put(r); seat.gasCounted.add(g.nonce); spend(r, BigInt(g.gas)) }
  const gasTaken = (seat, r, g) => { if (!seat.gasCounted.has(g.nonce)) { seat.gasCounted.add(g.nonce); spend(r, BigInt(g.gas)) } }
  const relayCovers = async (r, body) => {
    try {
      const facts = r.seller?.split && r.seller.salt && r.seller.receiver && r.seller.signer ? { split: { split: r.seller.split, salt: r.seller.salt, receiver: r.seller.receiver, signer: r.seller.signer } } : {}
      const j = await (await relayFetch(`${r.relay ?? relayUrl}/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, ...facts }), signal: AbortSignal.timeout(10_000) })).json()
      return j && typeof j === 'object' ? j : null
    } catch { return null }
  }
  const gasOver = (r, value) => (maxMicroUSD && value > BigInt(maxMicroUSD) ? `the gas, ${value}, is over PASS_MAX_SPEND (${maxMicroUSD})` : !allows(r.token, value) ? `the gas, ${value}, would pass PASS_MAX_SPEND` : null)

  const sameTerms = (o, offer) => same(o.escrow, offer.escrow) && same(o.recipient, offer.recipient) && same(o.currency, offer.currency) && o.amount === offer.amount
  const expired = (o) => Boolean(o.challenge.expires) && !(new Date(o.challenge.expires).getTime() > now())
  const sentAs = (pending) => (pending.transaction ? `in transaction ${pending.transaction}` : 'to the relay, which has named no transaction yet')

  const resent = async (send, first, payload, options, what, signal = null) => {
    let offer = first
    let answer = await send(offer.challenge, payload, options)
    let pending = sentNotShown(answer)
    const started = now()
    let tries = 0
    while (pending && tries < RESEND_TIMES && now() - started + pending.waitMs <= RESEND_TOTAL_MS) {
      log(`session: the seller sent the ${what} ${sentAs(pending)} and its node does not show it yet; the same credential goes again in ${pending.waitMs / 1000}s (${tries + 1} of ${RESEND_TIMES}), and nothing new is signed`)
      if (!(await sleep(pending.waitMs, signal))) break
      if (expired(offer)) {
        const next = answer.offers.find((o) => sameTerms(o, offer) && !expired(o))
        if (!next) break
        offer = next
      }
      tries += 1
      let again
      try { again = await send(offer.challenge, payload, options) } catch { break }
      answer = again
      pending = sentNotShown(answer)
    }
    return { answer, pending, tries, waitedMs: now() - started }
  }

  const closedAs = (seat, r, how, c, more = {}) => {
    r.closed = { at: new Date(now()).toISOString(), how, settled: String(c.settled), returned: String(c.deposit - c.settled), ...more }
    delete r.pending
    seat.store.put(r)
    return r.closed
  }

  const resumed = async (seat, r) => {
    const fields = { payer: r.payer, payee: r.payee, token: r.token, salt: r.salt, authorizedSigner: r.authorizedSigner ?? zeroAddress, escrow: r.escrow, chainId: r.chainId }
    if (r.chainId !== chainId || !same(r.payer, payer) || !same(channelIdOf(fields), r.channelId)) throw new SessionRefusal('session_state_refused', `Nothing was signed: the record of channel ${r.channelId} in ${seat.store.at} does not describe a channel of this key on this chain.`)
    const c = await chainOf(r)
    if (!c.exists) {
      if (r.pending?.kind === 'open' && Number(r.pending.validBefore) > await chainSecs()) return r
      closedAs(seat, r, 'never opened', { deposit: 0n, settled: 0n })
      return null
    }
    if (c.finalized) {
      const end = closedAs(seat, r, 'found closed on chain', c)
      log(`session: channel ${r.channelId} is closed on chain; ${end.returned} came back to ${payer}`)
      return null
    }
    if (c.closeRequestedAt > 0) throw new SessionRefusal('session_exiting', `Nothing was signed: channel ${r.channelId} has a close request on chain and takes no more vouchers. Run --refund to finish leaving it; the next call then opens a new channel.`, { channelId: r.channelId })
    if (c.settled > BigInt(r.signed)) {
      log(`session: the escrow has settled ${c.settled} on channel ${r.channelId} and this state file had signed ${r.signed}: the file is behind the chain, taking the chain's figure`)
      r.signed = String(c.settled)
    }
    if (c.settled > BigInt(r.spent)) r.spent = String(c.settled)
    r.deposit = String(c.deposit)
    const p = r.pending
    if (!(p?.kind === 'topUp' && p.payload && c.deposit < BigInt(p.base ?? 0) + BigInt(p.amount) && Number(p.validBefore) > await chainSecs())) delete r.pending
    seat.store.put(r)
    if (!seat.seen.has(r.channelId)) {
      seat.seen.add(r.channelId)
      seat.counted.set(r.channelId, BigInt(r.spent))
      log(`session: resumed channel ${r.channelId} from ${seat.store.at}: deposit ${r.deposit}, spent ${r.spent}, checked against the escrow ${r.escrow}`)
    }
    return r
  }

  const chosen = async (seat, offer) => {
    const open = seat.store.open().filter((r) => !r.recovered && r.chainId === chainId && same(r.payer, payer))
    const bad = open.find((r) => r.disputed)
    if (bad) throw new SessionRefusal('session_receipt_refused', `Nothing was signed: channel ${bad.channelId} is in dispute (${bad.disputed.why}), and no other is opened beside it. Run --refund to leave it.`, { channelId: bad.channelId, escrow: bad.escrow })
    const mine = open.find((r) => same(r.escrow, offer.escrow) && same(r.payee, offer.recipient) && same(r.token, offer.currency))
    if (mine) return seat.seen.has(mine.channelId) && !mine.pending && !mine.exit && offer.channelId !== mine.channelId ? mine : resumed(seat, mine)
    const other = open[0]
    if (!other) return null
    const what = !same(other.escrow, offer.escrow) ? `escrow ${offer.escrow}` : !same(other.payee, offer.recipient) ? `payee ${offer.recipient}` : `token ${offer.currency}`
    throw new SessionRefusal('session_terms_changed', `Nothing was signed: this seller now names ${what}, and channel ${other.channelId} is open at escrow ${other.escrow} for payee ${other.payee}. That channel stays where it is. Run --refund to close it; the next call then opens a channel on the new terms.`, { channelId: other.channelId, escrow: other.escrow })
  }

  const sized = (seat, offer, kind) => {
    const floor = seat.floors.get(`${kind}:${offer.escrow.toLowerCase()}`) ?? 0n
    return [offer.suggested, offer.amount * multiplier, floor].reduce((a, b) => (a > b ? a : b))
  }

  const fresh = async (seat, offer, facts, resource, origin) => {
    const check = await payeeCheck(offer, facts)
    if (check.verified === false) throw new SessionRefusal('session_payee_refused', `Nothing was signed: ${check.why}.`)
    let token, grace
    try {
      token = await read(offer.escrow, escrowAbi, 'TOKEN')
      grace = Number(await read(offer.escrow, escrowAbi, 'CLOSE_GRACE_PERIOD'))
    } catch (e) { throw new SessionRefusal('session_escrow_unread', `Nothing was signed: the escrow ${offer.escrow} could not be read (${said(e)}).`) }
    if (!same(token, offer.currency)) throw new SessionRefusal('session_escrow_refused', `Nothing was signed: the escrow ${offer.escrow} holds ${token}, and the challenge asks for ${offer.currency}.`)
    const config = { payer, payee: offer.recipient, token: offer.currency, authorizedSigner: zeroAddress, escrow: offer.escrow, chainId }
    let n = seat.store.all().filter((r) => same(r.escrow, offer.escrow) && same(r.payee, offer.recipient) && same(r.token, offer.currency) && same(r.payer, payer)).length
    let salt, channelId
    for (;;) {
      salt = saltAt(baseSalt, n)
      channelId = channelIdOf({ ...config, salt })
      if (!seat.store.get(channelId)) {
        const c = await chainOf({ escrow: offer.escrow, channelId })
        if (!c.exists) break
        if (!c.finalized) {
          seat.store.put({ version: 1, channelId, ...config, salt, origin, resource, deposit: String(c.deposit), signed: String(c.settled), spent: String(c.settled), graceSecs: grace, seller: { receiver: facts.receiver, signer: facts.signer, split: null, salt: null, verified: check.verified }, recovered: true, openedAt: null })
          log(`session: found channel ${channelId} of this key on the escrow, holding ${c.deposit - c.settled}, that ${seat.store.at} has no record of. It is not paid from; --refund closes it.`)
        }
      }
      n += 1
    }
    const proven = (await splitProven(facts.receiver, facts)) ?? (await splitProven(facts.receiver, split))
    if (check.verified === null) once(`session: the payee ${offer.recipient} could not be checked against the seller's split and signer: ${check.why}`)
    if (!proven) once(`session: the seller publishes no split for ${facts.receiver ?? offer.recipient}: leaving without the seller through the relay will need PASS_SESSION_SPLIT, or requestClose and withdraw at this key's own gas (--refund --self-send)`)
    return { version: 1, channelId, ...config, salt, origin, resource, deposit: '0', signed: '0', spent: '0', graceSecs: grace, relay: relayUrl, seller: { receiver: facts.receiver, signer: facts.signer, split: proven?.split ?? null, salt: proven?.salt ?? null, verified: check.verified, ...(check.verified === null ? { why: check.why } : {}), ...(check.factory ? { factory: check.factory } : {}) }, openedAt: new Date(now()).toISOString() }
  }

  const paying = async (seat, { origin, terms, resource, send, max, signal = null }, first) => {
    let offer = first
    if (!trust.of(offer.escrow)) throw new SessionRefusal('session_escrow_untrusted', `Nothing was signed: the escrow ${offer.escrow} is not one this client pays into. Pin it with PASS_SESSION_ESCROW.`)
    const price = offer.amount
    const isUsdc = USDC.has(offer.currency.toLowerCase())
    if (max !== null && price > max) throw new SessionRefusal('over_max', `quoted ${price} is more than maxAmount ${max}`)
    if (!isUsdc && max === null) throw new SessionRefusal('max_required', `the quote is in ${offer.currency}, not USDC, so the spend cap cannot value it; pass maxAmount to pay it`)
    const facts = sellerFacts(terms, network)
    const signedHere = { deposit: 0n, topUp: 0n }
    const within = (more, what) => {
      const all = signedHere.deposit + signedHere.topUp + more
      if (max !== null && all > max) throw new SessionRefusal('over_max', `paying ${price} takes a ${what} of ${more}: more than maxAmount ${max}. Nothing more was signed. Pass maxAmount ${all} or more to make it; what a channel does not spend comes back with --refund.`, { needed: String(all) })
      if (!allows(offer.currency, more)) throw new SessionRefusal('x402_bridge_spend_cap_reached', `paying ${price} takes a ${what} of ${more}, which would pass PASS_MAX_SPEND. Nothing more was signed. A ${what} counts toward PASS_MAX_SPEND; it is the price × PASS_DEPOSIT_MULTIPLIER, at least what the seller suggests.`, { needed: String(more) })
    }
    const facing = (r) => ({ channelId: r.channelId, escrow: r.escrow, payTo: r.payee, asset: r.token, amount: String(price), ...(signedHere.deposit ? { deposit: String(signedHere.deposit) } : {}), ...(signedHere.topUp ? { topUp: String(signedHere.topUp) } : {}), held: r.deposit, spent: r.spent, payeeVerified: r.seller?.verified === true })
    const disputed = (r, why, claim) => {
      r.disputed = { at: new Date(now()).toISOString(), why, claim }
      seat.store.put(r)
      return { error: 'session_receipt_refused', message: `The seller's answer was refused: ${why}. Nothing more is signed on channel ${r.channelId}. Run --refund to leave it.`, ...facing(r) }
    }
    const recovery = 'The channel is found on chain at the next start, and --refund returns what is unspent.'
    const depositPending = (r, what, amount, told) => new SessionRefusal('session_deposit_pending', `The ${what} of ${amount} ${what === 'deposit' ? 'to open' : 'into'} channel ${r.channelId} was sent ${sentAs(told.pending)}, and the seller's node did not show it in ${Math.round(told.waitedMs / 1000)}s (the same credential was sent ${told.tries + 1} times). It is in the escrow or on its way there, and is counted once. Nothing more was signed, and no other ${what} is signed while this one is pending: the next call sends the same authorization again. ${recovery}`, { ...(told.pending.transaction ? { transaction: told.pending.transaction } : {}), pending: what, signed: true, ...facing(r) })
    const adopt = (r, receipt) => {
      const from = BigInt(r.spent)
      r.spent = String(receipt.spent)
      if (r.pending) delete r.pending
      seat.store.put(r)
      countTo(seat, r, BigInt(r.spent))
      return BigInt(r.spent) > from ? BigInt(r.spent) - from : 0n
    }

    const live = (o) => {
      if (o.challenge.expires && !(new Date(o.challenge.expires).getTime() > now())) throw new SessionRefusal('session_challenge_expired', 'Nothing more was signed: the seller\'s challenge has expired. Call again for a fresh one.')
      return o.challenge
    }
    const key = randomUUID()
    let r = await chosen(seat, offer)
    if (r && !r.seller?.split && facts.split && facts.salt && !seat.asked.has(r.channelId) && (!r.seller?.receiver || !facts.receiver || same(r.seller.receiver, facts.receiver))) {
      seat.asked.add(r.channelId)
      const proven = await splitProven(r.seller?.receiver ?? facts.receiver, facts)
      if (proven) {
        r.seller = { ...(r.seller ?? {}), receiver: r.seller?.receiver ?? facts.receiver, signer: r.seller?.signer ?? facts.signer, split: proven.split, salt: proven.salt }
        seat.store.put(r)
        log(`session: the seller now publishes its split; kept in the record of channel ${r.channelId} for leaving without the seller`)
      }
    }
    let answer = null
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!same(offer.escrow, first.escrow) || !same(offer.recipient, first.recipient) || !same(offer.currency, first.currency) || offer.amount !== price) throw new SessionRefusal('session_terms_changed', 'Nothing more was signed: the seller\'s new challenge names another escrow, payee, token or price.')
      let payload
      live(offer)
      if (!r || r.pending?.kind === 'open') {
        if (!r) r = await fresh(seat, offer, facts, resource, origin)
        const deposit = sized(seat, offer, 'open')
        const prior = r.pending ? BigInt(r.pending.amount) : 0n
        const held = r.pending?.payload && r.pending.payload.cumulativeAmount === String(price) && Number(r.pending.validBefore) > await chainSecs() ? r.pending.payload : null
        const amount = held || deposit <= prior ? prior : deposit
        const more = amount - (seat.seen.has(r.channelId) ? prior : 0n)
        within(more, 'channel deposit')
        r.deposit = String(amount)
        if (held) {
          payload = held
          log(`session: the deposit of ${amount} to open channel ${r.channelId} is pending${r.pending.transaction ? ` in transaction ${r.pending.transaction}` : ''}: sending the same authorization again, and signing no other`)
        } else {
          const a = await authorize(r, amount, openNonce({ from: payer, payee: r.payee, token: r.token, salt: r.salt }))
          r.pending = { kind: 'open', amount: String(amount), validBefore: a.validBefore }
          seat.store.put(r)
          log(`session: signed a deposit of ${amount} of ${r.token} to open channel ${r.channelId} at escrow ${r.escrow} for ${origin}; state in ${seat.store.at}; what is unspent comes back with --refund`)
          payload = { action: 'open', type: 'authorization', channelId: r.channelId, authorization: a.authorization, signature: a.signature, cumulativeAmount: String(price), voucherSignature: await voucher(seat, r, price, price), salt: r.salt }
        }
        if (!seat.seen.has(r.channelId)) { seat.seen.add(r.channelId); seat.counted.set(r.channelId, 0n) }
        if (more > 0n) { deposited(seat, r, more); signedHere.deposit += more }
      } else {
        const need = BigInt(r.spent) + price
        for (let tops = 0; need > BigInt(r.deposit); tops++) {
          const held = r.pending?.kind === 'topUp' && r.pending.payload ? r.pending : null
          let top, add
          if (held) {
            top = held.payload
            add = BigInt(held.amount)
            if (!seat.credited.has(top.authorization.nonce)) {
              within(add, 'top-up')
              seat.credited.add(top.authorization.nonce)
              deposited(seat, r, add)
              signedHere.topUp += add
            }
            log(`session: the top-up of ${add} into channel ${r.channelId} is pending${held.transaction ? ` in transaction ${held.transaction}` : ''}: sending the same authorization again, and signing no other`)
          } else {
            const short = need - BigInt(r.deposit)
            add = [sized(seat, offer, 'topUp'), short].reduce((a, b) => (a > b ? a : b))
            within(add, 'top-up')
            const salt = `0x${randomBytes(32).toString('hex')}`
            const a = await authorize(r, add, topUpNonce({ channelId: r.channelId, additionalDeposit: add, from: payer, salt }))
            top = { action: 'topUp', type: 'authorization', channelId: r.channelId, salt, authorization: a.authorization, signature: a.signature, additionalDeposit: String(add) }
            r.pending = { kind: 'topUp', amount: String(add), validBefore: a.validBefore, base: r.deposit, payload: top }
            seat.store.put(r)
            seat.credited.add(a.authorization.nonce)
            deposited(seat, r, add)
            signedHere.topUp += add
            log(`session: the next call would pass the deposit of ${r.deposit}: signed a top-up of ${add} into channel ${r.channelId}`)
          }
          live(offer)
          let told
          try { told = await resent(send, offer, top, { only: true }, 'top-up', signal) }
          catch (e) { throw new SessionRefusal('session_deposit_pending', `The seller did not answer the top-up of ${add} into channel ${r.channelId} (${said(e)}). Its signed authorization may still be collected until ${new Date(Number(r.pending.validBefore) * 1000).toISOString()}, and is counted once. No other top-up is signed while this one is pending: the next call sends the same authorization again. ${recovery}`, { pending: 'top-up', signed: true, ...facing(r) }) }
          answer = told.answer
          if (answer.receipt && receiptProblem(r, answer.receipt)) return disputed(r, receiptProblem(r, answer.receipt), answer.receipt)
          const c = await chainOf(r)
          const rose = c.deposit > BigInt(r.deposit)
          r.deposit = String(c.deposit)
          if (!rose && told.pending) {
            if (told.pending.transaction) r.pending.transaction = told.pending.transaction
            seat.store.put(r)
            throw depositPending(r, 'top-up', add, told)
          }
          delete r.pending
          seat.store.put(r)
          if (rose) continue
          const floor = UINT.test(String(answer.problem?.requiredDeposit ?? '')) ? BigInt(answer.problem.requiredDeposit) : 0n
          const renewed = answer.problem?.kind === 'session/challenge-not-found' || answer.problem?.kind === 'invalid-challenge' ? answer.offers.find((o) => same(o.escrow, offer.escrow) && same(o.recipient, offer.recipient) && same(o.currency, offer.currency) && o.amount === price && o.challenge.id !== offer.challenge.id) : null
          if (tops === 0 && floor > add) seat.floors.set(`topUp:${offer.escrow.toLowerCase()}`, floor)
          else if (tops === 0 && renewed) offer = renewed
          else throw new SessionRefusal('session_top_up_failed', `the top-up of channel ${r.channelId} was not carried out: ${refusalOf(answer) ?? 'the deposit did not rise'}`, facing(r))
        }
        if (price > creditOf(seat, r) && !allows(r.token, price - creditOf(seat, r))) throw new SessionRefusal('x402_bridge_spend_cap_reached', 'this payment would pass PASS_MAX_SPEND', facing(r))
        payload = { action: 'voucher', channelId: r.channelId, cumulativeAmount: String(need), signature: await voucher(seat, r, need, price) }
      }
      const opening = payload.action === 'open'
      let told
      try { told = await resent(send, offer, payload, { key }, opening ? 'open' : 'payment', signal) }
      catch (e) { return { error: 'unreachable', message: `${said(e)}. The signed voucher${opening ? ' and deposit' : ''} may still be collected.`, signed: true, ...facing(r) } }
      answer = told.answer
      if (opening && told.pending) {
        r.pending = { ...r.pending, payload, ...(told.pending.transaction ? { transaction: told.pending.transaction } : {}) }
        seat.store.put(r)
        throw depositPending(r, 'deposit', BigInt(r.pending.amount), told)
      }

      if (answer.receipt) {
        const why = receiptProblem(r, answer.receipt)
        if (why) return disputed(r, why, answer.receipt)
        if (opening) {
          const c = await chainOf(r).catch(() => null)
          if (c?.exists) r.deposit = String(c.deposit)
        }
        const charged = adopt(r, answer.receipt)
        return { paid: answer.ok && charged > 0n, charged: String(charged), receipt: answer.receipt, answer, ...facing(r) }
      }
      const p = answer.problem
      if (!p) {
        if (!answer.ok) return { paid: false, charged: '0', answer, ...facing(r) }
        countTo(seat, r, BigInt(r.spent) + price)
        return { paid: false, charged: '0', signed: true, note: 'no receipt came back. The signed voucher can still be collected, so its price counts against PASS_MAX_SPEND.', answer, ...facing(r) }
      }
      const next = answer.offers.find((o) => same(o.escrow, offer.escrow) && same(o.recipient, offer.recipient) && same(o.currency, offer.currency) && o.amount === price)
      if (p.kind === 'session/insufficient-balance' && UINT.test(String(p.requiredDeposit ?? '')) && opening && seat.floors.get(`open:${offer.escrow.toLowerCase()}`) !== BigInt(p.requiredDeposit)) {
        seat.floors.set(`open:${offer.escrow.toLowerCase()}`, BigInt(p.requiredDeposit))
        log(`session: the seller's least deposit is ${p.requiredDeposit}: depositing that`)
      } else if (p.kind === 'session/insufficient-balance' && !opening && UINT.test(String(p.spent ?? '')) && BigInt(p.spent) !== BigInt(r.spent)) {
        if (BigInt(p.spent) > BigInt(r.signed)) return disputed(r, `it says ${p.spent} is spent, more than this key has signed (${r.signed})`, { spent: p.spent, requiredCumulative: p.requiredCumulative })
        log(`session: the seller counts ${p.spent} spent on channel ${r.channelId} and this client ${r.spent}; this key signed for it, so the count is taken and the call is paid again`)
        adopt(r, { spent: p.spent })
      } else if (p.kind === 'session/amount-exceeds-deposit' && !opening) {
        const c = await chainOf(r)
        if (c.deposit === BigInt(r.deposit)) return { error: 'session_refused', message: String(p.detail ?? p.title), problem: p.kind, answer, ...facing(r) }
        r.deposit = String(c.deposit)
        seat.store.put(r)
      } else if (p.kind === 'session/channel-finalized' || p.kind === 'session/channel-not-found') {
        const c = await chainOf(r)
        if (c.exists && c.finalized) { closedAs(seat, r, 'found closed on chain', c); r = null }
        else if (c.exists && c.closeRequestedAt > 0) throw new SessionRefusal('session_exiting', `channel ${r.channelId} has a close request on chain and takes no more vouchers. Run --refund to finish leaving it.`, facing(r))
        else return { error: 'session_refused', message: `${String(p.detail ?? p.title)}. The channel is ${c.exists ? 'open on chain' : 'not on chain'}; --refund leaves it.`, problem: p.kind, answer, ...facing(r) }
      } else if ((p.kind === 'session/challenge-not-found' || p.kind === 'invalid-challenge') && next && next.challenge.id !== offer.challenge.id) {
        log('session: the challenge was no longer good; paying again on the fresh one')
      } else return { error: 'session_refused', message: String(p.detail ?? p.title ?? p.kind), problem: p.kind, answer, ...(r ? facing(r) : {}) }
      if (next) offer = next
    }
    return { error: 'session_refused', message: `not paid after four attempts: ${String(answer?.problem?.detail ?? 'no receipt')}`, answer, ...(r ? facing(r) : {}) }
  }

  const guarded = (seat, fn, failed = (e) => ({ error: 'session_failed', message: `${said(e)}. What this call signed may still be collected.` })) => seat.serial(() => fn().catch((e) => (e instanceof SessionRefusal ? { error: e.code, message: e.message, ...e.more } : failed(e))))

  const pay = ({ dir, origin, offer, terms = null, resource = null, send, max = null, signal = null }) => {
    const seat = seatFor(dir)
    return guarded(seat, () => paying(seat, { origin, terms, resource, send, max, signal }, offer))
  }

  const usable = (offers) => (mode === 'off' ? [] : offers.filter((o) => trust.of(o.escrow)))

  const holds = (dir) => seatFor(dir).store.open().some((r) => !r.recovered && same(r.payer, payer) && r.chainId === chainId)

  const close = ({ dir, channelId, fresh: freshOffers, send, signal = null }) => {
    const seat = seatFor(dir)
    const failed = (e) => ({ op: 'session_close_failed', channelId, code: 'failed', why: said(e) })
    return guarded(seat, async () => {
      const r = seat.store.get(channelId)
      if (!r || r.closed) return { op: 'session_close_failed', channelId, why: 'no open channel with this id in the state directory' }
      let c = await chainOf(r)
      if (!c.exists) return { op: 'session_closed', channelId, ...closedAs(seat, r, 'never opened', { deposit: 0n, settled: 0n }) }
      if (c.finalized) return { op: 'session_closed', channelId, ...closedAs(seat, r, 'found closed on chain', c) }
      let offers
      try { offers = await freshOffers() } catch (e) { return { op: 'session_close_failed', channelId, code: 'unreachable', why: `the seller did not answer (${said(e)})` } }
      const offer = offers.find((o) => same(o.escrow, r.escrow) && same(o.recipient, r.payee) && same(o.currency, r.token))
      if (!offer) return { op: 'session_close_failed', channelId, code: 'no_challenge', why: 'the seller offers no session challenge for this channel\'s escrow and payee' }
      const cumulative = BigInt(r.spent)
      const signature = await voucher(seat, r, cumulative)
      const payload = { action: 'close', channelId: r.channelId, cumulativeAmount: String(cumulative), signature }
      let told
      let offered = offer
      let gasSigned = null
      const tried = new Set()
      for (;;) {
        try { told = await resent(send, offered, payload, { only: true }, 'close', signal) }
        catch (e) { return { op: 'session_close_failed', channelId, code: 'unreachable', why: `the seller did not answer (${said(e)})` } }
        const q = told.answer.problem
        if (!q || q.code !== GAS_PAYMENT_NEEDED || !q.sign || !q.authorization || told.answer.receipt) break
        const last = 'Nothing more was signed. --refund --exit leaves without the seller, through the relay; --refund --self-send at this key\'s own gas.'
        const secs = await chainSecs()
        const live = await livePayment(r, secs)
        if (live) {
          if (live.gasPayment && !tried.has(live.nonce)) {
            tried.add(live.nonce)
            gasSigned = live.gasPayment.authorization
            payload.gasPayment = live.gasPayment
            log(`session: the gas payment of ${live.gas} this key signed earlier for channel ${r.channelId} is still valid and unused: sending the close with it again, and signing no other`)
            offered = told.answer.offers.find((o) => sameTerms(o, offer) && !expired(o)) ?? offered
            continue
          }
          return { op: 'session_close_failed', channelId, code: GAS_PAYMENT_PENDING, gasMicroUSD: Number(live.gas), until: new Date(Number(live.until) * 1000).toISOString(), why: `The seller asked for the close's gas again (${String(q.detail ?? '').slice(0, 200)}), and ${pendingWhy(live)}. --refund --self-send leaves at this key's own gas.` }
        }
        c = await chainOf(r)
        const left = c.deposit - (cumulative > c.settled ? cumulative : c.settled)
        const a = q.authorization
        const covers = await relayCovers(r, { session: 'close', channel: r.channelId, cumulativeAmount: String(cumulative) })
        const why = !same(a.from, payer) ? `the gas payment is from ${a.from}, not this key`
          : !usdc(r) ? 'the channel does not hold USDC'
            : String(a.validAfter) !== '0' ? `the gas payment would become valid at ${a.validAfter}, and a close's is valid at once`
              : !UINT.test(String(a.validBefore)) || Number(a.validBefore) <= secs || Number(a.validBefore) > secs + GAS_PAYMENT_MAX_SECS ? `the gas payment would stay valid until ${a.validBefore}, more than ${GAS_PAYMENT_MAX_SECS}s from now`
                : covers?.covered === true ? 'the relay says this channel\'s fees cover the gas of its close, so no gas is owed'
                  : (await gasPaymentProblem({ ...q, leftMicroUSD: Number(left), returnedMicroUSD: Number(left) }, { relayUrl: r.relay ?? relayUrl, maxMicroUSD, chainId, relayFetchFn: relayFetch, quotePath: '/quote?session=close', what: 'close' })) ?? gasOver(r, BigInt(a.value))
        if (why) return { op: 'session_close_failed', channelId, code: 'gas_payment_refused', gasMicroUSD: q.gasMicroUSD, leftMicroUSD: q.leftMicroUSD, why: `The seller asked for the close's gas in USDC and it was refused: ${why}. ${last}` }
        log(`session: the fees of channel ${r.channelId} do not cover the gas of its close: paying ${a.value} of it in USDC from what comes back, ${left}; no ETH is needed`)
        gasSigned = a
        payload.gasPayment = { authorization: a, signature: await signer.signTypedData(q.sign) }
        tried.add(a.nonce)
        signedGas(seat, r, { nonce: a.nonce, gas: String(a.value), until: Number(a.validBefore), gasPayment: payload.gasPayment })
        offered = told.answer.offers.find((o) => sameTerms(o, offer) && !expired(o)) ?? offered
      }
      const answer = told.answer
      c = await chainOf(r)
      if (!c.finalized && told.pending) return { op: 'session_close_failed', channelId, code: 'close_pending', ...(told.pending.transaction ? { transaction: told.pending.transaction } : {}), why: `the seller sent the close ${sentAs(told.pending)}, and its node did not show it in ${Math.round(told.waitedMs / 1000)}s (the same credential was sent ${told.tries + 1} times). Nothing more was signed. The channel is closed when that transaction is counted: run --refund again to find it closed on chain, or --refund --exit to leave without the seller.` }
      if (!c.finalized && answer.problem?.code === 'nothing_to_return') {
        const { leftMicroUSD, returnedMicroUSD, gasMicroUSD } = answer.problem
        return { op: 'session_close_failed', channelId, code: 'nothing_to_return', ...(leftMicroUSD !== undefined ? { leftMicroUSD } : {}), returnedMicroUSD: returnedMicroUSD ?? 0, ...(gasMicroUSD !== undefined ? { gasMicroUSD } : {}), why: refusalOf(answer) ?? 'nothing comes back: the close\'s gas is not less than what is left in the channel' }
      }
      if (!c.finalized) return { op: 'session_close_failed', channelId, code: answer.problem?.kind ?? 'not_closed', why: refusalOf(answer) ?? 'the channel is still open on chain' }
      const gas = gasSigned && (await tookGas(r, gasSigned)) ? BigInt(gasSigned.value) : 0n
      if (gas > 0n) gasTaken(seat, r, { nonce: gasSigned.nonce, gas })
      const end = closedAs(seat, r, 'closed by the seller', c, { ...(answer.receipt?.txHash ? { transaction: answer.receipt.txHash } : {}), ...(gas > 0n ? { gas: String(gas), net: String(c.deposit - c.settled - gas) } : {}) })
      log(`session: channel ${r.channelId} closed: ${end.settled} paid to the seller, ${end.returned} returned to ${payer}${gas > 0n ? `, of which ${gas} paid the close's gas` : ''}`)
      return { op: 'session_closed', channelId, deposit: String(c.deposit), ...end }
    }, failed)
  }

  const exit = ({ dir, channelId, selfSend = false, wallet = null }) => {
    const seat = seatFor(dir)
    const failed = (e) => ({ op: 'session_exit_failed', channelId, code: 'failed', why: said(e) })
    return guarded(seat, async () => {
      const r = seat.store.get(channelId)
      if (!r || r.closed) return { op: 'session_exit_failed', channelId, why: 'no open channel with this id in the state directory' }
      const c = await chainOf(r)
      if (!c.exists) return { op: 'session_exit_failed', channelId, code: 'not_on_chain', why: 'the escrow holds no channel with this id' }
      if (c.finalized) {
        const took = r.exit?.held?.nonce && await tookGas(r, r.exit.held) ? BigInt(r.exit.held.gas) : 0n
        if (took > 0n) gasTaken(seat, r, r.exit.held)
        return { op: 'session_closed', channelId, ...closedAs(seat, r, took > 0n ? 'withdrawn without the seller, by the relay' : 'found closed on chain', c, took > 0n ? { gas: String(took), net: String(c.deposit - c.settled - took) } : {}) }
      }
      const at = Number((await pub.getBlock()).timestamp)
      const grace = Number(r.graceSecs ?? await read(r.escrow, escrowAbi, 'CLOSE_GRACE_PERIOD'))
      const leg = c.closeRequestedAt === 0 ? 'requestClose' : at >= c.closeRequestedAt + grace ? 'withdraw' : null
      const readyAt = (from) => new Date((from + grace) * 1000).toISOString()
      if (!leg) return { op: 'session_exit_waiting', channelId, readyAt: readyAt(c.closeRequestedAt), secondsLeft: c.closeRequestedAt + grace - at, why: 'the close request is on chain; the withdrawal can be sent when the grace period has passed' }
      let hash
      let held = null
      let paying = null
      let gasPaid = 0n
      if (selfSend) {
        if (!wallet) return { op: 'session_exit_failed', channelId, code: 'no_wallet', why: 'sending from this key needs a wallet client' }
        const data = encodeFunctionData({ abi: escrowAbi, functionName: leg, args: [r.channelId] })
        try {
          const have = await pub.getBalance({ address: payer })
          const short = { op: 'session_exit_failed', channelId, code: 'no_gas', why: `${payer} holds too little ETH to send ${leg}: the call is ${leg}(${r.channelId}) on ${r.escrow}, and only this key may send it` }
          if (have === 0n) return short
          const gas = await pub.estimateGas({ account: payer, to: getAddress(r.escrow), data })
          if (have < (gas * (await pub.getGasPrice()) * 3n) / 2n) return short
          hash = await wallet.sendTransaction({ to: getAddress(r.escrow), data, value: 0n })
        } catch (e) { return { op: 'session_exit_failed', channelId, code: 'not_sent', why: `${leg} could not be sent from here (${said(e)})` } }
      } else {
        const proven = r.seller?.split && r.seller.salt ? { split: r.seller.split, salt: r.seller.salt } : await splitProven(r.seller?.receiver, split)
        if (!proven || !r.seller?.signer || !r.seller.receiver) return { op: 'session_exit_failed', channelId, code: 'split_unknown', why: 'the relay sends an exit only with the seller\'s split and signer, and the seller published no split when this channel was opened. Set PASS_SESSION_SPLIT, or run --refund --self-send to send requestClose and withdraw from this key at its own gas.' }
        const signedLeg = async (which, deadline) => {
          const message = { channelId: r.channelId, nonce: BigInt(`0x${randomBytes(32).toString('hex')}`), deadline: BigInt(deadline) }
          const signature = await signer.signTypedData({ domain: voucherDomain(r.escrow, chainId), types: { [EXIT[which].type]: EXIT_FIELDS }, primaryType: EXIT[which].type, message })
          return { to: getAddress(r.escrow), data: encodeFunctionData({ abi: escrowAbi, functionName: EXIT[which].relayed, args: [message.channelId, message.nonce, message.deadline, signature] }) }
        }
        const relay = r.relay ?? relayUrl
        const json = { 'content-type': 'application/json' }
        const unreachable = (e) => ({ op: 'session_exit_failed', channelId, code: 'relay_unreachable', why: `the relay at ${relay} did not answer (${said(e)}). --refund --self-send sends ${leg} from this key at its own gas.` })
        const post = async (calls) => (await relayFetch(`${relay}/relay`, { method: 'POST', headers: json, body: JSON.stringify({ calls, split: { split: proven.split, salt: proven.salt, receiver: r.seller.receiver, signer: r.seller.signer } }), signal: AbortSignal.timeout(120_000) })).json()
        const declined = (j, more = {}) => ({ op: 'session_exit_failed', channelId, code: 'relay_declined', ...more, why: `the relay did not send ${EXIT[leg].relayed}: ${String(j?.results?.find((x) => x?.error)?.error ?? j?.error ?? 'no reason given').slice(0, 240)}. --refund --self-send sends ${leg} from this key at its own gas.` })
        let j = null
        const kept = leg === 'withdraw' && r.exit?.held?.call && at <= Number(r.exit.held.until) ? r.exit.held : null
        if (kept) {
          try { j = await post([kept.call]) } catch (e) { return unreachable(e) }
          if (j?.results?.[0]?.held === true) {
            const sends = Math.max(c.closeRequestedAt + grace, Number.isFinite(kept.validAfter) ? kept.validAfter : 0)
            return { op: 'session_exit_waiting', channelId, readyAt: new Date(sends * 1000).toISOString(), secondsLeft: Math.max(0, sends - at), withdrawal: 'held by the relay', why: `the relay holds the withdrawal and its gas payment and sends them${sends > at ? ` from ${new Date(sends * 1000).toISOString()}, when the payment becomes valid` : ''}; run --refund again to see the channel closed` }
          }
          hash = j?.results?.[0]?.hash
          if (hash) paying = kept
        }
        if (!hash) {
          const call = await signedLeg(leg, at + EXIT_DEADLINE_SECS)
          try { j = await post([call]) } catch (e) { return unreachable(e) }
          hash = j?.results?.[0]?.hash
          if (!hash && (j?.results?.[0]?.code ?? j?.code) === GAS_PAYMENT_NEEDED && usdc(r)) {
            let quote
            const refusal = String(j?.results?.find((x) => x?.error)?.error ?? j?.error ?? '').slice(0, 200)
            const live = await livePayment(r, at)
            if (live) return { op: 'session_exit_failed', channelId, code: GAS_PAYMENT_PENDING, gasMicroUSD: Number(live.gas), until: new Date(Number(live.until) * 1000).toISOString(), why: `the relay did not send ${EXIT[leg].relayed} (${refusal}), and ${pendingWhy(live)}. --refund --self-send sends ${leg} from this key at its own gas.` }
            quote = await relayCovers(r, { call, payment: true })
            if (quote === null) return unreachable(new Error('no quote'))
            if (quote.covered === true) return { op: 'session_exit_failed', channelId, code: 'gas_payment_refused', why: `Nothing was signed for the gas: the relay says this channel's fees cover the gas of leaving it, and it did not send ${EXIT[leg].relayed} (${refusal}). --refund --self-send sends ${leg} from this key at its own gas.` }
            const payTo = address(quote?.payTo)
            if (quote?.op !== 'refund_gas_quote' || !payTo || !(Number(quote.quoteMicroUSD) > 0)) return declined(j)
            const value = BigInt(Math.ceil(Number(quote.quoteMicroUSD)))
            const back = c.deposit - (BigInt(r.spent) > c.settled ? BigInt(r.spent) : c.settled)
            const numbers = { gasMicroUSD: Number(value), leftMicroUSD: Number(back) }
            if (value >= back) return { op: 'session_exit_failed', channelId, code: 'nothing_to_return', ...numbers, why: `nothing comes back through the relay: leaving costs ${value} of gas, and ${back} is left in the channel. Nothing was signed for it. --refund --self-send sends ${leg} from this key at its own gas.` }
            const over = gasOver(r, value)
            if (over) return { op: 'session_exit_failed', channelId, code: 'gas_payment_refused', ...numbers, why: `Nothing was signed for the gas: ${over}. --refund --self-send sends ${leg} from this key at its own gas.` }
            const both = leg === 'requestClose'
            const validAfter = both ? Number((await pub.getBlock()).timestamp) + grace + EXIT_PAYMENT_MARGIN_SECS : c.closeRequestedAt + grace
            const until = both ? validAfter + EXIT_HELD_SECS : at + EXIT_DEADLINE_SECS
            const withdrawal = both ? await signedLeg('withdraw', until) : call
            const authorization = { from: payer, to: payTo, value, validAfter: BigInt(validAfter), validBefore: BigInt(until), nonce: `0x${randomBytes(32).toString('hex')}` }
            const paid = await signer.signTypedData({ domain: await tokenDomain(pub, getAddress(r.token), chainId), types: TRANSFER_TYPES, primaryType: 'TransferWithAuthorization', message: authorization })
            const pay = encodeFunctionData({ abi: tokenAbi, functionName: 'transferWithAuthorization', args: [authorization.from, authorization.to, authorization.value, authorization.validAfter, authorization.validBefore, authorization.nonce, paid] })
            const bundle = { to: MULTICALL3, data: encodeFunctionData({ abi: multicall3Abi, functionName: 'aggregate3', args: [[{ target: withdrawal.to, allowFailure: false, callData: withdrawal.data }, { target: getAddress(r.token), allowFailure: false, callData: pay }]] }) }
            log(`session: the fees of channel ${r.channelId} do not cover the gas of leaving it: paying ${value} of it in USDC from what comes back, ${back}; no ETH is needed`)
            const signedNow = { call: bundle, until, gas: String(value), nonce: authorization.nonce, validAfter: Number(authorization.validAfter) }
            signedGas(seat, r, signedNow)
            try { j = await post(both ? [call, bundle] : [bundle]) } catch (e) { return unreachable(e) }
            hash = j?.results?.[0]?.hash
            if (hash && both && j.results[1]?.held === true) held = signedNow
            else if (hash && !both) paying = signedNow
            if (!hash) return declined(j, numbers)
          }
          if (!hash) return declined(j)
        }
      }
      const receipt = await pub.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') return { op: 'session_exit_failed', channelId, code: 'reverted', transaction: hash, why: `the ${leg} transaction reverted` }
      const after = (await landed(r, receipt, (x) => (leg === 'requestClose' ? x.closeRequestedAt > 0 : x.finalized))) ?? (await chainOf(r))
      const by = selfSend ? 'this key' : 'the relay'
      const ownGas = selfSend && gasWeiOf(receipt) ? { gasWei: gasWeiOf(receipt) } : {}
      if (leg === 'requestClose') {
        let requestedAt = after.closeRequestedAt
        if (!(requestedAt > 0) && blockOf(receipt) !== null) { try { requestedAt = Number((await pub.getBlock({ blockNumber: blockOf(receipt) })).timestamp) } catch {} }
        const known = requestedAt > 0
        const early = known && held && Number.isFinite(held.validAfter) ? requestedAt + grace - (held.validAfter + 1) : 0
        const unread = `the request landed in ${hash}${blockOf(receipt) !== null ? ` (block ${blockOf(receipt)})` : ''} and the node read does not show its time yet; the withdrawal can be sent ${grace}s after that block. Run --refund again to see when.`
        const gasFrom = held && Number.isFinite(held.validAfter) ? new Date((held.validAfter + 1) * 1000).toISOString() : null
        const sooner = early > 0 ? `The request took longer to land than the gas payment allows for: the payment can be taken from ${gasFrom}, ${early}s before the grace period ends at ${readyAt(requestedAt)}. The withdrawal it pays for cannot be sent before then.` : null
        r.exit = { requestedAt: known ? requestedAt : null, readyAt: known ? readyAt(requestedAt) : null, transaction: hash, by, ...(held ? { held } : {}) }
        seat.store.put(r)
        log(`session: close requested on channel ${r.channelId}; ${!known ? unread : held ? `the relay sends the withdrawal from ${r.exit.readyAt} and takes ${held.gas} of gas from what returns` : `the withdrawal can be sent from ${r.exit.readyAt}`}`)
        return { op: 'session_exit_requested', channelId, transaction: hash, sentBy: by, readyAt: r.exit.readyAt, graceSecs: grace, ...ownGas, ...(known ? {} : { why: unread }), ...(held ? { withdrawal: 'held by the relay', gasMicroUSD: Number(held.gas), until: new Date(held.until * 1000).toISOString(), ...(gasFrom ? { gasPaymentValidFrom: gasFrom } : {}), ...(sooner ? { note: sooner } : {}) } : {}) }
      }
      if (paying && (await tookGas(r, paying))) gasPaid = BigInt(paying.gas)
      if (gasPaid > 0n) gasTaken(seat, r, paying)
      const end = closedAs(seat, r, 'withdrawn without the seller', after, { transaction: hash, ...(gasPaid > 0n ? { gas: String(gasPaid), net: String(after.deposit - after.settled - gasPaid) } : {}) })
      log(`session: channel ${r.channelId} withdrawn: ${end.returned} returned to ${payer}${gasPaid > 0n ? `, of which ${gasPaid} paid the gas of leaving` : ''}`)
      return { op: 'session_closed', channelId, deposit: String(after.deposit), sentBy: by, ...ownGas, ...end }
    }, failed)
  }

  const leave = async ({ dir, transportFor, forced = false, selfSend = false, wallet = null }) => {
    const out = []
    for (const r of seatFor(dir).store.open().filter((x) => same(x.payer, payer) && x.chainId === chainId)) {
      if (forced || selfSend || r.exit) { out.push(await exit({ dir, channelId: r.channelId, selfSend, wallet })); continue }
      const t = await transportFor(r)
      out.push(t ? await close({ dir, channelId: r.channelId, fresh: t.fresh, send: t.send }) : { op: 'session_close_failed', channelId: r.channelId, code: 'no_route', why: 'the record names no route to ask the seller on' })
    }
    return out
  }

  return { mode, trust, payer, pay, close, exit, leave, usable, holds, channels: (dir) => seatFor(dir).store.all() }
}
