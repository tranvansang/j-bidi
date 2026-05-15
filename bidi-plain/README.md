# bidi-plain

Transport-agnostic bidirectional messaging — request-response, subscriptions, and push — over plain JSON.

Bring your own transport (WebSocket, Web Worker, `postMessage`, MessageChannel, etc). The endpoint just hands you serializable messages to send and consumes messages you feed back in.

For the binary (protobuf) encoding and bundled WebSocket (browser + Node `ws`) backends with auto-reconnect and heartbeat, see [`j-bidi`](../legacy).

## Requirements

This library uses the [Explicit Resource Management](https://github.com/tc39/proposal-explicit-resource-management) API (`using`, `DisposableStack`). Your environment needs:

- A **runtime polyfill** (e.g. `core-js`, Node.js ≥ 22, or a browser with native support)
- A **transpiler** that supports the `using` keyword (TypeScript ≥ 5.2 or Babel with `@babel/plugin-proposal-explicit-resource-management`)

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

`/ping` is answered with `/pong` automatically. To run your own heartbeat, send `/ping` on an interval and listen for `/pong` via the setter:

```ts
endpoint.pong = () => {
	// peer is alive
}
setInterval(() => endpoint.send({path: '/ping'}), 30_000)
```

## Message Protocol

The protocol uses 8 message types:

| Path     | Purpose               | Fields                           |
|----------|-----------------------|----------------------------------|
| `/ping`  | Heartbeat request     | —                                |
| `/pong`  | Heartbeat response    | —                                |
| `/req`   | Request               | `id`, `body?`                    |
| `/res`   | Response              | `id`, `body?`, `error?`, `code?` |
| `/sub`   | Subscribe             | `id`, `body?`                    |
| `/unsub` | Unsubscribe           | `id`                             |
| `/pub`   | Publish to subscriber | `id`, `body?`                    |
| `/push`  | Push notification     | `id`, `body`                     |

## API

### `createBidiEndpointPlain(options)`

Create an endpoint. Options:

- `send(message)` — transport send function (required)
- `request(body, signal)` — handler for incoming requests
- `subscribe(body, onData)` — handler for incoming subscriptions, return `Disposable` for cleanup
- `push(body)` — handler for incoming push messages

Returns a `Disposable` endpoint with:

- `send(message)` — feed incoming messages from the peer
- `request(body, options?)` — send a request (`options: {timeout?, signal?}`, default timeout 10s)
- `subscribe(body, onData)` — subscribe to a topic, returns `Disposable`
- `push(body)` — send a push message
- `pong` (setter) — callback invoked when a `/pong` is received from the peer
- `[Symbol.dispose]()` — cleanup (use with `using`)

## License

MIT
