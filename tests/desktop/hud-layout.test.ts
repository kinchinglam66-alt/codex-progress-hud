import { expect, it } from "vitest";
import { hudBounds } from "../../src/desktop/hud-layout.js";

it('does not feed native DPI rounding drift back into the next requested width',()=>{
  const area={x:0,y:0,width:1707,height:960};
  let actual={x:683,y:436,width:341,height:158};
  for(let i=0;i<100;i++){
    const requested=hudBounds(actual,area,1);
    expect(requested.width).toBe(340);
    actual={...requested,width:requested.width+1};
  }
  expect(actual.width).toBe(341);
  expect(actual.height).toBe(158);
});

it("fits rows, caps height at 70% and clamps a removed monitor position", () => {
  const area = { x: -1000, y: 0, width: 1000, height: 800 };
  const bounds = { x: 1500, y: 900, width: 340, height: 146 };
  expect(hudBounds(bounds, area, 32)).toEqual({ x: -340, y: 240, width: 340, height: 560 });
  expect(hudBounds(bounds, area, 0).height).toBe(82);
  expect(hudBounds(bounds, area, 2).height).toBe(252);
});

it("fits even a tiny work area and rejects invalid input", () => {
  const bounds = { x: 0, y: 0, width: 340, height: 146 };
  expect(hudBounds(bounds, { x: 0, y: 0, width: 200, height: 100 }, 3))
    .toEqual({ x: 0, y: 0, width: 200, height: 70 });
  expect(() => hudBounds(bounds, { x: 0, y: 0, width: 0, height: 100 }, 3)).toThrow();
  expect(() => hudBounds(bounds, { x: 0, y: 0, width: 200, height: 100 }, NaN)).toThrow();
});
