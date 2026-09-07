export interface HudRectangle { x: number; y: number; width: number; height: number }

export function hudBounds(current: HudRectangle, area: HudRectangle, rows: number): HudRectangle {
  if (![...Object.values(current), ...Object.values(area), rows].every(Number.isFinite) ||
      area.width < 1 || area.height < 2 || current.width < 1 ||
      !Number.isInteger(rows) || rows < 0 || rows > 32) throw new Error("Invalid HUD layout");
  const width = Math.min(Math.round(current.width), Math.floor(area.width));
  const height = Math.min(rows === 0 ? 82 : 64 + rows * 94, Math.floor(area.height * 0.7));
  return {
    x: Math.round(Math.max(area.x, Math.min(current.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(current.y, area.y + area.height - height))),
    width, height
  };
}
