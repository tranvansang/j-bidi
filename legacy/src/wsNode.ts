import {WebSocket as WsWebSocket} from 'ws'
import {type Atom, makeAtom} from 'j-atom'
import {BidiEndpointBinary} from './bidiBinary.js'
import {connectWsShared, createBidiEndpointShared} from './wsShared.js'

export function createNodeWsHeartBeat(
	ws: WsWebSocket,
	{pingInterval = 30_000, pongTimeout = 5_000}: {pingInterval?: number; pongTimeout?: number} = {},
) {
	let pongTimer: ReturnType<typeof setTimeout> | undefined // after ping, wait for pong
	let pingTimer: ReturnType<typeof setTimeout> | undefined // to schedule next ping

	ws.on('pong', () => {
		if (pongTimer) clearTimeout(pongTimer)
		pongTimer = undefined
		if (pingTimer) clearTimeout(pingTimer)
		pingTimer = setTimeout(ping, pingInterval)
	})
	ping()

	return {
		[Symbol.dispose]() {
			if (pingTimer) clearTimeout(pingTimer)
			if (pongTimer) clearTimeout(pongTimer)
		},
	}

	function ping() {
		pingTimer = undefined
		ws.ping(() => {}) // do nothing
		pongTimer = setTimeout(() => {
			logJson({
				level: 'warn',
				message: 'ws ping timeout',
			})
			if ([WebSocket.CONNECTING, WebSocket.OPEN].includes(ws.readyState as any)) ws.close(1000, 'ping timeout')
			// also when already CLOSING: a handshake started earlier may hang until ws's own 30s close timeout
			ws.terminate()
		}, pongTimeout)
	}
}

function logJson(json: any) {
	console.log(JSON.stringify(json))
}

export function connectWsNode({
	url,
	disableDeflate,
	...params
}: {
	url: string
	atom: Atom<WsWebSocket | undefined>
	resetBackoff?(): void
	disableDeflate?: boolean
}) {
	using stack = new DisposableStack()
	const ws = stack.adopt(
		new WsWebSocket(url, {
			perMessageDeflate: !disableDeflate,
		}),
		ws => {
			if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, 'closed')
		},
	)
	ws.binaryType = 'arraybuffer'
	const promise = stack.use(connectWsShared(ws, params))
	const moved = stack.move()
	return Object.assign(promise, {
		[Symbol.dispose]: moved[Symbol.dispose].bind(moved),
	})
}

export function createBidiEndpointNode(
	endpointAtom: Atom<BidiEndpointBinary | undefined>,
	wsPath: string,
	options?: {
		subscribe?(body: any, onData: (data: any) => void): void | Disposable
		request?(body: any, signal: AbortSignal): Promise<any>
		push?(body: any): any
		pingInterval?: number // ms between a pong and the next ping, default 30s
		pongTimeout?: number // ms to wait for a pong before dropping the socket, default 5s
	},
) {
	using stack = new DisposableStack()

	const wsAtom = makeAtom<WsWebSocket | undefined>()
	const endpointAndWsAtom = makeAtom<{endpoint: BidiEndpointBinary; ws: WsWebSocket} | undefined>()
	stack.use(wsAtom.sub(ws => createBidiEndpointShared(ws, endpointAndWsAtom, options)))

	stack.use(
		endpointAndWsAtom.sub(endpointAndWs => {
			endpointAtom.value = endpointAndWs?.endpoint
			if (endpointAndWs) return createNodeWsHeartBeat(endpointAndWs.ws, options)
		}),
	)

	const moved = stack.move()
	return Object.assign((resetBackoff: () => any) =>
		connectWsNode({
				atom: wsAtom,
				url: wsPath,
				resetBackoff,
			}), {
		[Symbol.dispose]: moved[Symbol.dispose].bind(moved),
	})
}
