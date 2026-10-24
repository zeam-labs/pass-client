import { getAddress, decodeFunctionData, recoverTypedDataAddress } from 'viem'
import { BATCH_SETTLEMENT_ADDRESS, BATCH_SETTLEMENT_DOMAIN, voucherTypes } from '@x402/evm'
import { computeChannelId } from '@x402/evm/batch-settlement/client'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const PASS_REALM = 'ZEAM Pass'
export const GRANT_HEADER = 'x-grant'

const CHANNELS_ABI = [{ type: 'function', name: 'channels', stateMutability: 'view', inputs: [{ name: 'channelId', type: 'bytes32' }], outputs: [{ name: 'balance', type: 'uint128' }, { name: 'totalClaimed', type: 'uint128' }] }]

export const refundMessage = (channelId, issued, realm = PASS_REALM) =>
  `${realm} refund\nchannel: ${String(channelId).toLowerCase()}\nissued: ${issued}`

export const refundUrlIn = (sentence) => {
  const m = /\bPOST\s+(https?:\/\/[^\s"'\\]+)/.exec(String(sentence ?? ''))
  return m ? m[1] : null
}

export const refundUrlOf = (terms) => (terms && typeof terms === 'object' ? refundUrlIn(terms.refund) : null)

export const refundUrlBeside = (upstream) => String(upstream).replace(/\/+$/, '').replace(/\/mcp$/, '') + '/refund'

const originOf = (u) => { try { return new URL(String(u)).origin } catch { return null } }
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 20

export const withGrant = (fetchFn, grant, seller) => {
  const home = originOf(seller)
  if (!grant || !home) return fetchFn
  return async (input, init = {}) => {
    const req = input instanceof Request ? input : null
    const headers = new Headers(init.headers ?? req?.headers)
    let at = req ? req.url : String(input)
    if (originOf(at) !== home || headers.has(GRANT_HEADER)) return fetchFn(input, init)
    headers.set(GRANT_HEADER, grant)
    let method = String(init.method ?? req?.method ?? 'GET').toUpperCase()
    let body = init.body
    const spare = req && body === undefined && req.body ? req.clone() : null
    const signal = init.signal ?? req?.signal
    let r = await fetchFn(input, { ...init, headers, redirect: 'manual' })
    for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
      const to = REDIRECTS.has(r.status) ? r.headers.get('location') : null
      if (!to) return r
      let next
      try { next = new URL(to, at) } catch { return r }
      if (!/^https?:$/.test(next.protocol)) return r
      const toGet = r.status === 303 ? method !== 'GET' && method !== 'HEAD' : r.status !== 307 && r.status !== 308 && method === 'POST'
      if (toGet) {
        method = 'GET'
        body = undefined
        for (const h of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) headers.delete(h)
      } else if (body === undefined && spare) body = await spare.arrayBuffer()
      await r.body?.cancel().catch(() => {})
      const onward = { ...init, method, headers, ...(signal ? { signal } : {}) }
      if (toGet) delete onward.body
      else if (body !== undefined) onward.body = body
      if (next.origin !== home) {
        headers.delete(GRANT_HEADER)
        headers.delete('authorization')
        return fetchFn(next, onward)
      }
      at = next
      r = await fetchFn(next, { ...onward, redirect: 'manual' })
    }
    return r
  }
}

const parsed = (text) => { try { return JSON.parse(text) } catch { return null } }

const messagesIn = (text, type) => {
  if (/text\/event-stream/.test(type ?? '')) {
    return String(text).split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => parsed(l.slice(5).trim())).filter(Boolean)
  }
  const j = parsed(text)
  return j === null ? [] : Array.isArray(j) ? j : [j]
}

export const termsInMcp = (text, type) => {
  for (const m of messagesIn(text, type)) {
    const r = m?.result
    if (!r?.isError) continue
    if (r.structuredContent && typeof r.structuredContent === 'object') return r.structuredContent
    const t = r.content?.[0]?.text
    const j = typeof t === 'string' ? parsed(t) : null
    if (j && typeof j === 'object') return j
  }
  return null
}

export const termsInHttp = async (r) => {
  const body = await r.clone().json().catch(() => null)
  if (body && typeof body === 'object' && !Array.isArray(body)) return body
  const header = r.headers.get('payment-required')
  if (!header) return null
  try { return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) } catch { return null }
}

export const hearingMcp = (fetchFn, onRefundUrl, onTerms = () => {}) => async (input, init = {}) => {
  const r = await fetchFn(input, init)
  if (String(init.method ?? 'GET').toUpperCase() === 'POST' && r.ok && r.body) {
    r.clone().text().then((text) => {
      const terms = termsInMcp(text, r.headers.get('content-type'))
      if (!terms) return
      const u = refundUrlOf(terms)
      if (u) onRefundUrl(u)
      onTerms(terms)
    }).catch(() => {})
  }
  return r
}

export const hearingHttp = (fetchFn, onRefundUrl, onTerms = () => {}) => async (input, init) => {
  const r = await fetchFn(input, init)
  if (r.status === 402) {
    const terms = await termsInHttp(r)
    const u = refundUrlOf(terms)
    if (u) onRefundUrl(u)
    if (terms) onTerms(terms)
  }
  return r
}

export const refundUrlInTerms = (terms) => {
  if (!terms || typeof terms !== 'object') return null
  const r = terms.refund
  if (typeof r === 'string') return refundUrlIn(r)
  if (r && typeof r === 'object') return refundUrlIn(`POST ${r.route ?? ''}`) ?? refundUrlIn(r.terms) ?? refundUrlIn(r.how)
  return null
}

const SELLER_FILE = 'seller.json'

export const sellerOf = (u) => { try { return new URL(String(u)).origin } catch { return null } }

const sellerFile = (dir) => {
  try { const j = JSON.parse(readFileSync(join(dir, SELLER_FILE), 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {} } catch { return {} }
}
const isRecord = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x)
const sellersIn = (all) => (isRecord(all.sellers) ? all.sellers : {})

export const readSeller = (dir, seller) => {
  const all = sellerFile(dir)
  const at = sellerOf(seller)
  const mine = at && isRecord(sellersIn(all)[at]) ? sellersIn(all)[at] : {}
  const before = typeof all.refund === 'string' && at && sellerOf(all.refund) === at ? all.refund : null
  return { refund: typeof mine.refund === 'string' ? mine.refund : before, paying: isRecord(mine.paying) ? mine.paying : {} }
}

export const channelsElsewhere = (dir, seller) => {
  const at = sellerOf(seller)
  const out = new Set()
  for (const [k, v] of Object.entries(sellersIn(sellerFile(dir)))) {
    if (k === at || !isRecord(v?.paying)) continue
    for (const c of Object.values(v.paying)) if (typeof c === 'string') out.add(c.toLowerCase())
  }
  return out
}

const rememberFor = (dir, seller, change) => {
  const at = sellerOf(seller)
  if (!at) return
  const all = sellerFile(dir)
  const sellers = sellersIn(all)
  const next = change(isRecord(sellers[at]) ? sellers[at] : {})
  if (!next) return
  try { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, SELLER_FILE), JSON.stringify({ ...all, sellers: { ...sellers, [at]: next } }, null, 2)) } catch { }
}

export const rememberPayingChannel = (dir, seller, key, channelId) => rememberFor(dir, seller, (mine) => {
  const paying = isRecord(mine.paying) ? mine.paying : {}
  return paying[key] === channelId ? null : { ...mine, paying: { ...paying, [key]: channelId } }
})

export const rememberRefundUrl = (dir, seller, url) => rememberFor(dir, seller, (mine) => (mine.refund === url ? null : { ...mine, refund: url }))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function askPassRefund({ url, channelId, signer, extra = {}, fetchFn = fetch, now = Date.now }) {
  const issued = new Date(now()).toISOString()
  const signature = await signer.signMessage({ message: refundMessage(channelId, issued) })
  const body = JSON.stringify({ channelId: String(channelId).toLowerCase(), issued, signature, ...extra })
  let r
  try {
    r = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(120_000) })
  } catch (e) {
    return { op: 'refund_failed', code: 'unreachable', why: `could not reach ${url}: ${e?.message ?? e}` }
  }
  const j = await r.json().catch(() => null)
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { op: 'refund_failed', code: 'unreadable', status: r.status, why: `${url} answered ${r.status} with no JSON` }
  return { status: r.status, ...j }
}

export const RELAY_URL = 'https://api.zeampass.com/relay'
const USDC_ON = { 8453: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 84532: '0x036cbd53842c5426634e7929541ec2318f3dcf7e' }
const QUOTE_ROOM = 2

export async function gasPaymentProblem(a, { relayUrl = RELAY_URL, maxMicroUSD = 0, chainId = 0, relayFetchFn = fetch, quotePath = '/quote?claim=1', what = 'refund' } = {}) {
  const auth = a.authorization ?? {}
  const m = a.sign?.message ?? {}
  const lower = (x) => String(x ?? '').toLowerCase()
  if (a.sign?.primaryType !== 'TransferWithAuthorization') return 'what it asks this key to sign is not a USDC gas payment'
  for (const k of ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce']) if (lower(m[k]) !== lower(auth[k])) return `what it asks this key to sign differs from the payment it describes (${k})`
  const on = Number(a.sign?.domain?.chainId)
  if (chainId && on !== chainId) return `the payment is on chain ${a.sign?.domain?.chainId}, not this client's (${chainId})`
  const token = USDC_ON[on]
  if (!token) return `the payment is on chain ${a.sign?.domain?.chainId}, where this client knows no USDC`
  if (lower(a.sign.domain.verifyingContract) !== token) return `the payment is in ${a.sign.domain.verifyingContract}, not USDC`
  const value = Number(auth.value)
  if (!Number.isSafeInteger(value) || value <= 0 || value !== Number(a.gasMicroUSD)) return `the payment is ${auth.value}, not the ${a.gasMicroUSD} it quotes`
  if (!(value < Number(a.leftMicroUSD ?? a.returnedMicroUSD))) return `the gas, ${value}, is not less than the ${a.leftMicroUSD ?? a.returnedMicroUSD} it would return`
  if (maxMicroUSD && value > maxMicroUSD) return `the gas, ${value}, is over PASS_MAX_SPEND (${maxMicroUSD})`
  let health, quote
  try {
    health = await (await relayFetchFn(`${relayUrl}/health`, { signal: AbortSignal.timeout(10_000) })).json()
    quote = await (await relayFetchFn(`${relayUrl}${quotePath}`, { signal: AbortSignal.timeout(10_000) })).json()
  } catch (e) { return `the relay at ${relayUrl} could not be asked what this ${what}'s gas costs (${e?.message ?? e})` }
  if (!health?.sender || lower(auth.to) !== lower(health.sender)) return `the payment goes to ${auth.to}, not to the relay's gas wallet (${health?.sender ?? 'unknown'} at ${relayUrl})`
  const priced = Number(quote?.quoteMicroUSD)
  if (!(priced > 0)) return `the relay at ${relayUrl} gave no price for this ${what}'s gas`
  if (value > priced * QUOTE_ROOM) return `the gas, ${value}, is more than ${QUOTE_ROOM} times what the relay prices it at now (${priced})`
  return null
}

export async function passRefund({ url, channelId, signer, payer = signer, selfSend = false, relayUrl = RELAY_URL, maxMicroUSD = 0, budget = null, chainId = 0, fetchFn = fetch, relayFetchFn = fetchFn, now = Date.now, wait = sleep, tries = 6, log = () => {} }) {
  const ask = (extra) => askPassRefund({ url, channelId, signer, extra, fetchFn, now })
  const first = selfSend ? { selfSend: true } : {}
  let a
  for (let i = 0; i < tries; i++) {
    a = await ask(first)
    if (a.code !== 'request_open' || i + 1 === tries) break
    const secs = Number(a.retry_after_seconds)
    await wait(Math.min(Number.isFinite(secs) && secs > 0 ? secs * 1000 : 1000, 5000))
  }
  if (a.op !== 'refund_quote' || a.code !== 'gas_payment_needed' || !a.sign || !a.authorization) return a
  const from = String(a.authorization.from ?? '').toLowerCase()
  if (!payer?.signTypedData || String(payer.address ?? '').toLowerCase() !== from) {
    return { ...a, op: 'refund_failed', code: 'gas_payment_needed', why: `${a.why ?? ''} The gas payment must be signed by the channel's payer, ${a.authorization.from}; this key cannot. Run --refund with the payer's key, or --self-send.`.trim() }
  }
  const problem = (await gasPaymentProblem(a, { relayUrl, maxMicroUSD, chainId, relayFetchFn })) ?? (budget && !budget.allows(Number(a.gasMicroUSD)) ? `the gas, ${a.gasMicroUSD}, and what this run has already paid would pass PASS_MAX_SPEND (${maxMicroUSD})` : null)
  if (problem) return { ...a, op: 'refund_failed', code: 'gas_payment_refused', why: `Nothing was signed: ${problem}. Run --refund --self-send to take a signed refund of the full balance and send it at your own gas.` }
  log(`the channel's fees do not cover the refund's gas: paying the ${a.gasMicroUSD} micro-USD the seller quotes for it (its gas estimate plus 15%) in USDC from ${a.authorization.from}, to get ${a.returnedMicroUSD} back`)
  const signature = await payer.signTypedData(a.sign)
  budget?.spend(Number(a.gasMicroUSD))
  return ask({ gasPayment: { authorization: a.authorization, signature } })
}

export async function rebaseChannel(storage, channelId, cs) {
  if (cs?.chargedCumulativeAmount === undefined) return false
  const prior = (await storage.get(channelId)) ?? {}
  await storage.set(channelId, {
    ...prior,
    chargedCumulativeAmount: String(cs.chargedCumulativeAmount),
    ...(cs.balance !== undefined ? { balance: String(cs.balance) } : {}),
    ...(cs.totalClaimed !== undefined ? { totalClaimed: String(cs.totalClaimed) } : {}),
    signedMaxClaimable: String(cs.chargedCumulativeAmount),
    signature: undefined,
  })
  return true
}

export async function voucherSigner(ctx, channelId, chainId) {
  if (!ctx?.signature || ctx.signedMaxClaimable === undefined) return null
  try {
    const at = await recoverTypedDataAddress({ domain: { ...BATCH_SETTLEMENT_DOMAIN, chainId, verifyingContract: getAddress(BATCH_SETTLEMENT_ADDRESS) }, types: voucherTypes, primaryType: 'Voucher', message: { channelId, maxClaimableAmount: BigInt(ctx.signedMaxClaimable) }, signature: ctx.signature })
    return at.toLowerCase()
  } catch { return null }
}

export async function channelOnChain(pub, channelId, blockNumber = null) {
  const [balance, totalClaimed] = await pub.readContract({ address: BATCH_SETTLEMENT_ADDRESS, abi: CHANNELS_ABI, functionName: 'channels', args: [channelId], ...(blockNumber !== null ? { blockNumber: BigInt(blockNumber) } : {}) })
  return { channelId: String(channelId).toLowerCase(), balance: String(balance), totalClaimed: String(totalClaimed), chargedCumulativeAmount: String(totalClaimed) }
}

export async function withdrawable(pub, storage, channelId) {
  const n = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }
  let rec
  try { rec = await storage.get(channelId) } catch { rec = undefined }
  let balance, claimed
  try {
    const c = await channelOnChain(pub, channelId)
    balance = n(c.balance)
    claimed = n(c.totalClaimed)
  } catch { balance = n(rec?.balance); claimed = 0n }
  const charged = n(rec?.chargedCumulativeAmount)
  const owed = charged > claimed ? charged : claimed
  const left = balance - owed
  return { id: String(channelId).toLowerCase(), balance, owed, withdrawable: left > 0n ? left : 0n }
}

const CONFIG = { name: 'config', type: 'tuple', components: [{ name: 'payer', type: 'address' }, { name: 'payerAuthorizer', type: 'address' }, { name: 'receiver', type: 'address' }, { name: 'receiverAuthorizer', type: 'address' }, { name: 'token', type: 'address' }, { name: 'withdrawDelay', type: 'uint40' }, { name: 'salt', type: 'bytes32' }] }
const VOUCHER_CLAIMS = { name: 'voucherClaims', type: 'tuple[]', components: [{ name: 'voucher', type: 'tuple', components: [{ ...CONFIG, name: 'channel' }, { name: 'maxClaimableAmount', type: 'uint128' }] }, { name: 'signature', type: 'bytes' }, { name: 'totalClaimed', type: 'uint128' }] }
const SIGNED_REFUND_ABI = [
  { type: 'function', name: 'refundWithSignature', stateMutability: 'nonpayable', inputs: [CONFIG, { name: 'amount', type: 'uint128' }, { name: 'nonce', type: 'uint256' }, { name: 'receiverAuthorizerSignature', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'claimWithSignature', stateMutability: 'nonpayable', inputs: [VOUCHER_CLAIMS, { name: 'authorizerSignature', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'multicall', stateMutability: 'nonpayable', inputs: [{ name: 'data', type: 'bytes[]' }], outputs: [{ name: 'results', type: 'bytes[]' }] },
]

export function signedRefundProblem(tx, { channelId, chainId }) {
  const lower = (x) => String(x ?? '').toLowerCase()
  if (!chainId) return 'this client does not know which chain it is on'
  if (lower(tx.to) !== lower(BATCH_SETTLEMENT_ADDRESS)) return `it calls ${tx.to}, not the escrow (${BATCH_SETTLEMENT_ADDRESS})`
  if (tx.chainId !== undefined && Number(tx.chainId) !== chainId) return `it is for chain ${tx.chainId}, not this client's (${chainId})`
  if (tx.value !== undefined && String(tx.value) !== '0' && lower(tx.value) !== '0x0') return `it sends ${tx.value} wei, and a refund sends none`
  try {
    const top = decodeFunctionData({ abi: SIGNED_REFUND_ABI, data: tx.data })
    const calls = top.functionName === 'multicall' ? top.args[0].map((data) => decodeFunctionData({ abi: SIGNED_REFUND_ABI, data })) : [top]
    let refunds = 0
    for (const c of calls) {
      if (c.functionName === 'claimWithSignature') continue
      if (c.functionName !== 'refundWithSignature') return 'its data is not a signed refund on the escrow'
      if (lower(computeChannelId(c.args[0], chainId)) !== lower(channelId)) return 'it refunds another channel, not this one'
      refunds++
    }
    return refunds === 1 ? null : `it carries ${refunds} refunds of this channel, not one`
  } catch { return 'its data is not a signed refund on the escrow' }
}

export async function sendSignedRefund({ answer, account, pub, wallet, storage, channelId, chainId = wallet?.chain?.id ?? pub?.chain?.id, log = () => {} }) {
  const tx = answer?.transaction
  if (answer?.op !== 'refund_signed' || !tx?.to || !tx?.data) return answer
  const problem = signedRefundProblem(tx, { channelId, chainId })
  if (problem) {
    const { transaction, ...rest } = answer
    return { ...rest, op: 'refund_failed', code: 'signed_refund_refused', refusedTransaction: transaction, why: `Nothing was sent: the transaction the seller handed back is not a signed refund of this channel (${problem}). Do not send it from any wallet.` }
  }
  let gas, price, have
  try {
    gas = await pub.estimateGas({ account: account.address, to: tx.to, data: tx.data })
    price = await pub.getGasPrice()
    have = await pub.getBalance({ address: account.address })
  } catch (e) {
    return { ...answer, sent: false, why: `${answer.why ?? ''} Could not price sending it from here (${e?.shortMessage ?? e?.message}); any wallet can send the transaction.`.trim() }
  }
  if (have < (gas * price * 3n) / 2n) {
    return { ...answer, sent: false, why: `${answer.why ?? ''} ${account.address} holds too little ETH on Base to send it; any wallet can send the transaction.`.trim() }
  }
  const hash = await wallet.sendTransaction({ to: getAddress(tx.to), data: tx.data, value: 0n })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  const paid = gasWeiOf(receipt)
  log(`sent the signed refund at your own gas: ${receipt.status} ${hash}${paid ? `; ${paid} wei of ETH` : ''}`)
  if (receipt.status !== 'success') return { op: 'refund_failed', code: 'reverted', microUSD: answer.microUSD, transaction: hash, gasPaidBy: 'you', ...(paid ? { gasWei: paid } : {}), why: 'the refund transaction reverted' }
  let channelState = null
  try {
    channelState = await channelOnChain(pub, channelId, receipt.blockNumber ?? null).catch(() => channelOnChain(pub, channelId))
    await rebaseChannel(storage, channelId, channelState)
  } catch (e) { log(`could not rebase the channel after the refund: ${e?.shortMessage ?? e?.message}`) }
  return { op: 'refunded', microUSD: answer.microUSD, returnedMicroUSD: answer.microUSD, transaction: hash, gasPaidBy: 'you', ...(paid ? { gasWei: paid } : {}), ...(channelState ? { channelState } : {}) }
}

export const gasWeiOf = (receipt) => {
  try { return receipt?.gasUsed !== undefined && receipt?.effectiveGasPrice !== undefined ? String(BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)) : null } catch { return null }
}
