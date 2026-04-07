import {protoDecodeJson, protoEncodeJson, ProtoMessage} from './protobuf.js'

export type BidiEndpointBinary = ReturnType<typeof makeBidiEndpointBinary>
export function makeBidiEndpointBinary({
	send,
	subscribe,
	request,
	push,
}: {
	send(message: Uint8Array): void
	subscribe?(body: any, onData: (data: Uint8Array) => void): void | Disposable
	request?(body: any, signal: AbortSignal): Promise<Uint8Array>
	push?(body: any): any
}) {
	using stack = new DisposableStack()

	let pong: (() => void) | undefined

	// subscription to response to partner. need to unsub when
	// - partner unsubscribes
	// - connection closes
	const allDisposable = stack.adopt({} as Record<string, Disposable>, allDisposable => {
		for (const [key, disposable] of Object.entries(allDisposable)) {
			disposable[Symbol.dispose]()
			delete allDisposable[key]
		}
	})

	// callback of subscription we are subscribing to
	const subs: Record<string, (data: Uint8Array) => any> = {}

	// requests we sent to partner and are waiting for response
	const defers: Record<string, PromiseWithResolvers<Uint8Array>> = {}

	// requests list we need to response when partner sends us
	// need to abort local processes if the partner sends but connection closes before finishing processing
	const reqs = stack.adopt({} as Record<string, () => void>, reqs => {
		for (const [key, abort] of Object.entries(reqs)) {
			abort?.()
			delete reqs[key]
		}
	})

	const moved = stack.move()
	return {
		send(this: void, message: Uint8Array) {
			const decoded = (() => {
				try {
					return ProtoMessage.decode(message) as any
				} catch (e) {
					logJson({
						level: 'warn',
						message: 'bidirectional message decode error',
						error: (e as Error).message,
						trace: (e as Error).stack,
					})
				}
			})()
			if (!decoded) return

			if (decoded.ping)
				send(
					ProtoMessage.encode({
						pong: {},
					}).finish(),
				)
			else if (decoded.pong) pong?.()
			else if (decoded.sub) {
				const {id, body} = decoded.sub
				if (!id) return
				allDisposable[id]?.[Symbol.dispose]()
				let decodedBody
				try {
					decodedBody = protoDecodeJson(body)
				} catch (e) {
					return logJson({
						level: 'warn',
						message: 'bidirectional message decode error for sub',
						error: (e as Error).message,
						trace: (e as Error).stack,
						id,
						bodyLength: body?.byteLength,
					})
				}
				const disposable = subscribe?.(decodedBody, data =>
					send(
						ProtoMessage.encode({
							pub: {
								id,
								body: data,
							},
						}).finish(),
					),
				)
				if (disposable) allDisposable[id] = disposable
			} else if (decoded.unsub) {
				const {id} = decoded.unsub
				if (!id) return
				allDisposable[id]?.[Symbol.dispose]()
				delete allDisposable[id]
			} else if (decoded.pub) {
				const {id, body} = decoded.pub
				if (!id) return
				void (async () => {
					try {
						await subs[id]?.(body)
					} catch (e) {
						logJson({
							level: 'warn',
							message: 'bidirectional message pub error',
							error: (e as Error).message,
							trace: (e as Error).stack,
							bodyLength: body?.byteLength,
							id,
						})
					}
				})()
			} else if (decoded.req) {
				const {id, body} = decoded.req
				if (!id) return
				if (request) {
					const abortController = new AbortController()
					reqs[id]?.()
					reqs[id] = abortController.abort.bind(abortController)
					void (async () => {
						try {
							send(
								ProtoMessage.encode({
									res: {
										id,
										body: await request(protoDecodeJson(body), abortController.signal),
									},
								}).finish(),
							)
						} catch (e) {
							send(
								ProtoMessage.encode({
									res: {
										id,
										error: (e as Error).message,
										code: (e as any).code,
									},
								}).finish(),
							)
						} finally {
							delete reqs[id]
						}
					})()
				}
			} else if (decoded.res) {
				const {id, body, error, code} = decoded.res
				if (!id) return
				const defer = defers[id]
				if (defer) {
					if (error || code) defer.reject(new Error(error || 'unknown error', {cause: {code}}))
					else defer.resolve(body)
				}
			} else if (decoded.push) {
				const {body} = decoded.push
				let decodedBody
				try {
					decodedBody = protoDecodeJson(body)
				} catch (e) {
					return logJson({
						level: 'warn',
						message: 'bidirectional message decode error for push',
						error: (e as Error).message,
						trace: (e as Error).stack,
						bodyLength: body?.byteLength,
					})
				}
				push?.(decodedBody)
			} else console.warn('unknown bidirectional message', decoded)
		},
		ping(this: void) {
			send(
				ProtoMessage.encode({
					ping: {},
				}).finish(),
			)
		},
		set pong(cb: undefined | (() => void)) {
			pong = cb
		},
		async request<T>(
			this: void,
			body: any,
			{
				timeout = 10_000,
				signal,
			}: {
				timeout?: number
				signal?: AbortSignal
			} = {},
		) {
			using stack = new DisposableStack()
			const defer = Promise.withResolvers<Uint8Array>()

			const id = crypto.randomUUID()
			defers[id]?.reject(new Error('duplicated request id'))
			defers[id] = defer
			stack.defer(() => void delete defers[id])

			const abortError = new DOMException('Aborted', 'AbortError')
			if (signal?.aborted) defer.reject(abortError)
			else {
				signal?.addEventListener('abort', () => defer.reject(abortError), {
					signal: stack.adopt(new AbortController(), controller => controller.abort()).signal,
				})

				if (timeout)
					stack.adopt(
						setTimeout(() => defer.reject(new Error('timeout')), timeout),
						clearTimeout,
					)

				send(
					ProtoMessage.encode({
						req: {
							id,
							body: protoEncodeJson(body),
						},
					}).finish(),
				)
			}

			return await defer.promise
		},
		subscribe(this: void, body: any, onData: (data: Uint8Array) => void) {
			const id = crypto.randomUUID()
			send(
				ProtoMessage.encode({
					sub: {
						id,
						body: protoEncodeJson(body),
					},
				}).finish(),
			)
			subs[id] = onData
			return {
				[Symbol.dispose]() {
					delete subs[id]
					send(
						ProtoMessage.encode({
							unsub: {id},
						}).finish(),
					)
				},
			}
		},
		push(body: any) {
			send(
				ProtoMessage.encode({
					push: {
						id: crypto.randomUUID(),
						body: protoEncodeJson(body),
					},
				}).finish(),
			)
		},
		[Symbol.dispose]: moved[Symbol.dispose].bind(moved),
	}
}

function logJson(json: any) {
	console.log(JSON.stringify(json))
}
