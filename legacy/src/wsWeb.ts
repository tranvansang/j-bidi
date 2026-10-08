import {type Atom, makeAtom} from 'j-atom'
import {type BidiEndpointBinary} from './bidiBinary.js'
import {connectWsShared, createBidiEndpointShared} from './wsShared.js'

function connectWsWeb({url, ...params}: {atom: Atom<WebSocket | undefined>; url: string; resetBackoff?(): void}) {
	using stack = new DisposableStack()
	const ws = stack.adopt(new WebSocket(url), ws => {
		if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, 'closed')
	})
	ws.binaryType = 'arraybuffer'
	const promise = stack.use(connectWsShared(ws, params))
	const moved = stack.move()
	return Object.assign(promise, {
		[Symbol.dispose]: moved[Symbol.dispose].bind(moved),
	})
}

export function createBidiEndpointWeb(
	endpointAtom: Atom<BidiEndpointBinary | undefined>,
	wsPath: string,
	{
		pingInterval = 30_000,
		pongTimeout = 5_000,
		...options
	}: {
		subscribe?(body: any, onData: (data: any) => void): void | Disposable
		request?(body: any, signal: AbortSignal): Promise<any>
		push?(body: any): any
		pingInterval?: number // ms between a pong and the next ping, default 30s
		pongTimeout?: number // ms to wait for a pong before dropping the socket, default 5s
	} = {},
) {
	using stack = new DisposableStack()

	const wsAtom = makeAtom<WebSocket | undefined>()
	const endpointAndWsAtom = makeAtom<{endpoint: BidiEndpointBinary; ws: WebSocket} | undefined>()
	stack.use(wsAtom.sub(ws => createBidiEndpointShared<WebSocket>(ws, endpointAndWsAtom, options)))

	stack.use(
		endpointAndWsAtom.sub(endpointAndWs => {
			endpointAtom.value = endpointAndWs?.endpoint
			if (endpointAndWs) {
				// setup heart beat
				let pongTimer: ReturnType<typeof setTimeout> | undefined // after ping, wait for pong
				let pingTimer: ReturnType<typeof setTimeout> | undefined // to schedule next ping

				const {endpoint, ws} = endpointAndWs
				endpoint.pong = () => {
					if (pongTimer) clearTimeout(pongTimer)
					pongTimer = undefined
					if (pingTimer) clearTimeout(pingTimer)
					pingTimer = setTimeout(ping, pingInterval)
				}
				ping()
				return {
					[Symbol.dispose]() {
						if (pongTimer) clearTimeout(pongTimer)
						if (pingTimer) clearTimeout(pingTimer)
					},
				}
				function ping() {
					pingTimer = undefined
					endpoint.ping()
					pongTimer = setTimeout(() => {
						console.warn('ws ping timeout')
						if (![WebSocket.CONNECTING, WebSocket.OPEN].includes(ws.readyState as any)) return
						ws.close(1000, 'ping timeout')
						// on a dead link, the close handshake never completes and the browser fires onclose only after its own
						// timeout (~60s in Chrome), and there's no terminate() like in ws. Report the disconnect now so the
						// caller reconnects; the real close event later is a no-op since the promises are already settled.
						ws.onclose?.(new CloseEvent('close', {code: 1006, reason: 'ping timeout'}))
					}, pongTimeout)
				}
			}
		}),
	)

	const moved = stack.move()
	return Object.assign(
		(resetBackoff: () => any) =>
			connectWsWeb({
				atom: wsAtom,
				url: wsPath,
				resetBackoff,
			}),
		{
			[Symbol.dispose]: moved[Symbol.dispose].bind(moved),
		},
	)
}
