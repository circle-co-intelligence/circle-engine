/**
 * sip.ts — PSTN dial-in leg. A sip.js UserAgent registers against a
 * WebRTC-capable SIP trunk (user's provider — Twilio/SignalWire/self-hosted
 * Asterisk), answers inbound calls, and pipes the call's remote audio into
 * the room as a publish track — the phone participant is just another seat.
 * Outbound: callee audio comes back on the same call.
 *
 * Entirely env-gated — unset config means the module never activates:
 *   VITE_CIC_SIP_URI       — e.g. sip:1000@provider.example.com
 *   VITE_CIC_SIP_WS        — wss://provider.example.com/ws
 *   VITE_CIC_SIP_PASSWORD  — registration secret
 *   VITE_CIC_SIP_TARGET    — optional PSTN number/URI to dial on room start
 */
import { UserAgent, Registerer, Inviter, SessionState, type Session } from 'sip.js';

export class SipLeg {
	private ua: UserAgent | null = null;
	private session: Session | null = null;

	constructor(private publish: (stream: MediaStream) => void) {}

	/** config present? */
	static configured(): boolean {
		const env = import.meta.env as Record<string, string | undefined>;
		return !!(env.VITE_CIC_SIP_URI && env.VITE_CIC_SIP_WS);
	}

	async start() {
		const env = import.meta.env as Record<string, string | undefined>;
		if (!SipLeg.configured()) return;
		this.ua = new UserAgent({
			uri: UserAgent.makeURI(env.VITE_CIC_SIP_URI!)!,
			transportOptions: { server: env.VITE_CIC_SIP_WS! },
			authorizationUsername: env.VITE_CIC_SIP_URI!.split('@')[0].replace('sip:', ''),
			authorizationPassword: env.VITE_CIC_SIP_PASSWORD
		});
		// inbound PSTN → room: answer, tap remote audio, publish as a seat
		this.ua.delegate = {
			onInvite: (s) => {
				this.session = s;
				s.accept();
				this.tapSession(s);
			}
		};
		await this.ua.start();
		await new Registerer(this.ua).register();
		// outbound room → PSTN when a dial target is configured
		const target = env.VITE_CIC_SIP_TARGET;
		if (target) {
			const uri = UserAgent.makeURI(target.includes('@') ? `sip:${target}` : `sip:${target}@${env.VITE_CIC_SIP_URI!.split('@')[1]}`);
			if (uri) {
				this.session = new Inviter(this.ua, uri);
				await (this.session as Inviter).invite();
				this.tapSession(this.session);
			}
		}
	}

	private tapSession(s: Session) {
		s.stateChange.addListener((st: SessionState) => {
			if (st !== SessionState.Established) return;
			const pc = (s.sessionDescriptionHandler as { peerConnection?: RTCPeerConnection })
				?.peerConnection;
			const remote = pc?.getReceivers().find((r) => r.track.kind === 'audio')?.track;
			if (remote) this.publish(new MediaStream([remote]));
		});
	}

	async stop() {
		await this.session?.bye?.().catch(() => {});
		await this.ua?.stop();
		this.session = null;
		this.ua = null;
	}
}
