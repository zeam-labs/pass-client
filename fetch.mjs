import { x402Client, x402HTTPClient } from '@x402/fetch'
import { ExactEvmScheme } from '@x402/evm/exact/client'
import { toClientEvmSigner } from '@x402/evm'
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage'
import { computeChannelId, buildChannelConfig } from '@x402/evm/batch-settlement/client'
import { unhurried, paymentsFor, selectorFor, floorStrategy, learnFloor, refusedBody, queue, PREFERRED } from './client.mjs'
import { refundUrlOf, rememberRefundUrl, rememberPayingChannel, withGrant } from './refund.mjs'
import { withAgent } from './agent.mjs'
import { parseChallenges, evmCharges, payCharge, credentialHeader, credentialHeaderName, receiptOf } from './mpp.mjs'
import { sessionOffers, httpTransport } from './session.mjs'

const USDC = new Set([
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
])

export const FETCH_TOOL = {
  name: 'paid_fetch',
  description: 'Calls any HTTP URL and, if it answers 402 Payment Required, pays it with this client\'s key and retries: under the x402 exact scheme; else as an MPP (Payment) charge on this client\'s network; else under the x402 batch-settlement scheme, from a payment channel. ' +
    'Works for any x402 API, for MPP APIs that take an EVM charge, for the HTTP routes of a ZEAM :: Bridge seller, and for endpoints behind a ZEAM :: Bridge gate, which admits a key by a payment of zero. ' +
    'The first batch-settlement payment to a seller signs a deposit into the channel, more than the price; later calls spend it and the rest is refundable. ' +
    'When the person running this client has pinned a session escrow, an MPP session the URL offers is paid the same way, from a channel in that escrow, before a charge. ' +
    'Set pay to false to see the terms without paying. maxAmount (base units of the asset) refuses a quote above it, and a deposit above it.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'the http(s) URL to call' },
      method: { type: 'string', description: 'GET, POST, …; POST when a body is given, GET otherwise' },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      body: { description: 'a JSON value is sent as JSON; a string is sent as is' },
      pay: { type: 'boolean', description: 'false returns the 402 terms without paying; default true' },
      maxAmount: { type: 'string', description: 'refuse to pay, or to deposit into a channel, more than this many base units of the quoted asset' },
    },
    required: ['url'],
  },
}

export const FETCH_ALIASES = ['x402_fetch']
export const isFetchTool = (name) => name === FETCH_TOOL.name || FETCH_ALIASES.includes(name)

const text = (o, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(o) }] })

const NO_SALT = `0x${'00'.repeat(32)}`

export function makeFetchTool({ signer, pub, network, grant = null, seller = null, log = () => {}, budget = { allows: () => true, spend: () => {} }, fetchImpl = withAgent(unhurried()), stateFor = null, depositMultiplier = 40, salt = null, asset = '', sessions = null } = {}) {
  const http402 = signer ? new x402HTTPClient(new x402Client().register(network, new ExactEvmScheme(toClientEvmSigner(signer, pub)))) : null
  const net = withGrant(fetchImpl, grant, seller)
  const seats = new Map()

  const seatFor = (url) => {
    if (seats.has(url.host)) return seats.get(url.host)
    const given = stateFor && !/^\.+$/.test(url.host) ? stateFor(url) : null
    if (!given) return null
    const store = given.storage ?? new FileClientChannelStorage({ directory: given.dir })
    const seat = { dir: given.dir, refund: given.refund ?? '--refund', store, floor: given.floor ?? { micro: 0 }, serial: given.serial ?? queue(), key: null, guard: null, credit: new Map() }
    const kept = { get: (k) => store.get(k), delete: (k) => store.delete(k), set: async (k, ctx) => { if (k === seat.key) await store.set(k, ctx) } }
    const raise = floorStrategy(seat.floor)
    const depositStrategy = (ctx) => {
      const raised = raise(ctx)
      const problem = seat.guard(BigInt(raised ?? ctx.depositAmount))
      if (problem) throw new Error(problem)
      return raised
    }
    seat.payments = paymentsFor({ signer, pub, network, selector: (_version, accepts) => accepts[0], batch: { depositPolicy: { depositMultiplier }, depositStrategy, storage: kept, ...(salt ? { salt } : {}) } })
    seat.http = new x402HTTPClient(seat.payments)
    seats.set(url.host, seat)
    return seat
  }

  const readBody = async (res) => {
    const raw = await res.text()
    try { return JSON.parse(raw) } catch { return raw }
  }

  async function charge(offer, terms, args, send, url) {
    const { amount, currency, recipient } = offer
    if (args.maxAmount !== undefined && amount > BigInt(args.maxAmount)) return text({ ...terms, error: 'over_max', message: `quoted ${amount} is more than maxAmount ${args.maxAmount}` }, true)
    const isUsdc = USDC.has(currency.toLowerCase())
    if (!isUsdc && args.maxAmount === undefined) return text({ ...terms, error: 'max_required', message: `the quote is in ${currency}, not USDC, so the spend cap cannot value it; pass maxAmount to pay it` }, true)
    if (isUsdc && !budget.allows(Number(amount))) return text({ ...terms, error: 'x402_bridge_spend_cap_reached', message: 'this payment would pass PASS_MAX_SPEND' }, true)
    let header, validBefore
    try { const credential = await payCharge({ signer, pub, offer }); validBefore = Number(credential.payload.validBefore); header = credentialHeader(credential) }
    catch (e) { return text({ ...terms, error: 'could_not_sign', message: String(e?.message ?? e) }, true) }
    if (isUsdc) budget.spend(Number(amount))
    let second
    try { second = await send({ [credentialHeaderName(offer.challenge)]: header }) } catch (e) { return text({ error: 'unreachable', message: `${String(e?.message ?? e)}. The signed charge may still be collected until it expires.` }, true) }
    const receipt = receiptOf(second.headers.get('payment-receipt'))
    const out = await readBody(second)
    const ok = second.status < 400
    const paid = ok && receipt?.status === 'success'
    if (paid) log(`paid_fetch: paid ${amount} of ${currency} to ${url.host} as an MPP charge`)
    const until = new Date(validBefore * 1000).toISOString()
    return text({ status: second.status, ok, paid, protocol: 'mpp', amount: String(amount), asset: currency, payTo: recipient, ...(receipt ? { receipt } : {}), ...(paid ? {} : { signed: true, note: `no receipt came back. The signed charge can still be collected until ${until}, so it counts against PASS_MAX_SPEND.` }), body: out }, !ok)
  }

  async function session(offer, terms, args, url, quoted, route) {
    const seat = seatFor(url)
    const got = await sessions.pay({ dir: seat.dir, origin: url.origin, offer, terms: quoted, resource: { transport: 'http', url: url.toString(), method: route.method }, send: route.send, signal: route.signal ?? null, max: args.maxAmount !== undefined ? BigInt(args.maxAmount) : null })
    const { answer, error, ...facts } = got
    const said = { protocol: 'mpp', intent: 'session', ...facts, ...(answer ? { status: answer.status, body: answer.body } : {}) }
    if (error) return text({ ...(answer ? {} : terms), error, ...said }, true)
    if (got.paid) log(`paid_fetch: paid ${got.charged} of ${got.asset} to ${url.host} from session channel ${got.channelId}`)
    return text({ ok: answer.ok, ...said }, !answer.ok)
  }

  const funded = async (pick, url) => {
    try {
      const c = await seatFor(url).store.get(computeChannelId(buildChannelConfig({ signer: { address: signer.address }, salt: salt ?? NO_SALT }, pick), pick.network).toLowerCase())
      return BigInt(c?.balance ?? 0) > BigInt(c?.chargedCumulativeAmount ?? 0)
    } catch { return false }
  }

  async function channel(pick, required, terms, args, send, url, quoted) {
    const amount = BigInt(pick.amount)
    const max = args.maxAmount !== undefined ? BigInt(args.maxAmount) : null
    if (max !== null && amount > max) return text({ ...terms, error: 'over_max', message: `quoted ${amount} is more than maxAmount ${args.maxAmount}` }, true)
    const isUsdc = USDC.has(String(pick.asset).toLowerCase())
    if (amount > 0n && !isUsdc && max === null) return text({ ...terms, error: 'max_required', message: `the quote is in ${pick.asset}, not USDC, so the spend cap cannot value it; pass maxAmount to pay it` }, true)
    let key
    try { key = computeChannelId(buildChannelConfig({ signer: { address: signer.address }, salt: salt ?? NO_SALT }, pick), pick.network).toLowerCase() }
    catch (e) { return text({ ...terms, error: 'could_not_sign', message: String(e?.message ?? e) }, true) }
    const seat = seatFor(url)
    if (!seat) return text({ ...terms, error: 'no_payable_terms', message: `no channel state can be kept for ${url.host}` }, true)

    return seat.serial(async () => {
      const chargedSoFar = async () => { try { return BigInt((await seat.store.get(key))?.chargedCumulativeAmount ?? 0) } catch { return 0n } }
      const credit = () => seat.credit.get(key) ?? 0n
      const uncovered = (more = 0n) => (amount > credit() + more ? amount - credit() - more : 0n)
      const capped = (units) => isUsdc && units > 0n && !budget.allows(Number(units))
      if (capped(uncovered())) return text({ ...terms, error: 'x402_bridge_spend_cap_reached', message: 'this payment would pass PASS_MAX_SPEND' }, true)
      learnFloor(seat.floor, quoted)
      seat.key = key
      let deposited = 0n
      let signed = false
      let refused = null
      seat.guard = (deposit) => {
        const all = deposited + deposit
        const said = `paying ${amount} to ${url.host} takes a channel deposit of ${deposit}${deposited ? `, after the ${deposited} this call already signed` : ''}`
        const unsigned = signed ? 'Nothing more was signed.' : 'Nothing was signed.'
        if (max !== null && all > max) refused = { error: 'over_max', needed: String(all), message: `${said}: more than maxAmount ${args.maxAmount}. ${unsigned} Pass maxAmount ${all} or more to make the deposit; what a channel does not spend comes back with --refund.` }
        else if (capped(deposit + uncovered(deposit))) refused = { error: 'x402_bridge_spend_cap_reached', needed: String(deposit), message: `${said}, which would pass PASS_MAX_SPEND. ${unsigned} A deposit counts toward PASS_MAX_SPEND; it is the price × PASS_DEPOSIT_MULTIPLIER, at least the seller's floor.` }
        return refused?.message ?? null
      }
      const facts = () => ({ scheme: PREFERRED, amount: String(amount), asset: pick.asset, payTo: pick.payTo, channelId: key, ...(deposited ? { deposit: String(deposited) } : {}) })
      let res = null
      let out = null
      let settlement = null
      let from = 0n
      for (let attempt = 0; attempt < 3; attempt++) {
        let payload
        try { payload = await seat.payments.createPaymentPayload({ ...required, accepts: [pick] }) }
        catch (e) { return text({ ...terms, ...(refused ?? { error: 'could_not_sign', message: String(e?.message ?? e) }), ...(deposited ? { deposit: String(deposited) } : {}) }, true) }
        signed = true
        from = await chargedSoFar()
        const deposit = payload.payload?.type === 'deposit' ? BigInt(payload.payload.deposit.amount) : 0n
        if (deposit > 0n) {
          deposited += deposit
          seat.credit.set(key, credit() + deposit)
          if (isUsdc) budget.spend(Number(deposit))
          log(`paid_fetch: signed a deposit of ${deposit} of ${pick.asset} into channel ${key} for ${url.host}; state in ${seat.dir}; what is unspent comes back with ${seat.refund}`)
        }
        try { res = await send(seat.http.encodePaymentSignatureHeader(payload)) }
        catch (e) { return text({ error: 'unreachable', message: `${String(e?.message ?? e)}. The signed voucher${deposit > 0n ? ' and deposit' : ''} may still be collected.`, ...facts() }, true) }
        const result = await seat.http.processPaymentResult(payload, (n) => res.headers.get(n), res.status).catch(() => ({ recovered: false }))
        settlement = result.settleResponse ?? null
        out = await readBody(res)
        if (res.status !== 402 || settlement) break
        if (result.recovered) { log(`paid_fetch: ${url.host} holds a different count for channel ${key}; resynced from its signed state, paying again`); continue }
        if (out?.code === 'funding_requires_open_fee' && learnFloor(seat.floor, out)) { log(`paid_fetch: the deposit floor at ${url.host} is ${seat.floor.micro} micro-USD: depositing that`); continue }
        if (refusedBody(out)) {
          log('paid_fetch: payment refused as stale — dropping the local channel record and resyncing')
          try { await seat.store.delete(key) } catch { }
          continue
        }
        break
      }
      const u = refundUrlOf(quoted)
      if (u) rememberRefundUrl(seat.dir, url.origin, u)
      if (settlement) rememberPayingChannel(seat.dir, url.origin, `${signer.address.toLowerCase()} ${salt ?? NO_SALT}`, key)
      const ok = res.status < 400
      const now = await chargedSoFar()
      const charged = settlement ? (now > from ? now - from : 0n) : ok ? amount : 0n
      const drawn = charged < credit() ? charged : credit()
      seat.credit.set(key, credit() - drawn)
      if (isUsdc && charged > drawn) budget.spend(Number(charged - drawn))
      const paid = ok && Boolean(settlement) && charged > 0n
      if (paid) log(`paid_fetch: paid ${charged} of ${pick.asset} to ${url.host} from channel ${key}`)
      const unsaid = ok && !settlement && amount > 0n
      return text({ status: res.status, ok, paid, ...facts(), ...(settlement ? { charged: String(charged), settlement } : {}), ...(unsaid ? { signed: true, note: 'no PAYMENT-RESPONSE came back. The signed voucher can still be claimed, so it counts against PASS_MAX_SPEND.' } : {}), body: out }, !ok)
    })
  }

  return async function call(args = {}, { signal } = {}) {
    let url
    try { url = new URL(String(args.url ?? '')) } catch { return text({ error: 'bad_url', message: 'url must be an absolute http(s) URL' }, true) }
    if (!/^https?:$/.test(url.protocol)) return text({ error: 'bad_url', message: 'only http and https' }, true)
    const hasBody = args.body !== undefined
    const method = String(args.method ?? (hasBody ? 'POST' : 'GET')).toUpperCase()
    const headers = { ...(args.headers ?? {}) }
    let body
    if (hasBody) {
      if (typeof args.body === 'string') body = args.body
      else { body = JSON.stringify(args.body); if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json' }
    }
    const send = (extra = {}) => net(url, { method, headers: { ...headers, ...extra }, ...(body !== undefined ? { body } : {}), ...(signal ? { signal } : {}) })

    let first
    try { first = await send() } catch (e) { return text({ error: 'unreachable', message: String(e?.message ?? e) }, true) }
    if (first.status !== 402) return text({ status: first.status, paid: false, body: await readBody(first) }, first.status >= 400)

    const firstBody = await readBody(first)
    const challenges = parseChallenges(first.headers.get('www-authenticate'))
    const charges = evmCharges(challenges, network)
    let required = null
    let unreadable = null
    try { required = (http402 ?? new x402HTTPClient(new x402Client())).getPaymentRequiredResponse((n) => first.headers.get(n), firstBody) }
    catch (e) { unreadable = String(e?.message ?? e) }
    if (required === null && !challenges.length) return text({ status: 402, paid: false, error: 'unreadable_terms', message: unreadable, body: firstBody }, true)
    const exact = (required?.accepts ?? []).filter((a) => a.scheme === 'exact' && a.network === network)
    const batch = stateFor ? (required?.accepts ?? []).filter((a) => a.scheme === PREFERRED && a.network === network) : []
    const offered = challenges.map((c) => ({ method: c.method, intent: c.intent, realm: c.realm, ...(c.expires ? { expires: c.expires } : {}) }))
    const terms = { status: 402, paid: false, ...(required ? { accepts: required.accepts } : {}), ...(offered.length ? { mpp: offered } : {}), ...(typeof firstBody === 'object' && firstBody?.realm ? { realm: firstBody.realm } : {}) }
    if (args.pay === false) return text(terms)
    if (!http402) return text({ ...terms, error: 'no_key', message: 'set PASS_PRIVATE_KEY to pay; this client has no key' }, true)
    const inSession = sessions && seatFor(url) ? sessions.usable(sessionOffers(challenges, network)).sort((a, b) => (a.amount < b.amount ? -1 : 1)) : []
    if (inSession.length && (sessions.mode === 'on' || !exact.length)) {
      const kept = sessions.mode === 'on' || sessions.holds(seatFor(url).dir) || !batch.length || !(await funded(selectorFor(asset)(required.x402Version, batch), url))
      if (kept) return session(inSession[0], terms, args, url, firstBody, { method, signal, send: httpTransport({ fetchFn: net, url, method, headers, body, signal, network }).send })
    }
    if (!exact.length && charges.length) return charge(charges.slice().sort((a, b) => (a.amount < b.amount ? -1 : 1))[0], terms, args, send, url)
    if (!exact.length && batch.length) return channel(selectorFor(asset)(required.x402Version, batch), required, terms, args, send, url, firstBody)
    if (!exact.length) return text({ ...terms, error: 'no_payable_terms', message: `nothing quoted under the exact or batch-settlement scheme, or as an MPP EVM charge taking an EIP-3009 authorization, on ${network}` }, true)

    const pick = exact.slice().sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1))[0]
    const amount = BigInt(pick.amount)
    if (args.maxAmount !== undefined && amount > BigInt(args.maxAmount)) return text({ ...terms, error: 'over_max', message: `quoted ${amount} is more than maxAmount ${args.maxAmount}` }, true)
    const isUsdc = USDC.has(String(pick.asset).toLowerCase())
    if (amount > 0n && !isUsdc && args.maxAmount === undefined) return text({ ...terms, error: 'max_required', message: `the quote is in ${pick.asset}, not USDC, so the spend cap cannot value it; pass maxAmount to pay it` }, true)
    if (amount > 0n && isUsdc && !budget.allows(Number(amount))) return text({ ...terms, error: 'x402_bridge_spend_cap_reached', message: 'this payment would pass PASS_MAX_SPEND' }, true)

    let payHeaders
    try { payHeaders = http402.encodePaymentSignatureHeader(await http402.createPaymentPayload({ ...required, accepts: [pick] })) }
    catch (e) { return text({ ...terms, error: 'could_not_sign', message: String(e?.message ?? e) }, true) }
    if (amount > 0n && isUsdc) budget.spend(Number(amount))
    const collectable = 'The signed transfer can still be collected until it expires, so it counts against PASS_MAX_SPEND.'
    let second
    try { second = await send(payHeaders) } catch (e) { return text({ error: 'unreachable', message: `${String(e?.message ?? e)}.${amount > 0n ? ` ${collectable}` : ''}` }, true) }
    let settlement = null
    try { settlement = http402.getPaymentSettleResponse((n) => second.headers.get(n)) } catch { }
    const out = await readBody(second)
    const ok = second.status < 400
    const paid = ok && amount > 0n
    if (ok) log(`paid_fetch: ${amount === 0n ? 'admitted by a payment of zero at' : `paid ${amount} of ${pick.asset} to`} ${url.host}`)
    return text({ status: second.status, ok, paid, amount: String(amount), asset: pick.asset, payTo: pick.payTo, ...(settlement ? { settlement } : {}), ...(!ok && amount > 0n ? { signed: true, note: collectable } : {}), body: out }, !ok)
  }
}
