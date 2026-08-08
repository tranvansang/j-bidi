import {spawn} from 'node:child_process'
import {readFile} from 'node:fs/promises'
import {deepStrictEqual, match, notStrictEqual, ok, strictEqual} from 'node:assert'
import {describe, it} from 'node:test'
import {createBidiEndpointPlain} from './index.js'

// Endpoints are linked through a JSON round trip, like a real transport would be:
// object identity never leaks between the two sides, and `undefined` fields drop off the wire.

interface Frame {
	message: any
	rest: any[]
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('round trip', () => {
	it('answers a request with the handler result', async () => {
		using pair = link({}, {async request(body) {
			return {echo: body}
		}})

		deepStrictEqual(await pair.a.request({hi: 1}), {echo: {hi: 1}})

		const [req] = framesOf(pair.toB, '/req')
		const [res] = framesOf(pair.toA, '/res')
		deepStrictEqual(req.message.body, {hi: 1})
		strictEqual(res.message.id, req.message.id)
	})

	it('resolves falsy results instead of mistaking them for failures', async () => {
		for (const result of [undefined, null, false, 0, '']) {
			using pair = link({}, {async request() {
				return result
			}})

			const {value, error} = await settle(pair.a.request({}))
			strictEqual(error, undefined, `${String(result)} should resolve`)
			strictEqual(value, result)
		}
	})

	it('keeps concurrent requests apart', async () => {
		using pair = link({}, {async request(body) {
			await flush(body.wait)
			return body.n
		}})

		const results = await Promise.all([
			pair.a.request({n: 'slow', wait: 6}),
			pair.a.request({n: 'quick', wait: 1}),
			pair.a.request({n: 'mid', wait: 3}),
		])

		deepStrictEqual(results, ['slow', 'quick', 'mid'])
		strictEqual(new Set(framesOf(pair.toB, '/req').map(frame => frame.message.id)).size, 3)
	})

	it('delivers a push body to the peer handler', async () => {
		const received: any[] = []
		using pair = link({}, {push(body) {
			received.push(body)
		}})

		pair.a.push({event: 'click'})
		await flush()

		deepStrictEqual(received, [{event: 'click'}])
		match(framesOf(pair.toB, '/push')[0].message.id, uuidPattern)
	})

	it('streams published data to the subscriber until it unsubscribes', async () => {
		let publish: ((data: any) => void) | undefined
		let released = 0
		using pair = link({}, {subscribe(body, onData) {
			deepStrictEqual(body, {path: '/topic'})
			publish = onData
			return {[Symbol.dispose]() {
				released++
			}}
		}})

		const received: any[] = []
		const sub = pair.a.subscribe({path: '/topic'}, data => void received.push(data))
		await flush()

		publish?.('first')
		publish?.({n: 2})
		await flush()
		deepStrictEqual(received, ['first', {n: 2}])

		sub[Symbol.dispose]()
		await flush()
		strictEqual(released, 1)

		publish?.('after unsub')
		await flush()
		strictEqual(received.length, 2, 'dropped subscriptions must not deliver')
		strictEqual(framesOf(pair.toB, '/unsub')[0].message.id, framesOf(pair.toB, '/sub')[0].message.id)
	})

	it('keeps two subscriptions on separate ids', async () => {
		const publishers: ((data: any) => void)[] = []
		using pair = link({}, {subscribe(body, onData) {
			publishers.push(onData)
		}})

		const left: any[] = []
		const right: any[] = []
		pair.a.subscribe({}, data => void left.push(data))
		pair.a.subscribe({}, data => void right.push(data))
		await flush()

		publishers[0]('to left')
		await flush()

		deepStrictEqual(left, ['to left'])
		deepStrictEqual(right, [])
		notStrictEqual(framesOf(pair.toB, '/sub')[0].message.id, framesOf(pair.toB, '/sub')[1].message.id)
	})

	it('answers /ping with /pong and reports the peer /pong', async () => {
		using pair = link()

		let alive = 0
		pair.b.pong = () => void alive++

		pair.b.send({path: '/ping'})
		await flush()

		strictEqual(framesOf(pair.toA, '/pong').length, 1)
		strictEqual(alive, 0, '/pong is answered by the peer, not by the sender')

		pair.a.send({path: '/pong'})
		pair.b.send({path: '/pong'})
		strictEqual(alive, 1, 'only the endpoint with a pong callback reports')
	})

	it('forwards extra send arguments from the caller, but not from protocol replies', async () => {
		using pair = link({}, {async request() {
			return 'ok'
		}})

		await pair.a.request({}, {}, 'meta', 7)
		pair.a.push({}, 'push-meta')
		pair.a.subscribe({}, () => {}, 'sub-meta')
		await flush()

		deepStrictEqual(framesOf(pair.toB, '/req')[0].rest, ['meta', 7])
		deepStrictEqual(framesOf(pair.toB, '/push')[0].rest, ['push-meta'])
		deepStrictEqual(framesOf(pair.toB, '/sub')[0].rest, ['sub-meta'])
		deepStrictEqual(framesOf(pair.toA, '/res')[0].rest, [])
	})

	it('mints a unique uuid per outbound message', async () => {
		using pair = link()

		pair.a.push({})
		pair.a.push({})
		pair.a.subscribe({}, () => {})
		void settle(pair.a.request({}, {timeout: 5}))
		await flush()

		const ids = [...pair.toB].map(frame => frame.message.id).filter(Boolean)
		strictEqual(ids.length, 4)
		for (const id of ids) match(id, uuidPattern)
		strictEqual(new Set(ids).size, 4)
	})
})

describe('cancellation and timeouts', () => {
	it('rejects with a timeout when the peer stays silent', async () => {
		using pair = link({}, {async request() {
			return await new Promise(() => {})
		}})

		const {error} = await settle(pair.a.request({}, {timeout: 20}))
		strictEqual(error.message, 'timeout')
	})

	it('defaults to a 10s timeout', async t => {
		t.mock.timers.enable({apis: ['setTimeout']})
		using pair = link({}, {async request() {
			return await new Promise(() => {})
		}})

		let outcome: any
		void (async () => {
			outcome = await settle(pair.a.request({}))
		})()

		t.mock.timers.tick(9_999)
		await flush()
		strictEqual(outcome, undefined, 'must still be pending just before 10s')

		t.mock.timers.tick(2)
		await flush()
		strictEqual(outcome.error.message, 'timeout')
	})

	it('never times out when timeout is 0, and dispose settles it', async t => {
		t.mock.timers.enable({apis: ['setTimeout']})
		using pair = link({}, {async request() {
			return await new Promise(() => {})
		}})

		let outcome: any
		void (async () => {
			outcome = await settle(pair.a.request({}, {timeout: 0}))
		})()

		t.mock.timers.tick(600_000)
		await flush()
		strictEqual(outcome, undefined, 'timeout 0 disables the timer')

		pair.a[Symbol.dispose]()
		await flush()
		strictEqual(outcome.error.message, 'endpoint disposed', 'dispose must settle it, else it hangs forever')
	})

	it('rejects a pre-aborted request without touching the transport', async () => {
		using pair = link()

		const {error} = await settle(pair.a.request({}, {signal: AbortSignal.abort()}))
		strictEqual(error.name, 'AbortError')
		ok(error instanceof DOMException)
		strictEqual(pair.toB.length, 0, 'an already-aborted request must not be sent')
	})

	it('rejects an in-flight request when its signal aborts', async () => {
		using pair = link({}, {async request() {
			return await new Promise(() => {})
		}})

		const controller = new AbortController()
		let outcome: any
		void (async () => {
			outcome = await settle(pair.a.request({}, {signal: controller.signal, timeout: 0}))
		})()

		await flush()
		controller.abort()
		await flush()

		strictEqual(outcome.error.name, 'AbortError')
		strictEqual(framesOf(pair.toB, '/req').length, 1)
	})

	it('ignores a signal that aborts after the request settled', async () => {
		using pair = link({}, {async request() {
			return 'done'
		}})

		const controller = new AbortController()
		strictEqual(await pair.a.request({}, {signal: controller.signal}), 'done')
		controller.abort()
		await flush()
	})

	it('drops a /res that arrives late, twice, or for an unknown id', async () => {
		using pair = link({}, {async request() {
			return await new Promise(() => {})
		}})

		const {error} = await settle(pair.a.request({}, {timeout: 20}))
		strictEqual(error.message, 'timeout')

		const {id} = framesOf(pair.toB, '/req')[0].message
		pair.a.send({path: '/res', id, body: 'late'})
		pair.a.send({path: '/res', id: crypto.randomUUID(), body: 'unknown'})
		await flush()
	})

	it('rejects the earlier caller when a request id collides', async t => {
		t.mock.method(crypto, 'randomUUID', () => 'fixed-id' as ReturnType<typeof crypto.randomUUID>)
		using pair = link({}, {async request() {
			return await new Promise(() => {})
		}})

		const first = settle(pair.a.request({}, {timeout: 0}))
		const second = settle(pair.a.request({}, {timeout: 20}))

		strictEqual((await first).error.message, 'duplicated request id')
		// the loser's cleanup then deletes the winner's entry, so the second call can only time out
		strictEqual((await second).error.message, 'timeout')
	})
})

describe('error propagation', () => {
	// Regression: a falsy `error` field used to read as success, so the caller resolved with undefined.
	it('rejects for every shape a handler can throw', async () => {
		const cases: [string, unknown, string][] = [
			['error with a message', new Error('boom'), 'boom'],
			['error without a message', new Error(), 'Error'],
			['string', 'thrown string', 'thrown string'],
			['empty string', '', 'unknown error'],
			['null', null, 'null'],
			['undefined', undefined, 'undefined'],
			['number', 42, '42'],
			['plain object', {}, '[object Object]'],
			['object with an empty message', {message: ''}, '[object Object]'],
		]

		for (const [label, thrown, expected] of cases) {
			using pair = link({}, {async request() {
				throw thrown
			}})

			const {value, error} = await settle(pair.a.request({}))
			ok(error, `${label} must reject, not resolve with ${String(value)}`)
			strictEqual(error.message, expected, label)
			strictEqual(framesOf(pair.toA, '/res').length, 1, `${label} must still produce a /res`)
		}
	})

	it('carries the error code through the cause', async () => {
		using pair = link({}, {async request() {
			throw Object.assign(new Error('nope'), {code: 'e_denied'})
		}})

		const {error} = await settle(pair.a.request({}))
		strictEqual(error.message, 'nope')
		strictEqual((error.cause as any).code, 'e_denied')
	})

	it('leaves the cause code undefined when the handler throws without one', async () => {
		using pair = link({}, {async request() {
			throw new Error('bare')
		}})

		const {error} = await settle(pair.a.request({}))
		strictEqual((error.cause as any).code, undefined)
	})

	it('rejects a /res that carries only a code', async () => {
		using endpoint = createBidiEndpointPlain({send(message) {
			if (message.path !== '/req') return
			queueMicrotask(() => endpoint.send({path: '/res', id: (message as any).id, code: 'e_code'}))
		}})

		const {error} = await settle(endpoint.request({}))
		strictEqual(error.message, 'unknown error')
		strictEqual((error.cause as any).code, 'e_code')
	})

	// A protobuf peer (see ../legacy) decodes unset string fields as '', so an empty
	// error field must keep meaning success.
	it('treats an empty error field from a peer as success', async () => {
		using endpoint = createBidiEndpointPlain({send(message) {
			if (message.path !== '/req') return
			queueMicrotask(() => endpoint.send({path: '/res', id: (message as any).id, body: 'ok', error: '', code: ''}))
		}})

		strictEqual(await endpoint.request({}), 'ok')
	})

	it('contains and logs an error thrown by a local subscription callback', async t => {
		const logged: any[] = []
		t.mock.method(console, 'log', (line: string) => void logged.push(JSON.parse(line)))

		let publish: ((data: any) => void) | undefined
		using pair = link({}, {subscribe(body, onData) {
			publish = onData
		}})

		pair.a.subscribe({}, () => {
			throw new Error('callback failed')
		})
		await flush()

		publish?.('data')
		await flush()

		strictEqual(logged.length, 1)
		strictEqual(logged[0].level, 'warn')
		strictEqual(logged[0].message, 'bidirectional message pub error')
		strictEqual(logged[0].error, 'callback failed')
		strictEqual(logged[0].id, framesOf(pair.toB, '/sub')[0].message.id)
	})

	it('contains a rejected async subscription callback', async t => {
		const logged: any[] = []
		t.mock.method(console, 'log', (line: string) => void logged.push(JSON.parse(line)))

		let publish: ((data: any) => void) | undefined
		using pair = link({}, {subscribe(body, onData) {
			publish = onData
		}})

		pair.a.subscribe({}, async () => {
			throw new Error('async callback failed')
		})
		await flush()

		publish?.('data')
		await flush()

		strictEqual(logged[0].error, 'async callback failed')
	})
})

describe('hostile and malformed frames', () => {
	// Regression: ids are peer-controlled map keys. Inherited members used to be
	// truthy but uncallable, so a single frame could throw out of send().
	const dangerousIds = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'prototype']

	it('survives prototype-shaped ids on every keyed path', () => {
		for (const id of dangerousIds) {
			for (const path of ['/sub', '/unsub', '/pub', '/req', '/res']) {
				using endpoint = createBidiEndpointPlain({
					send() {},
					async request() {
						return 'ok'
					},
					subscribe() {
						return {[Symbol.dispose]() {}}
					},
				})

				endpoint.send({path, id, body: 'x'} as any)
			}
		}
	})

	it('does not let a __proto__ id poison later lookups', async () => {
		using endpoint = createBidiEndpointPlain({
			send() {},
			async request() {
				return 'ok'
			},
			subscribe() {
				return {[Symbol.dispose]() {}}
			},
		})

		endpoint.send({path: '/req', id: '__proto__'})
		endpoint.send({path: '/sub', id: '__proto__'})
		await flush()

		// these ids only resolve to something callable if a prototype got reassigned
		for (const id of ['name', 'toString', 'call', 'bind']) {
			endpoint.send({path: '/req', id})
			endpoint.send({path: '/sub', id})
			endpoint.send({path: '/unsub', id})
		}
		await flush()
	})

	it('sweeps prototype-shaped keys on dispose', async () => {
		let released = 0
		let aborted = false
		const endpoint = createBidiEndpointPlain({
			send() {},
			async request(body, signal) {
				await flush(4)
				aborted = signal.aborted
				return 'late'
			},
			subscribe() {
				return {[Symbol.dispose]() {
					released++
				}}
			},
		})

		endpoint.send({path: '/sub', id: '__proto__'})
		endpoint.send({path: '/sub', id: 'constructor'})
		endpoint.send({path: '/req', id: '__proto__'})
		await flush()

		endpoint[Symbol.dispose]()
		await flush(6)

		strictEqual(released, 2, 'own keys named like prototype members must still be disposed')
		strictEqual(aborted, true, 'in-flight requests under such keys must still abort')
	})

	it('ignores frames with no id', async () => {
		let subscribed = 0
		let requested = 0
		const sent: Frame[] = []
		using endpoint = createBidiEndpointPlain({
			send(message, ...rest) {
				sent.push({message, rest})
			},
			async request() {
				requested++
				return 'ok'
			},
			subscribe() {
				subscribed++
			},
		})

		for (const path of ['/sub', '/unsub', '/pub', '/req', '/res']) endpoint.send({path} as any)
		await flush()

		strictEqual(subscribed, 0)
		strictEqual(requested, 0)
		strictEqual(sent.length, 0)
	})

	it('warns instead of throwing on malformed frames', t => {
		const warned: any[] = []
		t.mock.method(console, 'warn', (...args: any[]) => void warned.push(args))

		using endpoint = createBidiEndpointPlain({send() {}})

		for (const frame of [null, undefined, {}, {path: '/nope'}, 'string', 42, []]) endpoint.send(frame as any)

		strictEqual(warned.length, 7)
		strictEqual(warned[0][0], 'unknown bidirectional message path')
		strictEqual(warned[3][1], '/nope')
	})

	it('tolerates missing handlers', async () => {
		const sent: Frame[] = []
		using endpoint = createBidiEndpointPlain({send(message, ...rest) {
			sent.push({message, rest})
		}})

		endpoint.send({path: '/sub', id: 'a', body: 1})
		endpoint.send({path: '/unsub', id: 'a'})
		endpoint.send({path: '/pub', id: 'a', body: 1})
		endpoint.send({path: '/push', id: 'a', body: 1})
		endpoint.send({path: '/pong'})
		await flush()

		strictEqual(sent.length, 0)
	})

	it('delivers a push even when the frame carries no id', async () => {
		const received: any[] = []
		using endpoint = createBidiEndpointPlain({
			send() {},
			push(body) {
				received.push(body)
			},
		})

		endpoint.send({path: '/push', body: 'no id'} as any)
		deepStrictEqual(received, ['no id'])
	})

	it('replaces a subscription when the peer reuses a /sub id', async () => {
		const released: string[] = []
		using endpoint = createBidiEndpointPlain({
			send() {},
			subscribe(body) {
				return {[Symbol.dispose]() {
					released.push(body)
				}}
			},
		})

		endpoint.send({path: '/sub', id: 'same', body: 'first'})
		endpoint.send({path: '/sub', id: 'same', body: 'second'})
		deepStrictEqual(released, ['first'], 're-subscribing must release the previous handler')

		endpoint.send({path: '/unsub', id: 'same'})
		deepStrictEqual(released, ['first', 'second'])

		endpoint.send({path: '/unsub', id: 'same'})
		deepStrictEqual(released, ['first', 'second'], 'unsub twice must not dispose twice')
	})
})

describe('dispose', () => {
	it('settles every in-flight request', async () => {
		using pair = link({}, {async request() {
			return await new Promise(() => {})
		}})

		const pending = [
			settle(pair.a.request({}, {timeout: 0})),
			settle(pair.a.request({}, {timeout: 0})),
			settle(pair.a.request({}, {signal: new AbortController().signal})),
		]
		await flush()

		pair.a[Symbol.dispose]()

		for (const outcome of await Promise.all(pending)) strictEqual(outcome.error.message, 'endpoint disposed')
	})

	it('releases the peer subscriptions it is serving', async () => {
		let released = 0
		using pair = link({subscribe() {
			return {[Symbol.dispose]() {
				released++
			}}
		}}, {})

		pair.b.subscribe({}, () => {})
		await flush()

		pair.a[Symbol.dispose]()
		strictEqual(released, 1)
	})

	it('stops delivering to its own subscription callbacks', async () => {
		const received: any[] = []
		using pair = link({subscribe() {}}, {})

		pair.b.subscribe({}, data => void received.push(data))
		await flush()

		const {id} = framesOf(pair.toA, '/sub')[0].message
		pair.b[Symbol.dispose]()

		pair.b.send({path: '/pub', id, body: 'after dispose'})
		await flush()
		strictEqual(received.length, 0)
	})

	it('releases subscription callbacks for collection', async () => {
		const {stdout} = await runNode(
			`
			import {createBidiEndpointPlain} from '${import.meta.resolve('./index.js')}'
			const endpoint = createBidiEndpointPlain({send() {}})
			const ref = (() => {
				const marker = {retained: true}
				endpoint.subscribe({}, () => marker)
				return new WeakRef(marker)
			})()
			global.gc()
			const before = ref.deref() ? 'retained' : 'released'
			// deref keeps its target alive for the rest of the job, so hand the turn back first
			await new Promise(resolve => setImmediate(resolve))
			endpoint[Symbol.dispose]()
			global.gc()
			await new Promise(resolve => setImmediate(resolve))
			global.gc()
			console.log(before, ref.deref() ? 'retained' : 'released')
		`,
			['--expose-gc'],
		)

		strictEqual(stdout.trim(), 'retained released', 'dispose must drop the callbacks the subs map holds')
	})

	it('aborts requests it is still processing', async () => {
		let aborted: boolean | undefined
		const endpoint = createBidiEndpointPlain({
			send() {},
			async request(body, signal) {
				await flush(4)
				aborted = signal.aborted
				return 'late'
			},
		})

		endpoint.send({path: '/req', id: 'in-flight'})
		endpoint[Symbol.dispose]()
		await flush(6)

		strictEqual(aborted, true)
	})

	it('ignores everything the peer sends afterwards', async () => {
		let subscribed = 0
		const sent: Frame[] = []
		const endpoint = createBidiEndpointPlain({
			send(message, ...rest) {
				sent.push({message, rest})
			},
			async request() {
				return 'ok'
			},
			subscribe() {
				subscribed++
				return {[Symbol.dispose]() {}}
			},
			push() {
				throw new Error('push must not run after dispose')
			},
		})

		endpoint[Symbol.dispose]()
		endpoint.send({path: '/ping'})
		endpoint.send({path: '/req', id: 'r'})
		endpoint.send({path: '/sub', id: 's'})
		endpoint.send({path: '/push', id: 'p', body: 1})
		await flush()

		strictEqual(subscribed, 0, 'a post-dispose /sub used to register a disposable nothing would ever release')
		strictEqual(sent.length, 0)
	})

	it('refuses actions on a disposed endpoint', async () => {
		const sent: Frame[] = []
		const endpoint = createBidiEndpointPlain({send(message, ...rest) {
			sent.push({message, rest})
		}})

		const early = endpoint.subscribe({}, () => {})
		sent.length = 0
		endpoint[Symbol.dispose]()

		const {error} = await settle(endpoint.request({}))
		strictEqual(error.message, 'endpoint disposed')

		endpoint.push({})
		const late = endpoint.subscribe({}, () => {})
		late[Symbol.dispose]()
		early[Symbol.dispose]()

		strictEqual(sent.length, 0, 'nothing may be written to a closed transport')
	})

	it('is idempotent and unbound-safe', async () => {
		let released = 0
		const endpoint = createBidiEndpointPlain({
			send() {},
			subscribe() {
				return {[Symbol.dispose]() {
					released++
				}}
			},
		})

		endpoint.send({path: '/sub', id: 'a'})

		const dispose = endpoint[Symbol.dispose]
		dispose()
		dispose()
		endpoint[Symbol.dispose]()

		strictEqual(released, 1)
	})

	it('disposes at the end of a using block', async () => {
		let released = 0
		const outer = (() => {
			using endpoint = createBidiEndpointPlain({
				send() {},
				subscribe() {
					return {[Symbol.dispose]() {
						released++
					}}
				},
			})
			endpoint.send({path: '/sub', id: 'a'})
			strictEqual(released, 0)
			return endpoint
		})()

		strictEqual(released, 1)
		const {error} = await settle(outer.request({}))
		strictEqual(error.message, 'endpoint disposed')
	})
})

describe('package contract', () => {
	it('ships as an es module with no runtime dependencies', async () => {
		const pkg = JSON.parse(await readFile(new URL('package.json', import.meta.url), 'utf8'))

		strictEqual(pkg.type, 'module', 'without this, node parses index.js as commonjs and throws')
		deepStrictEqual(pkg.dependencies, undefined, 'consumers must not inherit unused dependencies')
		deepStrictEqual(pkg.exports['.'], {types: './index.d.ts', import: './index.js'})
		deepStrictEqual(pkg.files, ['index.js', 'index.d.ts'])
	})

	it('publishes types for the endpoint factory', async () => {
		const types = await readFile(new URL('index.d.ts', import.meta.url), 'utf8')
		match(types, /export declare function createBidiEndpointPlain/)
		match(types, /export type BidiEndpointPlain/)
	})
})

// Behaviour that is known to be wrong. Each test pins what the library does today, so a fix
// makes it fail loudly instead of passing unnoticed.
describe('known gaps', () => {
	it('leaves the remote handler running after a local abort', async () => {
		let remoteAborted: boolean | undefined
		using pair = link({}, {async request(body, signal) {
			await flush(4)
			remoteAborted = signal.aborted
			return 'done'
		}})

		const controller = new AbortController()
		const outcome = settle(pair.a.request({}, {signal: controller.signal, timeout: 0}))
		await flush()
		controller.abort()
		strictEqual((await outcome).error.name, 'AbortError')

		await flush(6)
		strictEqual(remoteAborted, false, 'gap: the protocol has no cancel frame, so the peer keeps working')
	})

	it('leaves the peer subscribed after dispose', async () => {
		let released = 0
		using pair = link({subscribe() {
			return {[Symbol.dispose]() {
				released++
			}}
		}}, {})

		pair.b.subscribe({}, () => {})
		await flush()

		pair.b[Symbol.dispose]()
		await flush()

		strictEqual(framesOf(pair.toA, '/unsub').length, 0, 'gap: dispose should unsubscribe from the peer')
		strictEqual(released, 0, 'gap: the peer keeps publishing into a closed transport')
	})

	it('still answers an in-flight request after dispose', async () => {
		const sent: Frame[] = []
		const endpoint = createBidiEndpointPlain({
			send(message, ...rest) {
				sent.push({message, rest})
			},
			async request() {
				await flush(4)
				return 'late'
			},
		})

		endpoint.send({path: '/req', id: 'q'})
		endpoint[Symbol.dispose]()
		sent.length = 0
		await flush(6)

		strictEqual(sent.length, 1, 'gap: the responder writes /res to a transport that is already gone')
		strictEqual(sent[0].message.path, '/res')
	})

	it('lets handler exceptions escape into the transport loop', () => {
		for (const [label, endpoint, frame] of handlerThrowCases()) {
			let escaped: Error | undefined
			try {
				endpoint.send(frame)
			} catch (err) {
				escaped = err as Error
			}
			ok(escaped, `gap: ${label} should be contained inside send()`)
			endpoint[Symbol.dispose]()
		}
	})

	it('drops the first publish on a synchronous transport', async () => {
		let a: ReturnType<typeof createBidiEndpointPlain>
		using stack = new DisposableStack()

		const b = stack.use(createBidiEndpointPlain({
			send(message) {
				a.send(message)
			},
			subscribe(body, onData) {
				onData('immediate')
				return {[Symbol.dispose]() {}}
			},
		}))
		a = stack.use(createBidiEndpointPlain({send(message) {
			b.send(message)
		}}))

		const received: any[] = []
		a.subscribe({}, data => void received.push(data))
		await flush()

		deepStrictEqual(received, [], 'gap: subs[id] is registered after /sub is sent, so a sync peer publishes into nothing')
	})

	it('never answers a request when no handler is configured', async () => {
		using pair = link({}, {})

		const {error} = await settle(pair.a.request({}, {timeout: 20}))
		strictEqual(error.message, 'timeout', 'gap: the peer should reply with an error instead of stalling')
		strictEqual(framesOf(pair.toA, '/res').length, 0)
	})

	it('answers twice when the peer reuses a request id', async () => {
		const sent: Frame[] = []
		let calls = 0
		using endpoint = createBidiEndpointPlain({
			send(message, ...rest) {
				sent.push({message, rest})
			},
			async request(body, signal) {
				const own = ++calls
				await flush(own === 1 ? 6 : 2)
				if (signal.aborted) throw new Error('aborted')
				return own
			},
		})

		endpoint.send({path: '/req', id: 'dup'})
		endpoint.send({path: '/req', id: 'dup'})
		await flush(10)

		strictEqual(sent.length, 2, 'gap: both handlers answer under the same id')
		deepStrictEqual(sent.map(frame => frame.message.id), ['dup', 'dup'])
	})

	it('disposes a replaced subscription twice when the handler returns nothing', async () => {
		let released = 0
		let disposable: any = {[Symbol.dispose]() {
			released++
		}}
		const endpoint = createBidiEndpointPlain({
			send() {},
			subscribe() {
				const current = disposable
				disposable = undefined
				return current
			},
		})

		endpoint.send({path: '/sub', id: 'same'})
		endpoint.send({path: '/sub', id: 'same'})
		strictEqual(released, 1)

		endpoint[Symbol.dispose]()
		strictEqual(released, 2, 'gap: the stale entry is disposed again because it was never deleted')
	})

	it('cannot read back the pong callback it was given', () => {
		using endpoint = createBidiEndpointPlain({send() {}})

		endpoint.pong = () => {}
		strictEqual(endpoint.pong, undefined, 'gap: pong is setter-only but typed as readable')
	})

	it('flattens the error identity of a remote rejection', async () => {
		using pair = link({}, {async request() {
			throw new DOMException('Aborted', 'AbortError')
		}})

		const {error} = await settle(pair.a.request({}))
		strictEqual(error.name, 'Error', 'gap: only the message and code survive the wire')
		strictEqual(error.message, 'Aborted')
	})

	it('disposes a module-scoped endpoint as soon as the module finishes', async () => {
		const {stdout} = await runNode(`
			import {createBidiEndpointPlain} from '${import.meta.resolve('./index.js')}'
			using endpoint = createBidiEndpointPlain({send() {}})
			setTimeout(async () => {
				try {
					console.log(await endpoint.request({}, {timeout: 20}))
				} catch (err) {
					console.log(err.message)
				}
			}, 0)
		`)

		strictEqual(stdout.trim(), 'endpoint disposed', 'gap: the readme suggests top-level using, which disposes at module end')
	})

	// Run out of process: this crash cannot be observed from inside the test runner,
	// which claims unhandled rejections for itself.
	it('crashes the process when a subscription callback throws a non-error', async () => {
		const {code, stderr} = await runNode(`
			import {createBidiEndpointPlain} from '${import.meta.resolve('./index.js')}'
			const sent = []
			const endpoint = createBidiEndpointPlain({send(message) { sent.push(message) }})
			endpoint.subscribe({}, () => { throw null })
			endpoint.send({path: '/pub', id: sent[0].id, body: 1})
		`)

		notStrictEqual(code, 0, 'gap: the /pub catch block reads .message off the thrown value')
		match(stderr, /Cannot read properties of null/)
	})
})

function link(aOpts: any = {}, bOpts: any = {}) {
	using stack = new DisposableStack()

	const toA: Frame[] = []
	const toB: Frame[] = []

	const a = stack.use(createBidiEndpointPlain({...aOpts, send(message: any, ...rest: any[]) {
		toB.push({message, rest})
		queueMicrotask(() => b.send(JSON.parse(JSON.stringify(message))))
	}}))

	const b = stack.use(createBidiEndpointPlain({...bOpts, send(message: any, ...rest: any[]) {
		toA.push({message, rest})
		queueMicrotask(() => a.send(JSON.parse(JSON.stringify(message))))
	}}))

	const moved = stack.move()
	return Object.assign({a, b, toA, toB}, {[Symbol.dispose]: moved[Symbol.dispose].bind(moved)})
}

function framesOf(frames: Frame[], path: string) {
	return frames.filter(frame => frame.message?.path === path)
}

function handlerThrowCases() {
	const cases: [string, ReturnType<typeof createBidiEndpointPlain>, any][] = [
		['a push handler', createBidiEndpointPlain({send() {}, push() {
			throw new Error('push failed')
		}}), {path: '/push', id: 'p', body: 1}],
		['a subscribe handler', createBidiEndpointPlain({send() {}, subscribe() {
			throw new Error('subscribe failed')
		}}), {path: '/sub', id: 's'}],
		['a transport that rejects the /pong reply', createBidiEndpointPlain({send() {
			throw new Error('transport closed')
		}}), {path: '/ping'}],
	]

	const pongThrower = createBidiEndpointPlain({send() {}})
	pongThrower.pong = () => {
		throw new Error('pong callback failed')
	}
	cases.push(['a pong callback', pongThrower, {path: '/pong'}])

	return cases
}

async function settle<T>(promise: Promise<T>) {
	try {
		return {value: await promise, error: undefined as any}
	} catch (error) {
		return {value: undefined as T | undefined, error: error as any}
	}
}

async function flush(times = 2) {
	for (let turn = 0; turn < times; turn++) await new Promise(resolve => setImmediate(resolve))
}

async function runNode(source: string, flags: string[] = []) {
	return await new Promise<{code: number; stdout: string; stderr: string}>(resolve => {
		const child = spawn(process.execPath, [...flags, '--input-type=module', '--eval', source])
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', chunk => void (stdout += chunk))
		child.stderr.on('data', chunk => void (stderr += chunk))
		child.on('close', code => resolve({code: code ?? -1, stdout, stderr}))
	})
}
