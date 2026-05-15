import protobuf from 'protobufjs'

export const protoRootBidiMessage = protobuf.Root.fromJSON({
	nested: {
		jbidi: {
			nested: {
				Message: {
					oneofs: {
						message: {
							oneof: ['ping', 'pong', 'sub', 'unsub', 'pub', 'req', 'res', 'push'],
						},
					},
					fields: {
						ping: {
							type: 'PingMessage',
							id: 1,
						},
						pong: {
							type: 'PongMessage',
							id: 2,
						},
						sub: {
							type: 'SubMessage',
							id: 3,
						},
						unsub: {
							type: 'UnsubMessage',
							id: 4,
						},
						pub: {
							type: 'PubMessage',
							id: 5,
						},
						req: {
							type: 'ReqMessage',
							id: 6,
						},
						res: {
							type: 'ResMessage',
							id: 7,
						},
						push: {
							type: 'PushMessage',
							id: 8,
						},
					},
				},
				PingMessage: {
					fields: {},
				},
				PongMessage: {
					fields: {},
				},
				SubMessage: {
					fields: {
						id: {
							type: 'string',
							id: 1,
						},
						body: {
							type: 'bytes',
							id: 2,
						},
					},
				},
				UnsubMessage: {
					fields: {
						id: {
							type: 'string',
							id: 1,
						},
					},
				},
				PubMessage: {
					fields: {
						id: {
							type: 'string',
							id: 1,
						},
						body: {
							type: 'bytes',
							id: 2,
						},
					},
				},
				ReqMessage: {
					fields: {
						id: {
							type: 'string',
							id: 1,
						},
						body: {
							type: 'bytes',
							id: 2,
						},
					},
				},
				ResMessage: {
					fields: {
						id: {
							type: 'string',
							id: 1,
						},
						body: {
							type: 'bytes',
							id: 2,
						},
						error: {
							type: 'string',
							id: 3,
						},
						code: {
							type: 'string',
							id: 4,
						},
					},
				},
				PushMessage: {
					fields: {
						id: {
							type: 'string',
							id: 1,
						},
						body: {
							type: 'bytes',
							id: 2,
						},
					},
				},
			},
		},
	},
})
