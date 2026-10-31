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
  let pendingAdmission;
  pi.registerCommand("renderer-admission-idle", {
    description: "Notify the controller when existing native activity becomes idle.",
    handler: async (args, ctx) => {
      const nonce = args.trim();
      if (!/^[a-f0-9-]{36}$/.test(nonce) || pendingAdmission)
        throw Error("Invalid or overlapping admission wait");
      pendingAdmission = nonce;
      // Acknowledge the control RPC now; native activity has no inference deadline.
      void ctx.waitForIdle().then(
        () => {
          if (pendingAdmission !== nonce) return;
          pendingAdmission = undefined;
          emit("admission_idle", ctx, { nonce });
        },
        (error) => {
          if (pendingAdmission !== nonce) return;
          pendingAdmission = undefined;
          emit("admission_error", ctx, { nonce, message: error.message });
        },
      );
    },
  });
  let pendingRecovery;
  if (process.env.RENDERER_PI_RECOVERY === "controller") {
    pi.registerCommand("renderer-recovery-release", {
      description: "Release the controller's current provider-recovery wait.",
      handler: async (args) => {
        if (!pendingRecovery || args.trim() !== pendingRecovery.nonce)
          throw Error("Stale or missing provider-recovery release");
        const pending = pendingRecovery;
        pendingRecovery = undefined;
        pending.resolve(true);
      },
    });
    pi.on("agent_before_settle", async (event, ctx) => {
      if (event.outcome !== "error") return;
      const projected = event.context.contextEntries.flatMap(({ sourceEntry, messages }) =>
        messages.map((message) => ({ sourceEntry, message })),
      );
      const index = projected.findLastIndex(({ message }) => message.role === "assistant");
      if (index < 0) return;
      const failed = projected[index].message;
      if (
        failed.stopReason !== "error" ||
        piAI.isContextOverflow(failed, ctx.model?.contextWindow ?? 0) ||
        !piAI.isRetryableAssistantError(failed)
      )
        return;

      // Use native context edits, as native retry does: retain raw history and all
      // earlier completed tool effects, omitting only this failed response/pairs.
      const targets = new Set([projected[index].sourceEntry.id]);
      const calls = new Set(
        failed.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])),
      );
      for (const { sourceEntry, message } of projected.slice(index + 1)) {
        if (message.role === "assistant") break;
        if (message.role === "toolResult" && calls.has(message.toolCallId))
          targets.add(sourceEntry.id);
      }
      if (pendingRecovery) throw Error("Overlapping provider-recovery boundaries");
      const wait = Promise.withResolvers();
      const nonce = randomUUID();
      pendingRecovery = { nonce, resolve: wait.resolve };
      emit("recovery_wait", ctx, {
        nonce,
        reason: failed.errorMessage ?? "Retryable provider failure",
      });
      // ctx.signal is no longer active at this boundary. The controller owns
      // cancellation and kills the namespace if the held delivery is cancelled.
      if (!(await wait.promise)) return;
      emit("recovery_released", ctx, { nonce });
      return {
        entries: [
          ...event.entries,
          ...[...targets].map((targetId) => ({
            type: "context_edit",
            targetId,
            replacement: null,
          })),
        ],
        continue: true,
      };
    });
  }
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
  pi.on("session_shutdown", (_event, ctx) => {
    pendingAdmission = undefined;
    pendingRecovery?.resolve(false);
    pendingRecovery = undefined;
    emit("session_shutdown", ctx);
  });
}
