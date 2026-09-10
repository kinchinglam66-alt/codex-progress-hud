import { windowContentSchema, windowDomSchema, type WindowContent } from '../diagnostics/window-state.js';

export interface ContentReader {
  executeJavaScript(code: string): Promise<unknown>;
  capturePage(rect: { x: number; y: number; width: number; height: number }, options: { stayHidden: boolean; stayAwake: boolean }): Promise<{ getSize(): { width: number; height: number }; toBitmap(): Buffer }>;
}

// No supplied code, selectors, text, URLs, or credentials cross this boundary.
export const DOM_DIAGNOSTIC_SCRIPT = `(() => {
  const hud = document.getElementById('hud');
  const style = hud ? getComputedStyle(hud) : null;
  return {
    hudPresent: !!hud,
    statusPresent: !!document.getElementById('status'),
    closePresent: !!document.getElementById('hide-window'),
    stylesheetCount: document.styleSheets.length,
    hudHidden: !hud || style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0,
    hudHasBackground: !!style && style.backgroundImage !== 'none',
    hudHasText: !!hud && !!hud.textContent.trim(),
    viewportWidth: window.innerWidth, viewportHeight: window.innerHeight
  };
})()`;

export function createWindowContentProbe(contents: ContentReader) {
  let result: WindowContent | undefined;
  let disposed = false;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const active = () => !disposed && result?.status === 'pending';
  return {
    start() {
      if (started || disposed) return;
      started = true;
      result = { status: 'pending' };
      timer = setTimeout(() => { if (active()) result = { ...result, status: 'timeout' }; }, 5000);
      timer.unref?.();
      void (async () => {
        try {
          const raw = await contents.executeJavaScript(DOM_DIAGNOSTIC_SCRIPT);
          if (!active()) return;
          const dom = windowDomSchema.parse(raw);
          result = { status: 'pending', dom };
          const picture = await contents.capturePage({ x: 0, y: 0, width: 64, height: 64 }, { stayHidden: true, stayAwake: false });
          if (!active()) return;
          const { width, height } = picture.getSize();
          if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 0 || height < 0 || width * height > 65536) throw Error('capture size');
          const pixels = picture.toBitmap();
          if (pixels.length !== width * height * 4) throw Error('capture format');
          let whitePixels = 0, transparentPixels = 0, varied = false;
          // Windows bitmap pixels have alpha in byte 3; RGB/BGR order does not affect these predicates.
          for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i+3] === 0) transparentPixels++;
            if (pixels[i]! >= 245 && pixels[i+1]! >= 245 && pixels[i+2]! >= 245 && pixels[i+3]! >= 245) whitePixels++;
            if (i > 0 && (pixels[i] !== pixels[0] || pixels[i+1] !== pixels[1] || pixels[i+2] !== pixels[2] || pixels[i+3] !== pixels[3])) varied = true;
          }
          result = { status: 'ready', dom, paint: { width, height, sampledPixels: pixels.length / 4, whitePixels, transparentPixels, varied } };
        } catch {
          if (active()) result = { ...result, status: 'failed' };
        } finally {
          clearTimeout(timer);
        }
      })();
    },
    snapshot(): WindowContent | undefined { return disposed || result === undefined ? undefined : windowContentSchema.parse(result); },
    dispose() { disposed = true; clearTimeout(timer); result = undefined; }
  };
}
