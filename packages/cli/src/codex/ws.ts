import { randomBytes } from "node:crypto";

/**
 * A WebSocket client over a unix socket, which is how a Codex app-server listens on `unix://`.
 * Bun's own WebSocket can't dial a unix socket, and this needs only text frames.
 */
export class UnixWebSocket {
	#socket: Bun.Socket<undefined> | undefined;
	#buffer = Buffer.alloc(0);
	/** What the socket hasn't taken yet: Bun's sockets write what fits and keep none of the rest. */
	#unsent = Buffer.alloc(0);
	#upgraded = false;
	#fragments: Buffer[] = [];
	#onMessage: (text: string) => void = () => {};
	#onClose: () => void = () => {};

	static async connect(path: string): Promise<UnixWebSocket> {
		const ws = new UnixWebSocket();
		const key = randomBytes(16).toString("base64");
		const { promise: upgraded, resolve, reject } = Promise.withResolvers<void>();
		ws.#socket = await Bun.connect({
			unix: path,
			socket: {
				data: (_socket, chunk) => {
					ws.#buffer = Buffer.concat([ws.#buffer, chunk]);
					if (!ws.#upgraded) {
						const end = ws.#buffer.indexOf("\r\n\r\n");
						if (end < 0) return;
						const head = ws.#buffer.subarray(0, end).toString();
						ws.#buffer = ws.#buffer.subarray(end + 4);
						if (!/^HTTP\/1\.1 101/.test(head)) {
							reject(new Error(`websocket upgrade refused: ${head.split("\r\n")[0]}`));
							return;
						}
						ws.#upgraded = true;
						resolve();
					}
					ws.#drain();
				},
				drain: () => ws.#flush(),
				close: () => {
					reject(new Error(`websocket ${path} closed during upgrade`));
					ws.#onClose();
				},
				error: (_socket, error) => reject(error),
			},
		});
		ws.#socket.write(
			`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
		);
		await upgraded;
		return ws;
	}

	onMessage(handler: (text: string) => void): void {
		this.#onMessage = handler;
	}

	onClose(handler: () => void): void {
		this.#onClose = handler;
	}

	send(text: string): void {
		this.#frame(0x1, Buffer.from(text));
	}

	close(): void {
		this.#socket?.end();
	}

	#frame(opcode: number, payload: Buffer): void {
		const mask = randomBytes(4);
		const length = payload.length;
		const head =
			length < 126
				? Buffer.from([0x80 | opcode, 0x80 | length])
				: length < 65536
					? Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 0xff])
					: Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), bigEndian64(length)]);
		const masked = Buffer.alloc(length);
		for (let i = 0; i < length; i++) masked[i] = (payload[i] as number) ^ (mask[i % 4] as number);
		this.#write(Buffer.concat([head, mask, masked]));
	}

	#write(bytes: Buffer): void {
		this.#unsent = Buffer.concat([this.#unsent, bytes]);
		this.#flush();
	}

	#flush(): void {
		if (!this.#socket || this.#unsent.length === 0) return;
		const written = this.#socket.write(this.#unsent);
		this.#unsent = this.#unsent.subarray(Math.max(0, written));
	}

	#drain(): void {
		for (;;) {
			const b = this.#buffer;
			if (b.length < 2) return;
			const fin = ((b[0] as number) & 0x80) !== 0;
			const opcode = (b[0] as number) & 0x0f;
			let length = (b[1] as number) & 0x7f;
			let offset = 2;
			if (length === 126) {
				if (b.length < 4) return;
				length = b.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (b.length < 10) return;
				length = Number(b.readBigUInt64BE(2));
				offset = 10;
			}
			// A server never masks its frames.
			if (b.length < offset + length) return;
			const payload = b.subarray(offset, offset + length);
			this.#buffer = b.subarray(offset + length);
			if (opcode === 0x9) this.#frame(0xa, payload);
			else if (opcode === 0x8) this.close();
			else if (opcode === 0x1 || opcode === 0x0) {
				this.#fragments.push(Buffer.from(payload));
				if (fin) {
					const text = Buffer.concat(this.#fragments).toString();
					this.#fragments = [];
					this.#onMessage(text);
				}
			}
		}
	}
}

function bigEndian64(n: number): Buffer {
	const buf = Buffer.alloc(8);
	buf.writeBigUInt64BE(BigInt(n));
	return buf;
}
