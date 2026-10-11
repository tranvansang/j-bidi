# j-bidi

Bidirectional messaging library supporting request-response, subscriptions, and push notifications, encoded as binary (protobuf).
Ships with browser WebSocket and Node.js `ws` backends, with a heartbeat. A connection rejects once its socket closes, so reconnecting is a retry loop around it.

If you only need plain JSON over your own transport (no protobuf, no bundled WebSocket), use [`bidi-plain`](../bidi-plain) instead — it's the transport-agnostic core.

## Requirements

This library uses the [Explicit Resource Management](https://github.com/tc39/proposal-explicit-resource-management) API (`using`, `DisposableStack`). Your environment needs:

- A **runtime polyfill** (e.g. `core-js`, Node.js ≥ 22, or a browser with native support)
- A **transpiler** that supports the `using` keyword (TypeScript ≥ 5.2 or Babel with `@babel/plugin-proposal-explicit-resource-management`)

## Install

```bash
npm i j-bidi
```

## Features

- **Request-Response** — RPC-style calls with timeout and AbortSignal support
- **Subscriptions** — pub/sub pattern with automatic cleanup
- **Push** — fire-and-forget messages
- **Ping/Pong** — built-in heartbeat (30s interval, 5s timeout by default)
- **Reconnect** — a connection rejects once its socket closes, ready for your retry loop
- **Binary encoding** — compact protobuf wire format
- **Cross-platform** — browser (WebSocket API) and Node.js (`ws`)

## Usage

### Browser

```ts
import {type BidiEndpointBinary, createBidiEndpointWeb} from 'j-bidi'
import {makeAtom} from 'j-atom'

// holds the endpoint while a connection is open
const endpointAtom = makeAtom<BidiEndpointBinary | undefined>()

// What makes one connection, with a heartbeat
using connect = createBidiEndpointWeb(endpointAtom, 'wss://example.com/ws', {
	subscribe(body, onData) {
		if (body?.path === '/topic') {
			return dataAtom.sub(data => onData(encode(data)))
		}
	},
	async request(body, signal) {
		if (body?.path === '/set-config') return updateConfig(body)
	},
	push(body) {
		console.log('received push:', body)
	},
})

// Use the endpoint
const endpoint = endpointAtom.value

// Subscribe to server data
using unsub = endpoint?.subscribe({path: '/topic', name: '/events'}, data => {
	console.log('event:', data)
})

// RPC call with timeout and abort
const result = await endpoint?.request(
	{path: '/service', name: '/query', body: {id: 123}},
	{timeout: 30_000},
)

// Fire-and-forget
endpoint?.push({path: '/notify', body: {event: 'click'}})
```

One connection never resolves, and rejects once its socket closes, misses a pong or can't open. Keep one in a loop to reconnect:

```ts
let failures = 0
while (true) {
	try {
		// its argument is called when the socket opens: start the backoff over
		using connection = connect(() => void (failures = 0))
		await connection
	} catch (e) {
		console.warn(e)
		await new Promise(resolve => setTimeout(resolve, Math.min(1000 * 2 ** failures++, 30_000)))
	}
}
```

### Node.js

```ts
import {createBidiEndpointNode} from 'j-bidi/node'
import {makeAtom} from 'j-atom'

const endpointAtom = makeAtom<BidiEndpointBinary | undefined>()

// as in the browser: call `connect(resetBackoff)` in your retry loop
using connect = createBidiEndpointNode(endpointAtom, 'wss://example.com/ws', {
	subscribe(body, onData) {
		if (body?.path === '/topic') {
			return sensorAtom.sub(data => onData(encode(data)))
		}
	},
})
```

### Server-side WebSocket handling

```ts
import {createBidiEndpointBinary} from 'j-bidi'
import {createNodeWsHeartBeat} from 'j-bidi/node'

wsServer.handleUpgrade(req, socket, head, ws => {
	const stack = new DisposableStack()
	stack.use(createNodeWsHeartBeat(ws))

	const endpoint = stack.use(createBidiEndpointBinary({
		send(message) {
			if (ws.readyState === WebSocket.OPEN) ws.send(message)
		},
		subscribe(body, onData) {
			if (body?.path === '/topic') {
				return dataAtom.sub(data => onData(encode(data)))
			}
		},
		async request(body, signal) {
			switch (body?.path) {
				case '/set-rtc':
					return handleSetRtc(body)
			}
		},
	}))

	ws.on('message', data => {
		if (data instanceof Uint8Array) endpoint.send(data)
	})
	ws.on('close', () => stack.dispose())
})
```

### Custom transport (plain JSON)

For non-WebSocket transports (Web Workers, `postMessage`, MessageChannel, etc.) using plain JSON, see the sibling [`bidi-plain`](../bidi-plain) package.

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

### `j-bidi`

#### `createBidiEndpointBinary(options)`

Create a protobuf-encoded endpoint. Options:

- `send(message)` — transport send function (required)
- `request(body, signal)` — handler for incoming requests
- `subscribe(body, onData)` — handler for incoming subscriptions, return `Disposable` for cleanup
- `push(body)` — handler for incoming push messages

Returns a `Disposable` endpoint with:

- `send(message)` — feed incoming messages from the peer
- `request(body, options?)` — send a request (`options: {timeout?, signal?}`); it rejects with `endpoint disposed` when the endpoint is disposed before the response
- `subscribe(body, onData)` — subscribe to a topic, returns `Disposable`
- `push(body)` — send a push message
- `[Symbol.dispose]()` — cleanup (use with `using`)

#### `createBidiEndpointWeb(endpointAtom, wsUrl, options?)`

Prepare connections over the browser WebSocket, with a heartbeat. Returns a `Disposable` function `connect(resetBackoff)`. Each call opens one connection and returns a `Disposable & Promise<void>` that never resolves, and rejects with an `Error` once the socket closes, misses a pong or can't open. `endpointAtom` holds the endpoint while a connection is open, and `resetBackoff()` is called when one opens. Call `connect` again to reconnect, typically in a retry loop. Options: `subscribe?`, `request?`, `push?`, `pingInterval?` (ms, default `30_000`), `pongTimeout?` (ms, default `5_000`).

### `j-bidi/node`

#### `createBidiEndpointNode(endpointAtom, wsUrl, options?)`

The same over Node.js `ws`. Returns the same `connect(resetBackoff)` function. Options: same as `createBidiEndpointWeb`.

#### `connectWsNode(options)`

Low-level Node.js WebSocket connection. Returns a `Disposable & Promise<void>`. Options: `url`, `atom`, `resetBackoff?`, `disableDeflate?`.

#### `createNodeWsHeartBeat(ws, options?)`

Add ping/pong heartbeat to a Node.js WebSocket. Options: `pingInterval?` (ms, default `30_000`), `pongTimeout?` (ms, default `5_000`). Returns a `Disposable` (use with `stack.use()` or `using`).

## License

MIT
