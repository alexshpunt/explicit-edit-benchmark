import { randomUUID } from "node:crypto";

const lifetime = randomUUID();

/** Remove system instructions and observe the real child without adding tools or messages. */
export default function baselineObserver(pi) {
  const emit = (event, ctx, extra = {}) => {
    process.stderr.write(
      "RENDERER_BASELINE " +
        JSON.stringify({
          event,
          lifetime,
          agentPid: process.pid,
          sessionId: ctx.sessionManager.getSessionId(),
          tools: pi.getActiveTools(),
          ...extra,
        }) +
        "\n",
    );
  };
  pi.on("session_start", (_event, ctx) => emit("session_start", ctx));
  pi.on("before_agent_start", (_event, ctx) => {
    emit("before_agent_start", ctx);
    return { systemPrompt: "" };
  });
  pi.on("context_with_system", (event, ctx) => {
    emit("context", ctx, {
      systemEmpty: !event.messages.some(
        (message) => message.role === "system" && message.content?.length,
      ),
    });
  });
  pi.on("session_shutdown", (_event, ctx) => emit("session_shutdown", ctx));
}
