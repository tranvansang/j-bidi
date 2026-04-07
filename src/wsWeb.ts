import {type Atom, makeAtom} from 'j-atom'
import {type BidiEndpointBinary} from './bidiBinary.js'
import {makeBidiEndpointShared, connectWsShared} from './wsShared.js'

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

export function makeBidiEndpointWeb(
	endpointAtom: Atom<BidiEndpointBinary | undefined>,
	wsPath: string,
	options?: {
		subscribe?(body: any, onData: (data: any) => void): void | Disposable
		request?(body: any, signal: AbortSignal): Promise<any>
		push?(body: any): any
	},
) {
	using stack = new DisposableStack()
	const endpointAndWsAtom = makeAtom<{endpoint: BidiEndpointBinary; ws: WebSocket} | undefined>()

	stack.use(makeBidiEndpointShared<WebSocket>(connectWsWeb, endpointAndWsAtom, wsPath, options))

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
					pingTimer = setTimeout(ping, 30_000)
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
						if ([WebSocket.CONNECTING, WebSocket.OPEN].includes(ws.readyState as any)) ws.close(1000, 'ping timeout')
					}, 5_000)
				}
			}
		}),
	)

	return stack.move()
}
