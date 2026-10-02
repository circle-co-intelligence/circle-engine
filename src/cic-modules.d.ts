/** Vendored production bundle modules — runtime-loaded from /cic/, not bundled */
declare module '/cic/*' {
	const mod: Record<string, unknown>;
	export = mod;
}

/** libarchive.js ships no typings — minimal surface we use */
declare module 'libarchive.js' {
	export class Archive {
		static init(options: { workerUrl: string }): unknown;
		static open(file: File): Promise<{
			getFilesArray(): Promise<{ file: File | { extract(): Promise<File>; name: string }; path: string }[]>;
		}>;
	}
}
