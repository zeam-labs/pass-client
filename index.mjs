#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { wrapMCPClientWithPayment } from '@x402/mcp'
import { paymentsFor, selectorFor, paymentRefused, paymentNotTaken, floorStrategy, learnFloor, untilAnswered, readsPaymentOnly, unhurried, PREFERRED } from './client.mjs'
import { withAgent } from './agent.mjs'
import { toClientEvmSigner } from '@x402/evm'
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage'
import { computeChannelId, buildChannelConfig } from '@x402/evm/batch-settlement/client'
import { privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, createWalletClient, http, fallback, keccak256, toHex, getAddress } from 'viem'
import { passRefund, rebaseChannel, sendSignedRefund, refundUrlBeside, refundUrlInTerms, readSeller, rememberRefundUrl, hearingMcp, withGrant } from './refund.mjs'
import { LINE_META, PRICE_META, LINE_GONE, lineUrlOf, lineUrlBeside, timeOf, timeFromTerms, isTimeTag, bodyOf, codeOf, meterOf, timeTerms, buyFor, askedMicro, MIN_BUY_MS, openLine, lineOp, marginFor, slowestFor, keepAhead } from './line.mjs'
import { FETCH_TOOL, isFetchTool, makeFetchTool } from './fetch.mjs'
import { makeSessions, sessionTrust, splitHint, httpTransport, mcpTransport, SESSION_MODES } from './session.mjs'
import { setting, nameInForce, TAG } from './env.mjs'
import * as chains from 'viem/chains'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

const UPSTREAM =
  setting('MCP_URL') ?? setting('UPSTREAM') ?? 'https://mcp.zeamprism.com/mcp'
const KEY = setting('PRIVATE_KEY') ?? process.env.PRISM_PRIVATE_KEY
const KEY_NAME = setting('PRIVATE_KEY') === undefined && process.env.PRISM_PRIVATE_KEY !== undefined ? 'PRISM_PRIVATE_KEY' : nameInForce('PRIVATE_KEY')
const NETWORK = setting('NETWORK') ?? 'eip155:8453'
const WANT = (setting('ASSET') ?? '').toLowerCase()
const NAME = setting('NAME') ?? 'zeam-pass'
const GRANT = setting('GRANT') || null
const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
const log = (...a) => console.error(TAG, ...a)

const argv = process.argv.slice(2)
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : (argv[i + 1] ?? '') }
const has = (name) => argv.includes(name)

if (has('--version') || has('-v')) {
  process.stdout.write(`${VERSION}\n`)
  process.exit(0)
}

if (has('--help') || has('-h')) {
  process.stdout.write([
    `zeam-pass ${VERSION} — the ZEAM :: Pass client: pay for MCP tools and paid URLs with a wallet.`,
    '',
    '  With your key exported as PASS_PRIVATE_KEY:',
    '',
    '    npx -y @zeampass/client --call call_rpc \'{"chain":"base","method":"eth_blockNumber","params":[]}\'',
    '    npx -y @zeampass/client --tools',
    '    npx -y @zeampass/client --call paid_fetch \'{"url":"https://…","pay":false}\'',
    '    npx -y @zeampass/client --refund',
    '',
    'With no arguments it runs as an MCP stdio server.',
    'Without a key: --tools, and --call of a free tool; --call of a paid tool prints the seller\'s terms and exits 1.',
    '',
    'Env: PASS_PRIVATE_KEY, PASS_MCP_URL, PASS_LINE=auto|on|off, PASS_MAX_SPEND (micro-USD, 0 = no cap),',
    '     PASS_DEPOSIT_MULTIPLIER (default 40, minimum 3), PASS_LINE_AHEAD_MS (default 2000: line time kept ahead of a call),',
    '     PASS_GRANT, PASS_SALT, PASS_ASSET, PASS_RPC_URL, PASS_STATE_DIR,',
    '     PASS_SESSION=auto|on|off, PASS_SESSION_ESCROW and PASS_SESSION_FACTORY (the MPP session escrow this client may pay into, and its payee factory).',
    '     Renamed from x402-mcp-bridge: every X402_ name still works, and so does the tool name x402_fetch.',
    '',
    '  --help, --version   print this, or the version, and exit; neither contacts a server.',
    '  --refund            the seller sends back the unspent balance and the unburned line time.',
    '  --refund --self-send  a signed refund, sent from this key at its own gas.',
    '  --refund --exit     leave an MPP session channel without the seller: the close request, then after the grace period the withdrawal.',
    '',
  ].join('\n'))
  process.exit(0)
}

const keyProblem = (k) => {
  if (/^0x[0-9a-fA-F]{64}$/.test(k)) return null
  if (/\.\.\.|…|[<>]/.test(k)) return 'it is the placeholder from an example, not a key'
  if (/^[0-9a-fA-F]{64}$/.test(k)) return 'it has no 0x in front'
  const hex = /^0x([0-9a-fA-F]*)$/.exec(k)
  if (hex) return `it has ${hex[1].length} hex digits after 0x, and a key has 64`
  return 'it is not 0x followed by 64 hex digits'
}
const KEY_PROBLEM = KEY ? keyProblem(KEY) : null
const KEYLESS = !KEY || KEY_PROBLEM !== null
const NEEDS_KEY = has('--refund') || (has('--call') && isFetchTool(flag('--call')))
if (KEY_PROBLEM && (has('--call') || has('--refund'))) {
  log(`${KEY_NAME} is set and is not a key: ${KEY_PROBLEM}. Nothing was called.`)
  log('A key is 0x followed by 64 hex digits. It stays on this machine and is never sent anywhere.')
  process.exit(1)
}
if (KEYLESS && NEEDS_KEY) {
  log(`set PASS_PRIVATE_KEY to a 0x-prefixed 32-byte key: ${has('--refund') ? '--refund' : flag('--call')} signs with it. It stays on this machine;`)
  log('it signs payment vouchers locally and is never sent anywhere.')
  process.exit(1)
}
if (KEY_PROBLEM) log(`${KEY_NAME} is set and is not a key: ${KEY_PROBLEM}. Running as if there were none.`)
if (KEYLESS) log('no key: serving the catalog and the free tools; a paid call returns the quote, which says what a key needs')
const account = KEYLESS ? null : privateKeyToAccount(KEY)
const chainId = Number(String(NETWORK).split(':')[1])
const chain = Object.values(chains).find((c) => c?.id === chainId)
if (!chain) { log(`unknown network ${NETWORK}`); process.exit(1) }

const stateDir = KEYLESS ? mkdtempSync(join(tmpdir(), 'pass-client-keyless-')) : setting('STATE_DIR') ??
  join(homedir(), '.x402-mcp-bridge', new URL(UPSTREAM).host, account.address.toLowerCase())
mkdirSync(stateDir, { recursive: true })

const readers = [
  ...(setting('RPC_URL') ? [setting('RPC_URL')] : []),
  ...(chain.rpcUrls?.default?.http ?? []),
  new URL('/verify', UPSTREAM).toString(),
]
const pub = createPublicClient({ chain, transport: fallback(readers.map(u => http(u))) })
log(`chain reads: ${readers.map(u => new URL(u).host).join(' -> ')}` +
  (setting('RPC_URL') ? '' : '  (set PASS_RPC_URL to put your own node first)'))

let chosenAccept = null
let capBlocked = false
let capWhy = null
const blockedBy = (why, needed = null) => {
  capBlocked = true
  capWhy = { message: why, ...(needed !== null ? { needed: String(needed) } : {}) }
  throw new Error(why)
}
const selector = selectorFor(WANT, (a) => {
  chosenAccept = a
  if (!overCap(a?.amount, a?.scheme === PREFERRED)) return
  blockedBy(`this payment of ${a.amount} would pass PASS_MAX_SPEND. Nothing was signed.`)
}, log)

const storage = new FileClientChannelStorage({ directory: stateDir })
let channelId = null
const watchedStorage = {
  get: (k) => storage.get(k),
  delete: (k) => storage.delete(k),
  set: async (k, ctx) => { channelId = k; noteBilled(await storage.get(k).catch(() => undefined), ctx); return storage.set(k, ctx) },
}

const depositPolicy = { depositMultiplier: Number(setting('DEPOSIT_MULTIPLIER') ?? 40) }
const floor = { micro: 0 }
const raiseToFloor = floorStrategy(floor)
const cappedDeposit = (ctx) => {
  const raised = raiseToFloor(ctx)
  const wanted = Number(raised ?? ctx.depositAmount)
  if (!overCap(wanted)) return raised
  const floored = raised !== undefined || /^0x(833589fcd6edb6e08f4c7c32d4f71b54bda02913|036cbd53842c5426634e7929541ec2318f3dcf7e)$/i.test(String(ctx.paymentRequirements?.asset ?? ''))
  const need = Math.max(Number(ctx.minimumDepositAmount ?? 0), floored && floor.micro > 0 ? floor.micro : 0)
  const fit = Math.floor(unitsOf(MAX_SPEND - spentMicroUSD - fetchSpent))
  const deposit = Math.max(need, Math.min(wanted, fit))
  if (overCap(deposit)) blockedBy(`paying ${ctx.requestAmount} takes a channel deposit of at least ${need}, which would pass PASS_MAX_SPEND. Nothing was signed. A deposit counts toward PASS_MAX_SPEND when it is signed.`, need)
  log(`PASS_MAX_SPEND leaves room for a deposit of ${deposit}, not ${wanted}: depositing that`)
  return String(deposit)
}

const MAX_SPEND = Number(setting('MAX_SPEND') ?? 10_000_000)
let fetchSpent = 0
let capReached = false
const signedBy = new WeakMap()
let signedUnits = 0
let paidUnits = 0
let creditUnits = 0
const depositBy = new WeakMap()
let spentMicroUSD = 0
let quoteMicroUSD = null
let spendUnit = 'micro-USD'

const quoteFromTerms = (j) => {
  for (const c of [j?.rate?.deposit?.tickQuoteMicroUSD, j?.rate?.tickQuoteMicroUSD,
                   j?.rate?.microUSDPerCall, j?.rate?.microUSDPerBlock, j?.quoteMicroUSD]) {
    const n = Number(c)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

const quotedUnits = () => {
  const asset = String(chosenAccept?.asset ?? '').toLowerCase()
  const row = [...(tickAccepts?.accepts ?? []), ...(accepts?.accepts ?? [])].find((r) => String(r.asset ?? '').toLowerCase() === asset)
  return Number(row?.amount ?? chosenAccept?.amount ?? 0)
}

const microUSDOf = (units) => {
  const quoted = quotedUnits()
  if (quoteMicroUSD === null || !(quoted > 0)) return units
  return units * (quoteMicroUSD / quoted)
}

const unitsOf = (micro) => {
  const quoted = quotedUnits()
  if (quoteMicroUSD === null || !(quoted > 0)) return micro
  return micro * (quoted / quoteMicroUSD)
}

const overCap = (units, fromCredit = false) => {
  const n = Number(units)
  if (!MAX_SPEND || !Number.isFinite(n) || !(n > 0)) return false
  return spentMicroUSD + fetchSpent + microUSDOf(fromCredit ? Math.max(0, n - creditUnits) : n) > MAX_SPEND
}
const roomMicro = () => (MAX_SPEND ? MAX_SPEND - spentMicroUSD - fetchSpent + microUSDOf(creditUnits) : Infinity)

const chargedIn = (ctx) => Number(BigInt(ctx?.chargedCumulativeAmount ?? 0))

const noteSigned = ({ paymentPayload, selectedRequirements }) => {
  const d = paymentPayload?.payload?.type === 'deposit' ? Number(paymentPayload.payload.deposit?.amount) : 0
  if (Number.isFinite(d) && d > 0) {
    depositBy.set(paymentPayload, d)
    creditUnits += d
    notePaid(d)
  }
  const n = Number(selectedRequirements?.amount)
  if (!Number.isFinite(n) || !(n > 0)) return
  if (selectedRequirements?.scheme !== PREFERRED) { notePaid(n); return }
  signedBy.set(paymentPayload, n)
  signedUnits += n
}

const notTaken = (out) => paymentNotTaken(out) || codeOf(out) === 'funding_requires_open_fee'

const unDeposit = (paymentPayload) => {
  const d = depositBy.get(paymentPayload)
  if (!d) return
  depositBy.delete(paymentPayload)
  creditUnits = Math.max(0, creditUnits - d)
  paidUnits = Math.max(0, paidUnits - d)
  spentMicroUSD = Math.max(0, spentMicroUSD - microUSDOf(d))
}

const noteAnswer = ({ paymentPayload, result, settleResponse }) => {
  const accepted = paymentPayload?.accepted ?? chosenAccept
  if (accepted?.scheme !== PREFERRED) return
  if (settleResponse ? settleResponse.success !== false : !notTaken(result)) return
  signedUnits = Math.max(0, signedUnits - (signedBy.get(paymentPayload) ?? 0))
  signedBy.delete(paymentPayload)
  unDeposit(paymentPayload)
}

const noteBilled = (was, ctx) => {
  let mine = 0
  try {
    const charged = chargedIn(ctx)
    if (!Number.isFinite(charged)) return
    const rose = was ? charged - chargedIn(was) : charged
    mine = Math.max(0, Math.min(rose, signedUnits))
    signedUnits -= mine
  } catch {}
  const drawn = Math.min(mine, creditUnits)
  creditUnits -= drawn
  notePaid(mine - drawn)
}

const notePaid = (units) => {
  paidUnits += units
  const spent = microUSDOf(paidUnits)
  if (spent > spentMicroUSD) spentMicroUSD = spent
  if (!MAX_SPEND || capReached || spentMicroUSD < MAX_SPEND || creditUnits > 0) return
  capReached = true
  log(`SPEND CAP REACHED — this run has spent ${spentMicroUSD} ${spendUnit} against a cap of ` +
    `${MAX_SPEND}. Paying for nothing further. Raise or remove it with PASS_MAX_SPEND.`)
  letGo('spend cap reached')
}

const saltOf = (raw) => {
  const v = String(raw).trim()
  if (/^0x[0-9a-fA-F]{64}$/.test(v)) return v
  return keccak256(toHex(v))
}

const CARD_PAYER = setting('PAYER_ADDRESS')
  ? getAddress(setting('PAYER_ADDRESS')) : null

const cardSigner = CARD_PAYER ? {
  address: CARD_PAYER,
  readContract: pub.readContract.bind(pub),
  signTypedData: () => {
    throw new Error(
      `this key spends ${CARD_PAYER}'s channel but cannot add funds to it — it is a ` +
      'spending key, not that wallet\'s key. Top up from the wallet that owns the channel.')
  },
} : null

if (CARD_PAYER && account) {
  log(`spending ${CARD_PAYER}'s channel, authorized as ${account.address}`)
  log('this key can spend that channel and return it; it cannot move the money elsewhere')
}

const payments = KEYLESS ? null : paymentsFor({ signer: cardSigner ?? account, pub, network: NETWORK, selector, batch: {
    depositPolicy,
    depositStrategy: cappedDeposit,
    storage: watchedStorage,
    ...(CARD_PAYER ? { payerAuthorizer: account.address, voucherSigner: toClientEvmSigner(account, pub) } : {}),
    ...(setting('SALT') ? { salt: saltOf(setting('SALT')) } : {}),
  } })
payments?.onAfterPaymentCreation(noteSigned)

const bare = withAgent(unhurried())
const net = withGrant(bare, GRANT, UPSTREAM)

const budget = {
  allows: (units) => !MAX_SPEND || spentMicroUSD + fetchSpent + units <= MAX_SPEND,
  spend: (units) => { fetchSpent += units },
}
const SESSION_MODE = (setting('SESSION') ?? 'auto').toLowerCase()
let sessions = null
if (!KEYLESS && !cardSigner) {
  try {
    if (!SESSION_MODES.includes(SESSION_MODE)) throw new Error(`PASS_SESSION is ${SESSION_MODES.join(', ')}; it is set to ${SESSION_MODE}`)
    sessions = makeSessions({ signer: account, pub, network: NETWORK, mode: SESSION_MODE, budget, log,
      trust: sessionTrust({ chainId, escrows: setting('SESSION_ESCROW'), factories: setting('SESSION_FACTORY') }),
      depositMultiplier: depositPolicy.depositMultiplier, baseSalt: setting('SALT') ? saltOf(setting('SALT')) : null,
      relayUrl: setting('RELAY_URL') || undefined, relayFetch: bare, split: splitHint(setting('SESSION_SPLIT')), maxMicroUSD: MAX_SPEND })
  } catch (e) { log(`${e.message}. Nothing was called.`); process.exit(1) }
  if (SESSION_MODE !== 'off' && sessions.trust.any) log(`MPP sessions: pays into ${sessions.trust.list.map((e) => `${e.escrow} (${e.from})`).join(', ')}`)
}
const reached = new Map()
const mcpAt = async (url) => {
  if (!reached.has(url)) {
    const c = readsPaymentOnly(new Client({ name: NAME, version: VERSION }))
    reached.set(url, c.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: net })).then(() => c))
  }
  return reached.get(url)
}
const sessionRoute = (r) => {
  if (r.resource?.transport === 'http') return httpTransport({ fetchFn: net, url: r.resource.url, method: r.resource.method ?? 'POST', network: NETWORK })
  if (r.resource?.transport === 'mcp') return mcpTransport({ callTool: async (p) => (await mcpAt(r.resource.url)).callTool(p), name: r.resource.tool, network: NETWORK })
  return null
}
const termsURL = new URL('/.well-known/x402', UPSTREAM).toString()

const seller = { time: null, lineUrl: null, refund: readSeller(stateDir).refund ?? null, tags: null }
const learnTerms = (t) => {
  if (!t || typeof t !== 'object') return
  learnFloor(floor, t)
  seller.time ??= timeFromTerms(t)
  seller.lineUrl ??= lineUrlOf(t)
  const r = refundUrlInTerms(t)
  if (r && !seller.refund) { seller.refund = r; rememberRefundUrl(stateDir, r) }
}

let accepts = null
let tickAccepts = null
const loadTerms = async () => {
  const r = await net(termsURL, { signal: AbortSignal.timeout(10_000) }).catch((e) => { throw new Error(`${termsURL} could not be reached (${e.message})`) })
  const j = await r.json().catch(() => null)
  if (!j || typeof j !== 'object' || (!r.ok && !Array.isArray(j.accepts))) throw new Error(`the seller publishes no terms document at ${termsURL} (it answered ${r.status}${r.ok ? ', not JSON' : ''})`)
  if (!Array.isArray(j.accepts) || !j.accepts.length) throw new Error(`the terms document at ${termsURL} lists no accepts`)
  learnTerms(j)
  accepts = { x402Version: j.x402Version ?? 1, accepts: j.accepts }
  tickAccepts = Array.isArray(j.tickAccepts) && j.tickAccepts.length
    ? { x402Version: j.x402Version ?? 1, accepts: j.tickAccepts }
    : accepts
  const q = quoteFromTerms(j)
  if (q !== null) {
    if (q !== quoteMicroUSD) log(`quote: ${q} micro-USD per call, from the seller's own terms`)
    quoteMicroUSD = q; spendUnit = 'micro-USD'
  } else if (quoteMicroUSD === null) {
    spendUnit = 'base units of the paid asset'
    log('quote: this server publishes no micro-USD price, so PASS_MAX_SPEND is read as base units of the asset, not dollars.')
  }
  return accepts
}
try { await loadTerms(); log(`terms cached from ${termsURL} — paying without probing`) }
catch (e) { log(`${e.message}; falling back to the terms in the seller's 402`) }

const EFFECTIVE_SALT = setting('SALT') ? saltOf(setting('SALT')) : `0x${'00'.repeat(32)}`
const channelConfigDeps = {
  signer: { address: (cardSigner ?? account)?.address },
  payerAuthorizer: CARD_PAYER ? account.address : undefined,
  voucherSigner: CARD_PAYER ? { address: account.address } : undefined,
  salt: EFFECTIVE_SALT,
}
const saltChannel = (reqs) => {
  try { return computeChannelId(buildChannelConfig(channelConfigDeps, reqs), reqs.network).toLowerCase() } catch { return null }
}
const channelForThisSalt = () => {
  if (KEYLESS || !accepts) return null
  const reqs = selectorFor(WANT)(accepts.x402Version, accepts.accepts)
  return reqs ? saltChannel(reqs) : null
}
const channelFiles = () => { try { return readdirSync(join(stateDir, 'client')).filter((n) => n.toLowerCase().endsWith('.json')) } catch { return [] } }
const SALT_CHANNEL = channelForThisSalt()
if (SALT_CHANNEL) {
  if (channelFiles().some((n) => n.toLowerCase() === `${SALT_CHANNEL}.json`)) channelId = SALT_CHANNEL
} else {
  const f = channelFiles()[0]
  if (f) channelId = f.replace(/\.json$/i, '')
}

if (has('--refund')) {
  const selfSend = has('--self-send')
  const left = sessions ? await sessions.leave({ dir: stateDir, transportFor: sessionRoute, forced: has('--exit'), selfSend,
    wallet: selfSend ? createWalletClient({ account, chain, transport: http(setting('RPC_URL') ?? chain.rpcUrls.default.http[0]) }) : null }) : []
  for (const a of left) {
    process.stdout.write(JSON.stringify(a, null, 2) + '\n')
    if (a.op === 'session_closed') log(`session channel ${a.channelId}: ${a.returned} returned, ${a.settled} paid to the seller${a.gas ? `; ${a.gas} of what returned paid the gas, in USDC` : ''}`)
    else if (a.op === 'session_exit_requested' && a.withdrawal) log(`session channel ${a.channelId}: close requested without the seller; the relay sends the withdrawal after ${a.readyAt ?? `the grace period (${a.graceSecs}s from the request's block)`} and takes ${a.gasMicroUSD} micro-USD of gas from what returns. Nothing more to send; --refund after that shows it closed${a.note ? `. ${a.note}` : ''}`)
    else if (a.op === 'session_exit_requested') log(`session channel ${a.channelId}: close requested without the seller; run --refund again after ${a.readyAt ?? `the grace period (${a.graceSecs}s from the request's block)`} to withdraw`)
    else if (a.op === 'session_exit_waiting' && a.withdrawal) log(`session channel ${a.channelId}: ${a.why}`)
    else if (a.op === 'session_exit_waiting') log(`session channel ${a.channelId}: the withdrawal can be sent after ${a.readyAt}; run --refund again then`)
    else log(`session channel ${a.channelId}: ${a.why}${a.op === 'session_close_failed' ? ' --refund --exit leaves without the seller: a close request through the relay, then the withdrawal after the grace period.' : ''}`)
  }
  const sessionsLeft = left.some((a) => a.op !== 'session_closed')
  if (!channelId) {
    if (!left.length) { process.stderr.write('no channel to refund — nothing has been bought with this key and salt\n'); process.exit(2) }
    process.exit(sessionsLeft ? 1 : 0)
  }
  if (!seller.refund) {
    try { learnTerms(await (await net(termsURL, { signal: AbortSignal.timeout(10_000) })).json()) } catch {}
  }
  const url = seller.refund ?? refundUrlBeside(UPSTREAM)
  log(`asking for the refund at ${url}`)
  let answer = await passRefund({ url, channelId, signer: account, payer: CARD_PAYER ? null : account, selfSend, relayUrl: setting('RELAY_URL') || undefined, maxMicroUSD: MAX_SPEND, budget, chainId, fetchFn: net, relayFetchFn: bare, log })
  if (answer.op === 'refund_signed') {
    const wallet = createWalletClient({ account, chain, transport: http(setting('RPC_URL') ?? chain.rpcUrls.default.http[0]) })
    answer = await sendSignedRefund({ answer, account, pub, wallet, storage, channelId, log }).catch((e) => ({ ...answer, sent: false, why: `${answer.why ?? ''} Could not send it from here: ${e?.shortMessage ?? e?.message}`.trim() }))
  }
  if (answer.op === 'refunded' && answer.channelState && answer.gasPaidBy !== 'you') {
    try {
      if (await rebaseChannel(storage, channelId, answer.channelState)) log(`channel rebased to ${answer.channelState.chargedCumulativeAmount} charged after the refund`)
    } catch (e) { log(`could not rebase the channel after the refund: ${e.message}`) }
  }
  process.stdout.write(JSON.stringify(answer, null, 2) + '\n')
  if (answer.op === 'refunded') {
    if (answer.returnedMicroUSD !== undefined) log(`returned ${answer.returnedMicroUSD} micro-USD, gas ${answer.gasMicroUSD ?? 0} micro-USD${answer.gasPaidBy === 'you' ? ' paid in ETH by this key' : ''}${answer.timeReturnedMs ? `, ${answer.timeReturnedMs} ms of unburned line time included` : ''}`)
    process.exit(sessionsLeft ? 1 : 0)
  }
  if (answer.code === 'nothing_to_return') {
    const left = Number(answer.leftMicroUSD ?? 0)
    log(left > 0
      ? `nothing comes back: ${left} micro-USD is left and sending it costs ${answer.gasMicroUSD ?? '?'} micro-USD of gas. --refund --self-send gets a signed refund of all of it to send at your own gas.`
      : 'nothing comes back: this channel holds nothing')
    process.exit(left > 0 || sessionsLeft ? 1 : 0)
  }
  if (answer.op === 'refund_signed') {
    log('the refund is signed and yours to send: any wallet on Base can send the transaction above')
    process.exit(1)
  }
  process.stderr.write([
    '',
    'The exit that always works needs nothing from the seller:',
    '  initiateWithdraw(config, amount)   then, after the delay, finalizeWithdraw(config)',
    'The escrow gates withdrawal to you alone, so your unspent collateral is safe either way.',
    '',
  ].join('\n'))
  process.exit(1)
}

const heard = new AsyncLocalStorage()
const asked = new AsyncLocalStorage()
const plain = untilAnswered(new Client({ name: NAME, version: VERSION }), {
  heard: (r) => { const s = heard.getStore(); if (s) s.raw = r },
  signal: () => asked.getStore() ?? null,
})
const whole = async (fn) => {
  const s = { raw: null }
  const out = await heard.run(s, fn)
  if (!s.raw || !out) return out
  return { ...s.raw, isError: out.isError ?? s.raw.isError }
}

const upstream = KEYLESS
  ? { connect: (t) => plain.connect(t), listTools: () => plain.listTools(),
      callTool: (name, args) => plain.callTool({ name, arguments: args ?? {} }) }
  : wrapMCPClientWithPayment(plain, payments, { autoPayment: true }).onAfterPayment(noteAnswer)
const callFree = (name, args) => whole(() => upstream.callTool(name, args))
const callPaid = (name, args, payload) => whole(() => upstream.callToolWithPayment(name, args, payload))
const callOnLineRaw = (name, args, credential) => plain.callTool({ name, arguments: args, _meta: { [LINE_META]: credential } })

const hearing = hearingMcp(net, (u) => { seller.refund = u; rememberRefundUrl(stateDir, u) }, learnTerms)
await upstream.connect(new StreamableHTTPClientTransport(new URL(UPSTREAM), { fetch: hearing }))
log(KEYLESS ? `catalog from ${UPSTREAM}, paying nothing` : `paying as ${account.address} -> ${UPSTREAM}`)

const learnTools = (tools) => {
  seller.tags = new Map(tools.map((t) => [t.name, t._meta?.[PRICE_META] ?? null]))
  seller.time ??= timeOf(seller.tags.get('buy_time'))
}
const tagOf = async (name) => {
  if (!seller.tags) { try { learnTools((await upstream.listTools()).tools) } catch { seller.tags = new Map() } }
  return seller.tags.get(name) ?? null
}

let paymentQueue = Promise.resolve()
const oneAtATime = (fn) => {
  const run = paymentQueue.then(fn, fn)
  paymentQueue = run.then(() => {}, () => {})
  return run
}
const payFirst = (name, args) => oneAtATime(() => payNow(name, args))

let coldStart = !channelId
if (coldStart && !KEYLESS) log('no local channel state — probing once to learn where this channel stands')

const available = async () => {
  if (!channelId) return null
  try {
    const c = await storage.get(channelId)
    if (!c?.balance || c.chargedCumulativeAmount === undefined) return null
    return Number(BigInt(c.balance) - BigInt(c.chargedCumulativeAmount))
  } catch { return null }
}

const deposited = async () => {
  if (!channelId) return 0n
  try { return BigInt((await storage.get(channelId))?.balance ?? 0) } catch { return 0n }
}

const needsTopUp = async (terms) => {
  if (!terms?.accepts?.length) return false
  const left = await available()
  if (left === null) return false
  const asset = String(chosenAccept?.asset ?? '').toLowerCase()
  const row = terms.accepts.find(r => String(r.asset ?? '').toLowerCase() === asset) ?? terms.accepts[0]
  return BigInt(left) < BigInt(row.amount ?? 0)
}

const payNow = async (name, args) => {
  if (KEYLESS) return callFree(name, args)
  if (coldStart) {
    coldStart = false
    const out = await callFree(name, args)
    if (codeOf(out) !== 'funding_requires_open_fee' || !learnFloor(floor, bodyOf(out))) return out
    log(`the seller's deposit floor is ${floor.micro} micro-USD: depositing that`)
    return callFree(name, args)
  }
  const buying = name === 'buy_time'
  if (buying && !seller.time) await tagOf('buy_time')
  const buyMicro = buying ? askedMicro(seller.time, args, Number(tickAccepts?.accepts?.[0]?.amount)) : null
  let terms = buying ? timeTerms(tickAccepts, buyMicro) : accepts
  let funding = !buying
  if (buying && await needsTopUp(terms)) {
    log('the collateral is below this purchase: it carries a deposit on the funding row')
    terms = timeTerms(accepts, buyMicro)
    funding = true
  }
  if (!terms) return callFree(name, args)
  for (const attempt of [1, 2]) {
    try {
      const payload = await payments.createPaymentPayload(terms)
      const out = await callPaid(name, args, payload)
      const code = codeOf(out)
      if (code === 'funding_requires_open_fee') {
        const raised = learnFloor(floor, bodyOf(out))
        if (raised || !funding) {
          log(raised ? `the seller's deposit floor is ${floor.micro} micro-USD: depositing that` : 'the seller wants this deposit on the funding row')
          if (buying) terms = timeTerms(accepts, buyMicro)
          funding = true
          continue
        }
      }
      if (explainPermit2(out)) return out
      if (paymentRefused(out)) {
        log('payment refused as stale — dropping the local channel record and resyncing')
        if (channelId) { try { await watchedStorage.delete(channelId) } catch {} }
        return callFree(name, args)
      }
      return out
    } catch (e) {
      if (asked.getStore()?.aborted || capBlocked) throw e
      if (attempt === 2) { log(`pay-first failed twice (${e.message}); paying on the seller's 402`); return callFree(name, args) }
      try { await loadTerms() } catch {}
    }
  }
}

const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
let approvalToldFor = null
const explainPermit2 = (out) => {
  if (!/permit2_allowance_required/.test(String(codeOf(out) ?? ''))) return false
  const token = chosenAccept?.asset
  if (!token || approvalToldFor === token) return true
  approvalToldFor = token
  const per = Number(chosenAccept?.amount ?? 0)
  const suggested = per > 0 ? BigInt(Math.ceil(per * depositPolicy.depositMultiplier * 4)) : 0n
  log(`${token} moves through Permit2 and your wallet has not approved it.`)
  log(`  send once, from your wallet:  approve(${PERMIT2}, ${suggested || '<amount>'})  on ${token}`)
  return true
}

if (!KEYLESS) log(`channel state in ${stateDir}`)

const LINE_MODE = (setting('LINE') ?? 'auto').toLowerCase()
const AUTO_FAST_RUN = Number(setting('AUTO_FAST_RUN') ?? 2)
const AUTO_GAP_MS = Number(setting('AUTO_GAP_MS') ?? 10_000)
const AHEAD_MS = Number(setting('LINE_AHEAD_MS') ?? 2000)
const IDLE_MS = Number(setting('LINE_IDLE_MS') ?? 1000)

const line = { credential: null, channel: null, msRemaining: 0, readAt: 0, metering: false, opening: null, offTimer: null, buys: 0, riding: 0, calls: 0, keeper: null, slowestBuyMs: 0, slowestDepositMs: 0, depositNext: false, capped: false, release: null }
const meterReads = (ms) => { line.msRemaining = Number(ms); line.readAt = Date.now() }
const margin = () => marginFor(AHEAD_MS, slowestFor({ plainMs: line.slowestBuyMs, depositMs: line.slowestDepositMs, depositNext: line.depositNext }))
const rate = { lastCallAt: 0, run: 0 }
const lineUrl = () => seller.lineUrl ?? lineUrlBeside(UPSTREAM)

const callsKeepComing = () => {
  const now = Date.now()
  const gap = rate.lastCallAt ? now - rate.lastCallAt : Infinity
  rate.lastCallAt = now
  rate.run = gap <= AUTO_GAP_MS ? rate.run + 1 : 1
  return rate.run >= AUTO_FAST_RUN
}

const dropLine = (why) => {
  if (line.offTimer) { clearTimeout(line.offTimer); line.offTimer = null }
  const credential = line.credential
  if (credential) log(`line let go (${why})`)
  line.credential = null
  line.channel = null
  line.metering = false
  return credential
}

let closing = Promise.resolve()
const letGo = (why, { leaving = false } = {}) => {
  if (line.riding > 0 && !leaving) { line.release = why; return closing }
  line.release = null
  const credential = dropLine(why)
  if (!credential) return closing
  closing = closing.then(async () => {
    await lineOp({ url: lineUrl(), op: 'off', credential, fetchFn: net }).catch(() => {})
    await lineOp({ url: lineUrl(), op: 'close', credential, fetchFn: net }).catch(() => {})
  })
  return closing
}

const touch = () => {
  if (line.offTimer) clearTimeout(line.offTimer)
  line.offTimer = null
  if (line.riding > 0) return
  line.offTimer = setTimeout(() => {
    line.offTimer = null
    if (!line.credential || !line.metering || line.riding > 0) return
    line.metering = false
    lineOp({ url: lineUrl(), op: 'off', credential: line.credential, fetchFn: net })
      .then((a) => { if (a.op === 'off') log(`meter off after ${IDLE_MS} ms idle; ${a.msRemaining ?? line.msRemaining} ms held`) })
      .catch(() => {})
  }, IDLE_MS)
  line.offTimer.unref?.()
}

const holdLine = () => {
  if (line.credential) return Promise.resolve(true)
  if (line.opening) return line.opening
  if (!channelId || KEYLESS) return Promise.resolve(false)
  line.opening = (async () => {
    const o = await openLine({ url: lineUrl(), channelId, signer: account, fetchFn: net })
    if (o.op !== 'opened') { log(`line not opened: ${o.code}${o.why ? ` (${o.why})` : ''}`); return false }
    line.credential = o.credential
    line.channel = String(channelId).toLowerCase()
    line.metering = o.metering !== false
    meterReads(o.msRemaining ?? 0)
    log(`line open at ${lineUrl()}: ${line.msRemaining} ms on the meter`)
    return true
  })().finally(() => { line.opening = null })
  return line.opening
}

const meterOn = async () => {
  if (line.metering) return true
  const a = await lineOp({ url: lineUrl(), op: 'on', credential: line.credential, fetchFn: net })
  if (a.op === 'on') { line.metering = true; meterReads(a.msRemaining ?? line.msRemaining); return true }
  if (LINE_GONE.has(a.code)) dropLine(a.code)
  return false
}

const buyTime = async (wantMs, enough = () => false) => {
  if (!seller.time) await tagOf('buy_time')
  if (!seller.time) return false
  if (line.credential && line.channel && channelId && line.channel !== String(channelId).toLowerCase()) {
    log(`the line rides ${line.channel} but a purchase would go to ${String(channelId).toLowerCase()}: not buying time against a channel the line does not ride. Keep PASS_STATE_DIR and PASS_SALT steady between runs, or run --refund.`)
    return false
  }
  const buy = buyFor({ wantMs, time: seller.time, availableMicro: await available(), depositMultiplier: depositPolicy.depositMultiplier })
  let took = 0
  let carried = false
  let skipped = false
  const out = await asked.run(null, () => oneAtATime(async () => {
    if (enough()) { skipped = true; return null }
    const held = await deposited()
    const from = Date.now()
    try {
      const o = await payNow('buy_time', buy.args)
      const r = bodyOf(o)
      if (!o?.isError && Number.isFinite(Number(r?.msRemaining))) meterReads(r.msRemaining)
      return o
    } finally { took = Date.now() - from; carried = (await deposited()) > held }
  }))
  if (skipped) return true
  const b = bodyOf(out)
  if (out?.isError || !b) { log(`buy_time: ${codeOf(out) ?? reasonFrom(out) ?? 'no answer'}`); return false }
  line.buys += 1
  if (carried) line.slowestDepositMs = Math.max(line.slowestDepositMs, took)
  else line.slowestBuyMs = Math.max(line.slowestBuyMs, took)
  const covered = await available()
  line.depositNext = covered !== null && covered < buyFor({ wantMs: 0, time: seller.time }).micro
  log(`bought ${b.boughtMs ?? buy.ms} ms of line time for ${buy.micro} micro-USD; ${line.msRemaining} ms on the meter`)
  return true
}

const ride = async (name, args, needMs = 0) => {
  line.riding += 1
  touch()
  try {
    return await rideLine(name, args, needMs)
  } finally {
    line.riding -= 1
    touch()
    if (line.riding === 0 && line.release !== null) { const why = line.release; line.release = null; letGo(why).catch(() => {}) }
  }
}

const topUp = async (wantMs, have) => {
  if (!seller.time) await tagOf('buy_time')
  if (!seller.time) return false
  const room = roomMicro()
  const fits = Number.isFinite(room) ? Math.floor(room / seller.time.rateMicro) * seller.time.rateMs : wantMs
  if (capReached || buyFor({ wantMs: 0, time: seller.time }).micro > room) {
    line.capped = true
    log(`PASS_MAX_SPEND is ${MAX_SPEND} and ${spentMicroUSD + fetchSpent} is spent: no more line time is bought; the call runs on the ${Math.round(have)} ms left`)
    return null
  }
  const blocked = capBlocked
  let why = null
  const ok = await buyTime(Math.min(wantMs, fits), () => lineLeft() > margin()).catch((e) => { why = e?.message ?? String(e); return false })
  if (capBlocked && !blocked) { capBlocked = blocked; line.capped = true; return null }
  if (!ok) log(`could not buy more line time while a call runs${why ? ` (${why})` : ''}: it keeps running on the ${Math.round(Math.max(0, lineLeft()))} ms left`)
  return ok
}

const lineLeft = () => line.msRemaining - (line.calls > 0 ? Date.now() - line.readAt : 0)

const keeping = () => {
  if (line.calls++ === 0) {
    line.readAt = Date.now()
    line.keeper = keepAhead({ margin, left: lineLeft, buy: topUp })
  }
  return () => {
    if (--line.calls > 0) return
    line.keeper.stop()
    line.keeper = null
  }
}

const rideLine = async (name, args, needMs = 0) => {
  let out = null
  let want = Math.max(2 * margin(), Math.ceil(needMs * 1.25))
  let need = needMs > 0 ? want : MIN_BUY_MS
  for (let attempt = 0; attempt < 4; attempt++) {
    if (capReached) break
    if (!(await holdLine())) return null
    if (!(await meterOn())) { if (!line.credential) continue; return null }
    const fill = line.msRemaining < need ? want : need
    for (let buys = 0; line.msRemaining < fill && buys < 3; buys++) {
      const had = line.msRemaining
      if (!(await buyTime(Math.max(MIN_BUY_MS, want - had), () => line.msRemaining >= fill))) { if (had >= MIN_BUY_MS) break; return null }
      if (line.msRemaining <= had) break
    }
    const kept = keeping()
    try { out = await callOnLineRaw(name, args, line.credential) } finally { kept() }
    const m = meterOf(out)
    if (m && Number.isFinite(Number(m.msRemaining))) meterReads(m.msRemaining)
    const code = codeOf(out)
    const cut = code ? null : bodyOf(out)
    if (code === 'out_of_time' || cut?.error === 'out_of_time') {
      const endedAt = Date.now()
      await oneAtATime(() => {})
      if (code && line.readAt <= endedAt) meterReads(bodyOf(out)?.msRemaining ?? 0)
      if (line.capped || capReached) {
        log(`${name} ended when its line ran out of time: PASS_MAX_SPEND stopped the Pass client buying more`)
        return capAnswer(`${name} ran until its line ran out of time and ended there unanswered: buying more time would go over the PASS_MAX_SPEND ceiling, so no more was bought. Raise it, set PASS_MAX_SPEND=0 to remove it, or restart the Pass client.`)
      }
    }
    if (cut?.error === 'out_of_time' && Number(cut.needsMs) > 0 && attempt < 3) {
      const ran = Number(m?.elapsedMs)
      want = Math.ceil(((Number.isFinite(ran) && ran > 0 ? ran : want) + Number(cut.needsMs)) * 1.5)
      need = want
      log(`${name} was cut with about ${cut.needsMs} ms still to run; buying up to ${want} ms and calling it again`)
      continue
    }
    if (code === 'meter_off') { line.metering = false; continue }
    if (code === 'out_of_time') {
      want *= 2
      log(`the line ran out of time on ${name}; buying ${want} ms and calling again`)
      continue
    }
    if (code && LINE_GONE.has(code)) { dropLine(code); continue }
    return out
  }
  return out
}

const reasonFrom = (out) => {
  const body = bodyOf(out)
  const why = body?.why ?? body?.message ?? body?.error ?? body?.code
  return typeof why === 'string' && why ? why.slice(0, 160) : null
}

const capAnswer = (message = 'This payment would go over the PASS_MAX_SPEND ceiling, so it was not made. ' +
  'Raise it, set PASS_MAX_SPEND=0 to remove it, or restart the Pass client.', more = {}) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({
  error: 'x402_bridge_spend_cap_reached',
  spentMicroUSD: spentMicroUSD + fetchSpent, capMicroUSD: MAX_SPEND,
  message, ...more }) }] })

const UPSTREAM_HOST = new URL(UPSTREAM).host
const fetchState = (url) => {
  if (url.host === UPSTREAM_HOST) return { dir: stateDir, storage, serial: oneAtATime, refund: '--refund' }
  const dir = setting('STATE_DIR') ? join(stateDir, 'hosts', url.host, account.address.toLowerCase()) : join(homedir(), '.x402-mcp-bridge', url.host, account.address.toLowerCase())
  return { dir, refund: `PASS_MCP_URL=${url.origin}${setting('STATE_DIR') ? ` PASS_STATE_DIR=${dir}` : ''} with --refund` }
}
const fetchTool = KEYLESS || cardSigner ? null : makeFetchTool({ signer: account, pub, network: NETWORK, grant: GRANT, seller: UPSTREAM, log, budget, stateFor: fetchState, depositMultiplier: depositPolicy.depositMultiplier, salt: setting('SALT') ? saltOf(setting('SALT')) : null, asset: WANT, sessions })

const sessionTools = new Map()
const bySession = (name, args, timed = false) => {
  if (!sessions || SESSION_MODE === 'off' || !sessions.trust.any || sessionTools.get(name) === 'none') return undefined
  return oneAtATime(async () => {
    if (SESSION_MODE !== 'on' && !sessions.holds(stateDir) && (await available()) > 0) return undefined
    const route = mcpTransport({ callTool: (p) => plain.callTool(p), name, args, network: NETWORK })
    let known = sessionTools.get(name)
    if (!known || Date.parse(known.offer.challenge.expires ?? '') - Date.now() < 30_000) {
      const first = await route.probe()
      if (!first.challenges.length && !Array.isArray(first.body?.accepts)) {
        if (!timed || !first.out?.isError) return first.out
        sessionTools.set(name, 'none')
        return undefined
      }
      const offers = sessions.usable(first.offers).sort((a, b) => (a.amount < b.amount ? -1 : 1))
      if (!offers.length) { sessionTools.set(name, 'none'); return undefined }
      known = { offer: offers[0], terms: first.body }
      sessionTools.set(name, known)
    }
    const { answer, error, message, ...facts } = await sessions.pay({ dir: stateDir, origin: new URL(UPSTREAM).origin, offer: known.offer, terms: known.terms, resource: { transport: 'mcp', url: UPSTREAM, tool: name }, send: route.send, signal: asked.getStore() ?? null })
    if (!error) return answer.out
    sessionTools.delete(name)
    if (error === 'x402_bridge_spend_cap_reached') {
      log(`PASS_MAX_SPEND is ${MAX_SPEND} and ${spentMicroUSD + fetchSpent} is spent: ${name} was not paid for`)
      return capAnswer(message)
    }
    log(`session: ${name} was not paid (${error}): ${message}`)
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error, message, ...facts }) }] }
  })
}

const callTool = async (name, args) => {
  capBlocked = false
  capWhy = null
  let out
  try {
    out = await callWithin(name, args)
  } catch (e) {
    if (!capBlocked) throw e
  }
  if (!capBlocked) return out
  log(`PASS_MAX_SPEND is ${MAX_SPEND} and ${spentMicroUSD + fetchSpent} is spent: ${name} was not paid for`)
  return capWhy ? capAnswer(`${capWhy.message} Raise PASS_MAX_SPEND, set it to 0 to remove it, or restart the Pass client.`, capWhy.needed ? { needed: capWhy.needed } : {}) : capAnswer()
}

const callWithin = async (name, args) => {
  if (isFetchTool(name) && fetchTool) return fetchTool(args, { signal: asked.getStore() ?? undefined })
  if (capReached) return capAnswer()
  if (KEYLESS) return callFree(name, args)
  if (name === 'buy_time') {
    const out = await payFirst(name, args)
    const b = bodyOf(out)
    if (!out?.isError && Number.isFinite(Number(b?.msRemaining))) meterReads(b.msRemaining)
    return out
  }
  const tag = await tagOf(name)
  const timed = isTimeTag(tag)
  const fast = timed && LINE_MODE !== 'off' ? callsKeepComing() : false
  const riding = timed && LINE_MODE !== 'off' && (LINE_MODE === 'on' || Boolean(line.credential && line.msRemaining > 0))
  if (!riding) {
    const out = await bySession(name, args, timed)
    if (out !== undefined) return out
  }
  if (!timed || LINE_MODE === 'off') return payFirst(name, args)
  const worth = riding || fast
  if (worth && !channelId && LINE_MODE === 'on') {
    log(`${name} is sold by time: buying time first, so this call rides a line`)
    await buyTime(AHEAD_MS)
  }
  if (worth && channelId) {
    const out = await ride(name, args)
    if (out) return out
  }
  const out = await payFirst(name, args)
  const code = codeOf(out)
  if ((code === 'out_of_time' || code === 'line_required') && channelId) {
    log(code === 'out_of_time' ? `${name} needs more than one block: calling it on a line` : 'the seller serves this channel on a line')
    const again = await ride(name, args, Number(bodyOf(out)?.needsMs) || 0)
    if (again) return again
  }
  return out
}

const told = typeof plain.getInstructions === 'function' ? plain.getInstructions() : null
const CLIENT_NOTE = KEYLESS
  ? 'You are connected through the ZEAM :: Pass client with no wallet key: the free tools work, and a paid call returns the seller\'s terms.'
  : 'You are connected through the ZEAM :: Pass client. It pays for paid tools from the wallet it was started with, and buys line time when a tool needs longer: do not call buy_time or line yourself. To take back what is unspent, the person runs the Pass client once with --refund. No payment steps are needed from you; the seller\'s payment instructions below are for clients that connect without it.'
const server = new Server({ name: NAME, title: 'ZEAM :: Pass client', version: VERSION }, { capabilities: { tools: {} }, instructions: told ? `${CLIENT_NOTE}\n\n${told}` : CLIENT_NOTE })
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const { tools } = await upstream.listTools()
  learnTools(tools)
  return { tools: fetchTool && !tools.some((t) => t.name === FETCH_TOOL.name) ? [...tools, FETCH_TOOL] : tools }
})
server.setRequestHandler(CallToolRequestSchema, (req, extra) => asked.run(extra?.signal ?? null, () => callTool(req.params.name, req.params.arguments ?? {})))

let leaving = false
const stopPaying = async (why) => {
  if (leaving) return
  leaving = true
  await Promise.race([letGo(why, { leaving: true }), new Promise((r) => setTimeout(r, 3000))])
  process.exit(0)
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stopPaying('shutting down'))
for (const ev of ['end', 'close']) {
  process.stdin.on(ev, () => stopPaying('stdin closed — whatever started us is gone'))
}
process.on('disconnect', () => stopPaying('parent disconnected'))

const finish = async (code) => {
  leaving = true
  await Promise.race([oneAtATime(() => letGo('one-shot call finished', { leaving: true })), new Promise((r) => setTimeout(r, 3000))])
  process.exit(code)
}

if (has('--tools')) {
  const out = await upstream.listTools()
  process.stdout.write(JSON.stringify(out.tools.map(t => t.name), null, 2) + '\n')
  await finish(0)
}

if (has('--call')) {
  const tool = flag('--call')
  if (!tool) { process.stderr.write('--call needs a tool name\n'); process.exit(2) }
  const rawArgs = argv[argv.indexOf('--call') + 2]
  let args = {}
  if (rawArgs && !rawArgs.startsWith('--')) {
    try { args = JSON.parse(rawArgs) }
    catch (e) { process.stderr.write(`--call arguments must be JSON: ${e.message}\n`); process.exit(2) }
  }
  const times = Math.max(1, Math.trunc(Number(flag('--times') ?? 1)) || 1)
  let failed = false
  for (let i = 0; i < times; i++) {
    try {
      const out = await callTool(tool, args)
      const text = out?.content?.[0]?.text
      process.stdout.write((typeof text === 'string' ? text : JSON.stringify(out)) + '\n')
      if (out?.isError) failed = true
      if (KEYLESS && out?.isError && Array.isArray(bodyOf(out)?.accepts)) log(`no key: ${tool} is a paid tool and was not paid for; the seller's terms are on stdout. Set PASS_PRIVATE_KEY to pay.`)
    } catch (e) {
      process.stderr.write(`call failed: ${e.message}\n`)
      failed = true
    }
  }
  await finish(failed ? 1 : 0)
}

await server.connect(new StdioServerTransport())
if (LINE_MODE === 'on' && channelId) await holdLine()
log(`up on stdio — line mode ${LINE_MODE}${channelId ? '' : ' (channel opens on your first call)'}` +
  ` | spend cap ${MAX_SPEND ? MAX_SPEND + ' ' + spendUnit : 'NONE (PASS_MAX_SPEND=0)'}` +
  ' | stops when stdin closes')
