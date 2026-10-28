import { randomUUID } from "node:crypto";
import * as piAI from "@earendil-works/pi-ai";
import { declaredToolNames } from "./pi-codemode-profile.mjs";

const lifetime = randomUUID();
const baseline = process.env.RENDERER_PI_HARNESS !== "pi-agent-ide-codemode";

/** Observe native identity and loadout; only the Baseline removes system instructions. */
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
    if (baseline) return { systemPrompt: "" };
  });
  pi.on("context_with_system", (event, ctx) => {
    const systemEmpty = baseline
      ? !event.messages.some((message) => message.role === "system" && message.content?.length)
      : piAI.getCurrentSystemPrompt(event.messages).length === 0;
    if (!baseline && systemEmpty) {
      process.stderr.write("Native IDE system instructions are missing\n");
      process.exit(1);
    }
    emit("context", ctx, {
      systemEmpty,
      ...(!baseline ? { declaredTools: declaredToolNames(event.messages) } : {}),
    });
  });
  pi.on("session_shutdown", (_event, ctx) => emit("session_shutdown", ctx));
}
