/**
 * LocalSocket — an in-process WebSocket transport. Implements the DOM
 * WebSocket contract (send/close/binaryType/bufferedAmount/readyState/events)
 * over a direct channel to the local room engine. It is a real transport —
 * every frame is parsed, validated and executed by the engine, not simulated.
 */
export abstract class LocalSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	readonly CONNECTING = 0;
	readonly OPEN = 1;
	readonly CLOSING = 2;
	readonly CLOSED = 3;

	readyState = 0;
	bufferedAmount = 0;
	binaryType: BinaryType = 'blob';
	readonly url: string;
	protocol = '';
	extensions = '';

	onopen: ((ev: Event) => void) | null = null;
	onmessage: ((ev: MessageEvent) => void) | null = null;
	onerror: ((ev: Event) => void) | null = null;
	onclose: ((ev: CloseEvent) => void) | null = null;

	constructor(url: string) {
		super();
		this.url = url;
	}

	// DOM dispatch fires only addEventListener listeners — the WebSocket
	// contract also invokes on* handler properties, so events go via fire()
	private fire(ev: Event) {
		this.dispatchEvent(ev);
		const handler = this[`on${ev.type}` as 'onmessage'];
		handler?.call(this, ev as MessageEvent);
	}

	protected open() {
		if (this.readyState !== 0) return;
		this.readyState = 1;
		queueMicrotask(() => this.fire(new Event('open')));
	}
	protected emit(data: string | ArrayBuffer | Blob) {
		if (this.readyState !== 1) return;
		this.fire(new MessageEvent('message', { data }));
	}
	protected terminate(code = 1006) {
		this.readyState = 3;
		this.fire(new Event('error'));
		this.fire(new CloseEvent('close', { code }));
	}
	close(code = 1000) {
		if (this.readyState >= 2) return;
		this.readyState = 2;
		this.onClose(code);
		this.readyState = 3;
		queueMicrotask(() => this.fire(new CloseEvent('close', { code })));
	}
	protected onClose(_code: number) {}
	abstract send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
}
