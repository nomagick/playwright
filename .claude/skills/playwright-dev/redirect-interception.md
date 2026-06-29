# Redirect Interception — Status and Remaining Work

## Background

When a browser follows an HTTP redirect (3xx), the redirect target is a new network request with its own headers, cookies, and URL. Users reasonably expect `page.route()` to intercept these requests just like any other. Prior to the Chromium fix, Playwright silently skipped route handlers for all redirected requests on all three browsers, citing "we do not support intercepting redirects."

The Chromium fix is in `packages/playwright-core/src/server/chromium/crNetworkManager.ts`. The blocking condition `if (redirectedFrom || ...)` was reduced to `if (!this._userRequestInterceptionEnabled && this._protocolRequestInterceptionEnabled)` — removing the blanket redirect suppression. Chrome's `Fetch.requestPaused` already fires for redirected requests; Playwright was the only thing suppressing the route.

Firefox and WebKit each require browser-level changes described below.

---

## Firefox

### Where the block lives

`browser_patches/firefox/juggler/NetworkObserver.js`, method `_shouldIntercept()` (search for the method name):

```javascript
_shouldIntercept() {
  // We do not want to intercept any redirects, because we are not able
  // to intercept subresource redirects, and it's unreliable for main requests.
  if (this.redirectedFromId)
    return false;          // <-- this is the block
  ...
}
```

When `_shouldIntercept()` returns false, `isIntercepted` is set to false in the `requestWillBeSent` event, and `ffNetworkManager.ts` does not create a `FFRouteImpl` for the request (see `ffNetworkManager.ts` line 72: `if (event.isIntercepted) route = new FFRouteImpl(...)`).

### What needs to change

1. **Investigate** whether `nsIInterceptedChannel` is available for redirected subresource requests. The comment claims it isn't — but this was written years ago and may be stale. A quick test is to remove the `if (this.redirectedFromId) return false` guard and run the subresource redirect tests to see if Firefox throws or hangs.

2. **If subresource redirects are also interceptable**: simply remove the early return. All redirect requests will then get `isIntercepted: true` and reach `FFRouteImpl`.

3. **If only navigation redirects are interceptable**: gate the guard on the content policy type:
   ```javascript
   if (this.redirectedFromId && causeType !== Ci.nsIContentPolicy.TYPE_DOCUMENT)
     return false;
   ```
   `TYPE_DOCUMENT` covers top-level navigation. `TYPE_SUBDOCUMENT` covers iframes. Other types are subresources.

4. **No TypeScript changes needed** once the juggler emits `isIntercepted: true` for redirects — `ffNetworkManager.ts` already handles the rest.

### Test signal

Run `npm run ttest -- --grep "intercept.*redirect" --project=firefox` and `npm run ctest-mcp -- --grep "redirect"`. The three new tests in `tests/page/page-route.spec.ts` ("intercept redirect target", "intercept server-originated redirect", "expose redirectedFrom") are currently marked `.fixme` for Firefox — remove those marks once the juggler change is in.

---

## WebKit

### Where the block lives

`packages/playwright-core/src/server/webkit/wkPage.ts`, `_onRequestWillBeSent()`:

```typescript
// We do not support intercepting redirects.
if (this._page.needsRequestInterception() && !event.redirectResponse)
  this._requestIdToRequestWillBeSentEvent.set(event.requestId, event);
else
  this._onRequest(session, event, false);  // false = not intercepted
```

When `event.redirectResponse` is set (i.e., this event describes a redirect target), the event bypasses the pending-intercept map and goes straight to `_onRequest` with `intercepted = false`. No `WKRouteImpl` is created. The same pattern exists in `wvPage.ts` for the WebView backend.

### What needs to change

**Step 1 — verify that WebKit fires `Network.requestIntercepted` for redirect targets.**

Remove the `!event.redirectResponse` guard (both in `wkPage.ts` and `wvPage.ts`) and run a navigation redirect test on WebKit. If `requestIntercepted` fires for the redirect target, the request will be correctly intercepted. If it never fires, the `requestWillBeSentEvent` will sit in `_requestIdToRequestWillBeSentEvent` indefinitely and the request will hang.

A definitive way to verify: add a temporary `console.log` inside `_onRequestIntercepted` in `wkPage.ts` and observe whether it fires for a 301 redirect navigation.

**Step 2 — if `requestIntercepted` does fire**: remove the guard, remove the stale comment. The `intercepted` flag passed to `_onRequest` will be `true`, `WKRouteImpl` will be created, and the handler will run. Same for `wvPage.ts`.

**Step 3 — if `requestIntercepted` does NOT fire for redirects**: a WebKit browser patch is needed. The relevant WebKit-side code is in `Source/WebInspectorUI` or the network backend — look for where `requestIntercepted` events are emitted and extend it to also fire for redirect targets.

### Fulfill with redirect status

`wkInterceptableRequest.ts:124-126` (and `wvInterceptableRequest.ts`) also throws when `route.fulfill()` is called with a 3xx status:

```typescript
if (300 <= response.status && response.status < 400)
  throw new Error('Cannot fulfill with redirect status: ' + response.status);
```

This is a separate but related issue. `Network.interceptRequestWithResponse` (the WK protocol command) may not support redirect status codes — verify this. If it doesn't, the right user-facing path is `route.continue({ url: locationUrl })` which redirects the request URL without issuing a real HTTP redirect. If the protocol does support it, remove the guard.

The test `tests/page/page-route.spec.ts` "should not fulfill with redirect status" is currently `.skip` for non-WebKit browsers (it only asserts the throw). Once WebKit redirect interception works, this test should be deleted and replaced with a positive test.

### Test signal

Same three `.fixme` tests as Firefox — remove the WebKit marks once the above steps are complete.
