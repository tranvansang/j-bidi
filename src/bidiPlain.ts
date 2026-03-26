import {makeDisposer} from 'jdisposer'
import {addEvtListener} from 'jrx'

type SendPayload =
	| {
			path: '/ping'
	  }
	| {
			path: '/pong'
	  }
	| {
			path: '/sub'
			id: string
			body?: any
	  }
	| {
			path: '/pub'
			id: string
			body?: any
	  }
	| {
			path: '/unsub'
			id: string
	  }
	| {
			path: '/req'
			id: string
			body?: any
	  }
	| {
			path: '/res'
			id: string
			body?: any
			error?: string
			code?: string
	  }
	| {
			path: '/push'
			id: string
			body?: string
	  }

export type BidiEndpointPlain = ReturnType<typeof makeBidiEndpointPlain>
export function makeBidiEndpointPlain({
	send,
	subscribe,
	request,
	push,
}: {
	send(message: SendPayload, ...rest: any[]): void
	subscribe?(body: any, onData: (data: any) => void): void | (() => void)
	request?(body: any, signal: AbortSignal): Promise<any>
	push?(body: any): any
}) {
	const disposer = makeDisposer()

	let pong: (() => void) | undefined

	// subscription to response to partner. need to unsub when
	// - partner unsubscribes
	// - connection closes
	const unsubs: Record<string, () => any> = {}
	disposer.add(() => {
		for (const [key, unsub] of Object.entries(unsubs)) {
			unsub?.()
			delete unsubs[key]
		}
	})

	// callback of subscription we are subscribing to
	const subs: Record<string, (data: any) => any> = {}

	// requests we sent to partner and are waiting for response
	const defers: Record<string, PromiseWithResolvers<any>> = {}

	// requests list we need to response when partner sends us
	// need to abort local processes if the partner sends but connection closes before finishing processing
	const reqs: Record<string, () => void> = {}
	disposer.add(() => {
		for (const [key, abort] of Object.entries(reqs)) {
			abort?.()
			delete reqs[key]
		}
	})

	return {
		send(this: void, message: SendPayload) {
			switch (message?.path) {
				case '/ping':
					send({path: '/pong'})
					break
				case '/pong':
					pong?.()
					break
				case '/sub':
					{
						const {id, body} = message
						if (!id) return
						unsubs[id]?.()
						const sub = subscribe?.(body, data =>
							send({
								path: '/pub',
								id,
								body: data,
							}),
						)
						if (sub) unsubs[id] = sub
					}
					break
				case '/unsub':
					{
						const {id} = message
						if (!id) return
						unsubs[id]?.()
						delete unsubs[id]
					}
					break
				case '/pub':
					{
						const {id, body} = message
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
									id,
								})
							}
						})()
					}
					break
				case '/req':
					{
						const {id, body} = message
						if (!id) return
						if (request) {
							const abortController = new AbortController()
							reqs[id]?.()
							reqs[id] = abortController.abort.bind(abortController)
							void (async () => {
								try {
									send({
										path: '/res',
										id,
										body: await request(body, abortController.signal),
									})
								} catch (e) {
									send({
										path: '/res',
										id,
										error: (e as Error).message,
										code: (e as any).code,
									})
								} finally {
									delete reqs[id]
								}
							})()
						}
					}
					break
				case '/res':
					{
						const {id, body, error, code} = message
						if (!id) return
						const defer = defers[id]
						if (defer) {
							if (error || code) defer.reject(new Error(error || 'unknown error', {cause: {code}}))
							else defer.resolve(body)
						}
					}
					break
				case '/push':
					{
						const {body} = message
						push?.(body)
					}
					break
				default:
					console.warn('unknown bidirectional message path', (message as any)?.path)
			}
		},
		set pong(cb: undefined | (() => void)) {
			pong = cb
		},
		request<T>(
			this: void,
			body: any,
			{
				timeout = 10_000,
				signal,
			}: {
				timeout?: number
				signal?: AbortSignal
			} = {},
			...rest: any[]
		) {
			const disposer = makeDisposer()
			const defer = Promise.withResolvers<T>()

			const id = crypto.randomUUID()
			defers[id]?.reject(new Error('duplicated request id'))
			defers[id] = defer
			disposer.add(() => void delete defers[id])

			const abortError = new DOMException('Aborted', 'AbortError')
			if (signal?.aborted) defer.reject(abortError)
			else {
				if (signal) disposer.add(
						addEvtListener(signal, 'abort', () =>
							defer.reject(abortError)
					))

				if (timeout) {
					const timer = setTimeout(() => defer.reject(new Error('timeout')), timeout)
					disposer.add(() => clearTimeout(timer))
				}

				send(
					{
						path: '/req',
						id,
						body,
					},
					...rest,
				)
			}

			return (async () => {
				try {
					return await defer.promise
				} finally {
					disposer.dispose()
				}
			})()
		},
		subscribe<T>(this: void, body: any, onData: (data: T) => void, ...rest: any[]) {
			const id = crypto.randomUUID()
			send(
				{
					path: '/sub',
					id,
					body,
				},
				...rest,
			)
			subs[id] = onData
			return () => {
				delete subs[id]
				send({path: '/unsub', id})
			}
		},
		push(body: any, ...rest: any[]) {
			send(
				{
					path: '/push',
					id: crypto.randomUUID(),
					body,
				},
				...rest,
			)
		},
		dispose: disposer.dispose,
	}
}

function logJson(json: any) {
	console.log(JSON.stringify(json))
}
