import { useEffect, useRef, useState } from "preact/hooks";
import { cleanOutput, clip, formatArgs, formatCount, formatDuration, oneLine } from "./format.ts";
import {
  type Agent,
  CATEGORY_COLORS,
  type Call,
  type Model,
  agentPhase,
  currentCall,
  innermostCall,
  lastAssistantMessage,
  rgba,
  visibleItems,
} from "./model.ts";
import { type Store, useStore } from "./store.ts";

/** Quantizes time so cards re-render a few times per second, not every frame. */
const tick = (t: number) => Math.floor(t / 100);

function CategoryChip({ call }: { call: Call }) {
  const color = CATEGORY_COLORS[call.category];
  return (
    <span class="chip" style={{ color: rgba(color, 1), background: rgba(color, 0.13) }}>
      {call.tool}
    </span>
  );
}

function StatusPill({ agent, t }: { agent: Agent; t: number }) {
  const phase = agentPhase(agent, t);
  if (phase === "active") return <span class="pill live">working</span>;
  if (phase === "waiting") return <span class="pill">queued</span>;
  const status = agent.info.status;
  return (
    <span class={`pill ${status === "done" ? "done" : "failed"}`}>
      {status === "done" ? "done" : status}
    </span>
  );
}

function AgentCard({ agent, store, t }: { agent: Agent; store: Store; t: number }) {
  const call = currentCall(agent, t);
  const inner = call ? innermostCall(call, t) : null;
  const message = lastAssistantMessage(agent, t);
  const elapsed = Math.min(t, agent.info.endMs) - agent.info.startMs;
  const running = !!inner && inner.start <= t && t < inner.end;
  let edits = 0;
  for (const mark of agent.marks)
    if (mark.t <= t) edits += Math.max(mark.hunk.insert.length, mark.hunk.remove);
  return (
    <button
      class={`agent-card${agentPhase(agent, t) === "active" ? " active" : ""}`}
      style={{ "--agent": rgba(agent.color, 1), "--agent-soft": rgba(agent.color, 0.14) }}
      onClick={() => store.set({ focusAgent: agent.id, selectedCall: inner?.id ?? null })}
    >
      <div class="card-head">
        <span class="agent-dot" />
        <span class="card-title">{agent.info.label}</span>
        <span class="card-time">{formatDuration(Math.max(0, elapsed))}</span>
      </div>
      <div class={`card-call${running ? " running" : ""}`}>
        {inner ? (
          <>
            {inner.parent && <span class="chip ghost">codemode ›</span>}
            <CategoryChip call={inner} />
            <span class="card-summary">{inner.summary || "…"}</span>
          </>
        ) : (
          <span class="card-summary muted">Waiting for the model…</span>
        )}
      </div>
      {(message || edits > 0) && (
        <div class="card-foot">
          <span class="card-message">{message ? clip(oneLine(message.text), 160) : ""}</span>
          {edits > 0 && <span class="card-edits">{edits} lines edited</span>}
        </div>
      )}
    </button>
  );
}

function Output({ call }: { call: Call }) {
  const [open, setOpen] = useState(false);
  const text = cleanOutput(call.output);
  if (!call.finished) return <div class="call-output pending">Running…</div>;
  if (!text.trim()) return null;
  const long = text.length > 600 || text.split("\n").length > 12;
  return (
    <div class={`call-output${call.ok === false ? " error" : ""}`}>
      <pre>
        {open || !long ? clip(text, 20_000) : clip(text.split("\n").slice(0, 12).join("\n"), 600)}
      </pre>
      {long && (
        <button class="link" onClick={() => setOpen(!open)}>
          {open ? "Show less" : `Show all (${formatCount(call.outputBytes || text.length)} chars)`}
        </button>
      )}
    </div>
  );
}

function CallEntry({
  call,
  t,
  store,
  selected,
}: {
  call: Call;
  t: number;
  store: Store;
  selected: string | null;
}) {
  const isSelected = selected === call.id;
  const containsSelected = call.children.some((child) => child.id === selected);
  const [open, setOpen] = useState(false);
  const expanded = open || isSelected || containsSelected;
  const children = call.children.filter((child) => child.start <= t);
  const edits =
    call.marks.length + call.children.reduce((sum, child) => sum + child.marks.length, 0);
  return (
    <div
      class={`entry call${isSelected ? " selected" : ""}${call.parent ? " nested" : ""}`}
      data-call={call.id}
    >
      <button
        class="call-head"
        onClick={() => {
          setOpen(!expanded);
          store.set({ selectedCall: call.id, reveal: store.state.reveal + 1 });
        }}
      >
        <CategoryChip call={call} />
        <span class="call-summary">{call.summary}</span>
        {edits > 0 && <span class="card-edits">{edits} edits</span>}
        <span class="call-time">
          {call.finished && call.end <= t
            ? call.end - call.start >= 1
              ? formatDuration(call.end - call.start)
              : ""
            : "…"}
          {call.ok === false && call.end <= t && <b class="err"> failed</b>}
        </span>
      </button>
      {expanded && (
        <div class="call-body">
          {call.tool === "codemode" || call.tool === "eval" ? (
            <pre class="code-args">
              {(call.args as { code?: string }).code ?? formatArgs(call.args)}
            </pre>
          ) : (
            <pre class="args">{formatArgs(call.args)}</pre>
          )}
          {children.length > 0 && (
            <div class="children">
              {children.map((child) => (
                <CallEntry key={child.id} call={child} t={t} store={store} selected={selected} />
              ))}
            </div>
          )}
          {call.end <= t ? <Output call={call} /> : <div class="call-output pending">Running…</div>}
        </div>
      )}
    </div>
  );
}

function Transcript({ agent, store }: { agent: Agent; store: Store }) {
  useStore(store, (state) => tick(state.t));
  const t = store.state.t;
  const exact = t;
  const selected = useStore(store, (state) => state.selectedCall);
  const count = visibleItems(agent, exact);
  const scroller = useRef<HTMLDivElement>(null);
  const [showTask, setShowTask] = useState(false);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const target = selected ? element.querySelector(`[data-call="${CSS.escape(selected)}"]`) : null;
    if (target) target.scrollIntoView({ block: "nearest" });
    else element.scrollTop = element.scrollHeight;
  }, [count, selected, agent]);
  const items = agent.items.slice(0, count);
  const usage = agent.info.usage;
  return (
    <div
      class="transcript"
      style={{ "--agent": rgba(agent.color, 1), "--agent-soft": rgba(agent.color, 0.14) }}
    >
      <div class="transcript-head">
        <button
          class="back"
          onClick={() => store.set({ focusAgent: null })}
          title="All agents (Esc)"
        >
          ←
        </button>
        <span class="agent-dot" />
        <div class="transcript-title">
          <div>{agent.info.label}</div>
          <small>
            {agent.calls.length} calls
            {usage?.output != null && ` · ${formatCount(usage.output)} output tokens`}
            {` · ${formatDuration(agent.info.endMs - agent.info.startMs)}`}
          </small>
        </div>
        <StatusPill agent={agent} t={exact} />
      </div>
      <div class="transcript-body" ref={scroller}>
        {agent.info.task && (
          <div class="entry task">
            <button class="task-toggle" onClick={() => setShowTask(!showTask)}>
              Task {showTask ? "▾" : "▸"}
            </button>
            <div class={`task-text${showTask ? " open" : ""}`}>{agent.info.task}</div>
          </div>
        )}
        {exact < agent.info.startMs && (
          <div class="entry muted">Starts at {formatDuration(agent.info.startMs)}.</div>
        )}
        {items.map((item, index) =>
          item.kind === "message" ? (
            item.message.role === "user" && item.message.text === agent.info.task ? null : (
              <div key={index} class={`entry message ${item.message.role}`}>
                {item.message.thinking && (
                  <div class="thinking">
                    {clip(item.message.thinking.replace(/\*\*/g, ""), 600)}
                  </div>
                )}
                {item.message.text.trim() && <div class="message-text">{item.message.text}</div>}
              </div>
            )
          ) : (
            <CallEntry
              key={item.call.id}
              call={item.call}
              t={t}
              store={store}
              selected={selected}
            />
          ),
        )}
      </div>
    </div>
  );
}

export function AgentsPanel({ model, store }: { model: Model; store: Store }) {
  const focus = useStore(store, (state) => state.focusAgent);
  const showFinished = useStore(store, (state) => state.showFinished);
  useStore(store, (state) => tick(state.t));
  const t = store.state.t;
  const agent = focus ? model.agentById.get(focus) : undefined;
  if (agent) return <Transcript agent={agent} store={store} />;
  const active = model.agents.filter((entry) => agentPhase(entry, t) === "active");
  const finished = model.agents
    .filter((entry) => agentPhase(entry, t) === "finished")
    .sort((a, b) => b.info.endMs - a.info.endMs);
  const queued = model.agents.filter((entry) => agentPhase(entry, t) === "waiting").length;
  return (
    <div class="agents">
      <div class="panel-head">
        <div class="panel-title">
          Agents <b>{active.length}</b> working
        </div>
        <div class="panel-meta">
          <span>{finished.length} done</span>
          <span>{queued} queued</span>
        </div>
      </div>
      <div class="agent-grid">
        {active.map((entry) => (
          <AgentCard key={entry.id} agent={entry} store={store} t={t} />
        ))}
        {active.length === 0 && <div class="empty">No agent is working at this moment.</div>}
        {finished.length > 0 && (
          <button class="section-toggle" onClick={() => store.set({ showFinished: !showFinished })}>
            {showFinished ? "▾" : "▸"} Finished ({finished.length})
          </button>
        )}
        {showFinished &&
          finished.map((entry) => <AgentCard key={entry.id} agent={entry} store={store} t={t} />)}
      </div>
    </div>
  );
}
