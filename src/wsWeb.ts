import {type Disposer, makeDisposer} from 'jdisposer'
import {type Atom, makeAtom} from 'j-atom'
import {type BidiEndpointBinary} from './bidiBinary.js'
import {addBidiEndpointShared, connectWsShared} from './wsShared.js'

async function connectWsWeb({
	url,
	...params
}: {
	disposer: Disposer
	atom: Atom<WebSocket | undefined>
	url: string
	resetBackoff?(): void
}) {
	const ws = new WebSocket(url)
	ws.binaryType = 'arraybuffer'
	params.disposer.add(() => {
		if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, 'closed')
	})
	return connectWsShared(ws, params)
}

export function addBidiEndpointWeb(
	endpointAtom: Atom<BidiEndpointBinary | undefined>,
	wsPath: string,
	options?: {
		subscribe?(body: any, onData: (data: any) => void): void | (() => void)
		request?(body: any, signal: AbortSignal): Promise<any>
		push?(body: any): any
	},
) {
	const disposer = makeDisposer()
	const endpointAndWsAtom = makeAtom<{endpoint: BidiEndpointBinary; ws: WebSocket} | undefined>()

	disposer.add(addBidiEndpointShared<WebSocket>(connectWsWeb, endpointAndWsAtom, wsPath, options))

	disposer.add(
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
				return () => {
					if (pongTimer) clearTimeout(pongTimer)
					if (pingTimer) clearTimeout(pingTimer)
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

	return disposer.dispose
}
