# Changelog

## Unreleased

- The spend-cap answer, `x402_bridge_spend_cap_reached`, reports in `spentMicroUSD` what the run counted toward `PASS_MAX_SPEND`, session vouchers and `paid_fetch` payments included, as the line on stderr does. Before, it reported only the x402 part: a run that had paid 1750 in session vouchers answered `spentMicroUSD: 0`.
- `--refund` on a session channel whose close would cost more gas than it returns answers `code: "nothing_to_return"` with `leftMicroUSD`, `returnedMicroUSD` and `gasMicroUSD`, as the seller does and as the README says. Before, it answered `code: "verification-failed"`, the seller's problem type, and dropped the numbers.
- The README says what a session channel's record holds: amounts and addresses, and the signed payments the Pass client may have to send again (a pending deposit or top-up, a close's gas payment, an exit's held withdrawal and gas payment). It said the record held no signature.
- Over MCP, the answer to a payment-only credential (a session top-up, a voucher sent ahead, a close) is read even when the tool lists an `outputSchema` and the answer carries no `structuredContent`. Before, the MCP SDK threw it away with `-32600` ("has an output schema but did not return structured content"), so at Prism the top-up landed and the call that needed it answered `session_deposit_pending`. A result that runs a tool is still checked against the schema.
- On a line, a purchase that waits behind another one still in flight looks at the line again when its turn comes and buys nothing if more than half of `PASS_LINE_AHEAD_MS` (or the margin the README gives) is left, as the README says. Before, a purchase decided from the reading taken before the first one landed was made anyway: `PASS_LINE=on zeam-pass --call wait '{"ms":500}' --times 3` bought 2000 ms, then 2000 more with 2961 ms on the meter, 6000 ms for 1.5 s of calls.

## 4.0.0

- `PASS_MAX_SPEND` bounds every payment the Pass client can make. An x402 deposit or top-up for an MCP tool, a line purchase's among them, counts when it is signed, as a `paid_fetch` deposit and a session deposit already did, and one that would pass the cap is made smaller to fit, down to what the call and the seller's floor need; below that nothing is signed. A call paid out of it is not counted again. An `exact` transfer, over MCP and in `paid_fetch`, counts when it is signed, whether or not the seller answers, and so does a gas payment for a refund, a session close or an exit, once. Before, an MCP deposit was not held to the cap: a run with `PASS_MAX_SPEND=4000` deposited 4817.
- Over MCP a tool sold by time (`per: "time"`, as Prism's `call_rpc`) is paid by MPP session when the seller offers one into a pinned escrow and the call does not ride a line, as it is over HTTP, and a session channel opened over HTTP pays the MCP calls to the same seller. Before, only tools priced per call were paid by session over MCP, so `call_rpc` was paid by x402 even with `PASS_SESSION=on`.
- `--refund --exit` reads the close request at the block of its own receipt, once its node shows that block, and says when the withdrawal can be sent. Before, a node a block behind gave `readyAt` 1970-01-01T00:15:00.000Z and a record with `requestedAt` 0. When no node shows the request's time yet, `readyAt` is null and the answer says why.
- The `viem` and `ethers` chain transport holds everything one request signs for to `maxMicroUSD`: the deposit or top-up, the call, and line time bought before and during it, counted when signed, with a deposit made smaller to fit down to what the call and the seller's floor need, and below that the request refused with an error carrying `code: 'x402_bridge_spend_cap_reached'` and `needed`. `refund()` holds its gas payment to it. Before, `maxMicroUSD` stopped only the purchases made while a call ran: the deposit (40 × the price) and the line time bought before the call were not bounded. `prism()` and `PrismProvider` now pass `maxMicroUSD`, `grant` and `relayUrl` on; before, they dropped them, so `grant` in their options never reached the seller.
- `--refund --self-send` states the ETH gas it paid (`gasWei`), on an x402 refund and on a session exit, and reads the refunded channel at the refund's own block. That gas is not counted toward `PASS_MAX_SPEND`, which is in dollars: the Pass client has no ETH price of its own.
- A major version because the package, the command and the settings have new names: `@zeampass/client`, `zeam-pass`, `PASS_…`. What you already run keeps working, as the rename below says. `@zeam-labs/x402-mcp-bridge` 3.2.2 and earlier stay on npm and run as before; its 4.0.0 only installs `@zeampass/client`.
- The Pass client pays by MPP `session` (`draft-evm-session-00`, method `evm`, USDC on Base), over MCP and in `paid_fetch`, into an escrow pinned with `PASS_SESSION_ESCROW`; none is built in, so nothing changes until one is pinned. It opens the channel by an EIP-3009 authorization through the seller's relay, signs a voucher per call, tops up, resumes from `<state directory>/session`, closes with `--refund`, and leaves without the seller with `--refund --exit` (the relay) or `--refund --self-send` (its own gas). A deposit and every top-up count toward `PASS_MAX_SPEND`.
- A session channel is left with no ETH whatever was spent on it. When a channel's fees do not cover the gas of its close, `--refund` pays the gas the seller quotes in USDC out of what returns, in the close's own transaction, after the checks an x402 refund's gas payment gets (to the relay's gas wallet, the amount quoted, under twice the relay's price, under what returns, within `PASS_MAX_SPEND`). `--refund --exit` does the same against a seller that does not answer: the close request, the withdrawal and one gas payment are signed together, the relay sends the request, holds the rest and sends it after the grace period, and the payment cannot be taken before then: signed with the request it is valid from 30 s after the grace period the chain gives at posting, which the relay requires, and the answer says from when (`gasPaymentValidFrom`); signed once the request is on chain, from the end of its grace period. Before, it was valid one second before the grace period counted from the chain's time before the request landed, so up to a few seconds inside the grace period. `--refund --self-send`, at the key's own gas, is the last resort. Before, a channel that had spent little could only be left with ETH.
- One gas payment per session channel at a time. The Pass client keeps each one it signs in the channel's record and signs no other while that one is unexpired and the token shows it unused; it sends the same one again, or answers `gas_payment_pending` with the time to wait. A close's payment must be valid at once, for no more than 10 minutes, and less than what the escrow itself shows would return; an exit's is valid from the end of the grace period for 15 minutes. Nothing is signed when the relay says the channel's fees cover the gas.
- `paid_fetch` pays a 402 that offers x402 `batch-settlement` terms, from a payment channel: the first call to a seller signs a deposit (price × `PASS_DEPOSIT_MULTIPLIER`, at least the seller's floor), later calls sign vouchers. This is what a ZEAM :: Bridge seller quotes on its HTTP routes, so before, `paid_fetch` answered `no_payable_terms` to most of them. `exact` terms are paid first as before, then an MPP `evm` charge, then `batch-settlement`. A deposit counts toward `PASS_MAX_SPEND` when it is signed and is refused above `maxAmount`, before anything is signed. Channel state is kept per host, `~/.x402-mcp-bridge/<host>/<address>`; a URL on the host of `PASS_MCP_URL` pays from the channel the MCP tools pay from; `--refund` with `PASS_MCP_URL` at the host returns what is unspent.
- `PASS_MAX_SPEND` counts only what this run paid. A channel record behind the seller's count is resynced from the seller's corrective 402, and the count it resyncs to is what earlier runs were charged, not this run's spend. Before, a run that resynced counted that earlier total, up to the price of what it had signed, and refused calls it had never paid for with `x402_bridge_spend_cap_reached`; a voucher the seller took for a call that failed, and did not charge, was counted the same way when the next call was paid. A charge whose answer never arrived is still counted when the resync shows it, and a resync does not lower what the run has counted.
- An `exact` payment for an MCP tool counts toward `PASS_MAX_SPEND` when it is signed. Before, only `batch-settlement` charges were counted over MCP, so a seller that quoted `exact` rows was held to the cap one call at a time and never in total.
- A line is opened on the channel the Pass client pays — the one `PASS_SALT` selects, the scheme's default when it is unset — not on whichever channel file happens to sort first in `PASS_STATE_DIR`. A state directory left holding a channel from another salt is ignored for the run. Before, a directory that held a channel from a different salt let the Pass client ride a line on one channel while it deposited and bought time on another: every call answered `out_of_time` and it bought more time up to `PASS_MAX_SPEND` while nothing got done, the money recoverable only by refunding the other channel. A purchase that would go to a channel the line does not ride is now refused and said, rather than draining to the cap.
- At `PASS_MAX_SPEND` the line is let go only after the running call ends. Before, the Pass client switched the meter off and closed the line while the call it had paid for was still running on it.
- On exit the Pass client waits for `off` and `close` to be answered (up to 3 s) on every exit that holds a line: after `PASS_MAX_SPEND` stopped the run, and when it is stopped while a call is riding the line. Before, a run stopped by its cap exited with `off` still in flight and never sent `close`, and one stopped during a call sent neither.
- A purchase made slow by its deposit no longer sets how much time is bought while a call runs. The lead kept ahead of a call is twice the slowest purchase; the first purchase on a channel carries the deposit and takes seconds, so after it the Pass client bought four times that (about 11 s of time, 13 ms into an 800 ms call) and most of it had to come back through a refund. A purchase that carried a deposit now counts only while the next purchase will carry one, so a call is topped up by `PASS_LINE_AHEAD_MS` or by what it has run, as the README says.
- A call on a line is kept on the line. While it runs the Pass client buys more time before the line runs out: when half of `PASS_LINE_AHEAD_MS` is left it buys as much as the call has run so far, so a long call takes a few purchases and is answered once. Before, the Pass client waited for the seller to cut the call, bought more and ran the whole call again, so the time already burned bought nothing, and a `viem` or `ethers` request longer than 2 s could not finish. `PASS_MAX_SPEND` stops the purchases and the answer says so; a failed purchase leaves the call running; a cancel stops them. A line filled from empty collateral is filled before the call is sent, not sent on the 250 ms that carried the deposit. A purchase larger than the per-call price counts toward `PASS_MAX_SPEND` at its own price on a seller that publishes a micro-USD quote; it used to count as one call.
- Renamed to the ZEAM :: Pass client, `@zeampass/client`: it is now the part of ZEAM :: Pass an agent with its own wallet runs, and it pays MPP as well as x402. The command is `zeam-pass`, the settings are `PASS_…` and the tool is `paid_fetch`. The old names keep working: the command `x402-mcp-bridge`, every `X402_…` setting (the `PASS_…` name wins when both are set, and the Pass client says so once) and the tool name `x402_fetch`, which is answered but no longer listed. The state directory is still `~/.x402-mcp-bridge`. Error codes are unchanged, `x402_bridge_spend_cap_reached` among them. What a seller runs is now named ZEAM :: Bridge.
- Lines on stderr are tagged `[zeam-pass]`, and the MCP server names itself `zeam-pass` unless `PASS_NAME` is set; both were `x402-bridge`. The `/viem` and `/ethers` client logs under the same tag; its lines used to start `prism:`, and a log function passed in receives the line without a prefix.
- `@modelcontextprotocol/sdk` is pinned at 1.31.0, up from 1.30.0. `npm audit` reports 1.30.0 as high, GHSA-6qxp-vccf-f47h: the SDK's OAuth client could send stored credentials to an authorization server the MCP server names. The Pass client was not exposed: it gives its transport no `authProvider` and holds no OAuth credentials, so that client never runs.
- A signed MPP charge can be collected for at most ten minutes, or until the challenge expires if that is sooner. A seller's challenge used to set that window by itself, so one that named a year got a signature good for a year.
- `paid_fetch` pays an MPP charge. A 402 that carries `WWW-Authenticate: Payment` with method `evm`, intent `charge`,
  on the Pass client's network, is paid with one signed EIP-3009 transfer when the URL offers no x402 `exact` terms. The
  credential goes in the header the challenge names; the receipt comes back in the result. Before, such a URL
  answered `unreadable_terms` or `no_payable_terms`.
- Without a key, `--call` runs a free tool, and for a paid tool prints the seller's terms and exits 1, as the stdio server already did. Before, `--call` of any tool printed only "set X402_PRIVATE_KEY…" and exited. `--refund` and `--call paid_fetch` still need the key.
- A key that is set and is not a key is reported as that, with what is wrong (a placeholder, no `0x`, the number of hex digits) and never the key. Before, it was reported as no key. `--call` and `--refund` stop on it; the stdio server and `--tools` say so and run without a key.
- A seller with no document at `/.well-known/x402` is said to publish none, with the status it answered, and the Pass client falls back to the terms in the seller's 402 as before. Before, the line was "could not cache terms" with the JSON parser's error.
- A signed MPP charge counts toward `PASS_MAX_SPEND` from the moment it is sent, whether or not a receipt comes back.
- `pay: false` lists the MPP challenges a URL offers under `mpp`.
- Every request the Pass client sends to a seller, a relay or a `paid_fetch` URL carries `User-Agent: zeam-pass-client/<version> node`. Before, it sent Node's default, `node`, so a seller could not tell the Pass client from any other Node client. A `User-Agent` given in `paid_fetch`'s `headers`, or on a request handed to the `/viem` or `/ethers` client, is sent as given. Chain reads through `PASS_RPC_URL` are unchanged.
- A paid call runs until the seller answers, the connection drops or the MCP client that asked cancels it; a cancel is passed on to the seller. Before, the Pass client gave up on a tool call after 60 seconds (the MCP SDK's default), on any HTTP request after 5 minutes without a byte (Node's `fetch` default) and on a `viem` transport request after 10 seconds, while the call kept running on the seller and burning line time. Adds the `undici` dependency, used only to switch those two `fetch` limits off.
- The meter is switched off `PASS_LINE_IDLE_MS` after the last call on the line ends. Before, the time counted from the end of the call before, so a call that ran longer than that had its meter switched off while it was running.
- `--refund --self-send` sends only a signed refund of this channel. The transaction a seller hands back is sent when it calls the escrow, `0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003`, with `refundWithSignature` for this channel, alone or with its claim in the escrow's `multicall`, on the Pass client's chain and with no ETH. Anything else is refused as `signed_refund_refused`: nothing is sent and it is not handed back as a transaction to send. Before, the Pass client sent whatever `to` and `data` the seller's answer carried, from your key.
- `--refund` signs a gas payment only on its own chain and in that chain's USDC. Before, a payment naming any chain but Base was signed without a check of its token contract.

## 3.2.2

- The README says Patent pending. No code change from 3.2.1.

## 3.2.1

- `X402_MAX_SPEND` counts only what this run signed. On a channel resumed from earlier runs it used to count the channel's earlier charges as this run's spend and refuse to pay.
- A refund asked of a channel with nothing in it says the channel holds nothing. It used to say the channel was fully spent, which is false of one that was refunded unspent.
- `--version` prints the version and exits. It used to fall through and start the server, which contacts the seller. `--help` lists both flags.

- `X402_MAX_SPEND` is checked before a payment is signed. Before, the bridge stopped only after the cap had been
  passed, so one call could go over it by any amount.
- With `X402_LINE=on`, the first call of a time tool on a new channel buys time and rides a line. Before, it paid the
  per-call price and only later calls rode.
- `--refund` no longer signs whatever gas payment a seller asks for. It checks the payment against the relay: paid
  to the relay's gas wallet, the amount quoted, at most twice the relay's price, less than the refund, within
  `X402_MAX_SPEND`, in USDC. Before, a seller could name any amount and any wallet and the bridge signed it.
- A call cut for time is called again until it finishes, up to three times, each with half as much time again as
  it needed; 3.2.0 tried once more and then handed back what fitted.
- The first purchase on a new channel is topped up before the call, so the call is not sent with 250 ms.

## 3.2.0

- A call cut for time is finished in one purchase. When the seller's answer says how long the call needs
  (`needsMs`), the bridge buys that much line time, plus a quarter, and calls again; before, it bought
  `X402_LINE_AHEAD_MS` and handed back whatever fitted.
- The seller's instructions are passed to your MCP client, under a note that the bridge is paying. Before, a
  client behind the bridge received none.

## 3.1.0

- Line time is bought in milliseconds. A ZEAM :: Pass seller now tags `buy_time` `{"usd", "per": "ms", "ms"}`
  and takes `buy_time {"ms"}`; the bridge reads that price and buys `X402_LINE_AHEAD_MS` of it, never less than
  250 ms. 3.0.x understood only the older per-block tag, and against a seller that sells milliseconds it never
  bought time and paid per call.
- A seller on an older ZEAM :: Pass, tagging `buy_time` per block, is still read and still asked for blocks.
- An agent that calls `buy_time` itself through the bridge, with `ms` or with `blocks`, is priced correctly.

## 3.0.3

- No URL in the README or this changelog is followed by punctuation: plain-text link finders on package
  pages kept a trailing comma or bracket in the URL. No code changes.

## 3.0.2

- README reads in a narrow column: the `X402_LINE` and configuration tables are lists, and every code
  block fits 80 columns. No code changes.

## 3.0.1

- The npm page: keywords, author, homepage https://zeamprism.com/connect and LICENSE and CHANGELOG.md in the package.
  The README says `ethers` must be installed for the ethers provider and no longer names test files the package
  does not carry. No code changes.

## 3.0.0

- Lines are ZEAM :: Pass lines: `POST <base>/line` open → EIP-191 proof by the payer key → credential, sent as
  `_meta["zeam-pass/line"]` (MCP) or `x-line` (HTTP). The `/pay` websocket is gone.
- Time is bought with `buy_time {blocks}`, N × the block price, no more than the collateral covers.
- Meter: `off` after 1000 ms idle, `on` before the next call; `meter_off`, `out_of_time` and `line_unknown` are handled
  by code.
- Auto mode: per call until 2 time-tool calls arrive within 10 s, then a line; a call cut at one block is called again
  on a line. Per-call tools never ride.
- Refunds: `POST <base>/refund` signed `ZEAM Pass refund`; the 409 `refund_quote` is paid with a signed USDC gas
  payment; `--self-send`; unburned time is returned (`timeReturnedMs`).
- A deposit reaches the seller's floor, read from the 402's `deposit` line or `neededMicroUSD`. The chain transport
  deposits 40 × the price, like the bridge (it was the scheme's 5).
- `X402_GRANT` is sent as `x-grant` on every request.
- `structuredContent`, `isError` and `_meta` reach the MCP client unchanged.
- `x402_fetch`: pay any x402 URL under `exact`, or pass a Pass gate with a zero-value payment.
- `--times N` repeats a `--call` in one process.
