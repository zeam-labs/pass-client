# @zeampass/client

`@zeampass/client`, version 4.1.1. Source: https://github.com/zeam-labs/pass-client

The buyer side of ZEAM :: Pass, for an agent that carries its own wallet: it stands in front of a paid MCP server or URL and pays
from that wallet. To fund an agent without installing anything, give it a pass, a funded link:
https://zeampass.com/

ZEAM :: Pass is the buyer side: a pass, or this client. Over MCP the client pays x402: per call, or it buys time and
rides a line on a ZEAM :: Bridge seller. Over HTTP, `paid_fetch` pays a URL's 402 as an x402 `exact` payment, as an
MPP charge, or from an x402 `batch-settlement` channel. It works with ZEAM :: Prism, with any ZEAM :: Bridge seller over MCP and over HTTP, with any x402 seller and, over HTTP, with a URL that takes an MPP `evm` charge.
With a session escrow pinned in `PASS_SESSION_ESCROW` it also pays by MPP `session`, over MCP and over HTTP: see
*Paying by session*.

## Run it

`--help` and `--version` print and exit; neither contacts a server.

It needs Node.js 20 or later. Export your key as `PASS_PRIVATE_KEY`. It signs locally and is never sent.

    npx -y @zeampass/client --tools
    npx -y @zeampass/client --call call_rpc \
      '{"chain":"base","method":"eth_blockNumber","params":[]}'
    PASS_MCP_URL=https://seller.example/agents/mcp \
      npx -y @zeampass/client --call add '{"a":1,"b":2}'

`--times N` repeats a `--call` in one process. With no arguments the client is an MCP stdio server:

```json
{
  "mcpServers": {
    "prism": {
      "command": "npx",
      "args": ["-y", "@zeampass/client@4.1.1"],
      "env": { "PASS_PRIVATE_KEY": "0x..." }
    }
  }
}
```

Without a key it serves `tools/list` and the free tools; a paid call returns the seller's terms. `--tools` and
`--call` do the same: a free tool runs, and a paid one prints the seller's terms and exits 1. `--refund` and
`paid_fetch` need the key. A key that is set and malformed is reported as that, and `--call` stops.

The seller's instructions reach your MCP client, under a note that the client is paying.

Results pass through whole: `content`, `structuredContent`, `isError` and `_meta`.

## Paying per call

1. The client reads the terms once from the seller's `/.well-known/x402` (Prism publishes it) and pays from them.
   A seller that publishes none, as a ZEAM :: Bridge seller does not, is asked each time: before every paid call and
   every `buy_time` purchase the client sends the call unpaid and pays from the 402 that answers it. A run with
   `PASS_LINE=on` that does not yet know which channel this key and `PASS_SALT` pay this seller asks once before its
   first purchase: a first run, a run whose state directory holds only other channels, and a run whose recorded
   channel the seller answers `unknown_channel`. That one ask is the unpaid `buy_time` that learns the channel, after
   which the client asks for a line on it (a channel the seller does not know yet answers `unknown_channel`)
   and, when it must buy time, pays from that same 402.
2. The first paid call deposits into a batch-settlement channel: price × `PASS_DEPOSIT_MULTIPLIER` (default 40,
   minimum 3), raised to the seller's floor (the 402's `deposit` line, or `neededMicroUSD`), and no more than
   `PASS_MAX_SPEND` leaves room for. On Prism: 250 µUSD × 40 = $0.01.
3. Later calls sign vouchers against that deposit, with no gas. With the seller's `/.well-known/x402` terms no round
   trip asks the price; without them each paid call is the unpaid call and then the paid one.

The deposit sits in x402's batch-settlement escrow `0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003`, hardcoded in
`@x402/evm`. No owner, no pause, no upgrade. Only your key can withdraw it.

## Line time

A ZEAM :: Bridge seller that sells time lists `buy_time` and `line`, and tags its time tools `{"per":"time"}`. Prism:
1 µUSD per ms. A paid call without a line costs $0.00025 and runs at most 250 ms. On a line a call costs the
milliseconds it runs; calls at once burn once.

1. **Buy.** `buy_time {"ms": N}` pays for N milliseconds from the channel. Before a call the client fills an empty
   line to `PASS_LINE_AHEAD_MS` (default 2000 ms): no more per purchase than the channel's collateral covers, never
   less than 250 ms. A seller on an older version of the plugin that sells time in blocks is asked for blocks.
2. **Open.** `POST <base>/line {"op":"open","channelId"}` returns a message. The client signs it (EIP-191) with the
   payer key and posts `{"op":"prove","channelId","nonce","signature"}`; the answer carries the credential.
   A line opened on a channel with no other line open switches the channel's meter on. A line opened while another
   line is open on the channel leaves the meter as it is: if an agent switched it off, the answer's `metering` is
   `false`, and the client sends `{"op":"on"}` before it rides.
3. **Ride.** Each time-tool call carries the credential in `_meta["zeam-pass/line"]`; no payment per call. The answer's
   `_meta["zeam-pass/meter"]` states `msRemaining`. A call runs until the seller answers or the MCP client that asked
   cancels it, which the client passes on to the seller and which stops its purchases. A hang-up ends the call
   and its bill on a Node seller and on a Python seller served over ASGI; a WordPress seller, and a Python seller
   served over WSGI, cannot see one, and the call burns until it returns. Cancel a call before you hang up.
4. **Stay ahead.** While a call runs the line burns 1 ms per ms and the seller keeps the call going as long as the
   line holds time. When half of `PASS_LINE_AHEAD_MS` is left (or twice the slowest purchase so far, if longer; one
   that carried a deposit counts only while the next will carry one) the client buys again: as much as the call has
   run so far, at least twice that threshold (`PASS_LINE_AHEAD_MS`, or four times the slowest purchase, so a slow
   purchase still lands with time in hand): no more per purchase than the channel's collateral covers or
   `PASS_MAX_SPEND` leaves room for, never less than 250 ms. It buys only while a call runs: a purchase whose turn
   comes after the last call has ended is not made, and one whose price is answered after that is not signed. One
   already signed when the call ends is completed, and its time stays on the line until a refund returns it. The call
   is not run again. At `PASS_MAX_SPEND` it stops
   buying; the call ends when the line runs out and the answer is `x402_bridge_spend_cap_reached`. A purchase that
   fails is said and tried again; the call runs on what is left.
5. **Meter.** After `PASS_LINE_IDLE_MS` (default 1000) with no call the client sends `{"op":"off"}`; the next call
   sends `{"op":"on"}`. The meter is the channel's, not the line's: this `off`, and the `off` on exit, switch it off for
   every line open on that channel, and another agent riding the same channel must send `on` again. `close` ends only
   the client's own line; it leaves the meter and every other line as they are.
   `meter_off` is switched on and called again; `line_unknown` opens a new line; `out_of_time`,
   which now means a purchase failed or came late, buys twice the time and calls again.
6. **Exit.** Every exit takes one path: the end of `--call` or `--tools`, an error, stdin closing, SIGINT or SIGTERM.
   The client signs nothing new, waits up to `PASS_EXIT_WAIT_MS` (default 30000) for every purchase still in
   flight, deposit or voucher, and records each answer in `PASS_STATE_DIR`; then it sends `off`, then `close`. A
   purchase still unanswered at that bound is said, and the line is let go without its answer. Unburned time comes
   back with a refund.

`PASS_LINE`:

- `auto` (default): per call until 2 time-tool calls arrive within 10 s
  (`PASS_AUTO_FAST_RUN`, `PASS_AUTO_GAP_MS`), then a line while it holds time.
  A call cut for running past what one call buys (`out_of_time`) is called again on a line.
  When the seller says how much more the call needs (`needsMs`), the client runs the whole call again, so it buys
  what the call already ran (the time one call buys) plus `needsMs`, plus a quarter, and never less than
  `PASS_LINE_AHEAD_MS`, before it calls again. A call already on a line that is cut with `needsMs` is called
  again on what it ran plus `needsMs`, plus half; no purchase is under 250 ms. It calls a cut call again at most three
  times on a line; a call still cut after that answers with the seller's cut: what the call got done, and `needsMs` for
  what is left. Where the seller's cut says how to continue, continue from that answer, and continue a continuation that
  is cut again the same way, from its own answer: the wallet-audits scans say to call again with `to_block` one below
  `scanned.from`, and each cut's `needsMs` is for what is left below its own `scanned.from`, so a continuation cut
  again is called with `to_block` one below the new `scanned.from`, and needs the new `needsMs`.
- `on`: every time-tool call rides a line.
- `off`: per call only.

Tools priced per call never ride a line.

## Refunds

    npx -y @zeampass/client --refund

1. The client posts `{channelId, issued, signature}` to the refund route the seller names (its 402 or
   `/.well-known/x402`), else `<base>/refund`. The channel is the one this key and `PASS_SALT` pay: the one the
   seller's `/.well-known/x402` fixes, or, against a seller that publishes none, the one a run from this
   `PASS_STATE_DIR` last paid into with them. The seller is the one in `PASS_MCP_URL`, by its origin: a state
   directory shared by several sellers keeps each one's refund route and channel apart, and `--refund` asks only
   that seller, for its own channel. When no run from this `PASS_STATE_DIR` recorded that channel (a state directory
   from 4.0.0 or earlier, or a lost one), the client works it out from this key, `PASS_SALT` and the seller's
   terms (against a seller that publishes none, it calls one paid tool unpaid, `buy_time` where there is one, to read
   its 402), and asks for it when it holds something the payer can withdraw: the escrow's balance for it, less what
   the seller has claimed or is owed (the larger of the escrow's `totalClaimed` and the amount charged that this
   state directory records), as the seller judges a refund; it then records it. When that channel holds nothing the
   payer can withdraw, `--refund` says so, with its balance and what the seller has claimed or is owed, asks nobody
   and exits 2. A channel recorded at another
   seller, or paid with another key or `PASS_SALT`, is never asked for; when none is this seller's, `--refund` says so
   and asks nobody. `--refund --channel <id>` asks this seller for that channel by name: the seller refunds it only
   to a proof signed by the channel's payer, and a channel whose voucher in the state directory another key signed is
   not asked for. The key signs:

        ZEAM Pass refund
        channel: <channel id, lowercase>
        issued: <ISO time>

2. Our relay pays the gas of a refund when our fee on what the buyer spent covers the gas of the deposit, of the
   refund and of settling any calls not yet settled, and of every further deposit and every earlier refund it paid for
   on that channel, with a 15% margin; otherwise the buyer pays the refund's gas, with a 15% margin, in USDC, quoted
   before the buyer signs that payment. Our fee is the fee share the seller's `refund` terms name: 9.99% for most
   sellers, 100% at Prism. The seller counts the gas at the current gas and ETH price: free when
   `feeMicroUSD >= coverMicroUSD`. Then the seller sends the balance and the unburned time: `returnedMicroUSD`,
   `timeReturnedMs`, `gasMicroUSD: 0`.
3. When they do not, the seller answers 409 `refund_quote` with `feeMicroUSD`, `coverMicroUSD` and `gasMicroUSD`: this
   refund's gas, as the relay estimates it now, plus 15%. The client signs a gasless USDC payment of it and posts
   again; one transaction returns the rest. If the gas has risen past the payment by the time the relay sends,
   nothing is sent and the answer is `refund_quote` with `requoted: true` and the new figure: run `--refund` again.
4. When the gas is more than what is left: `nothing_to_return` with the numbers.

`--refund --self-send` asks for a signed refund of all of it and sends it from your key, at your gas, if the key holds
ETH on Base. Otherwise it prints the transaction for any wallet to send.

No answer from the seller: `initiateWithdraw`, then `finalizeWithdraw` after the channel's `withdrawDelay`.

`--refund` also closes the MPP session channels opened at that seller: see *Paying by session*.

## Paying by session

An MPP `session` (`draft-evm-session-00`, method `evm`) is a payment channel in an escrow contract: one deposit, then
one signed voucher per call for the running total, and what is not spent comes back when the channel closes. The
seller's relay sends the deposit from an EIP-3009 authorization the key signs, so the key needs USDC and no ETH.

It is off until you pin an escrow. No escrow is built in. ZEAM's session contracts are the escrow `EvmPaymentChannel`
at `0x5e09aD70b644414cD1cD7Df1d9a10fF7899D92B8` on Base and its payee factory at
`0xE18fCE1266056becA4a3B0edfc15F8634EA6901B`: both deployed on 2026-10-13, immutable, and not audited.

- `PASS_SESSION_ESCROW`: the escrow, or escrows, the client may pay into. A session into any other escrow is not
  paid.
- `PASS_SESSION_FACTORY`: that escrow's payee factory. With it, before the deposit, the client checks that the
  payee in the challenge is the factory's address for the seller's signer and split (`receiverAuthorizer` and `payTo`
  in the seller's 402) and signs nothing when it is not. Without it, or when the 402 names neither, the client
  says the payee could not be checked, and pays.
- `PASS_SESSION` (default `auto`): `auto` pays by session when the seller offers one into a pinned escrow: after an
  x402 `exact` quote, before an MPP charge and before a new `batch-settlement` channel. A `batch-settlement` channel
  that still holds money is spent first; an open session channel is used before either. `on` pays by session first
  whenever one is offered. `off` never does.

Over MCP, with an escrow pinned, a tool priced per call is asked without payment for its session challenge: once
when it offers none, and again each time the challenge is about to expire when it does. The answer of a free tool is
returned as it is. A tool sold by time is paid the same way when it does not ride a line: with `PASS_LINE=off`, and
with `auto` until a line holds time. A session channel opened over HTTP pays the MCP calls to the same seller.

What it signs, over MCP and in `paid_fetch` alike:

- The deposit is price × `PASS_DEPOSIT_MULTIPLIER`, at least the seller's `suggestedDeposit`. When the next call would
  pass the deposit, a top-up of the same size is signed first.
- A voucher is for what the seller's receipts show spent plus the price of the call, and never for more than the
  deposit. A receipt that claims more than the key has signed is refused, and nothing more is signed on that channel.
- The deposit and every top-up count toward `PASS_MAX_SPEND` when they are signed, and one that would pass it is not
  signed. A call paid out of a deposit this run signed is not counted again; a call paid out of an earlier run's
  deposit is. In `paid_fetch`, `maxAmount` refuses a deposit or top-up above it, as it refuses a price.
- One channel per seller, payee, token and escrow. Its record is `<state directory>/session/<channel id>.json`; it
  holds amounts and addresses, and the signed payments the client may have to send again rather than sign a
  second one: a deposit or top-up until the escrow shows it, the gas payment of a close, and, after `--refund --exit`,
  the withdrawal and gas payment the relay holds. Each pays only the addresses it names (the escrow, the relay's gas
  wallet, the key), so the file cannot send money anywhere else, but anyone who reads it can send them while they are
  valid: keep the state directory private. A new run resumes the channel after checking the record against the
  escrow. When a seller later names another escrow or payee, nothing is signed and the open channel stays where it
  is until you close it.

Leaving:

- `--refund` asks the seller to close the channel: the seller is paid what was spent and the rest returns to the key
  in the same transaction. When the channel's fees do not cover that transaction's gas plus 15%, the seller quotes it and the
  client pays it in USDC out of what returns, under the checks in Limits. The key needs no ETH.
- `--refund --exit` leaves without the seller and without ETH, through the relay: a close request signed by the key,
  and, run again after the escrow's grace period (15 minutes in ZEAM's escrow), a signed withdrawal of everything the seller has not
  settled. These two signed calls are ZEAM's addition to the draft's escrow. The relay sends them free when the fees
  on what the channel has settled cover their gas plus 15%. When they do not, the client asks the relay its price and
  signs the withdrawal and a USDC payment of that price along with the request; the relay sends the request, holds
  the rest and sends it after the grace period. The gas comes out of what returns, the key needs no ETH, and there is
  nothing to run again: a later `--refund` shows the channel closed. The relay needs the seller's split, which a ZEAM :: Bridge seller
  publishes beside its session challenge and the client keeps in the channel's record; for a seller that
  publishes none, give it as `PASS_SESSION_SPLIT`, `{"split":{"recipients":[…],"allocations":[…],"totalAllocation":"…","distributionIncentive":0},"salt":"0x…"}`.
  The client uses it only when the 0xSplits factory gives the seller's split address for it.
- `--refund --self-send` sends the draft's own `requestClose`, and after the grace period `withdraw`, from the key at
  its own gas. It needs nothing from the seller or the relay.
- A channel that already has a close request on chain, sent from another state directory or by another tool, is
  not closed through the seller: `--refund` answers `session_exit_waiting` with when the withdrawal can be sent
  (`readyAt`) and, once the grace period has passed, sends the withdrawal through the relay when the relay sends it
  free. When the relay asks for its gas, `--refund` signs nothing and says so; `--refund --exit` pays that gas in USDC
  out of what returns, and `--refund --self-send` sends `withdraw` at the key's own gas.

## Gates and grants

A ZEAM :: Bridge gate admits listed keys by a zero-value payment: nothing moves. `PASS_GRANT` is sent as the `x-grant`
header on every request to the seller's own origin (the origin of `PASS_MCP_URL`), over MCP and HTTP, so a key
admitted by grant passes the gate. It is not sent to a relay, to a `paid_fetch` URL on another origin, or across a
redirect to another origin.

## Any paid URL

`paid_fetch` is offered beside the seller's tools. It calls a URL and pays a 402 with the first of these the URL
offers:

1. x402 `exact`: one signed transfer.
2. An MPP (`WWW-Authenticate: Payment`) charge, method `evm`.
3. x402 `batch-settlement`: a payment channel, as in *Paying per call*. A ZEAM :: Bridge seller quotes this on its
   HTTP routes (`POST <base>/v1/<tool>`, and its own routes behind the paywall), with an MPP charge beside it only
   where the price covers the gas.

With a session escrow pinned, an MPP `session` the URL offers into it is paid after 1 and before 2, as *Paying by
session* says. The result carries `protocol: "mpp"`, `intent: "session"`, `channelId`, `charged`, the `receipt`,
`payeeVerified` and, when one was signed, `deposit` or `topUp`.

    npx -y @zeampass/client --call paid_fetch \
      '{"url":"https://api.example.com/v1/quote","body":{"symbol":"ETH"}}'

- `pay: false` returns the terms without paying.
- `maxAmount` (base units) refuses a larger quote before signing.
- USDC counts toward `PASS_MAX_SPEND`. Another asset is paid only with `maxAmount`.
- A zero-value gate: signed, admitted, `paid: false`.
- An MPP charge is paid when it is method `evm`, intent `charge`, on the client's network, taking an EIP-3009
  `authorization`: one signed USDC transfer, no channel. The result carries `protocol: "mpp"` and the `receipt`.
- A signed MPP charge counts toward `PASS_MAX_SPEND` when it is sent, receipt or not: its seller can collect it until
  the challenge expires. With no receipt the result says `signed: true` and `paid: false`. A signed x402 `exact`
  transfer counts the same way; a URL that answers it with an error gets `signed: true` and `paid: false`.
- Other MPP methods (`tempo`, `stripe`) are listed under `mpp` in the terms and not paid.
- A `batch-settlement` payment: the first call to a seller signs a deposit, price × `PASS_DEPOSIT_MULTIPLIER`, at
  least the floor its 402 names; later calls sign vouchers against it. The result carries `scheme`, `channelId`,
  `charged` and, when one was signed, `deposit`.
- A deposit counts toward `PASS_MAX_SPEND` when it is signed, and `maxAmount` refuses a deposit above it as it
  refuses a price. Refused, nothing is signed and `needed` is the amount that would be. A call paid out of a deposit
  this run signed is not counted again; a call paid out of an earlier deposit is.
- Channel state is kept per host: `~/.x402-mcp-bridge/<host>/<address>`, or
  `<PASS_STATE_DIR>/hosts/<host>/<address>` when `PASS_STATE_DIR` is set. A URL on the host of `PASS_MCP_URL` pays
  from the channel the MCP tools pay from. A record is named by its channel, which the receiver in the terms fixes:
  other terms are another channel, and a seller's answer updates only the channel its own terms name.
- To take back what such a channel has not spent: `PASS_MCP_URL=https://<host>` with `--refund`, and with
  `PASS_STATE_DIR` set, that host's directory as `PASS_STATE_DIR`. The client prints the settings when it
  signs a deposit.
- A 402 after a payment: `funding_requires_open_fee` deposits the floor it names; a count the seller proves with
  this key's own voucher resyncs the channel; `payment_invalid` drops the local record and resyncs from the chain.
  The call is then paid again, three payments at most, every deposit among them inside `maxAmount` and
  `PASS_MAX_SPEND`.
- A seller that takes the voucher and fails: its error comes back, `paid: false`, nothing counted. An answer with no
  `PAYMENT-RESPONSE`: `signed: true`, `paid: false`, and the price counts toward `PASS_MAX_SPEND`.

## Chain clients

```js
import { createPublicClient } from 'viem'
import { base } from 'viem/chains'
import { prism } from '@zeampass/client/viem'

const client = createPublicClient({
  chain: base,
  transport: prism({ key: process.env.PASS_PRIVATE_KEY }),
})
await client.getBlockNumber()
```

The ethers provider needs `ethers` 6 or later installed beside the client (`npm install ethers`).

```js
import { PrismProvider } from '@zeampass/client/ethers'
const provider = new PrismProvider({ key: process.env.PASS_PRIVATE_KEY })
```

1. The first request pays per call at `/rpc/base` (or `/rpc/eth`, `chain: 'eth'`) and funds the channel: 40 × the price,
   at least the seller's floor.
2. Then it opens a line, buys `aheadMs` (2000) of time, and sends `x-line`. While a request runs it buys more
   before the line runs out, as above.
3. `maxMicroUSD` (default `PASS_MAX_SPEND`) bounds everything one request signs for: a deposit or top-up, the call,
   the line time bought before and during it. Each counts when it is signed; a call or line time paid out of a deposit
   the same request signed is not counted again, and one paid out of an earlier request's deposit is. A deposit that
   would pass it is made smaller to fit, down to what the call and the seller's floor need. Below that nothing is
   signed and the request is refused with an error whose `code` is `x402_bridge_spend_cap_reached` and whose `needed`
   is the amount. During a call, purchases stop at it and the call runs on the time left. `refund()` holds its gas
   payment to it.
4. The meter goes off after `idleMs` (1000) idle; the line is let go after `dropAfterMs` (10000).
5. `state()`, `close()`, `refund()`. Call `close()` or `refund()` before exit.

Options: `url`, `chain`, `network`, `stateDir`, `depositMultiplier`, `asset`, `salt`, `rpcUrl`, `grant`, `relayUrl`,
`maxMicroUSD`, `aheadMs`, `idleMs`, `dropAfterMs`, `log`. The `PASS_*` variables are the defaults; the state directory is shared with the
client.

## Configuration

- `PASS_PRIVATE_KEY` (no default): funds the channel and signs.
- `PASS_MCP_URL` (default `https://mcp.zeamprism.com/mcp`): any x402 MCP
  endpoint.
- `PASS_LINE` (default `auto`): `auto`, `on`, `off`.
- `PASS_LINE_AHEAD_MS` (default `2000`): line time kept ahead of a call; the least bought per `buy_time` while the
  channel's collateral and `PASS_MAX_SPEND` leave room for it.
- `PASS_LINE_IDLE_MS` (default `1000`): meter off after this idle.
- `PASS_EXIT_WAIT_MS` (default `30000`): how long an exit waits for a purchase in flight to be answered before it
  lets the line go.
- `PASS_MAX_SPEND` (default `10000000`, $10): ceiling on what this run pays, µUSD; `0` removes it. Every deposit
  and top-up counts when it is signed, x402 or session, for an MCP tool or in `paid_fetch`; so does every signed
  transfer: an `exact` payment, an MPP charge, a gas payment. A call paid out of a deposit this run signed is not
  counted again. What the channel was charged before this run is not counted. For an MCP tool an x402 deposit that
  would pass the cap is made smaller to fit, down to what the call and the seller's floor need; below that nothing
  is signed.
- `PASS_DEPOSIT_MULTIPLIER` (default `40`): deposit = price × this, at least
  the seller's floor; minimum 3.
- `PASS_GRANT` (no default): `x-grant` on every request to the seller's own origin.
- `PASS_RPC_URL` (default the chain's public RPC): your node for chain reads.
- `PASS_STATE_DIR` (default `~/.x402-mcp-bridge/<host>/<address>`): channel
  state, and in `seller.json`, for each seller by origin, its refund route and the channel each key and `PASS_SALT`
  last paid into there; keep it.
- `PASS_SALT` (default the scheme's): a distinct channel.
- `PASS_ASSET` (default first quoted): address or symbol.
- `PASS_NETWORK` (default `eip155:8453`): CAIP-2.
- `PASS_SESSION` (default `auto`): `auto`, `on`, `off`. Nothing is paid by session until an escrow is pinned.
- `PASS_SESSION_ESCROW` (no default): the MPP session escrow addresses the client may pay into.
- `PASS_SESSION_FACTORY` (no default): the payee factory of that escrow, to check a seller's payee.
- `PASS_SESSION_SPLIT` (no default): a seller's split and its salt, for `--refund --exit`.

Every request to a seller, a relay or a `paid_fetch` URL is sent with `User-Agent: zeam-pass-client/<version> node`,
so the other side can see it is `@zeampass/client` and which version. A `User-Agent` you put in `paid_fetch`'s
`headers` is sent instead. Nothing else about you is added: no address, no host name.

USDT, DAI and WETH settle through Permit2: approve `0x000000000022D473030F116dDEE9F6B43aC78BA3` once. USDC needs no
approval.

## Limits

- It exits when stdin closes, and lets its line go once the purchases in flight are answered.
- It stops at `PASS_MAX_SPEND`: further calls return `x402_bridge_spend_cap_reached`, with `spentMicroUSD`, what
  this run counted toward it, and `capMicroUSD`, for an MCP tool and from `paid_fetch` alike.
- On `--refund`, when the seller asks for the refund's gas in USDC, it signs only a payment to the relay's own gas
  wallet, in USDC on its own chain, for the amount quoted, no more than twice what the relay prices that
  gas at, less than the refund and within `PASS_MAX_SPEND`. Otherwise it signs nothing and says why. The relay is
  ZEAM's (`https://api.zeampass.com/relay`); `PASS_RELAY_URL` names another. The gas of a session channel's close is
  checked the same way. For `--refund --exit` the price is the relay's own, and the payment is signed only when it
  is less than what is left in the channel and within `PASS_MAX_SPEND`; it cannot be taken before the grace period
  ends. Signed with the close request, it is valid from 30 s after the grace period the chain gives at that moment,
  for 15 minutes; the answer says from when (`gasPaymentValidFrom`), and says so if the request landed so late that
  this falls inside the grace period. Signed after the request is on chain, it is valid from the end of that
  request's grace period. A close's gas payment is signed only when it is valid at once and for
  no more than 10 minutes, is less than what the escrow shows would return, and the relay does not say the channel's
  fees cover the gas. When the client does not sign it, the answer keeps the seller's `code: "gas_payment_needed"`,
  `leftMicroUSD`, `returnedMicroUSD`, `gasMicroUSD` and its detail as `why`, and adds `refused: "gas_payment_refused"`
  and `refusedWhy`, the client's reason. Each payment is kept in the channel's record, and no other is signed
  for that channel while one is unexpired and unused: the same one is sent again, or `--refund` says until when to
  wait (`gas_payment_pending`).
- On `--refund --self-send` it sends only the escrow's signed refund of this channel: `refundWithSignature`, alone
  or with its claim in the escrow's `multicall`. Any other transaction a seller hands back is not sent; the answer
  is `signed_refund_refused` and says why. `initiateWithdraw` needs nothing from the seller.
- The ETH gas that `--self-send` pays is not counted toward `PASS_MAX_SPEND`. The client knows its cost in ETH
  before sending but holds no ETH price of its own, and a price asked of the seller or the relay would make the exit
  depend on them. It sends only when the key holds 1.5 × the estimate, and the answer states what was paid
  (`gasWei`).
- Lost state is rebuilt from the seller: the first payment on the channel after it is lost is refused with the
  seller's corrective 402, which carries the channel's state, and is made again from that state; nothing is charged
  for the refused one. Against a seller that publishes no `/.well-known/x402` terms, the unpaid calls that ask the
  price come first. A channel that holds nothing then takes one deposit.

## Verify before you run it

The versions are pinned exactly.

    npm view @zeampass/client@4.1.1 version dist.integrity
    npm pack @zeampass/client@4.1.1
    less package/index.mjs

## Upgrading from @zeam-labs/x402-mcp-bridge

Up to 3.2.2 the client was published as `@zeam-labs/x402-mcp-bridge`. Those versions stay on npm and run as before.
Moving to `@zeampass/client` changes nothing you run:

- the command `x402-mcp-bridge` is installed beside `zeam-pass`;
- every `X402_…` setting is read when its `PASS_…` name is not set. With both set and different, `PASS_…`
  wins and the client says so once on stderr;
- the tool name `x402_fetch` is answered as `paid_fetch`. Only `paid_fetch` is listed;
- the state directory is still `~/.x402-mcp-bridge`, so a channel you funded is still found;
- the error code `x402_bridge_spend_cap_reached` is unchanged.

Apache-2.0. Patent pending.
