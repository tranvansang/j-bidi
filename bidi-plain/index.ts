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
			path: '/abort'
			id: string
	  }
	| {
			path: '/push'
			id: string
			body?: string
	  }

export type BidiEndpointPlain = ReturnType<typeof createBidiEndpointPlain>
export function createBidiEndpointPlain({
	send,
	subscribe,
	request,
	push,
}: {
	send(message: SendPayload, ...rest: any[]): void
	subscribe?(body: any, onData: (data: any) => void): void | Disposable
	request?(body: any, signal: AbortSignal): Promise<any>
	push?(body: any): any
}) {
	using stack = new DisposableStack()

	let pong: (() => void) | undefined
	let disposed = false
	stack.defer(() => void (disposed = true))

	// subscription to response to partner. need to unsub when
	// - partner unsubscribes
	// - connection closes
	const allDisposable = stack.adopt(Object.create(null) as Record<string, Disposable>, allDisposable => {
		for (const [key, disposable] of Object.entries(allDisposable)) {
			disposable[Symbol.dispose]()
			delete allDisposable[key]
		}
	})

	// callback of subscription we are subscribing to. need to drop when
	// - we unsubscribe
	// - connection closes
	const subs = stack.adopt(Object.create(null) as Record<string, (data: any) => any>, subs => {
		for (const key of Object.keys(subs)) delete subs[key]
	})

	// requests we sent to partner and are waiting for response
	// need to settle them when connection closes, else callers hang until timeout (forever if timeout is 0)
	const defers = stack.adopt(Object.create(null) as Record<string, PromiseWithResolvers<any>>, defers => {
		for (const [key, defer] of Object.entries(defers)) {
			defer.reject(new Error('endpoint disposed'))
			delete defers[key]
		}
	})

	// requests list we need to response when partner sends us
	// need to abort local processes if the partner sends but connection closes before finishing processing
	const reqs = stack.adopt(Object.create(null) as Record<string, AbortController>, reqs => {
		for (const [key, abortController] of Object.entries(reqs)) {
			abortController.abort()
			delete reqs[key]
		}
	})

	const moved = stack.move()
	return {
		send(this: void, message: SendPayload) {
			if (disposed) return
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
						allDisposable[id]?.[Symbol.dispose]()
						const disposable = subscribe?.(body, data => {
							if (disposed) return
							send({
								path: '/pub',
								id,
								body: data,
							})
						})
						if (disposable) allDisposable[id] = disposable
					}
					break
				case '/unsub':
					{
						const {id} = message
						if (!id) return
						allDisposable[id]?.[Symbol.dispose]()
						delete allDisposable[id]
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
							// unique per message, so it doubles as the identity of this run
							const abortController = new AbortController()
							reqs[id]?.abort()
							reqs[id] = abortController
							void (async () => {
								try {
									const responseBody = await request(body, abortController.signal)
									if (disposed || reqs[id] !== abortController) return
									send({
										path: '/res',
										id,
										body: responseBody,
									})
								} catch (e) {
									if (disposed || reqs[id] !== abortController) return
									send({
										path: '/res',
										id,
										error: (e as Error)?.message || String(e) || 'unknown error',
										code: (e as any)?.code,
									})
								} finally {
									// a newer /req may own the id by now, and its entry must survive
									if (reqs[id] === abortController) delete reqs[id]
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
				case '/abort':
					{
						const {id} = message
						if (!id) return
						reqs[id]?.abort()
						delete reqs[id]
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
			...rest: any[]
		) {
			if (disposed) throw new Error('endpoint disposed')

			using stack = new DisposableStack()
			const defer = Promise.withResolvers<T>()

			const id = crypto.randomUUID()
			defers[id]?.reject(new Error('duplicated request id'))
			defers[id] = defer
			stack.defer(() => void delete defers[id])

			const abortError = new DOMException('Aborted', 'AbortError')
			if (signal?.aborted) defer.reject(abortError)
			else {
				signal?.addEventListener('abort', () => giveUp(abortError), {
					signal: stack.adopt(new AbortController(), ab => ab.abort()).signal,
				})

				if (timeout)
					stack.adopt(
						setTimeout(() => giveUp(new Error('timeout')), timeout),
						clearTimeout,
					)

				send(
					{
						path: '/req',
						id,
						body,
					},
					...rest,
				)
			}

			return await defer.promise

			function giveUp(reason: Error) {
				defer.reject(reason)
				if (!disposed) send({path: '/abort', id}, ...rest)
			}
		},
		subscribe<T>(this: void, body: any, onData: (data: T) => void, ...rest: any[]) {
			const id = crypto.randomUUID()
			if (!disposed) {
				// a synchronous transport can deliver /pub before send() returns, so be ready first
				subs[id] = onData
				send(
					{
						path: '/sub',
						id,
						body,
					},
					...rest,
				)
			}
			return {
				[Symbol.dispose]() {
					delete subs[id]
					if (!disposed) send({path: '/unsub', id})
				},
			}
		},
		push(body: any, ...rest: any[]) {
			if (disposed) return
			send(
				{
					path: '/push',
					id: crypto.randomUUID(),
					body,
				},
				...rest,
			)
		},
		[Symbol.dispose]: moved[Symbol.dispose].bind(moved),
	}
}

function logJson(json: any) {
	console.log(JSON.stringify(json))
}
