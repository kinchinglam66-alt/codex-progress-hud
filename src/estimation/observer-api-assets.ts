import {createHash} from 'node:crypto';
import {lstat, open} from 'node:fs/promises';
import {isAbsolute, resolve} from 'node:path';
import {observerAssetPins,observerInstructionsMaxBytes} from './asset-pins.js';

const LIMIT = 16_384;

/** Uses release pins, not hashes learned from untrusted files or API responses. */
export async function loadObserverApiAssets(resourcesDirectory: string): Promise<Readonly<{instructions: string; schema: unknown}>> {
  try {
    if (!isAbsolute(resourcesDirectory) || /[\p{Cc}\p{Cf}]/u.test(resourcesDirectory) ||
        /(?:^|[\\/])[^\\/]*\.asar(?:[\\/]|$)/i.test(resourcesDirectory)) throw Error();
    async function readPinned(name: keyof typeof observerAssetPins): Promise<string> {
      const limit=name==='observer-instructions.md'?observerInstructionsMaxBytes:LIMIT;
      const path = resolve(resourcesDirectory, 'observer-assets', name);
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > limit) throw Error();
      const handle = await open(path, 'r');
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size > limit) throw Error();
        const buffer = Buffer.alloc(limit + 1);
        let size = 0;
        while (size < buffer.length) {
          const read = await handle.read(buffer, size, buffer.length - size, null);
          if (read.bytesRead === 0) break;
          size += read.bytesRead;
        }
        if (size > limit) throw Error();
        const bytes = buffer.subarray(0, size);
        if (createHash('sha256').update(bytes).digest('hex') !== observerAssetPins[name]) throw Error();
        return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
      } finally { await handle.close(); }
    }
    const [instructions, schemaText] = await Promise.all([
      readPinned('observer-instructions.md'), readPinned('observer.schema.json'),
    ]);
    return Object.freeze({instructions, schema: JSON.parse(schemaText) as unknown});
  } catch { throw new Error('OBSERVER_API_ASSETS_UNAVAILABLE'); }
}

/** Load the separately pinned, read-only compression protocol assets. */
export async function loadObserverCompressionAssets(resourcesDirectory: string): Promise<Readonly<{instructions: string; schema: unknown}>> {
  try {
    if (!isAbsolute(resourcesDirectory) || /[\p{Cc}\p{Cf}]/u.test(resourcesDirectory) ||
        /(?:^|[\\/])[^\\/]*\.asar(?:[\\/]|$)/i.test(resourcesDirectory)) throw Error();
    async function readPinned(name: 'context-summary-instructions.md'|'context-summary.schema.json'): Promise<string> {
      const path = resolve(resourcesDirectory, 'observer-assets', name);
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > LIMIT) throw Error();
      const handle = await open(path, 'r');
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size > LIMIT) throw Error();
        const buffer = Buffer.alloc(LIMIT + 1); let size = 0;
        while (size < buffer.length) { const read = await handle.read(buffer, size, buffer.length - size, null); if (read.bytesRead === 0) break; size += read.bytesRead; }
        if (size > LIMIT) throw Error();
        const bytes = buffer.subarray(0, size);
        if (createHash('sha256').update(bytes).digest('hex') !== observerAssetPins[name]) throw Error();
        return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
      } finally { await handle.close(); }
    }
    const [instructions, schemaText] = await Promise.all([
      readPinned('context-summary-instructions.md'), readPinned('context-summary.schema.json'),
    ]);
    return Object.freeze({instructions, schema: JSON.parse(schemaText) as unknown});
  } catch { throw new Error('OBSERVER_COMPRESSION_ASSETS_UNAVAILABLE'); }
}
