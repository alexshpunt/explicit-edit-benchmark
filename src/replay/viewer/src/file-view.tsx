import { cpp } from "@codemirror/lang-cpp";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import {
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "preact/hooks";
import { required } from "../../../required.ts";
import { changesBetween, documentLines, documentText } from "./doc-sync.ts";
import { formatCount } from "./format.ts";
import { Minimap, type Reader } from "./minimap.ts";
import {
  type FileModel,
  type Mark,
  type Model,
  agentPhase,
  callObserves,
  lastAtOrBefore,
  markAlpha,
  markSelected,
  rgba,
} from "./model.ts";
import { type Store, ZOOM_LEVELS, frameScheduler, useStore } from "./store.ts";

const NEUTRAL = [150, 158, 176] as const;

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.modifier], color: "#c49bf5" },
  {
    tag: [tags.typeName, tags.className, tags.namespace, tags.standard(tags.typeName)],
    color: "#78d3c6",
  },
  { tag: [tags.string, tags.special(tags.string), tags.character], color: "#b9e08f" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "#f3a06b" },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: "#596278",
    fontStyle: "italic",
  },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#86adff" },
  { tag: [tags.processingInstruction, tags.meta, tags.macroName], color: "#f2c66d" },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: "#8d97ad" },
  { tag: [tags.propertyName], color: "#d3dbeb" },
  { tag: [tags.variableName], color: "#e3e7f0" },
]);

const theme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "transparent", color: "#e3e7f0" },
    ".cm-scroller": {
      fontFamily: "var(--mono)",
      fontSize: "var(--code-size, 12.5px)",
      lineHeight: "1.6",
    },
    ".cm-content": { padding: "10px 0 40vh" },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "#3d4456",
      border: "none",
      paddingRight: "6px",
    },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 14px", minWidth: "52px" },
    ".cm-line": { padding: "0 18px 0 12px", transition: "background-color 120ms linear" },
    "&.cm-focused": { outline: "none" },
    ".cm-selectionBackground, ::selection": { backgroundColor: "#2b3550 !important" },
  },
  { dark: true },
);

const refresh = StateEffect.define();

interface Removal {
  /** 0-based line of the current version the removed lines were above. */
  line: number;
  mark: Mark;
}

interface Context {
  marks: (Mark | null)[];
  t: number;
  selected: string | null;
  removals: Removal[];
  /** Zoomed far out: flat tints, no hatching. */
  far?: boolean;
}

/** How long a removal stays visible as a marker in the code. */
const REMOVAL_MS = 9000;

class RemovalWidget extends WidgetType {
  constructor(
    readonly mark: Mark,
    readonly alpha: number,
  ) {
    super();
  }
  eq(other: RemovalWidget) {
    return other.mark === this.mark && Math.abs(other.alpha - this.alpha) < 0.05;
  }
  toDOM() {
    const element = document.createElement("div");
    const color = this.mark.agent?.color ?? NEUTRAL;
    element.className = "cm-removed";
    element.style.setProperty("--removed", rgba(color, 1));
    element.style.opacity = this.alpha.toFixed(2);
    const count = this.mark.hunk.remove;
    element.textContent = `− ${count} line${count === 1 ? "" : "s"} removed${this.mark.agent ? ` · ${this.mark.agent.info.label}` : ""}`;
    return element;
  }
  get estimatedHeight() {
    return 18;
  }
}

/** Block widgets must come from a state field, not a view plugin. */
function removalField(context: Context) {
  const build = (doc: Text): DecorationSet => {
    const builder = new RangeSetBuilder<Decoration>();
    for (const removal of context.removals) {
      const alpha = 1 - (context.t - removal.mark.t) / REMOVAL_MS;
      if (alpha <= 0) continue;
      const position = doc.line(Math.min(doc.lines, removal.line + 1)).from;
      builder.add(
        position,
        position,
        Decoration.widget({
          widget: new RemovalWidget(removal.mark, Math.max(0.35, Math.round(alpha * 10) / 10)),
          block: true,
          side: -1,
        }),
      );
    }
    return builder.finish();
  };
  return StateField.define<DecorationSet>({
    create: (state) => build(state.doc),
    update: (value, tr) =>
      tr.docChanged || tr.effects.some((effect) => effect.is(refresh))
        ? build(tr.state.doc)
        : value,
    provide: (field) => EditorView.decorations.from(field),
  });
}

function markStyle(mark: Mark, t: number, selected: boolean, far = false) {
  const alpha = markAlpha(t - mark.t);
  const color = mark.agent?.color ?? NEUTRAL;
  const bucket = Math.round(alpha * 40) / 40;
  if (mark.confidence === "ambiguous" && far)
    return `background-color: ${rgba(NEUTRAL, bucket * 0.3)}`;
  if (mark.confidence === "ambiguous")
    return `background: repeating-linear-gradient(135deg, ${rgba(NEUTRAL, bucket * 0.55)} 0 5px, transparent 5px 10px); box-shadow: inset 3px 0 0 ${rgba(NEUTRAL, 0.75)}`;
  if (selected)
    return `background-color: ${rgba(color, Math.max(0.42, bucket * 0.9))}; box-shadow: inset 4px 0 0 #fff`;
  return `background-color: ${rgba(color, bucket * 0.42)}; box-shadow: inset 3px 0 0 ${rgba(color, Math.min(1, bucket * 2.2))}`;
}

function markPlugin(context: Context) {
  const cache = new Map<string, Decoration>();
  const decorationOf = (mark: Mark) => {
    const selected = markSelected(mark, context.selected);
    const style = markStyle(mark, context.t, selected, context.far);
    let decoration = cache.get(style);
    if (!decoration) {
      decoration = Decoration.line({ attributes: { style } });
      cache.set(style, decoration);
    }
    return decoration;
  };
  const build = (view: EditorView): DecorationSet => {
    const builder = new RangeSetBuilder<Decoration>();
    for (const { from, to } of view.visibleRanges) {
      let position = from;
      while (position <= to) {
        const line = view.state.doc.lineAt(position);
        const mark = context.marks[line.number - 1];
        if (mark) builder.add(line.from, line.from, decorationOf(mark));
        position = line.to + 1;
      }
    }
    return builder.finish();
  };
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refresh)))
        )
          this.decorations = build(update.view);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

/** Owns the editor and the minimap of one file and keeps both at the playhead. */
class FileController {
  private view: EditorView;
  private minimap: Minimap;
  private context: Context = { marks: [], t: 0, selected: null, removals: [] };
  private shown: number;
  private lastReveal: number;
  private unsubscribe: () => void;
  private observer: ResizeObserver;
  private zoom = 0;

  constructor(
    private host: HTMLElement,
    canvas: HTMLCanvasElement,
    private file: FileModel,
    private model: Model,
    private store: Store,
  ) {
    const state = store.state;
    this.shown = file.versionAt(state.t);
    const initial = file.state(this.shown);
    this.context = {
      marks: initial.marks,
      t: state.t,
      selected: state.selectedCall,
      removals: this.removals(this.shown, state.t),
    };
    this.lastReveal = state.reveal;
    const language = file.info.language;
    this.view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: documentText(initial.lines),
        extensions: [
          lineNumbers(),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          ["cpp", "c", "c++", "h", "hpp"].includes(language) ? cpp() : [],
          syntaxHighlighting(highlight),
          theme,
          markPlugin(this.context),
          removalField(this.context),
          EditorView.domEventHandlers({
            mousemove: (event, view) => this.hover(event, view),
            mouseleave: () => this.clearHover(),
            click: (event, view) => this.click(event, view),
          }),
        ],
      }),
    });
    host.addEventListener("wheel", this.wheel, { passive: false, capture: true });
    this.minimap = new Minimap(canvas, {
      scrollTo: (line) => {
        if (this.store.state.follow) this.store.set({ follow: false });
        this.scrollToLine(line, false);
      },
      hover: (mark, x, y) => {
        if (mark) store.set({ tooltip: { kind: "mark", x, y, mark } });
        else this.clearHover();
      },
    });
    const schedule = frameScheduler(() => this.sync());
    this.unsubscribe = store.subscribe(schedule);
    this.view.scrollDOM.addEventListener("scroll", () => this.drawMinimap(), { passive: true });
    this.observer = new ResizeObserver(() => {
      this.minimap.resize();
      this.drawMinimap();
    });
    this.observer.observe(required(canvas.parentElement));
    this.minimap.resize();
    this.sync();
  }

  destroy() {
    this.unsubscribe();
    this.observer.disconnect();
    this.view.destroy();
  }

  private sync() {
    const { t, selectedCall, reveal, follow, zoom } = this.store.state;
    if (zoom !== this.zoom) this.applyZoom(zoom);
    const version = this.file.versionAt(t);
    const previous = this.shown;
    const state = this.file.state(version);
    // Tints fade slowly: refreshing them five times a second is enough.
    const contextChanged =
      version !== this.shown ||
      Math.floor(t / 200) !== Math.floor(this.context.t / 200) ||
      selectedCall !== this.context.selected;
    this.context.marks = state.marks;
    this.context.t = t;
    this.context.selected = selectedCall;
    this.context.removals = this.removals(version, t);
    if (version !== this.shown) {
      let changes = null;
      try {
        changes = changesBetween(this.view.state.doc, this.file.changes, this.shown, version);
      } catch (error) {
        console.warn("agent-replay: falling back to a full document update", error);
      }
      this.view.dispatch({
        changes: changes ?? {
          from: 0,
          to: this.view.state.doc.length,
          insert: documentText(state.lines),
        },
        effects: refresh.of(null),
      });
      this.shown = version;
      if (documentLines(this.view.state.doc) !== state.lines.length) {
        console.warn("agent-replay: document drifted from the trace; replacing it");
        this.view.dispatch({
          changes: { from: 0, to: this.view.state.doc.length, insert: documentText(state.lines) },
        });
      }
    } else if (contextChanged) this.view.dispatch({ effects: refresh.of(null) });
    if (reveal !== this.lastReveal) {
      this.lastReveal = reveal;
      this.revealSelected();
    } else if (follow && version > previous && version > 0) {
      // Show the newest change: its largest insertion, else its largest removal.
      const change = this.file.changes[version - 1];
      let shift = 0;
      let best = { at: 0, size: -1 };
      for (const hunk of change?.hunks ?? []) {
        const size = hunk.insert.length ? 1e6 + hunk.insert.length : hunk.remove;
        if (size > best.size)
          best = { at: hunk.at + shift + Math.floor(hunk.insert.length / 2), size };
        shift += hunk.insert.length - hunk.remove;
      }
      if (best.size >= 0) this.scrollToLine(best.at, true);
    }
    this.drawMinimap();
  }

  /** Pure removals of the last few seconds, mapped to lines of `version`. */
  private removals(version: number, t: number): Removal[] {
    const removals: Removal[] = [];
    for (let index = version - 1; index >= 0; index--) {
      const change = this.file.changes[index];
      if (!change || t - change.t >= REMOVAL_MS) break;
      let shift = 0;
      const own: Removal[] = [];
      const marks = this.file.hunkMarks[index] ?? [];
      for (const [hunkIndex, hunk] of change.hunks.entries()) {
        const mark = marks[hunkIndex];
        if (mark && hunk.remove > 0 && hunk.insert.length === 0)
          own.push({ line: hunk.at + shift, mark });
        shift += hunk.insert.length - hunk.remove;
      }
      // Carry the positions through the later changes.
      for (let later = index + 1; later < version; later++)
        for (const removal of own) {
          let delta = 0;
          for (const hunk of this.file.changes[later]?.hunks ?? []) {
            if (hunk.at + hunk.remove <= removal.line) delta += hunk.insert.length - hunk.remove;
            else if (hunk.at < removal.line) delta += hunk.at - removal.line;
          }
          removal.line += delta;
        }
      removals.push(...own);
    }
    return removals.sort((a, b) => a.line - b.line);
  }

  private applyZoom(zoom: number) {
    const anchor = this.viewportLines();
    const middle = Math.floor((anchor[0] + anchor[1]) / 2);
    this.zoom = zoom;
    this.context.far = zoom < 6;
    this.view.dispatch({ effects: refresh.of(null) });
    this.host.style.setProperty("--code-size", `${zoom}px`);
    this.host.classList.toggle("far", zoom < 6);
    this.view.requestMeasure();
    requestAnimationFrame(() => this.scrollToLine(middle, true));
  }

  private stepZoom(direction: 1 | -1) {
    const levels = ZOOM_LEVELS;
    const index = levels.findIndex((level) => level >= this.store.state.zoom);
    const next =
      levels[
        Math.max(
          0,
          Math.min(levels.length - 1, (index < 0 ? levels.length - 1 : index) + direction),
        )
      ];
    this.store.set({ zoom: next });
  }

  private wheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      this.stepZoom(event.deltaY > 0 ? -1 : 1);
      return;
    }
    if (this.store.state.follow) this.store.set({ follow: false });
  };

  private viewportLines(): [number, number] {
    const rect = this.view.scrollDOM.getBoundingClientRect();
    const doc = this.view.state.doc;
    const top = this.view.lineBlockAtHeight(rect.top - this.view.documentTop);
    const bottom = this.view.lineBlockAtHeight(rect.bottom - this.view.documentTop);
    return [doc.lineAt(top.from).number - 1, doc.lineAt(bottom.from).number];
  }

  private readers(): Reader[] {
    const { t } = this.store.state;
    const readers: Reader[] = [];
    for (const agent of this.model.agents) {
      if (agentPhase(agent, t) !== "active") continue;
      let index = lastAtOrBefore(agent.calls, t, (call) => call.start);
      for (let steps = 0; index >= 0 && steps < 12; index--, steps++) {
        const call = agent.calls[index];
        if (!call) break;
        const observes = callObserves(call).filter(
          (observe) => observe.file === this.file.info.id && observe.t <= t,
        );
        const [first] = observes;
        if (!first) continue;
        const age = t - first.t;
        if (age > 15000) break;
        for (const observe of observes)
          for (const range of observe.ranges)
            readers.push({ agent, from: range[0] - 1, to: range[1], age });
        break;
      }
    }
    return readers;
  }

  private drawMinimap() {
    const state = this.file.state(this.shown);
    this.minimap.draw({
      lines: state.lines,
      marks: state.marks,
      t: this.store.state.t,
      selected: this.store.state.selectedCall,
      viewport: this.viewportLines(),
      readers: this.readers(),
    });
  }

  private scrollToLine(line: number, center = true) {
    const doc = this.view.state.doc;
    const number = Math.max(1, Math.min(doc.lines, Math.round(line) + 1));
    this.view.dispatch({
      effects: EditorView.scrollIntoView(doc.line(number).from, {
        y: center ? "center" : "center",
      }),
    });
  }

  private revealSelected() {
    const id = this.store.state.selectedCall;
    if (!id) return;
    const marks = this.context.marks;
    const line = marks.findIndex((mark) => !!mark && markSelected(mark, id));
    if (line >= 0) return this.scrollToLine(line);
    const call = this.model.callById.get(id);
    const own = call ? [...call.marks, ...call.children.flatMap((child) => child.marks)] : [];
    const mark = own.find((entry) => entry.file === this.file);
    if (mark) this.scrollToLine(mark.hunk.at);
  }

  private markAt(event: MouseEvent, view: EditorView) {
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (position == null) return null;
    return this.context.marks[view.state.doc.lineAt(position).number - 1] ?? null;
  }

  private hover(event: MouseEvent, view: EditorView) {
    const mark = this.markAt(event, view);
    const current = this.store.state.tooltip;
    if (mark)
      this.store.set({ tooltip: { kind: "mark", x: event.clientX, y: event.clientY, mark } });
    else if (current?.kind === "mark") this.store.set({ tooltip: null });
    return false;
  }

  private clearHover() {
    if (this.store.state.tooltip?.kind === "mark") this.store.set({ tooltip: null });
  }

  private click(event: MouseEvent, view: EditorView) {
    const mark = this.markAt(event, view);
    const call = mark?.call ?? mark?.candidates[0];
    if (call) this.store.set({ selectedCall: call.id, focusAgent: call.agent.id });
    return false;
  }
}

export function FileView({ model, store }: { model: Model; store: Store }) {
  const fileIndex = useStore(store, (state) => state.fileIndex);
  const file = required(model.files[fileIndex]);
  const version = useStore(store, (state) => file.versionAt(state.t));
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const controller = new FileController(
      required(host.current),
      required(canvas.current),
      file,
      model,
      store,
    );
    return () => controller.destroy();
  }, [file]);
  const lines = file.state(version).lines.length;
  const follow = useStore(store, (state) => state.follow);
  const atStart = useStore(store, (state) => state.t === 0 && !state.playing);
  const zoom = useStore(store, (state) => state.zoom);
  const zoomIndex = ZOOM_LEVELS.indexOf(zoom);
  const setZoom = (index: number) =>
    store.set({ zoom: ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, index))] });
  return (
    <section class="file-panel">
      <div class="panel-head">
        <div class="file-tabs">
          {model.files.map((entry, index) => (
            <button
              key={entry.info.id}
              class={`file-tab${index === fileIndex ? " active" : ""}`}
              onClick={() => store.set({ fileIndex: index })}
            >
              <span class="file-glyph" />
              {entry.info.path}
            </button>
          ))}
        </div>
        <div class="file-stats">
          <span class={lines === 0 ? "alarm" : ""}>
            <b>{formatCount(lines)}</b> lines
          </span>
          <span>
            version <b>{version}</b>
            <i> / {file.versions}</i>
          </span>
          <button
            class={`toggle${follow ? " on" : ""}`}
            title="Scroll to each new edit"
            onClick={() => store.set({ follow: !follow })}
          >
            <span class="toggle-dot" />
            Follow edits
          </button>
          <div class="zoom" title="Zoom (Ctrl + wheel)">
            <button onClick={() => setZoom(zoomIndex - 1)} disabled={zoomIndex <= 0}>
              −
            </button>
            <input
              type="range"
              min={0}
              max={ZOOM_LEVELS.length - 1}
              value={zoomIndex}
              onInput={(event) => setZoom(Number((event.target as HTMLInputElement).value))}
            />
            <button
              onClick={() => setZoom(zoomIndex + 1)}
              disabled={zoomIndex >= ZOOM_LEVELS.length - 1}
            >
              +
            </button>
          </div>
        </div>
      </div>
      <div class="file-body">
        <div class="minimap">
          <canvas ref={canvas} />
        </div>
        <div class="code">
          <div class="cm-host" ref={host} />
          {atStart && (
            <div class="intro">
              <div class="intro-card">
                <div class="intro-kicker">{model.header.run.harnessLabel}</div>
                <div class="intro-title">{model.header.scenario.title}</div>
                <p>{model.header.scenario.task}</p>
                <button
                  class="intro-play"
                  onClick={() => store.set({ playing: true, follow: true })}
                >
                  <svg viewBox="0 0 16 16">
                    <path d="M4.5 2.8v10.4a.6.6 0 0 0 .9.5l8.4-5.2a.6.6 0 0 0 0-1L5.4 2.3a.6.6 0 0 0-.9.5z" />
                  </svg>
                  Play the run
                </button>
                <small>
                  Space to play · drag the timeline to scrub · click an edit to see who made it
                </small>
              </div>
            </div>
          )}
          {lines === 0 && (
            <div class="empty-overlay">
              <b>{file.info.path} is empty</b>
              <span>The file has 0 lines at this moment of the run.</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
