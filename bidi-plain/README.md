# bidi-plain

Transport-agnostic bidirectional messaging — request-response, subscriptions, and push — over plain JSON.

Bring your own transport (WebSocket, Web Worker, `postMessage`, MessageChannel, etc). The endpoint just hands you
serializable messages to send and consumes messages you feed back in.

For the binary (protobuf) encoding and bundled WebSocket (browser + Node `ws`) backends with auto-reconnect and
heartbeat, see [`j-bidi`](https://www.npmjs.com/package/j-bidi).

## Requirements

This library uses the [Explicit Resource Management](https://github.com/tc39/proposal-explicit-resource-management) API
(`using`, `DisposableStack`). Your environment needs:

- A **runtime polyfill** (e.g. `core-js`, Node.js ≥ 22, or a browser with native support)
- A **transpiler** that supports the `using` keyword (TypeScript ≥ 5.2 or Babel with
  `@babel/plugin-proposal-explicit-resource-management`)

## Install

```bash
npm i bidi-plain
```

## Features

- **Request-Response** — RPC-style calls with timeout and AbortSignal support
- **Subscriptions** — pub/sub pattern with automatic cleanup
- **Push** — fire-and-forget messages
- **Ping/Pong** — protocol-level, wire it to whatever heartbeat you need
- **Transport-agnostic** — works over any send/receive pair
- **Plain JSON** — messages are plain objects, serialize however you like

## Usage

```ts
import {createBidiEndpointPlain} from 'bidi-plain'

// Example: bidirectional messaging over a Web Worker
using endpoint = createBidiEndpointPlain({
	send(message) {
		postMessage(message)
	},
	subscribe(body, onData) {
		if (body?.path === '/atom') {
			return atom.sub(v => onData(v))
		}
	},
	async request(body, signal) {
		if (body?.path === '/set-config') return updateConfig(body)
	},
	push(body) {
		handlePush(body)
	},
})

// Feed incoming messages from the other side
self.onmessage = ({data}) => endpoint.send(data)

// Subscribe to peer data
using unsub = endpoint.subscribe({path: '/topic', name: '/events'}, data => {
	console.log('event:', data)
})

// RPC call with timeout and abort
const result = await endpoint.request(
	{path: '/service', name: '/query', body: {id: 123}},
	{timeout: 30_000},
)

// Fire-and-forget
endpoint.push({path: '/notify', body: {event: 'click'}})
```

### Heartbeat

`/ping` is answered with `/pong` automatically. To run your own heartbeat, send `/ping` on an interval and listen for
`/pong` via the setter:

```ts
endpoint.pong = () => {
	// peer is alive
}
setInterval(() => endpoint.send({path: '/ping'}), 30_000)
```

## Errors

Only a `request` handler may throw: `bidi-plain` sends the error back to the caller, its `code` included. A call handler
never catches to answer.

| thrown in                                                | may throw? | becomes                                                                             |
|----------------------------------------------------------|------------|-------------------------------------------------------------------------------------|
| a `request` handler, sync or async                       | yes        | the caller's `request` rejects: the same `message`, a string `code` as `cause.code` |
| a subscriber's `onData`, a `subscribe` or `push` handler | no         | uncaught: it reaches the link's message listener                                    |

- An `onData`, `subscribe` or `push` handler never throws. Make sure it can't fail, or catch every error inside it and
  handle it there.
- On a Node side, an uncaught error **crashes the process**: the whole server, Electron main or the thread, with every
  peer on it. An async handler's rejection is unhandled and crashes it too.

```ts
// a request handler throws to answer with an error
async request(body, signal) {
	if (!body?.id) throw Object.assign(new Error('id required'), {code: 'e_bad_request'})
	return await load(body.id, signal)
}

// on the caller
try {
	await endpoint.request({path: '/load'})
} catch (e) {
	e.message // 'id required'
	e.cause.code // 'e_bad_request'
}

// a subscriber catches its own errors
endpoint.subscribe({path: '/topic'}, data => {
	try {
		render(data)
	} catch (e) {
		report(e)
	}
})
```

- The caller's `request` also rejects on its timeout (`Error('timeout')`), its `signal` (`AbortError`) and the
  endpoint's end (`Error('endpoint disposed')`).
- The handler's `signal` aborts when the caller gives up or the endpoint ends; a late answer is dropped. A long handler
  honors it.
- A call to a side with no `request` handler is dropped: the caller waits for its timeout.

## Message Protocol

The protocol uses 9 message types:

| Path     | Purpose                  | Fields                           |
|----------|--------------------------|----------------------------------|
| `/ping`  | Heartbeat request        | —                                |
| `/pong`  | Heartbeat response       | —                                |
| `/req`   | Request                  | `id`, `body?`                    |
| `/res`   | Response                 | `id`, `body?`, `error?`, `code?` |
| `/abort` | Caller gave up on `/req` | `id`                             |
| `/sub`   | Subscribe                | `id`, `body?`                    |
| `/unsub` | Unsubscribe              | `id`                             |
| `/pub`   | Publish to subscriber    | `id`, `body?`                    |
| `/push`  | Push notification        | `id`, `body`                     |

## API

### `createBidiEndpointPlain(options)`

Create an endpoint. Options:

- `send(message)` — transport send function (required)
- `request(body, signal)` — handler for incoming requests; may throw to reject the caller (see [Errors](#errors))
- `subscribe(body, onData)` — handler for incoming subscriptions, return `Disposable` for cleanup; must not throw
- `push(body)` — handler for incoming push messages; must not throw

Returns a `Disposable` endpoint with:

- `send(message)` — feed incoming messages from the peer; rethrows what a `subscribe` or `push` handler or an `onData`
  throws
- `request(body, options?)` — send a request (`options: {timeout?, signal?}`, default timeout 10s)
- `subscribe(body, onData)` — subscribe to a topic, returns `Disposable`; `onData` must not throw
- `push(body)` — send a push message
- `pong` (setter) — callback invoked when a `/pong` is received from the peer
- `[Symbol.dispose]()` — cleanup (use with `using`)

## License

MIT
