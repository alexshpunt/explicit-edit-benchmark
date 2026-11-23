/** Whole-file map on canvas: one thin row per line, edits tinted by agent, reading brackets
 * and the code viewport. Click or drag to scroll the code. */
import { required } from "../../../required.ts";
import { type Agent, type Mark, markAlpha, markSelected, rgba } from "./model.ts";

export interface Reader {
  agent: Agent;
  /** 0-based, end exclusive. */
  from: number;
  to: number;
  age: number;
}

export interface MinimapFrame {
  lines: readonly string[];
  marks: readonly (Mark | null)[];
  t: number;
  selected: string | null;
  viewport: [number, number];
  readers: Reader[];
}

const NEUTRAL = [150, 158, 176] as const;
const GUTTER = 14;

export class Minimap {
  private context: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private ratio = 1;
  private frame: MinimapFrame | null = null;
  private dragging = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private handlers: {
      scrollTo: (line: number) => void;
      hover: (mark: Mark | null, x: number, y: number) => void;
    },
  ) {
    this.context = required(canvas.getContext("2d"));
    canvas.addEventListener("pointerdown", (event) => {
      this.dragging = true;
      canvas.setPointerCapture(event.pointerId);
      this.scrollFrom(event);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (this.dragging) this.scrollFrom(event);
      else this.hoverFrom(event);
    });
    canvas.addEventListener("pointerup", () => (this.dragging = false));
    canvas.addEventListener("pointerleave", () => this.handlers.hover(null, 0, 0));
  }

  resize() {
    const parent = required(this.canvas.parentElement);
    this.ratio = window.devicePixelRatio || 1;
    this.width = parent.clientWidth;
    this.height = parent.clientHeight;
    this.canvas.width = Math.round(this.width * this.ratio);
    this.canvas.height = Math.round(this.height * this.ratio);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
  }

  private lineAt(y: number) {
    const count = this.frame?.lines.length ?? 0;
    return Math.max(0, Math.min(count - 1, Math.floor((y / this.height) * count)));
  }

  private scrollFrom(event: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    this.handlers.scrollTo(this.lineAt(event.clientY - rect.top));
  }

  private hoverFrom(event: PointerEvent) {
    if (!this.frame) return;
    const rect = this.canvas.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const count = this.frame.lines.length;
    const perPixel = count / this.height;
    const center = this.lineAt(y);
    const reach = Math.max(1, Math.ceil(perPixel * 2));
    let found: Mark | null = null;
    for (let offset = 0; offset <= reach && !found; offset++)
      found = this.frame.marks[center + offset] ?? this.frame.marks[center - offset] ?? null;
    this.handlers.hover(found, event.clientX, event.clientY);
  }

  private silhouette: HTMLCanvasElement | null = null;
  private silhouetteOf: readonly string[] | null = null;

  /** Code silhouette (indentation and length, merged per pixel row), drawn once per version. */
  private drawSilhouette(lines: readonly string[]) {
    const { width, height, ratio } = this;
    const canvas = (this.silhouette ??= document.createElement("canvas"));
    canvas.width = this.canvas.width;
    canvas.height = this.canvas.height;
    this.silhouetteOf = lines;
    const c = required(canvas.getContext("2d"));
    c.setTransform(ratio, 0, 0, ratio, 0, 0);
    c.clearRect(0, 0, width, height);
    const count = Math.max(1, lines.length);
    const rowHeight = height / count;
    const textLeft = GUTTER;
    const textWidth = width - GUTTER - 6;
    c.fillStyle = "rgba(160,170,195,0.16)";
    const rows = Math.ceil(height);
    const perRow = count / rows;
    for (let row = 0; row < rows; row++) {
      const first = Math.floor(row * perRow);
      const last = Math.min(count, Math.max(first + 1, Math.floor((row + 1) * perRow)));
      let indent = Infinity;
      let length = 0;
      for (let index = first; index < last; index += Math.max(1, Math.floor((last - first) / 6))) {
        const line = lines[index] ?? "";
        const trimmed = line.trimStart();
        if (!trimmed) continue;
        indent = Math.min(indent, line.length - trimmed.length);
        length = Math.max(length, line.length);
      }
      if (!length) continue;
      const x = textLeft + Math.min(indent, 40) * 0.9;
      const w = Math.max(2, Math.min(textWidth, length * 0.9) - (x - textLeft));
      c.fillRect(x, row, w, Math.max(0.6, Math.min(1, rowHeight)));
    }
  }

  draw(frame: MinimapFrame) {
    this.frame = frame;
    const { context: c, width, height, ratio } = this;
    if (!width || !height) return;
    c.setTransform(ratio, 0, 0, ratio, 0, 0);
    c.clearRect(0, 0, width, height);
    const count = Math.max(1, frame.lines.length);
    const rowHeight = height / count;
    const textLeft = GUTTER;

    if (
      this.silhouetteOf !== frame.lines ||
      this.silhouette?.width !== this.canvas.width ||
      this.silhouette.height !== this.canvas.height
    )
      this.drawSilhouette(frame.lines);
    c.setTransform(1, 0, 0, 1, 0, 0);
    if (this.silhouette) c.drawImage(this.silhouette, 0, 0);
    c.setTransform(ratio, 0, 0, ratio, 0, 0);

    // Edits: merge runs of lines with the same mark into one bar.
    const minimum = Math.max(rowHeight, 1.5);
    let index = 0;
    while (index < count) {
      const mark = frame.marks[index];
      if (!mark) {
        index++;
        continue;
      }
      let end = index + 1;
      while (end < count && frame.marks[end] === mark) end++;
      const selected = markSelected(mark, frame.selected);
      const alpha = Math.min(1, markAlpha(frame.t - mark.t) * (selected ? 1.6 : 1.15));
      const color = mark.agent?.color ?? NEUTRAL;
      const y = index * rowHeight;
      const h = Math.max(minimum, (end - index) * rowHeight);
      c.fillStyle = rgba(color, alpha * (mark.confidence === "ambiguous" ? 0.6 : 1));
      c.fillRect(textLeft - 3, y, width - textLeft - 3, h);
      c.fillStyle = rgba(color, Math.min(1, alpha * 1.6));
      c.fillRect(textLeft - 6, y, 3, h);
      if (selected) {
        c.strokeStyle = "rgba(255,255,255,0.9)";
        c.lineWidth = 1;
        c.strokeRect(textLeft - 6.5, y - 0.5, width - textLeft + 3, h + 1);
      }
      index = end;
    }

    // Reading brackets in the left gutter, one column per reader, fading with age.
    const columns = new Map<string, number>();
    for (const reader of frame.readers) {
      const column = columns.get(reader.agent.id) ?? columns.size % 3;
      columns.set(reader.agent.id, column);
      const alpha = 0.95 * Math.exp(-reader.age / 6000) + 0.25;
      const y = reader.from * rowHeight;
      const h = Math.max(3, (reader.to - reader.from) * rowHeight);
      const x = 2 + column * 3.5;
      c.fillStyle = rgba(reader.agent.color, alpha);
      c.fillRect(x, y, 2, h);
      c.fillRect(x, y, 4, 1);
      c.fillRect(x, y + h - 1, 4, 1);
    }

    // Viewport.
    const [top, bottom] = frame.viewport;
    const vy = (top / count) * height;
    const vh = Math.max(6, ((bottom - top) / count) * height);
    c.fillStyle = "rgba(255,255,255,0.06)";
    c.fillRect(GUTTER - 6, vy, width - GUTTER + 6, vh);
    c.strokeStyle = "rgba(255,255,255,0.35)";
    c.lineWidth = 1;
    c.strokeRect(GUTTER - 5.5, vy + 0.5, width - GUTTER + 4, vh - 1);
  }
}
