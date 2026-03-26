import {WebSocket as WsWebSocket} from 'ws'
import {type Disposer, makeDisposer} from 'jdisposer'
import {type Atom, makeAtom} from 'j-atom'
import {BidiEndpointBinary} from './bidiBinary.js'
import {addBidiEndpointShared, connectWsShared} from './wsShared.js'

export function addNodeWsHeartBeat(ws: WsWebSocket) {
	let pongTimer: ReturnType<typeof setTimeout> | undefined // after ping, wait for pong
	let pingTimer: ReturnType<typeof setTimeout> | undefined // to schedule next ping

	ws.on('pong', () => {
		if (pongTimer) clearTimeout(pongTimer)
		pongTimer = undefined
		if (pingTimer) clearTimeout(pingTimer)
		pingTimer = setTimeout(ping, 30_000)
	})
	ping()

	return () => {
		if (pingTimer) clearTimeout(pingTimer)
		if (pongTimer) clearTimeout(pongTimer)
	}

	function ping() {
		pingTimer = undefined
		ws.ping(() => {}) // do nothing
		pongTimer = setTimeout(() => {
			logJson({
				level: 'warn',
				message: 'ws ping timeout',
			})
			if ([WebSocket.CONNECTING, WebSocket.OPEN].includes(ws.readyState as any)) {
				ws.close(1000, 'ping timeout')
				ws.terminate()
			}
		}, 5_000)
	}
}

function logJson(json: any) {
	console.log(JSON.stringify(json))
}

export async function connectWsNode({
	url,
	disableDeflate,
	...params
}: {
	url: string
	disposer: Disposer
	atom: Atom<WsWebSocket | undefined>
	resetBackoff?(): void
	disableDeflate?: boolean
}) {
	const ws = new WsWebSocket(url, {
		perMessageDeflate: !disableDeflate,
	})
	ws.binaryType = 'arraybuffer'

	params.disposer.add(() => {
		if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, 'closed')
	})
	return connectWsShared(ws, params)
}

export function addBidiEndpointNode(
	endpointAtom: Atom<BidiEndpointBinary | undefined>,
	wsPath: string,
	options?: {
		subscribe?(body: any, onData: (data: any) => void): void | (() => void)
		request?(body: any, signal: AbortSignal): Promise<any>
		push?(body: any): any
	},
) {
	const disposer = makeDisposer()

	const endpointAndWsAtom = makeAtom<{endpoint: BidiEndpointBinary; ws: WsWebSocket} | undefined>()
	disposer.add(addBidiEndpointShared(connectWsNode, endpointAndWsAtom, wsPath, options))
	disposer.add(
		endpointAndWsAtom.sub(endpointAndWs => {
			endpointAtom.value = endpointAndWs?.endpoint
			if (endpointAndWs) return addNodeWsHeartBeat(endpointAndWs.ws)
		}),
	)

	return disposer.dispose
}
