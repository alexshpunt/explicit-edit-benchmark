import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import path from "node:path";

/** Local no-cost provider. It sees only the real runtime's requests, not reference states. */
export async function providerFixture(root, respond) {
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const result = respond(body, requests.length);
      if (result?.error) {
        res.writeHead(result.status ?? 401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: result.error } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (!result) return;
      const delta = result.command
        ? {
            tool_calls: [
              {
                index: 0,
                id: `call-${requests.length}`,
                type: "function",
                function: { name: "bash", arguments: JSON.stringify({ command: result.command }) },
              },
            ],
          }
        : { content: "done" };
      res.write(
        `data: ${JSON.stringify({ id: `msg-${requests.length}`, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: result.command ? "tool_calls" : "stop" }], usage: result.usage ?? { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    } catch (error) {
      res.destroy(error);
    }
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const modelsFile = path.join(root, "models.json");
  await writeFile(
    modelsFile,
    JSON.stringify({
      providers: {
        fixture: {
          api: "openai-completions",
          apiKey: "dummy",
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          models: [
            {
              id: "deterministic",
              reasoning: false,
              contextWindow: 100000,
              maxTokens: 4096,
              cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  return {
    requests,
    config: {
      runtime: process.env.RENDERER_PI_RUNTIME,
      model: "fixture/deterministic",
      thinking: "off",
      modelsFile,
    },
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}
