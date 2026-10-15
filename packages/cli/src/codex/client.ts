import { SwbError } from "../errors.ts";
import { UnixWebSocket } from "./ws.ts";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
export type Notification = { method: string; params: Record<string, unknown> };

/** A client of a Codex app-server, over its unix socket. */
export class CodexClient {
	readonly #ws: UnixWebSocket;
	#id = 0;
	readonly #pending = new Map<number, Pending>();
	#listener: (note: Notification) => void = () => {};
	#closed: () => void = () => {};

	private constructor(ws: UnixWebSocket) {
		this.#ws = ws;
		ws.onMessage((text) => {
			const msg = JSON.parse(text) as {
				id?: number;
				method?: string;
				params?: Record<string, unknown>;
				result?: unknown;
				error?: { message?: string };
			};
			if (msg.method && msg.id === undefined) this.#listener({ method: msg.method, params: msg.params ?? {} });
			else if (msg.method) {
				// A server request (an approval, a question) belongs to the person at the TUI; never answer it.
			} else if (msg.id !== undefined) {
				const pending = this.#pending.get(msg.id);
				this.#pending.delete(msg.id);
				if (msg.error) pending?.reject(new SwbError(`codex: ${msg.error.message ?? JSON.stringify(msg.error)}`));
				else pending?.resolve(msg.result);
			}
		});
		ws.onClose(() => {
			for (const pending of this.#pending.values()) pending.reject(new SwbError("codex app-server closed the connection"));
			this.#pending.clear();
			this.#closed();
		});
	}

	static async connect(socket: string, name: string): Promise<CodexClient> {
		const client = new CodexClient(await UnixWebSocket.connect(socket));
		await client.request("initialize", {
			clientInfo: { name, title: null, version: "0" },
			capabilities: { experimentalApi: true },
		});
		client.#ws.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
		return client;
	}

	onNotification(listener: (note: Notification) => void): void {
		this.#listener = listener;
	}

	onClose(listener: () => void): void {
		this.#closed = listener;
	}

	request<T = unknown>(method: string, params: unknown): Promise<T> {
		const id = ++this.#id;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		this.#pending.set(id, { resolve, reject });
		this.#ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		return promise as Promise<T>;
	}

	close(): void {
		this.#ws.close();
	}
}
