import { afterEach, expect, it, vi } from 'vitest';
import { createWindowContentProbe } from '../../src/desktop/window-content-probe.js';

afterEach(() => vi.useRealTimers());
const dom = { hudPresent: true, statusPresent: true, closePresent: true, stylesheetCount: 1, hudHidden: false, hudHasBackground: true, hudHasText: true, viewportWidth: 340, viewportHeight: 158 };
const tick = async () => { for (let i=0;i<8;i++) await Promise.resolve(); };

it('collects sanitized DOM and bounded pixel statistics once, without retaining pixels or text', async () => {
  const contents = {
    executeJavaScript: vi.fn(async () => ({ ...dom, text: 'private task', token: 'secret' })),
    capturePage: vi.fn(async () => ({ getSize: () => ({ width: 2, height: 1 }), toBitmap: () => Buffer.from([255,255,255,255, 20,20,20,255]) }))
  };
  const probe = createWindowContentProbe(contents);
  probe.start(); probe.start(); await tick();
  expect(probe.snapshot()).toMatchObject({ status: 'ready', dom, paint: { width: 2, height: 1, sampledPixels: 2, whitePixels: 1, transparentPixels: 0, varied: true } });
  expect(JSON.stringify(probe.snapshot())).not.toMatch(/private|secret/);
  expect(contents.capturePage).toHaveBeenCalledWith({ x: 0, y: 0, width: 64, height: 64 }, { stayHidden: true, stayAwake: false });
  expect(contents.executeJavaScript).toHaveBeenCalledTimes(1);
  probe.dispose();
});

it('times out a stalled renderer and does not capture or retry after late settlement', async () => {
  vi.useFakeTimers();
  let resolve!: (value: unknown) => void;
  const capturePage = vi.fn();
  const probe = createWindowContentProbe({ executeJavaScript: () => new Promise(r => { resolve=r; }), capturePage });
  probe.start(); await vi.advanceTimersByTimeAsync(5000);
  expect(probe.snapshot()).toEqual({ status: 'timeout' });
  resolve(dom); await tick(); probe.start();
  expect(capturePage).not.toHaveBeenCalled();
  expect(probe.snapshot()).toEqual({ status: 'timeout' });
  probe.dispose();
});

it('does not publish results or capture after disposal', async () => {
  let resolve!: (value: unknown) => void;
  const capturePage = vi.fn();
  const probe = createWindowContentProbe({ executeJavaScript: () => new Promise(r => { resolve=r; }), capturePage });
  probe.start(); probe.dispose(); resolve(dom); await tick();
  expect(capturePage).not.toHaveBeenCalled();
  expect(probe.snapshot()).toBeUndefined();
});

it('categorizes failures without publishing native error messages', async () => {
  const probe = createWindowContentProbe({ executeJavaScript: () => { throw Error('secret'); }, capturePage: vi.fn() });
  expect(() => probe.start()).not.toThrow(); await tick();
  expect(probe.snapshot()).toEqual({ status: 'failed' });
  probe.dispose();
});

it('retains DOM evidence when only pixel capture times out', async () => {
  vi.useFakeTimers();
  const probe = createWindowContentProbe({ executeJavaScript: async () => dom, capturePage: () => new Promise(() => {}) });
  probe.start(); await tick();
  await vi.advanceTimersByTimeAsync(5000);
  expect(probe.snapshot()).toEqual({status:'timeout',dom});
  probe.dispose();
});

it('rejects oversized captures before reading bitmap memory', async () => {
  const toBitmap = vi.fn();
  const probe = createWindowContentProbe({ executeJavaScript: async () => dom, capturePage: async () => ({getSize:()=>({width:65536,height:65536}),toBitmap}) });
  probe.start(); await tick();
  expect(probe.snapshot()).toEqual({status:'failed',dom});
  expect(toBitmap).not.toHaveBeenCalled();
  probe.dispose();
});
