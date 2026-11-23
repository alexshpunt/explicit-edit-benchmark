import { useEffect, useRef } from "preact/hooks";
import { required } from "../../../required.ts";
import { formatTime } from "./format.ts";
import {
  CATEGORY_COLORS,
  type Call,
  type Mark,
  type Model,
  lastAtOrBefore,
  rgba,
} from "./model.ts";
import { type Store, frameScheduler } from "./store.ts";

const AXIS = 22;
const DENSITY = 26;
const EDITS = 18;
const LEFT = 12;
const RIGHT = 12;

/** Canvas timeline: density strip, edit ticks, one lane per concurrent agent slot. */
class TimelineCanvas {
  private context: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private ratio = 1;
  private dragging = false;
  private hovered: Call | null = null;
  private density: Float32Array = new Float32Array(0);
  private edits: Array<{ t: number; mark: Mark }> = [];
  private schedule: () => void;
  private unsubscribe: () => void;
  private observer: ResizeObserver;

  constructor(
    private canvas: HTMLCanvasElement,
    private model: Model,
    private store: Store,
  ) {
    this.context = required(canvas.getContext("2d"));
    for (const file of model.files)
      file.hunkMarks.forEach((marks) =>
        marks.forEach((mark) => this.edits.push({ t: mark.t, mark })),
      );
    this.schedule = frameScheduler(() => this.draw());
    this.unsubscribe = store.subscribe(this.schedule);
    this.observer = new ResizeObserver(() => {
      this.resize();
      this.draw();
    });
    this.observer.observe(required(canvas.parentElement));
    canvas.addEventListener("pointerdown", this.down);
    canvas.addEventListener("pointermove", this.move);
    canvas.addEventListener("pointerup", this.up);
    canvas.addEventListener("pointerleave", this.leave);
    this.resize();
    this.draw();
  }

  destroy() {
    this.unsubscribe();
    this.observer.disconnect();
  }

  private get lanesTop() {
    return AXIS + DENSITY + EDITS + 6;
  }

  private get laneHeight() {
    const available = this.height - this.lanesTop - 6;
    return Math.max(4, Math.min(22, available / this.model.laneCount));
  }

  private x(t: number) {
    return LEFT + (t / this.model.duration) * (this.width - LEFT - RIGHT);
  }

  private time(x: number) {
    const t = ((x - LEFT) / (this.width - LEFT - RIGHT)) * this.model.duration;
    return Math.max(0, Math.min(this.model.duration, t));
  }

  private resize() {
    const parent = required(this.canvas.parentElement);
    this.ratio = window.devicePixelRatio || 1;
    this.width = parent.clientWidth;
    this.height = parent.clientHeight;
    this.canvas.width = Math.round(this.width * this.ratio);
    this.canvas.height = Math.round(this.height * this.ratio);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.computeDensity();
  }

  /** The static picture: everything but the playhead, focus and selection. */
  private layer: HTMLCanvasElement | null = null;

  /** Concurrent active calls per pixel column. */
  private computeDensity() {
    this.layer = null;
    const columns = Math.max(1, Math.floor(this.width - LEFT - RIGHT));
    const density = new Float32Array(columns);
    const scale = columns / this.model.duration;
    for (const call of this.model.calls) {
      if (call.parent) continue;
      const from = Math.max(0, Math.floor(call.start * scale));
      const to = Math.min(columns - 1, Math.ceil(call.end * scale));
      for (let column = from; column <= to; column++) density[column] = (density[column] ?? 0) + 1;
    }
    this.density = density;
  }

  private callAt(x: number, y: number): Call | null {
    const lane = Math.floor((y - this.lanesTop) / this.laneHeight);
    if (lane < 0 || lane >= this.model.laneCount) return null;
    const t = this.time(x);
    const slack = (4 / (this.width - LEFT - RIGHT)) * this.model.duration;
    const calls = this.model.laneCalls[lane] ?? [];
    const index = lastAtOrBefore(calls, t + slack, (call) => call.start);
    for (let candidate = index; candidate >= 0 && candidate > index - 4; candidate--) {
      const call = calls[candidate];
      if (call && call.start - slack <= t && t <= call.end + slack) {
        const children = call.children;
        const child = children[lastAtOrBefore(children, t, (entry) => entry.start)];
        if (child && t <= child.end + slack) return child;
        return call;
      }
    }
    return null;
  }

  private down = (event: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const call = y >= this.lanesTop ? this.callAt(x, y) : null;
    // Shift-drag scrubs even over a call.
    if (call && !event.shiftKey) {
      this.store.set({
        selectedCall: call.id,
        focusAgent: call.agent.id,
        reveal: this.store.state.reveal + 1,
        t: Math.max(this.store.state.t, Math.min(call.end, this.model.duration)),
        playing: false,
      });
      return;
    }
    this.dragging = true;
    this.canvas.setPointerCapture(event.pointerId);
    this.store.set({ t: this.time(x), playing: false, tooltip: null });
  };

  private move = (event: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (this.dragging) {
      this.store.set({ t: this.time(x) });
      return;
    }
    const call = y >= this.lanesTop ? this.callAt(x, y) : null;
    this.canvas.style.cursor = call ? "pointer" : y < this.lanesTop ? "ew-resize" : "crosshair";
    if (call !== this.hovered) {
      this.hovered = call;
      this.schedule();
    }
    if (call)
      this.store.set({ tooltip: { kind: "call", x: event.clientX, y: event.clientY, call } });
    else if (this.store.state.tooltip?.kind === "call") this.store.set({ tooltip: null });
  };

  private up = () => {
    this.dragging = false;
  };

  private leave = () => {
    this.hovered = null;
    if (this.store.state.tooltip?.kind === "call") this.store.set({ tooltip: null });
    this.schedule();
  };

  /** Everything that does not depend on the playhead, drawn once per size. */
  private drawLayer() {
    const { width, height, ratio, model } = this;
    const layer = (this.layer ??= document.createElement("canvas"));
    layer.width = Math.round(width * ratio);
    layer.height = Math.round(height * ratio);
    const c = required(layer.getContext("2d"));
    c.setTransform(ratio, 0, 0, ratio, 0, 0);

    // Axis.
    c.font = "500 10px Inter, 'Segoe UI', system-ui, sans-serif";
    c.textBaseline = "middle";
    const seconds = model.duration / 1000;
    const step = [1, 2, 5, 10, 15, 30, 60, 120, 300].find((value) => seconds / value <= 14) ?? 600;
    for (let second = 0; second <= seconds; second += step) {
      const x = this.x(second * 1000);
      c.fillStyle = "rgba(255,255,255,0.05)";
      c.fillRect(Math.round(x), AXIS, 1, height - AXIS);
      c.fillStyle = "#5d667c";
      c.textAlign = second === 0 ? "left" : "center";
      c.fillText(formatTime(second * 1000), x, AXIS / 2);
    }

    // Density strip.
    const top = AXIS + 4;
    let peak = 1;
    for (const value of this.density) peak = Math.max(peak, value);
    const scaleX = (width - LEFT - RIGHT) / this.density.length;
    const gradient = c.createLinearGradient(0, top, 0, top + DENSITY);
    gradient.addColorStop(0, "rgba(124,156,255,0.85)");
    gradient.addColorStop(1, "rgba(124,156,255,0.12)");
    c.beginPath();
    c.moveTo(LEFT, top + DENSITY);
    this.density.forEach((value, column) => {
      c.lineTo(LEFT + column * scaleX, top + DENSITY - (value / peak) * (DENSITY - 2));
    });
    c.lineTo(LEFT + this.density.length * scaleX, top + DENSITY);
    c.closePath();
    c.fillStyle = gradient;
    c.fill();

    // Edit ticks.
    const editTop = top + DENSITY + 3;
    for (const { t: time, mark } of this.edits) {
      const x = Math.round(this.x(time));
      const color = mark.agent?.color ?? [150, 158, 176];
      c.fillStyle = rgba(color, 0.95);
      const size = Math.min(
        EDITS - 4,
        4 + Math.sqrt(mark.hunk.insert.length + mark.hunk.remove) * 1.6,
      );
      c.fillRect(x - 1, editTop + (EDITS - size) / 2, 2, size);
    }

    // Lanes.
    const laneHeight = this.laneHeight;
    const blockHeight = this.blockHeight;
    for (let lane = 0; lane < model.laneCount; lane += 2) {
      c.fillStyle = "rgba(255,255,255,0.018)";
      c.fillRect(0, this.lanesTop + lane * laneHeight, width, laneHeight);
    }
    // Agent spans: a faint bar in the agent's color behind its calls.
    for (const agent of model.agents) {
      const y = this.lanesTop + agent.lane * laneHeight;
      const x0 = this.x(agent.info.startMs);
      const x1 = this.x(agent.info.endMs);
      c.fillStyle = rgba(agent.color, 0.09);
      c.fillRect(x0, y + 1, Math.max(1, x1 - x0), laneHeight - 2);
      c.fillStyle = rgba(agent.color, 0.9);
      c.fillRect(x0, y + 1, 2, laneHeight - 2);
      if (agent.info.status !== "done") {
        c.fillStyle = "rgba(255,110,110,0.9)";
        c.fillRect(x1 - 2, y + 1, 2, laneHeight - 2);
      }
    }
    for (let lane = 0; lane < model.laneCount; lane++) {
      const y = this.lanesTop + lane * laneHeight + (laneHeight - blockHeight) / 2;
      for (const call of model.laneCalls[lane] ?? []) {
        const x0 = this.x(call.start);
        const x1 = Math.max(x0 + 2, this.x(call.end));
        const color = CATEGORY_COLORS[call.category];
        c.fillStyle = rgba(color, call.ok === false ? 0.45 : 0.78);
        c.fillRect(x0, y, x1 - x0 - 0.5, blockHeight);
        // Nested calls of a script: thin sub-blocks along the bottom of the parent block.
        if (call.children.length && blockHeight >= 5) {
          const subHeight = Math.max(2, Math.round(blockHeight * 0.38));
          for (const child of call.children) {
            const cx0 = this.x(child.start);
            const cx1 = Math.max(cx0 + 1.5, this.x(child.end));
            c.fillStyle = rgba(CATEGORY_COLORS[child.category], 1);
            c.fillRect(cx0, y + blockHeight - subHeight, Math.min(cx1, x1) - cx0, subHeight);
          }
        }
        if (call.ok === false) {
          c.fillStyle = "rgba(255,96,96,0.95)";
          c.fillRect(x1 - 2.5, y, 2, blockHeight);
        }
      }
    }
  }

  private get blockHeight() {
    const laneHeight = this.laneHeight;
    return Math.max(3, laneHeight - (laneHeight > 10 ? 5 : 2));
  }

  private draw() {
    const { context: c, width, height, ratio, model } = this;
    if (!width || !height) return;
    if (this.layer?.width !== Math.round(width * ratio)) this.drawLayer();
    const { t, selectedCall, focusAgent } = this.store.state;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.layer) c.drawImage(this.layer, 0, 0);
    c.setTransform(ratio, 0, 0, ratio, 0, 0);
    const playX = this.x(t);
    const laneHeight = this.laneHeight;
    const blockHeight = this.blockHeight;

    // Focused agent: a brighter span.
    const focused = focusAgent ? model.agentById.get(focusAgent) : undefined;
    if (focused) {
      const y = this.lanesTop + focused.lane * laneHeight;
      const x0 = this.x(focused.info.startMs);
      const x1 = this.x(focused.info.endMs);
      c.fillStyle = rgba(focused.color, 0.16);
      c.fillRect(x0, y + 1, Math.max(1, x1 - x0), laneHeight - 2);
      c.strokeStyle = rgba(focused.color, 0.7);
      c.lineWidth = 1;
      c.strokeRect(x0 + 0.5, y + 1.5, Math.max(1, x1 - x0) - 1, laneHeight - 3);
    }

    // Selected and hovered calls.
    const selected = selectedCall ? model.callById.get(selectedCall) : undefined;
    const selectedRoot = selected?.parent ?? selected;
    const hoveredRoot = this.hovered?.parent ?? this.hovered;
    for (const call of [hoveredRoot, selectedRoot]) {
      if (!call) continue;
      const x0 = this.x(call.start);
      const x1 = Math.max(x0 + 2, this.x(call.end));
      const y = this.lanesTop + call.agent.lane * laneHeight + (laneHeight - blockHeight) / 2;
      const isSelected = call === selectedRoot;
      c.strokeStyle = isSelected ? "#ffffff" : "rgba(255,255,255,0.6)";
      c.lineWidth = isSelected ? 1.5 : 1;
      c.strokeRect(x0 - 0.5, y - 0.5, x1 - x0 + 0.5, blockHeight + 1);
      if (isSelected && selected && selected !== call) {
        const cx = this.x(selected.start);
        c.fillStyle = "#ffffff";
        c.fillRect(cx - 0.5, y - 3, 1.5, blockHeight + 6);
      }
    }

    // Future veil and playhead.
    c.fillStyle = "rgba(11,13,18,0.6)";
    c.fillRect(playX, AXIS + 2, width - playX, height - AXIS - 2);
    c.fillStyle = "#ffffff";
    c.fillRect(Math.round(playX) - 0.5, AXIS - 2, 1.5, height - AXIS + 2);
    c.beginPath();
    c.moveTo(playX - 5, AXIS - 6);
    c.lineTo(playX + 5, AXIS - 6);
    c.lineTo(playX, AXIS + 1);
    c.closePath();
    c.fill();
  }
}

export function Timeline({ model, store }: { model: Model; store: Store }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const timeline = new TimelineCanvas(required(canvas.current), model, store);
    return () => timeline.destroy();
  }, [model]);
  return (
    <div class="timeline-canvas">
      <canvas ref={canvas} />
    </div>
  );
}
