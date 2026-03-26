import {Disposer, makeDisposer} from 'jdisposer'
import {Atom, makeAtom} from 'j-atom'
import {type WebSocket as WsWebSocket} from 'ws'
import {BidiEndpointBinary, makeBidiEndpointBinary} from './bidiBinary.js'
import {addEvtListener, addRetry} from 'jrx'

export async function connectWsShared<T extends WebSocket | WsWebSocket>(
	ws: T,
	{
		disposer,
		atom,
		resetBackoff,
	}: {
		disposer: Disposer
		atom: Atom<T | undefined>
		resetBackoff?(): void
	},
) {
	if (disposer.signal.aborted) return

	let connected = false
	const connectedDefer = Promise.withResolvers<void>()
	const disconnectedDefer = Promise.withResolvers<void>()
	ws.onopen = () => {
		connected = true
		connectedDefer.resolve()
	}
	ws.onerror = (e: any) => {
		connectedDefer.reject(e)
		// only reject disconnectedDefer, AFTER connected. Otherwise, nodejs will crash since disconnectedDefer.promise is not awaited
		if (connected) disconnectedDefer.reject(e)
	}
	ws.onclose = (evt: CloseEvent) => {
		connectedDefer.reject(new Error(`WebSocket closed before open (${evt.code} ${evt.reason || ''})`))
		if (connected) disconnectedDefer.reject(new Error(`WebSocket closed (${evt.code} ${evt.reason || ''})`))
	}

	await connectedDefer.promise

	if (disposer.signal.aborted) return
	resetBackoff?.()

	atom.value = ws
	disposer.add(() => {
		if (atom.value === ws) atom.value = undefined
	})

	return disconnectedDefer.promise
}

export function addBidiEndpointShared<T extends WebSocket | WsWebSocket>(
	connectWs: (params: {
		disposer: Disposer
		atom: Atom<T | undefined>
		url: string
		resetBackoff?(): void
	}) => Promise<void>,
	endpointAndWsAtom: Atom<{endpoint: BidiEndpointBinary; ws: T} | undefined>,
	wsPath: string,
	{
		subscribe,
		request,
		push,
	}: {
		subscribe?(body: any, onData: (data: any) => void): void | (() => void)
		request?(body: any, signal: AbortSignal): Promise<any>
		push?(body: any): any
	} = {},
) {
	const disposer = makeDisposer()

	const wsAtom = makeAtom<T>()

	// pipeline websocket connection to a bidirectional endpoint
	disposer.add(
		wsAtom.sub(ws => {
			if (!ws) return (endpointAndWsAtom.value = undefined)

			const disposer = makeDisposer()
			const endpoint = makeBidiEndpointBinary({
				send(message) {
					// when connected:
					// - topic atom subscribes to dataSourceAtom, which subscribes to endpointAndWsAtom, which subscribes to wsAtom
					// - the subscription registers an unsubscription hook (*1)
					// when disconnected:
					// - ws's state becomes CLOSED
					// -> wsAtom.value becomes undefined
					// -> endpointAndWsAtom.value becomes undefined
					// -> dataSourceAtom.value becomes undefined
					// -> topic atom triggers unsubscription hook (*1)
					// -> the unsubscription hook is "bidirectional endpoint sends an /unsub message". However, the websocket already CLOSED, so we need to check readyState before sending.
					if (ws.readyState === WebSocket.OPEN) ws.send(message as Uint8Array<ArrayBuffer>)
					else console.warn('ws is closed, cannot send message wShared', message.length)
				},
				subscribe,
				request,
				push,
			})
			disposer.add(endpoint.dispose)

			endpointAndWsAtom.value = {endpoint, ws}

			disposer.add(
				addEvtListener(ws, 'message', ({data}: MessageEvent) => {
					// nodejs's Buffer extends Uint8Array
					if (data instanceof Uint8Array) return endpoint.send(data)

					// Web's WebSocket with binaryType = 'arraybuffer'
					if (data instanceof ArrayBuffer) return endpoint.send(new Uint8Array(data))

					console.warn('wsShared received non-binary data, expected Uint8Array or ArrayBuffer', typeof data)
				}),
			)

			return disposer.dispose
		}),
	)

	// try connecting, until success, retry if disconnect, unless disposer gets disposed
	disposer.add(
		addRetry((disposer, {resetBackoff}) =>
			connectWs({
				disposer,
				atom: wsAtom,
				url: wsPath,
				resetBackoff,
			}),
		),
	)

	return disposer.dispose
}
