# Fork Notes

This is a maintained fork of Playwright. It intentionally diverges from upstream
in how **Chromium network interception** behaves. The changes are not intended to
be contributed back — they exist to keep our application on standards-faithful,
real-browser behavior.

> **Scope: Chromium only.** We do not use Firefox or WebKit. The deviations below
> are implemented and tested for Chromium alone. Cross-engine parity is explicitly
> a non-goal, which is why this is a fork and not a PR.

## Guiding principle

**The interception layer is a transport, not an author.**

Playwright's `page.route()` sits between the browser and the network. Its job is to
let the user observe and control real requests — not to synthesize requests the
browser never made, suppress requests the browser did make, or inject headers the
user never wrote. Every header, every continue, every fulfill should reflect
**user intent and real browser behavior**, nothing more.

Upstream accumulated a set of "convenience" behaviors that violate this: silent
CORS header injection, synthetic preflight responses, and blanket suppression of
redirected requests. Each was a reasonable-looking local fix to a bug report, but
together they make the tool an unreliable oracle — a passing test no longer proves
"my app works," only "my app works with Playwright's invisible corrections applied."

Corollary used throughout this fork: **every move should be initiated by the user.**
Convenience belongs in explicit, named opt-ins — never silent defaults.

---

## Deviations from upstream

Each entry lists the behavior, the rationale, the symbols touched (not line numbers —
those drift on rebase), and the related upstream issues so you can recognize the
code if a rebase drags it back.

### 1. Redirected requests are interceptable

**Commit:** `fix(chromium): requests in a redirection chain should be Interceptable`

**What:** Route handlers now fire for every request in a redirect chain, not just
the first. Previously redirect targets were silently auto-continued.

**Why:** When the browser follows a 3xx, it issues a *new* outgoing request to the
`Location` URL. Chrome's `Fetch.requestPaused` fires for that request and the
browser is paused waiting on it — Playwright had full control and was choosing to
discard it. The "we do not support intercepting redirects" comment described a
policy, not a protocol limitation.

**Symbols / files:**
- `crNetworkManager.ts` → `CRNetworkManager._onRequest()`: removed the
  `if (redirectedFrom || ...)` branch that auto-continued redirect targets. The
  remaining guard (`!_userRequestInterceptionEnabled && _protocolRequestInterceptionEnabled`)
  is correct and kept — it handles `Fetch.enable` being active solely for HTTP auth.
- `crNetworkManager.ts` → removed `InterceptableRequest._originalRequestRoute` and
  the `headersOverride` plumbing through the constructor. This was the
  cross-redirect-hop header-propagation machinery (added by upstream #28962) that
  only existed *because* redirect targets were auto-continued. With targets routed
  to the handler, each request carries its own headers like any other request.

**Replaces upstream machinery for:** #3993, #3994 (original decision), #28962,
#28758, #32045, #31351, #13106, #36029 — all of which are symptoms of, or
compensation for, the redirect-suppression decision. They are moot under this fork.

**Test contract:** `tests/page/page-network-request.spec.ts` →
`should work for a redirect and interception` (intercept count 1 → 2);
`tests/page/page-route.spec.ts` → redirect interception tests;
`tests/page/page-request-continue.spec.ts` → the redirect header-propagation tests
are inverted to assert per-request headers (no cross-hop propagation).

### 2. No silent CORS header injection on `fulfill()` (working tree)

**What:** `route.fulfill()` sends exactly the headers the user provided. Playwright
no longer auto-injects `access-control-allow-origin`, `access-control-allow-credentials`,
or `vary: Origin` on cross-origin responses.

**Why:** The removed `_maybeAddCorsHeaders` injected those headers whenever the user
did *not* already supply CORS headers. That is the tool authoring a security-sensitive
response (`allow-credentials: true` on a reflected origin) on the user's behalf. It
made CORS-failure paths untestable and turned invalid mocks into false greens. The
browser blocking a fulfilled cross-origin response with no ACAO is **correct feedback**,
identical to what a real server with those headers would cause.

**Symbols / files:**
- `server/network.ts` → `Route.fulfill()`: removed the `_maybeAddCorsHeaders(headers)`
  call and the `_maybeAddCorsHeaders()` method itself.

**Replaces upstream machinery for:** #12929.

**If you want the convenience back:** add it as an explicit opt-in
(e.g. `fulfill({ cors: true })`), never as a silent default.

**Test contract:** `tests/page/page-route.spec.ts` (cors fulfill tests).

### 3. No synthetic CORS preflight (OPTIONS) responses

**What:** Preflight `OPTIONS` requests reach route handlers and the page like any
other request. Playwright no longer synthesizes a `204` with permissive
`Access-Control-Allow-*` headers on the user's behalf.

**Why:** Synthesizing the preflight response is an opinionated policy baked into the
engine. It made the OPTIONS request unobservable and made it impossible to test a
server that rejects preflight. The browser should perform its own real preflight and
the user should see it.

**Symbols / files:**
- `crNetworkManager.ts` → `CRNetworkManager._onRequest()`: removed the
  `isInterceptedOptionsPreflight` block that called `Fetch.fulfillRequest` with a
  synthetic 204.

**Replaces upstream machinery for:** #36311.

**Test contract:**
- `tests/page/page-event-request.spec.ts` → `should expose preflight OPTIONS request
  with network interception` (was `should not expose...`).
- `tests/page/page-network-request.spec.ts` → `should get preflight CORS requests
  when intercepting` (was `should not get...`).

### 4. No internal request-restart auto-continue

**What:** Removed the `alreadyContinuedParams` replay that auto-continued a request
when Chromium restarted it internally (e.g. no-cors → cors upgrade for a
"less public address space").

**Why:** This was tightly coupled to `_originalRequestRoute` (removed in #1) and to
the redirect-suppression model. With per-request routing it is unnecessary; the
restarted request is simply routed again.

**Symbols / files:**
- `crNetworkManager.ts` → `CRNetworkManager._onRequestPaused()`: removed the
  `existingRequest?._originalRequestRoute?._alreadyContinuedParams` replay block.
- `crNetworkManager.ts` → `InterceptableRequest`: removed the
  "fulfilled body returns empty" short-circuit in the body reader that depended on
  `_originalRequestRoute?._fulfilled`.

> **Watch on rebase:** the upstream comment here references a real Chromium behavior
> (internal request restarts, e.g. CORS upgrades). If you ever see a request that
> should be intercepted but silently vanishes or double-fires after a rebase, this
> is the first place to look. Verify our per-request routing still handles the
> restart case before assuming it's fine.

### 5. Revert: do not forward cookie header on `route.continue`

**Commit:** `Revert "fix(chromium): do not forward cookie header on route.continue (#41435)"`

**What:** Reverted upstream #41435.

**Why:** That fix existed to paper over redirect-suppression behavior. Once
redirected requests are properly interceptable (deviation #1), the problem it
addressed does not arise, and the fix becomes harmful (it strips a cookie header the
user/browser legitimately set).

**Watch on rebase:** if upstream revisits #41435 or related cookie-on-continue
handling, re-evaluate against deviation #1 rather than blindly re-reverting.

### 6. `HeadersArray | Headers` accepted on header-bearing APIs

**What:** `route.fulfill`, `route.continue`, `APIRequest.newContext`
(`extraHTTPHeaders`), and `APIRequestContext.fetch` (`headers`) accept either the
object form (`Headers`) or the array form (`HeadersArray` = `{name, value}[]`).

**Why:** The object form (`Record<string, string>`) cannot represent duplicate
header names (e.g. multiple `Set-Cookie`). The array form is lossless and is already
the internal wire format. This is an additive, backward-compatible enhancement and is
independent of the CORS/redirect changes — it could stand alone.

**Symbols / files:**
- `client/network.ts` → `Route.fulfill`, `Route._innerFulfill`, `Route._continue`,
  `FallbackOverrides`/`SerializedFallbackOverrides` types, `Request.headers()`,
  `Request._actualHeaders()`.
- `client/network.ts` → `RawHeaders._fromHeadersObject` (renamed from
  `_fromHeadersObjectLossy`; now array-aware — array input is preserved verbatim
  instead of being collapsed).
- `client/fetch.ts` → `FetchOptions`, `NewContextOptions`, `APIRequest.newContext`,
  `APIRequestContext.fetch`.

**Test contract:** header-array variants in the fulfill/continue/fetch specs.

---

## Maintaining the fork

### Rebase strategy

- **Pin to upstream tags, not `main`.** Rebase deliberately every few releases, not
  continuously. The touched files (`crNetworkManager.ts`, client/server `network.ts`)
  are actively churned upstream.
- **Conflicts are expected in `crNetworkManager.ts`.** Use the symbol references
  above (not line numbers) to re-locate each deviation. Re-apply by *intent*, not by
  diff: the goal is "transport, not author," not a specific patch shape.

### Drift detection — the tests are the contract

Our test changes are not incidental — they *are* the specification of this fork. They
encode the correct behavior so that any upstream change which re-introduces a
workaround fails loudly. After every rebase:

```bash
npm run ctest tests/page/page-route.spec.ts
npm run ctest tests/page/page-request-continue.spec.ts
npm run ctest tests/page/page-network-request.spec.ts
npm run ctest tests/page/page-event-request.spec.ts
```

If any of these fail after a rebase, upstream has changed behavior under us — read
the failure as a signal, not a chore. Decide whether to re-assert our behavior or
adopt theirs; never "fix" the test to make it pass without understanding which way
the behavior moved.

### Adding a new deviation

1. Implement it under the guiding principle (transport, not author; user-initiated).
2. Add or invert a test that asserts the faithful behavior.
3. Add an entry to this file: what, why, symbols, related upstream issues.
4. If it's a convenience, make it an explicit opt-in, not a silent default.

### Related background

`/.claude/skills/playwright-dev/redirect-interception.md` documents the Firefox and
WebKit investigation paths for redirect interception, kept in case scope ever expands
beyond Chromium. Not needed for current (Chromium-only) operation.
