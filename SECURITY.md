# Security Policy

This tool holds a funded private key. Treat everything below as the threat model you are accepting
when you run it.

## Reporting a vulnerability

**info@zeamlabs.com** — put `SECURITY` in the subject.

We are a small operator, not a security team with a rota. What you can expect: an acknowledgement
within 72 hours, and an honest answer about whether we can fix it and when. If a report is credible
and we cannot fix it quickly, we will say so publicly here rather than sit on it quietly.

Please do not open a public issue for anything that could expose a user's key or funds. Anything
else — a crash, a wrong error message, a dependency concern — is fine in the open.

There is no bug bounty. We will credit you by name or handle if you want it.

## What this software does with your key

`PASS_PRIVATE_KEY` is read from the environment at startup and passed to `privateKeyToAccount` and
`toClientEvmSigner` from `viem` and `@x402/evm`. It signs x402 vouchers, channel deposits and MPP
charges locally. It is never transmitted, logged, or written to disk by this code.

The Pass client custodies nothing. Your funds sit as collateral in the upstream's settlement contract and
are withdrawable by your signature alone, subject to that contract's withdraw delay.

**Your exposure is the size of your deposit**, not the price of a call. The Pass client pays automatically
against the terms the upstream quotes, up to the per-request ceiling, without asking you per call.
Fund a channel with what you are willing to lose to a dishonest or broken meter, and use a key that
holds nothing else.

`paid_fetch` pays whatever URL it is given: an x402 `exact` payment, an MPP `evm` charge, or an x402
`batch-settlement` channel. A channel takes a deposit, and the URL's own terms name its receiver, its
floor and its withdraw delay. The Pass client signs no `paid_fetch` deposit above `maxAmount` or above
what is left of `PASS_MAX_SPEND`, and counts each one against `PASS_MAX_SPEND` when it signs it. The
receiver can claim only what the vouchers sign, one price per call. The rest of a deposit comes back by
`--refund`, or with no answer from the seller by withdrawal after that delay. Channel records are kept
per host, and a seller's answer is written only to the channel its own terms name.

An MPP `session` is paid only into an escrow contract you pin with `PASS_SESSION_ESCROW`; none is built in. You
are trusting that contract's code with the deposit. The Pass client signs no voucher above the deposit or above
what the seller's receipts show spent plus the call being paid, signs no deposit or top-up that would pass
`PASS_MAX_SPEND`, and refuses a receipt that claims more than it has signed. The seller can collect up to the
highest voucher signed, one call's price above what its receipts show. The rest comes back by `--refund`, or
without the seller by the escrow's close request and withdrawal after its grace period.

## In scope

- Any path by which the private key leaves the machine, reaches disk, or enters a log
- Signing a voucher for more than the upstream quoted, or outside the channel it was scoped to
- Channel-state handling that causes a duplicate deposit or an unrecoverable channel
- Dependency confusion or a supply-chain path in how the tarball is fetched, pinned, or resolved
- Anything that lets an upstream server extract more than the per-request ceiling it advertised

## Out of scope

- The upstream server's metering being dishonest. That is a trust question, not a vulnerability in
  this client — the meter runs server-side and cannot be verified from here. Documented, not fixable.
- Vulnerabilities in `viem`, `@x402/*`, or the MCP SDK. Report those upstream; tell us too and we
  will bump the pin.
- Losing your own key or your own `PASS_STATE_DIR`.

## Verifying what you are about to run

The package is `@zeampass/client` on npm; until 4.0.0 it was `@zeam-labs/x402-mcp-bridge`. Check
what you are about to run before you run it:

    npm view @zeampass/client dist.integrity version
    npm pack @zeampass/client && tar xzf zeampass-client-*.tgz
    less package/index.mjs

npm's integrity hash proves the bytes you fetched are the bytes that were published.
It does not prove we are honest — read the source, it is short on purpose, and it matches this
repository commit for commit.

`npx -y @zeampass/client` fetches the current release every launch, so a future version
could differ from the one you audited. Pin the version you audited — `npx -y @zeampass/client@<version>` — or
vendor the tarball at a known integrity hash and run it from disk. Dependencies are
pinned to exact versions precisely so that the code under the code cannot move beneath you.

## Supported versions

The current release is the only supported one. There are no backported fixes.

