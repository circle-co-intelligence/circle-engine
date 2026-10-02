/**
 * Local recording artifact registry — in-memory map of recorder uploads so
 * the `recordings` frame can list real artifacts for this device-session.
 * Shared by install.ts (the /rec-local store) and roomBridge (the frame).
 */
export interface Artifact {
	key: string;
	url: string;
	at: number;
	bytes: number;
}

const artifacts = new Map<string, Artifact[]>(); // roomCode → artifacts

export function noteArtifact(roomCode: string, key: string, bytes: number) {
	const list = artifacts.get(roomCode) ?? [];
	list.push({ key, url: `/rec-local/${key}`, at: Date.now(), bytes });
	artifacts.set(roomCode, list.slice(-20));
}

export function artifactsFor(roomCode: string): Artifact[] {
	return artifacts.get(roomCode) ?? [];
}
