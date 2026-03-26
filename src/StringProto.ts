import protobuf from 'protobufjs'

export const protoRootString = protobuf.Root.fromJSON({
	nested: {
		jbidi: {
			nested: {
				String: {
					fields: {
						value: {
							type: 'string',
							id: 1,
						},
					},
				},
			},
		},
	},
})
