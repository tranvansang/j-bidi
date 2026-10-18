# Changelog

## 0.2.0 — 2026-10-18

### Breaking

- A subscriber's `onData` is no longer wrapped in a try/catch. Whatever it throws leaves `endpoint.send()` as is and
  reaches the link's message listener, and an async `onData` that rejects is an unhandled rejection. On Node, either one
  crashes the process unless you catch it. Before, both were caught and logged as a `bidirectional message pub error`
  JSON line.
- The endpoint no longer writes to `console.log`.

Only a `request` handler may throw now. `onData`, `subscribe` and `push` must not, see [Errors](README.md#errors).

### Migrating

Catch inside any `onData` that can fail:

```ts
endpoint.subscribe({path: '/topic'}, data => {
	try {
		render(data)
	} catch (e) {
		report(e)
	}
})
```

If you read the `bidirectional message pub error` log line, report from that catch instead.

## 0.1.2 — 2026-10-12

- Works on plain http pages, where `crypto.randomUUID` is undefined: ids fall back to a v4 UUID built from
  `crypto.getRandomValues`.

## 0.1.1 — 2026-08-09

- The endpoint counts as disposed as soon as dispose starts, so a subscription that publishes while it is released no
  longer sends to the closing transport.

## 0.1.0 — 2026-08-09

- `/abort`: a request that times out or whose `signal` aborts tells the peer, and the peer's handler `signal` aborts.
- Dispose rejects pending requests with `Error('endpoint disposed')` and drops subscription callbacks. Afterwards the
  endpoint ignores incoming frames, `request` rejects, and `push` and `subscribe` send nothing.
- A request handler that throws a value without a message (a string, `null`, …) rejects the caller instead of resolving
  it with `undefined`.
- A reused `/req` id aborts the older run, and only the newest run answers.
- `subscribe` registers `onData` before sending `/sub`, so a synchronous transport's first `/pub` is not lost.
- Ids from the peer are kept in null-prototype maps, so ids like `__proto__` can't break the endpoint.
- A `/push` body may be any JSON value, not only a string.
- The package is `"type": "module"` and has no runtime dependencies.

## 0.0.2 — 2026-05-15

- Fixed package exports.

## 0.0.1 — 2026-05-15

- First release: the plain JSON endpoint split from `j-bidi`.
