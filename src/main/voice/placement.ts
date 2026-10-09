// Where the popup goes: 16 px below-right of the pointer, flipped left or up near the edges of the pointer's
// screen so it never covers the pointer or leaves the work area (plan 12 §5.1). Pure, in screen DIPs.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export const POINTER_GAP = 16

export function placePopup(pointer: { x: number; y: number }, size: { width: number; height: number }, workArea: Rect): { x: number; y: number } {
  const right = workArea.x + workArea.width
  const bottom = workArea.y + workArea.height
  let x = pointer.x + POINTER_GAP
  let y = pointer.y + POINTER_GAP
  if (x + size.width > right) x = pointer.x - POINTER_GAP - size.width
  if (y + size.height > bottom) y = pointer.y - POINTER_GAP - size.height
  // On a screen too small to flip into, stay inside the work area.
  x = Math.max(workArea.x, Math.min(x, right - size.width))
  y = Math.max(workArea.y, Math.min(y, bottom - size.height))
  return { x: Math.round(x), y: Math.round(y) }
}
