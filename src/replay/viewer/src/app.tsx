import { useEffect, useMemo } from "preact/hooks";
import type { PackedTrace } from "../../trace/types.ts";
import { AgentsPanel } from "./agents.tsx";
import { FileView } from "./file-view.tsx";
import { clip, formatCount, formatDuration, formatTime, oneLine } from "./format.ts";
import {
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  type Model,
  agentPhase,
  buildModel,
  lastAtOrBefore,
  rgba,
} from "./model.ts";
import { Store, type Tooltip, useStore } from "./store.ts";
import { Timeline } from "./timeline.tsx";

const SPEEDS = [1, 2, 4, 8, 16];

function modelName(model?: string) {
  if (!model) return "";
  const name = model.split("/").pop() ?? model;
  return name.replace(/^gpt-/i, "GPT-").replace(/-(\w)/g, (_, c: string) => " " + c.toUpperCase());
}

function Counters({ model, store }: { model: Model; store: Store }) {
  const frame = useStore(store, (state) => Math.floor(state.t / 100));
  const t = store.state.t;
  const counts = useMemo(() => {
    let active = 0;
    let done = 0;
    for (const agent of model.agents) {
      const phase = agentPhase(agent, t);
      if (phase === "active") active++;
      else if (phase === "finished") done++;
    }
    const calls = lastAtOrBefore(model.calls, t, (call) => call.start) + 1;
    const edits = lastAtOrBefore(model.editTimes, t, (time) => time) + 1;
    let lines = 0;
    for (const file of model.files)
      for (let index = 0; index < file.versionAt(t); index++)
        for (const hunk of file.changes[index]?.hunks ?? [])
          lines += hunk.insert.length + hunk.remove;
    return { active, done, calls, edits, lines };
  }, [frame, t, model]);
  return (
    <div class="counters">
      <div class="counter">
        <b>{counts.active}</b>
        <span>working</span>
      </div>
      <div class="counter">
        <b>
          {counts.done}
          <i>/{model.agents.length}</i>
        </b>
        <span>agents done</span>
      </div>
      <div class="counter">
        <b>{formatCount(counts.calls)}</b>
        <span>tool calls</span>
      </div>
      <div class="counter">
        <b>{counts.edits}</b>
        <span>file writes</span>
      </div>
      <div class="counter">
        <b>{formatCount(counts.lines)}</b>
        <span>lines changed</span>
      </div>
    </div>
  );
}

function TopBar({ model, store }: { model: Model; store: Store }) {
  const { scenario, run } = model.header;
  return (
    <header class="topbar">
      <div class="brand">
        <div class="title">{scenario.title}</div>
        <div class="badges">
          <span class="badge harness">{run.harnessLabel}</span>
          {run.model && (
            <span class="badge">
              {modelName(run.model)}
              {run.thinking && <i> · {run.thinking}</i>}
            </span>
          )}
          {run.harnessVersion && <span class="badge subtle">{run.harnessVersion}</span>}
        </div>
      </div>
      <Counters model={model} store={store} />
    </header>
  );
}

function Controls({ model, store }: { model: Model; store: Store }) {
  const playing = useStore(store, (state) => state.playing);
  const speed = useStore(store, (state) => state.speed);
  const t = useStore(store, (state) => Math.floor(state.t / 100)) * 100;
  const outcome = model.header.run.outcome ?? {};
  return (
    <div class="controls">
      <button
        class="play"
        title="Play or pause (Space)"
        onClick={() => {
          const state = store.state;
          store.set({ playing: !state.playing, t: state.t >= model.duration ? 0 : state.t });
        }}
      >
        {playing ? (
          <svg viewBox="0 0 16 16">
            <rect x="3.5" y="2.5" width="3" height="11" rx="1" />
            <rect x="9.5" y="2.5" width="3" height="11" rx="1" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16">
            <path d="M4.5 2.8v10.4a.6.6 0 0 0 .9.5l8.4-5.2a.6.6 0 0 0 0-1L5.4 2.3a.6.6 0 0 0-.9.5z" />
          </svg>
        )}
      </button>
      <div class="clock">
        <b>{formatTime(t, true)}</b>
        <span> / {formatTime(model.duration)}</span>
      </div>
      <div class="speeds">
        {SPEEDS.map((value) => (
          <button
            key={value}
            class={value === speed ? "active" : ""}
            onClick={() => store.set({ speed: value })}
          >
            {value}×
          </button>
        ))}
      </div>
      <div class="legend">
        {(Object.keys(CATEGORY_COLORS) as Array<keyof typeof CATEGORY_COLORS>)
          .filter((category) => model.calls.some((call) => call.category === category))
          .map((category) => (
            <span key={category}>
              <i style={{ background: rgba(CATEGORY_COLORS[category], 0.9) }} />
              {CATEGORY_LABELS[category]}
            </span>
          ))}
        <span>
          <i class="tick" />
          Edit
        </span>
      </div>
      <div class="outcome">
        {Object.entries(outcome)
          .slice(0, 4)
          .map(([key, value]) => (
            <span key={key}>
              {key} <b>{String(value)}</b>
            </span>
          ))}
      </div>
      <div class="hint">Space play · ←/→ step · ⇧←/→ edits</div>
    </div>
  );
}

function TooltipView({ store }: { store: Store }) {
  const tooltip = useStore(store, (state) => state.tooltip);
  if (!tooltip) return null;
  const width = 360;
  const left = Math.min(window.innerWidth - width - 12, tooltip.x + 14);
  const below = tooltip.y < window.innerHeight * 0.6;
  // Preact 11 does not add "px" to numbers.
  const style = below
    ? { left: `${left}px`, top: `${tooltip.y + 16}px`, width: `${width}px` }
    : {
        left: `${left}px`,
        bottom: `${window.innerHeight - tooltip.y + 12}px`,
        width: `${width}px`,
      };
  return (
    <div class="tooltip" style={style}>
      {tooltipBody(tooltip)}
    </div>
  );
}

function tooltipBody(tooltip: Tooltip) {
  if (tooltip.kind === "text") return <div>{tooltip.text}</div>;
  if (tooltip.kind === "call") {
    const { call } = tooltip;
    const color = CATEGORY_COLORS[call.category];
    return (
      <>
        <div class="tip-head" style={{ "--agent": rgba(call.agent.color, 1) }}>
          <span class="agent-dot" />
          {call.agent.info.label}
        </div>
        <div class="tip-call">
          {call.parent && <span class="chip ghost">codemode ›</span>}
          <span class="chip" style={{ color: rgba(color, 1), background: rgba(color, 0.14) }}>
            {call.tool}
          </span>
          <span>{call.summary}</span>
        </div>
        <div class="tip-meta">
          {formatTime(call.start, true)} ·{" "}
          {call.finished ? formatDuration(call.end - call.start) : "unfinished"}
          {call.ok === false && <b class="err"> · failed</b>}
          {call.children.length > 0 && ` · ${call.children.length} nested calls`}
          {call.marks.length > 0 && ` · ${call.marks.length} edits`}
        </div>
      </>
    );
  }
  const { mark } = tooltip;
  const lines = mark.hunk.insert.length;
  const removed = mark.hunk.remove;
  const call = mark.call;
  return (
    <>
      {mark.agent && call ? (
        <div class="tip-head" style={{ "--agent": rgba(mark.agent.color, 1) }}>
          <span class="agent-dot" />
          {mark.agent.info.label}
        </div>
      ) : (
        <div class="tip-head neutral">
          {mark.confidence === "ambiguous" ? "Ambiguous author" : "Changed outside the agents"}
        </div>
      )}
      {call && (
        <div class="tip-call">
          {call.parent && <span class="chip ghost">codemode ›</span>}
          <span
            class="chip"
            style={{
              color: rgba(CATEGORY_COLORS[call.category], 1),
              background: rgba(CATEGORY_COLORS[call.category], 0.14),
            }}
          >
            {call.tool}
          </span>
          <span>{call.summary}</span>
        </div>
      )}
      {mark.confidence === "ambiguous" && mark.candidates.length > 0 && (
        <div class="tip-candidates">
          {mark.candidates.slice(0, 5).map((candidate) => (
            <div key={candidate.id} style={{ "--agent": rgba(candidate.agent.color, 1) }}>
              <span class="agent-dot" />
              {clip(candidate.agent.info.label, 34)}:{" "}
              <span class="muted">{clip(oneLine(candidate.summary), 60)}</span>
            </div>
          ))}
        </div>
      )}
      <div class="tip-meta">
        {formatTime(mark.t, true)} · +{lines} −{removed} lines · {mark.confidence}
        {call && " · click to open"}
      </div>
    </>
  );
}

function usePlayback(model: Model, store: Store) {
  useEffect(() => {
    let frame = 0;
    let last = 0;
    const loop = (now: number) => {
      const state = store.state;
      if (state.playing) {
        const delta = last ? Math.min(100, now - last) : 0;
        const t = state.t + delta * state.speed;
        if (t >= model.duration) store.set({ t: model.duration, playing: false });
        else store.set({ t });
      }
      last = now;
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [model]);
}

function useKeys(model: Model, store: Store) {
  useEffect(() => {
    const step = (times: number[], direction: 1 | -1) => {
      const t = store.state.t;
      const index = lastAtOrBefore(times, direction > 0 ? t : t - 1, (time) => time);
      const next = direction > 0 ? times[index + 1] : times[index];
      if (next !== undefined) store.set({ t: next, playing: false });
    };
    const handler = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === " ") {
        event.preventDefault();
        const state = store.state;
        store.set({ playing: !state.playing, t: state.t >= model.duration ? 0 : state.t });
      } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        step(
          event.shiftKey ? model.editTimes : model.eventTimes,
          event.key === "ArrowRight" ? 1 : -1,
        );
      } else if (event.key === "Escape") store.set({ focusAgent: null, selectedCall: null });
      else if (event.key === "Home") store.set({ t: 0 });
      else if (event.key === "End") store.set({ t: model.duration, playing: false });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [model]);
}

export function App({ trace }: { trace: PackedTrace }) {
  const model = useMemo(() => buildModel(trace), [trace]);
  const store = useMemo(
    () =>
      new Store({
        t: 0,
        playing: false,
        speed: 4,
        selectedCall: null,
        focusAgent: null,
        fileIndex: 0,
        tooltip: null,
        showFinished: false,
        reveal: 0,
        follow: true,
        zoom: 12.5,
      }),
    [trace],
  );
  usePlayback(model, store);
  useKeys(model, store);
  // For browser automation and the console: window.agentReplay.store.set({ t: 30000 }).
  Object.assign(window, { agentReplay: { model, store } });
  useEffect(() => {
    document.title = `${model.header.scenario.title} · Agent Replay`;
  }, [model]);
  return (
    <div class="app">
      <TopBar model={model} store={store} />
      <main class="workspace">
        <FileView model={model} store={store} />
        <aside class="agents-panel">
          <AgentsPanel model={model} store={store} />
        </aside>
      </main>
      <footer class="timeline">
        <Controls model={model} store={store} />
        <Timeline model={model} store={store} />
      </footer>
      <TooltipView store={store} />
    </div>
  );
}
