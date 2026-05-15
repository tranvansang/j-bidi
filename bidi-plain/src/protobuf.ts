import {type Writer} from 'protobufjs'
import {protoRootString} from './StringProto.js'
import {protoRootBidiMessage} from './BidiMessageProto.js'

interface ProtoType<T> {
	decode(buffer: Uint8Array): T
	encode(message: T): Writer
}
const ProtoString = protoRootString.lookupType('jbidi.String') as unknown as ProtoType<{
	value: string
}>

export function protoEncodeJson(value: any) {
	return ProtoString.encode({value: value === undefined ? '' : JSON.stringify(value)}).finish()
}
export function protoDecodeJson<T>(bytes: Uint8Array): T {
	const {value} = ProtoString.decode(bytes)
	return value === '' ? (undefined as T) : (JSON.parse(value) as T)
}

export const ProtoMessage = protoRootBidiMessage.lookupType('jbidi.Message') as unknown as ProtoType<{
	ping?: {}
	pong?: {}
	sub?: {
		id: string
		body?: Uint8Array
	}
	unsub?: {id: string}
	pub?: {
		id: string
		body?: Uint8Array
	}
	req?: {
		id: string
		body?: Uint8Array
	}
	res?: {
		id: string
		body?: Uint8Array
		error?: string
		code?: string
	}
	push?: {
		id: string
		body?: Uint8Array
	}
}>
