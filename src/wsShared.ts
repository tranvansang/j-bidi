import {Atom, makeAtom} from 'j-atom'
import {type WebSocket as WsWebSocket} from 'ws'
import {BidiEndpointBinary, makeBidiEndpointBinary} from './bidiBinary.js'
import {retry} from 'jrx'

export function connectWsShared<T extends WebSocket | WsWebSocket>(
	ws: T,
	{
		atom,
		resetBackoff,
	}: {
		atom: Atom<T | undefined>
		resetBackoff?(): void
	},
) {
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

	const stack = new DisposableStack()
	return Object.assign(
		(async () => {
			await connectedDefer.promise

			if (stack.disposed) return
			resetBackoff?.()

			atom.value = stack.adopt(ws, ws => {
				if (atom.value === ws) atom.value = undefined
			})

			return disconnectedDefer.promise
		})(),
		{[Symbol.dispose]: stack[Symbol.dispose].bind(stack)},
	)
}

export function addBidiEndpointShared<T extends WebSocket | WsWebSocket>(
	connectWs: (params: {atom: Atom<T | undefined>; url: string; resetBackoff?(): void}) => Disposable & Promise<void>,
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
	const stack = new DisposableStack()

	const wsAtom = makeAtom<T>()

	// pipeline websocket connection to a bidirectional endpoint
	stack.adopt(
		wsAtom.sub(ws => {
			if (!ws) return (endpointAndWsAtom.value = undefined)

			using stack = new DisposableStack()
			const endpoint = stack.use(
				makeBidiEndpointBinary({
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
				}),
			)

			endpointAndWsAtom.value = {endpoint, ws}

			ws.addEventListener(
				'message',
				({data}: any) => {
					// nodejs's Buffer extends Uint8Array
					if (data instanceof Uint8Array) return endpoint.send(data)

					// Web's WebSocket with binaryType = 'arraybuffer'
					if (data instanceof ArrayBuffer) return endpoint.send(new Uint8Array(data))

					console.warn('wsShared received non-binary data, expected Uint8Array or ArrayBuffer', typeof data)
				},
				{
					signal: stack.adopt(new AbortController(), controller => controller.abort()).signal,
				},
			)
			const moved = stack.move()
			return moved.dispose.bind(moved)
		}),
		x => x(),
	)

	// try connecting, until success, retry if disconnect, unless stack gets disposed
	void stack.use(
		retry(({resetBackoff}) =>
			connectWs({
				atom: wsAtom,
				url: wsPath,
				resetBackoff,
			}),
		),
	)

	return stack
}
