#!/usr/bin/env node
// Generates src-tauri/icons/* without ImageMagick — encodes PNGs directly
// (zlib + CRC) and wraps them into .ico (PNG-in-ICO, Vista+) and .icns
// (PNG-in-ICNS). Icon is the Circle mark: a ring on deep background.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'icons');
mkdirSync(OUT, { recursive: true });

function crc32(buf) {
	let c = ~0;
	for (const b of buf) {
		c ^= b;
		for (let k = 0; k < 8; k++) c = c >>> 1 ^ (c & 1 ? 0xedb88320 : 0);
	}
	return ~c >>> 0;
}
function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const td = Buffer.concat([Buffer.from(type), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(td));
	return Buffer.concat([len, td, crc]);
}

function png(size) {
	const { floor } = Math;
	const c = size / 2;
	const ringR = c * 0.78;
	const ringW = Math.max(2, size * 0.09);
	const rows = [];
	for (let y = 0; y < size; y++) {
		const row = Buffer.alloc(1 + size * 4);
		for (let x = 0; x < size; x++) {
			const dx = x + 0.5 - c;
			const dy = y + 0.5 - c;
			const d = Math.hypot(dx, dy);
			// deep navy field, warm ring
			let r = 0x1a, g = 0x1e, b = 0x28, a = 0;
			const onRing = Math.abs(d - ringR) <= ringW / 2;
			const inDisc = d <= ringR - ringW / 2;
			if (onRing) {
				// gold→amber ring with soft edge
				r = 0xe8; g = 0xa8; b = 0x4d; a = 255;
			} else if (inDisc) {
				r = 0x1a; g = 0x1e; b = 0x28; a = 255;
			}
			const o = 1 + x * 4;
			row[o] = r; row[o + 1] = g; row[o + 2] = b; row[o + 3] = a;
		}
		rows.push(row);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(Buffer.concat(rows))),
		chunk('IEND', Buffer.alloc(0))
	]);
}

function ico(pngs) {
	// PNG-in-ICO container
	const header = Buffer.alloc(6);
	header.writeUInt16LE(0); header.writeUInt16LE(1); header.writeUInt16LE(pngs.length, 4);
	let offset = 6 + pngs.length * 16;
	const entries = [];
	for (const { size, buf } of pngs) {
		const e = Buffer.alloc(16);
		e[0] = size >= 256 ? 0 : size; e[1] = e[0];
		e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
		e.writeUInt32LE(buf.length, 8); e.writeUInt32LE(offset, 12);
		offset += buf.length;
		entries.push(e);
	}
	return Buffer.concat([header, ...entries, ...pngs.map((p) => p.buf)]);
}

function icns(png512) {
	// ic10 = 1024² PNG, ic09 = 512² PNG — one entry suffices for modern macOS
	const type = Buffer.from('ic09');
	const len = Buffer.alloc(4);
	len.writeUInt32BE(8 + png512.length);
	const body = Buffer.concat([Buffer.from('icns'), len]);
	return Buffer.concat([body, type, len, png512]);
}

const p32 = png(32), p128 = png(128), p256 = png(256), p512 = png(512);
writeFileSync(join(OUT, '32x32.png'), p32);
writeFileSync(join(OUT, '128x128.png'), p128);
writeFileSync(join(OUT, '128x128@2x.png'), p256);
writeFileSync(join(OUT, 'icon.png'), p512);
writeFileSync(join(OUT, 'icon.ico'), ico([{ size: 32, buf: p32 }, { size: 128, buf: p128 }, { size: 256, buf: p256 }]));
writeFileSync(join(OUT, 'icon.icns'), icns(p512));
console.log('icons written to', OUT);
