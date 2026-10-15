import { createPublicClient, createWalletClient, http as plainHttp, fallback, keccak256, toHex } from 'viem'
import { passRefund, rebaseChannel, sendSignedRefund, refundUrlBeside, refundUrlInTerms, readSeller, rememberRefundUrl, hearingHttp, withGrant } from './refund.mjs'
import { floorStrategy, learnFloor, unhurried, queue } from './client.mjs'
import { setting, TAG } from './env.mjs'
import { withAgent } from './agent.mjs'
import { LINE_HEADER, LINE_GONE, lineUrlOf, lineUrlBeside, timeFromTerms, timeTerms, buyFor, MIN_BUY_MS, openLine, lineOp, marginFor, keepAhead } from './line.mjs'
import { privateKeyToAccount } from 'viem/accounts'
import * as chains from 'viem/chains'
import { x402Client, x402HTTPClient, wrapFetchWithPayment } from '@x402/fetch'
import { BatchSettlementEvmScheme } from '@x402/evm/batch-settlement/client'
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage'
import { toClientEvmSigner } from '@x402/evm'
import { mkdirSync, readdirSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const SPEND_CAP = 'x402_bridge_spend_cap_reached'

export class SpendCapError extends Error {
  constructor(message, { needed = null, spentMicroUSD = 0, capMicroUSD = 0 } = {}) {
    super(message)
    this.code = SPEND_CAP
    if (needed !== null) this.needed = String(needed)
    this.spentMicroUSD = spentMicroUSD
    this.capMicroUSD = capMicroUSD
  }
}

const USDC = new Set(['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '0x036cbd53842c5426634e7929541ec2318f3dcf7e'])

const saltOf = (raw) => /^0x[0-9a-fA-F]{64}$/.test(String(raw).trim()) ? String(raw).trim() : keccak256(toHex(String(raw)))

function wallet({ key, url, network, stateDir, depositMultiplier, asset, salt, rpcUrl, grant, maxMicroUSD, log }) {
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('prism(): key must be a 0x-prefixed 32-byte private key. It signs vouchers locally and is never sent anywhere.')
  }
  const account = privateKeyToAccount(key)
  const chainId = Number(String(network).split(':')[1])
  const payChain = Object.values(chains).find((c) => c?.id === chainId)
  if (!payChain) throw new Error(`prism(): unknown network ${network}`)
  const dir = stateDir ?? join(homedir(), '.x402-mcp-bridge', new URL(url).host, account.address.toLowerCase())
  mkdirSync(dir, { recursive: true })
  const readers = [...(rpcUrl ? [rpcUrl] : []), ...(payChain.rpcUrls?.default?.http ?? []), new URL('/verify', url).toString()]
  const pub = createPublicClient({ chain: payChain, transport: fallback(readers.map((u) => plainHttp(u))) })

  const want = String(asset ?? '').toLowerCase()
  const floor = { micro: 0 }
  const asking = new AsyncLocalStorage()
  const fresh = () => ({ spent: 0, credit: 0, last: null })
  const outside = fresh()
  const here = () => asking.getStore() ?? outside
  const roomOf = (b) => (maxMicroUSD ? maxMicroUSD - b.spent : Infinity)
  const capped = (b, why, needed = null) => (b.refused = new SpendCapError(`${why} Nothing was signed. maxMicroUSD (PASS_MAX_SPEND) is ${maxMicroUSD} for a request and ${b.spent} is signed for this one.`, { needed, spentMicroUSD: b.spent, capMicroUSD: maxMicroUSD }))
  const capOf = (e) => { const b = here(); return e?.code === SPEND_CAP ? e : b.refused && String(e?.message ?? '').includes(b.refused.message) ? b.refused : null }
  const pick = (accepts) => {
    if (want) {
      const hit = accepts.find((a) => String(a.asset).toLowerCase() === want || String(a.extra?.name ?? '').toLowerCase() === want)
      if (hit) return hit
    }
    return accepts[0]
  }
  const selector = (_v, accepts) => {
    const hit = pick(accepts)
    const b = here()
    const n = Number(hit?.amount ?? 0)
    const uncovered = Math.max(0, n - b.credit)
    if (maxMicroUSD && uncovered > roomOf(b)) throw capped(b, `This payment of ${n} would pass maxMicroUSD.`, n)
    return hit
  }
  const raise = floorStrategy(floor)
  const depositStrategy = (ctx) => {
    const raised = raise(ctx)
    const wanted = Number(raised ?? ctx.depositAmount)
    const b = here()
    const room = roomOf(b)
    if (wanted <= room) return raised
    const floored = raised !== undefined || USDC.has(String(ctx.paymentRequirements?.asset ?? '').toLowerCase())
    const need = Math.max(Number(ctx.minimumDepositAmount ?? 0), floored && floor.micro > 0 ? floor.micro : 0)
    const deposit = Math.max(need, Math.min(wanted, Math.floor(room)))
    if (deposit > room) throw capped(b, `This request takes a channel deposit of at least ${need}, which would pass maxMicroUSD.`, need)
    log(`maxMicroUSD leaves room for a deposit of ${deposit}, not ${wanted}: depositing that`)
    return String(deposit)
  }
  const signed = ({ paymentPayload, selectedRequirements }) => {
    const b = here()
    const before = { spent: b.spent, credit: b.credit }
    const d = paymentPayload?.payload?.type === 'deposit' ? Number(paymentPayload.payload.deposit?.amount) : 0
    if (d > 0) { b.spent += d; b.credit += d }
    const n = Number(selectedRequirements?.amount ?? 0)
    if (n > 0) { const drawn = Math.min(n, b.credit); b.credit -= drawn; b.spent += n - drawn }
    b.last = { spent: b.spent - before.spent, credit: b.credit - before.credit }
  }
  const notTaken = () => {
    const b = here()
    if (!b.last) return
    b.spent -= b.last.spent
    b.credit -= b.last.credit
    b.last = null
  }
  const storage = new FileClientChannelStorage({ directory: dir })
  const state = { channelId: null }
  try {
    const f = readdirSync(join(dir, 'client')).find((n) => n.endsWith('.json'))
    if (f) state.channelId = f.replace(/\.json$/, '')
  } catch { }
  const watched = {
    get: (k) => storage.get(k),
    delete: (k) => { if (state.channelId === k) state.channelId = null; return storage.delete(k) },
    set: (k, ctx) => { state.channelId = k; return storage.set(k, ctx) },
  }
  const payments = new x402Client(selector).register(network,
    new BatchSettlementEvmScheme(toClientEvmSigner(account, pub), {
      depositPolicy: { depositMultiplier: Number(depositMultiplier ?? 40) },
      depositStrategy,
      storage: watched,
      ...(salt ? { salt: saltOf(salt) } : {}),
    }))
  payments.onAfterPaymentCreation(signed)
  const httpClient = new x402HTTPClient(payments)
  const seller = { refund: readSeller(dir).refund ?? null }
  const bare = withAgent(unhurried())
  const net = hearingHttp(withGrant(bare, grant, url), (u) => { seller.refund = u; rememberRefundUrl(dir, u) }, (t) => learnFloor(floor, t))
  const paidFetch = wrapFetchWithPayment(net, payments)
  const oneAtATime = queue()
  log(`paying as ${account.address}, state in ${dir}`)
  const wallets = createWalletClient({ account, chain: payChain, transport: plainHttp(rpcUrl ?? payChain.rpcUrls?.default?.http?.[0]) })
  const request = (fn) => asking.run(fresh(), async () => { try { return await fn() } catch (e) { throw capOf(e) ?? e } })
  return { account, state, seller, floor, net, bare, storage: watched, pub, wallets, payments, httpClient, paidFetch, oneAtATime, dir, depositMultiplier: Number(depositMultiplier ?? 40), here, roomOf, notTaken, request, capOf }
}

function line({ url, w, aheadMs, idleMs, dropAfterMs, maxMicroUSD, log }) {
  const s = { credential: null, remainingMs: 0, readAt: 0, metering: false, opening: null, offTimer: null, dropTimer: null, calls: 0,
              terms: null, time: null, lineUrl: null, topping: null, keeper: null, slowestBuyMs: 0, capped: false }
  const where = () => s.lineUrl ?? lineUrlBeside(url)
  const reads = (ms) => { s.remainingMs = Number(ms); s.readAt = Date.now() }
  const lineLeft = () => s.remainingMs - (s.calls > 0 ? Date.now() - s.readAt : 0)
  const margin = () => marginFor(aheadMs, s.slowestBuyMs)
  const drop = (why) => {
    if (s.offTimer) clearTimeout(s.offTimer); if (s.dropTimer) clearTimeout(s.dropTimer)
    s.offTimer = s.dropTimer = null
    const credential = s.credential
    if (credential) {
      log(`line let go (${why})`)
      lineOp({ url: where(), op: 'close', credential, fetchFn: w.net }).catch(() => {})
    }
    s.credential = null; s.metering = false
  }
  const terms = async () => {
    if (s.terms) return s.terms
    try {
      const j = await (await w.net(new URL('/.well-known/x402', url), { signal: AbortSignal.timeout(10_000) })).json()
      const accepts = Array.isArray(j.tickAccepts) && j.tickAccepts.length ? j.tickAccepts : j.accepts
      if (Array.isArray(accepts) && accepts.length) {
        s.terms = { x402Version: j.x402Version ?? 2, accepts, funding: Array.isArray(j.accepts) && j.accepts.length ? j.accepts : accepts, raw: j }
        s.time = timeFromTerms(j)
        s.lineUrl = lineUrlOf(j)
        learnFloor(w.floor, j)
        const r = refundUrlInTerms(j)
        if (r && !w.seller.refund) w.seller.refund = r
      }
    } catch { }
    return s.terms
  }
  const open = () => {
    if (s.credential) return Promise.resolve(s.credential)
    if (s.opening) return s.opening
    if (!w.state.channelId) return Promise.resolve(null)
    s.opening = (async () => {
      await terms()
      const o = await openLine({ url: where(), channelId: w.state.channelId, signer: w.account, fetchFn: w.net })
      if (o.op !== 'opened') { log(`line not opened: ${o.code}${o.why ? ` (${o.why})` : ''}`); return null }
      s.credential = o.credential; s.metering = o.metering !== false; reads(o.msRemaining ?? 0)
      log(`line open, ${s.remainingMs}ms on the meter`)
      return s.credential
    })().finally(() => { s.opening = null })
    return s.opening
  }
  const on = async () => {
    if (s.metering || !s.credential) return
    const a = await lineOp({ url: where(), op: 'on', credential: s.credential, fetchFn: w.net })
    if (a.op === 'on') { s.metering = true; reads(a.msRemaining ?? s.remainingMs) }
    else if (LINE_GONE.has(a.code)) drop(a.code)
  }
  const off = async () => {
    if (!s.metering || !s.credential) return
    s.metering = false
    const a = await lineOp({ url: where(), op: 'off', credential: s.credential, fetchFn: w.net })
    if (a.op === 'off') reads(a.msRemaining ?? s.remainingMs)
  }
  const touch = () => {
    if (s.offTimer) clearTimeout(s.offTimer); if (s.dropTimer) clearTimeout(s.dropTimer)
    s.offTimer = s.dropTimer = null
    if (s.calls > 0) return
    s.offTimer = setTimeout(() => { off().catch(() => {}) }, idleMs); s.offTimer.unref?.()
    s.dropTimer = setTimeout(() => { off().catch(() => {}).finally(() => drop('idle')) }, dropAfterMs); s.dropTimer.unref?.()
  }
  const during = async (call) => {
    if (s.calls++ === 0) { s.readAt = Date.now(); s.capped = false; s.keeper = keepAhead({ margin, left: lineLeft, buy: keeping() }) }
    touch()
    try { return await call() } finally {
      if (--s.calls === 0) { s.keeper.stop(); s.keeper = null }
      touch()
    }
  }
  const available = async () => {
    try {
      const c = await w.storage.get(w.state.channelId)
      return c?.balance && c.chargedCumulativeAmount !== undefined ? Number(BigInt(c.balance) - BigInt(c.chargedCumulativeAmount)) : null
    } catch { return null }
  }
  const rate = async () => {
    const t = await terms()
    return s.time ?? { rateMicro: Number(t?.accepts?.[0]?.amount ?? 250), rateMs: 250, maxMs: 14400 * 250, buys: 'blocks' }
  }
  const buyOnce = (wantMs) => w.oneAtATime(async () => {
    if (!s.credential) return false
    const from = Date.now()
    const time = await rate()
    const t = s.terms
    const b = w.here()
    const room = w.roomOf(b) + b.credit
    const fits = Number.isFinite(room) ? Math.max(Math.floor(room / time.rateMicro), 1) * time.rateMs : wantMs
    const buy = buyFor({ wantMs: Math.min(wantMs, fits), time, availableMicro: await available(), depositMultiplier: w.depositMultiplier })
    const body = JSON.stringify(buy.args)
    const post = async (rows) => {
      const quote = timeTerms({ x402Version: t.x402Version ?? 2, accepts: rows }, buy.micro)
      w.here().last = null
      const payload = await w.payments.createPaymentPayload(quote)
      const headers = { ...w.httpClient.encodePaymentSignatureHeader(payload), 'content-type': 'application/json' }
      const res = await w.net(new URL('/v1/buy_time', url), { method: 'POST', headers, body })
      await w.httpClient.processPaymentResult(payload, (n) => res.headers.get(n), res.status).catch(() => {})
      return res
    }
    let r = null
    if (t) {
      const left = await available()
      const short = left !== null && left < buy.micro
      r = await post(short ? t.funding : t.accepts)
      if (r.status === 402) {
        w.notTaken()
        const j = await r.clone().json().catch(() => null)
        if (j?.code === 'funding_requires_open_fee' && !short) {
          log('this purchase carries a deposit on the funding row')
          r = await post(Array.isArray(j.accepts) && j.accepts.length ? j.accepts : t.funding)
          if (r.status === 402) w.notTaken()
        } else { s.terms = null; r = null }
      }
    }
    if (!r) {
      w.here().last = null
      r = await w.paidFetch(new URL('/v1/buy_time', url), { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      if (r.status === 402) w.notTaken()
    }
    const j = await r.json().catch(() => null)
    if (r.status !== 200 || j?.paid === false) { log(`buy_time refused: ${j?.code ?? j?.error ?? r.status}`); return false }
    reads(j.msRemaining ?? s.remainingMs + buy.ms)
    s.slowestBuyMs = Math.max(s.slowestBuyMs, Date.now() - from)
    return buy.micro
  })
  const keeping = () => async (wantMs, have) => {
    const time = await rate()
    const b = w.here()
    const room = w.roomOf(b) + b.credit
    const stop = () => {
      s.capped = true
      log(`this request has signed for ${b.spent} micro-USD of the ${maxMicroUSD} that maxMicroUSD (PASS_MAX_SPEND) allows: no more line time is bought; it runs on the ${Math.round(have)}ms left`)
      return null
    }
    if (buyFor({ wantMs: 0, time }).micro > room) return stop()
    const fits = Number.isFinite(room) ? Math.floor(room / time.rateMicro) * time.rateMs : wantMs
    let capErr = false
    const micro = await buyOnce(Math.min(wantMs, fits)).catch((e) => { capErr = Boolean(w.capOf(e)); return false })
    if (capErr) return stop()
    if (!micro) { log(`could not buy more line time while a request runs: it keeps running on the ${Math.round(Math.max(0, lineLeft()))}ms left`); return false }
    return true
  }
  const ensure = async (minMs) => {
    const fill = s.remainingMs < minMs ? 2 * margin() : minMs
    for (let i = 0; s.credential && s.remainingMs < fill && i < 4; i++) {
      const had = s.remainingMs
      if (!(await buyOnce(Math.max(MIN_BUY_MS, fill - had)))) { if (had >= MIN_BUY_MS) break; return false }
      if (s.remainingMs <= had) break
    }
    return Boolean(s.credential) && s.remainingMs >= Math.min(minMs, MIN_BUY_MS)
  }
  const topUp = () => {
    if (s.topping || s.remainingMs >= aheadMs / 2) return s.topping
    s.topping = (async () => {
      const left = await available()
      if (left === null || left < MIN_BUY_MS * ((s.time?.rateMicro ?? 250) / (s.time?.rateMs ?? 250))) return false
      return buyOnce(aheadMs)
    })().catch(() => false).finally(() => { s.topping = null })
    return s.topping
  }
  const read = (res) => {
    const left = Number(res.headers.get('x-pass-ms-remaining'))
    if (res.headers.has('x-pass-ms-remaining') && Number.isFinite(left)) reads(left)
  }
  const ranOut = async (endedAt) => {
    await w.oneAtATime(() => {})
    if (s.readAt <= endedAt) reads(0)
    return s.capped
  }
  return { s, open, on, off, during, ensure, topUp, drop, terms, read, ranOut, remaining: () => s.remainingMs }
}

export function client(opts = {}) {
  const {
    key = setting('PRIVATE_KEY'), url = setting('MCP_URL')?.replace(/\/mcp\/?$/, '') ?? 'https://mcp.zeamprism.com',
    chain = 'base', network = setting('NETWORK') ?? 'eip155:8453',
    stateDir = setting('STATE_DIR'), depositMultiplier = setting('DEPOSIT_MULTIPLIER'),
    asset = setting('ASSET'), salt = setting('SALT'), rpcUrl = setting('RPC_URL'),
    grant = setting('GRANT'),
    relayUrl = setting('RELAY_URL') || undefined, maxMicroUSD = Number(setting('MAX_SPEND') ?? 10_000_000),
    aheadMs = 2000, idleMs = 1000, dropAfterMs = 10_000,
    log = (...a) => console.error(TAG, ...a),
  } = opts
  const w = wallet({ key, url, network, stateDir, depositMultiplier, asset, salt, rpcUrl, grant, maxMicroUSD, log })
  const l = line({ url, w, aheadMs, idleMs, dropAfterMs, maxMicroUSD, log })
  const door = new URL(`/rpc/${chain}`, url).toString()

  const withLine = (req) => { const r = new Request(req); r.headers.set(LINE_HEADER, l.s.credential); return r }
  const errorData = async (r) => {
    const j = await r.clone().json().catch(() => null)
    return (Array.isArray(j) ? j[0] : j)?.error?.data ?? j
  }
  const codeOf = async (r) => {
    const j = await r.clone().json().catch(() => null)
    const d = (Array.isArray(j) ? j[0] : j)?.error?.data ?? j
    return d?.code ?? d?.error ?? null
  }

  const fetchFn = (input, init) => w.request(() => paying(input, init))
  const paying = async (input, init) => {
    const req = new Request(input, init)
    let r = null
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!l.s.credential && w.state.channelId) await l.open()
      if (l.s.credential) {
        await l.on()
        if (!(await l.ensure(MIN_BUY_MS))) { if (l.s.credential) l.drop('could not buy time'); continue }
        r = await l.during(() => w.net(withLine(req.clone())))
        const endedAt = Date.now()
        l.read(r)
        l.topUp()
        if (r.status !== 402 && r.status !== 403) return r
        const code = await codeOf(r)
        if (code === 'meter_off') { l.s.metering = false; continue }
        if (code === 'out_of_time') { if (await l.ranOut(endedAt)) return r; continue }
        if (LINE_GONE.has(code)) { l.drop(code); continue }
        return r
      }
      r = await w.oneAtATime(() => { w.here().last = null; return w.paidFetch(req.clone()) })
      if (r.status !== 402) return r
      w.notTaken()
      const code = await codeOf(r)
      if (code === 'funding_requires_open_fee' && learnFloor(w.floor, await errorData(r))) continue
      if ((code === 'out_of_time' || code === 'line_required') && w.state.channelId) { await l.open(); continue }
      return r
    }
    if (r) return r
    throw new Error(`${TAG} could not hold a line after four attempts`)
  }

  const refund = async ({ selfSend = false } = {}) => {
    await l.off().catch(() => {})
    l.drop('refunding')
    await w.oneAtATime(() => {})
    const channelId = w.state.channelId
    if (!channelId) return { op: 'refund_failed', why: 'no channel' }
    await l.terms()
    const passUrl = w.seller.refund ?? refundUrlBeside(url)
    const gas = { spent: 0 }
    let a = await passRefund({ url: passUrl, channelId, signer: w.account, selfSend, relayUrl, maxMicroUSD, budget: { allows: (u) => !maxMicroUSD || gas.spent + u <= maxMicroUSD, spend: (u) => { gas.spent += u } }, chainId: w.pub.chain?.id, fetchFn: w.net, relayFetchFn: w.bare, log })
    if (a.op === 'refund_signed') a = await sendSignedRefund({ answer: a, account: w.account, pub: w.pub, wallet: w.wallets, storage: w.storage, channelId, log })
    if (a.op === 'refunded' && a.channelState && a.gasPaidBy !== 'you') await rebaseChannel(w.storage, channelId, a.channelState).catch((e) => log(`could not rebase the channel after the refund: ${e.message}`))
    return a
  }
  const close = async () => { await l.off().catch(() => {}); l.drop('closed') }
  const state = () => ({ address: w.account.address, channelId: w.state.channelId, line: Boolean(l.s.credential),
                         metering: l.s.metering, msRemaining: l.remaining() })
  return { door, fetch: fetchFn, close, refund, state }
}

export { LINE_HEADER }
