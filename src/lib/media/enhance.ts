/**
 * enhance.ts — opt-in media enhancements, all lazy-loaded OSS:
 *
 *   audio denoise   → denoise-voice-clarity (MIT) — DeepFilterNet3 + clarity
 *                     chain in an AudioWorklet; audio never leaves the device
 *   virtual bg/blur → @twilio/video-processors (BSD-3) standalone processFrame
 *                     loop: video element → segmentation → canvas.captureStream
 *   music mode      → hi-fi capture constraints (no DSP, stereo, 510k Opus)
 *                     — the denoise/AGC chain is skipped entirely
 *
 * Everything is opt-in (settings ops) and fails open to the raw track —
 * an unsupported browser or a model-load failure just means no processing.
 */

export type VideoFx = 'off' | 'blur' | 'image';

interface FxHandle {
	track: MediaStreamTrack;
	stop(): void;
}

// ---------- audio: DeepFilterNet3 + voice clarity ----------

export async function denoiseAudioTrack(track: MediaStreamTrack): Promise<FxHandle | null> {
	try {
		const { createDenoisedTrack, isVoiceClaritySupported } = await import('denoise-voice-clarity');
		if (!isVoiceClaritySupported()) return null;
		const handle = await createDenoisedTrack(track);
		return {
			track: handle.track,
			stop: () => void handle.destroy?.()
		};
	} catch {
		return null; // wasm/worklet unavailable — raw track stays
	}
}

/** hi-fi music mode: bypass the speech DSP chain entirely */
export function musicModeConstraints(): MediaTrackConstraints {
	return {
		echoCancellation: false,
		noiseSuppression: false,
		autoGainControl: false,
		channelCount: { ideal: 2 },
		sampleRate: { ideal: 48000 }
	};
}

// ---------- video: background blur / replacement ----------

const ASSETS = 'https://cdn.jsdelivr.net/npm/@twilio/video-processors@3.2.0/dist/build';

export async function videoFxTrack(
	source: MediaStreamTrack,
	mode: VideoFx,
	image?: HTMLImageElement
): Promise<FxHandle | null> {
	if (mode === 'off') return null;
	try {
		const proc = await import('@twilio/video-processors');
		if (!proc.isSupported || typeof VideoFrame === 'undefined') return null;
		const options = { assetsPath: ASSETS, inputFrameBufferType: 'videoframe' as const };
		const p =
			mode === 'blur'
				? new proc.GaussianBlurBackgroundProcessor({ ...options, blurFilterRadius: 15 })
				: new proc.VirtualBackgroundProcessor({
						...options,
						backgroundImage: image ?? (await loadDefaultBg())
					});
		await p.loadModel();

		const video = document.createElement('video');
		video.muted = true;
		video.playsInline = true;
		video.srcObject = new MediaStream([source]);
		await video.play();
		const canvas = document.createElement('canvas');
		canvas.width = video.videoWidth || 640;
		canvas.height = video.videoHeight || 480;

		let alive = true;
		const pump = () => {
			if (!alive || source.readyState !== 'live') return;
			void p.processFrame(video, canvas).finally(() => {
				if (alive && 'requestVideoFrameCallback' in video)
					video.requestVideoFrameCallback(pump);
			});
		};
		video.requestVideoFrameCallback(pump);

		const track = canvas.captureStream(24).getVideoTracks()[0];
		return {
			track,
			stop: () => {
				alive = false;
				track.stop();
				video.srcObject = null;
			}
		};
	} catch {
		return null;
	}
}

async function loadDefaultBg(): Promise<HTMLImageElement> {
	const img = new Image();
	img.src =
		'data:image/svg+xml,' +
		encodeURIComponent(
			`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1a2233"/><stop offset="1" stop-color="#0d1117"/></linearGradient></defs><rect width="1280" height="720" fill="url(#g)"/></svg>`
		);
	await img.decode();
	return img;
}

// ---------- video: smart crop — face-framed, like a camera operator ----------

/**
 * Auto-framing: FaceDetector (mediapipe tasks-vision) runs at ~2Hz on a
 * downscaled probe canvas; the largest face's padded box is mapped into a
 * 4:3 crop, smoothed, and drawn to the output canvas — a camera operator
 * for every seat. Opt-in via mediaFx; fails open to the raw track.
 */
export async function smartCropTrack(source: MediaStreamTrack): Promise<FxHandle | null> {
	try {
		const { FaceDetector, FilesetResolver } = await import('@mediapipe/tasks-vision');
		const wasm = await FilesetResolver.forVisionTasks(
			'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17/wasm'
		);
		const detector = await FaceDetector.createFromOptions(wasm, {
			baseOptions: {
				modelAssetPath:
					'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'
			},
			runningMode: 'VIDEO',
			minDetectionConfidence: 0.5
		});

		const video = document.createElement('video');
		video.muted = true;
		video.playsInline = true;
		video.srcObject = new MediaStream([source]);
		await video.play();
		const out = document.createElement('canvas');
		out.width = 640;
		out.height = 480;
		const ctx2d = out.getContext('2d')!;

		// smoothed crop rect in source pixels — starts as the full frame
		let cx = video.videoWidth / 2 || 320;
		let cy = video.videoHeight / 2 || 240;
		let cw = video.videoWidth || 640;
		let ch = video.videoHeight || 480;
		let lastDetect = 0;
		let alive = true;

		const pump = (now: number) => {
			if (!alive || source.readyState !== 'live') return;
			if (now - lastDetect > 500 && video.videoWidth) {
				lastDetect = now;
				const res = detector.detectForVideo(video, now).detections;
				type Box = { originX: number; originY: number; width: number; height: number };
				const best = res
					.map((d) => d.boundingBox as Box | undefined)
					.filter((b): b is Box => !!b)
					.sort((a, b) => b.width * b.height - a.width * a.height)[0];
				if (best) {
					// pad the face box 2.2× then fit a 4:3 crop inside the frame
					const pad = 2.2;
					let w = Math.min(best.width * pad, video.videoWidth);
					let h = Math.min((w * 3) / 4, video.videoHeight);
					w = Math.min(w, (h * 4) / 3);
					const tx = Math.max(0, Math.min(video.videoWidth - w, best.originX + best.width / 2 - w / 2));
					const ty = Math.max(0, Math.min(video.videoHeight - h, best.originY + best.height / 2 - h / 2));
					// exponential smoothing so the frame glides, never snaps
					cx += (tx - cx) * 0.25;
					cy += (ty - cy) * 0.25;
					cw += (w - cw) * 0.25;
					ch += (h - ch) * 0.25;
				}
			}
			ctx2d.drawImage(video, cx, cy, cw, ch, 0, 0, out.width, out.height);
			if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(pump);
		};
		video.requestVideoFrameCallback(pump);

		const track = out.captureStream(24).getVideoTracks()[0];
		return {
			track,
			stop: () => {
				alive = false;
				track.stop();
				detector.close();
				video.srcObject = null;
			}
		};
	} catch {
		return null;
	}
}
