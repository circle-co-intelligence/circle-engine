/**
 * modelStatus — lightweight status channel for on-device model loads.
 * ASR/TTS/LLM weights are 100–270MB on first touch; silent minutes of
 * "nothing happening" read as broken, so consumers (the badge overlay)
 * surface loading/failed states honestly — including download progress
 * when the producer can measure it.
 */
export type ModelPhase = 'loading' | 'ready' | 'error';
export type ModelId = 'vad' | 'asr' | 'tts' | 'llm';

export interface ModelDetail {
	/** overall download progress 0–100, when measurable */
	pct?: number;
	/** human-readable size hint for the pill, e.g. "~110 MB" */
	sizeHint?: string;
}

type Listener = (id: ModelId, phase: ModelPhase, detail?: ModelDetail) => void;
const listeners = new Set<Listener>();

export function emitModel(id: ModelId, phase: ModelPhase, detail?: ModelDetail): void {
	listeners.forEach((fn) => fn(id, phase, detail));
}

export function onModel(fn: Listener): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}
