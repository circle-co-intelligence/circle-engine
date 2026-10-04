/**
 * modelStatus — lightweight status channel for on-device model loads.
 * ASR/TTS/LLM weights are 100–270MB on first touch; silent minutes of
 * "nothing happening" read as broken, so consumers (the badge overlay)
 * surface loading/failed states honestly.
 */
export type ModelPhase = 'loading' | 'ready' | 'error';
export type ModelId = 'vad' | 'asr' | 'tts' | 'llm';

type Listener = (id: ModelId, phase: ModelPhase) => void;
const listeners = new Set<Listener>();

export function emitModel(id: ModelId, phase: ModelPhase): void {
	listeners.forEach((fn) => fn(id, phase));
}

export function onModel(fn: Listener): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}
