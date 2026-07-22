export type MockResponse =
  | { type: "text"; text: string }
  | { type: "tool"; calls: { name: string; arguments: Record<string, unknown> }[] }
  | { type: "error"; status: number; message: string };

export interface MockLlm {
  url: string;
  port: number;
  requests: unknown[];
  enqueue: (...responses: MockResponse[]) => void;
  stop: () => void;
}

/**
 * A scripted OpenAI-compatible chat endpoint on an ephemeral port. Enqueue
 * responses (plain assistant text or tool_calls) and they are dequeued one per
 * POST /v1/chat/completions; every request body is recorded in `requests`.
 */
export function startMockLlm(): MockLlm {
  const queue: MockResponse[] = [];
  const requests: unknown[] = [];
  let callId = 0;
  let completionId = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      const body = (await req.json()) as { model?: string; stream?: boolean };
      requests.push(body);

      const scripted = queue.shift();
      if (!scripted) {
        return new Response(JSON.stringify({ error: "mock LLM queue empty" }), { status: 500 });
      }

      if (scripted.type === "error") {
        return new Response(JSON.stringify({ error: { code: scripted.status, message: scripted.message } }), {
          status: scripted.status,
        });
      }

      if (body.stream) {
        const chunks: unknown[] = [];
        if (scripted.type === "text") {
          // split content into two deltas to exercise accumulation
          const mid = Math.ceil(scripted.text.length / 2);
          chunks.push(
            { choices: [{ index: 0, delta: { role: "assistant", content: scripted.text.slice(0, mid) } }] },
            { choices: [{ index: 0, delta: { content: scripted.text.slice(mid) } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          );
        } else {
          chunks.push(
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: scripted.calls.map((c, i) => ({
                      index: i,
                      id: `call_${++callId}`,
                      type: "function",
                      function: { name: c.name, arguments: "" },
                    })),
                  },
                },
              ],
            },
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: scripted.calls.map((c, i) => ({
                      index: i,
                      function: { arguments: JSON.stringify(c.arguments) },
                    })),
                  },
                },
              ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          );
        }
        const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
        return new Response(sse, {
          headers: { "content-type": "text/event-stream" },
        });
      }

      const message =
        scripted.type === "text"
          ? { role: "assistant", content: scripted.text }
          : {
              role: "assistant",
              content: null,
              tool_calls: scripted.calls.map((c) => ({
                id: `call_${++callId}`,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.arguments) },
              })),
            };

      return Response.json({
        id: `chatcmpl-${++completionId}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model ?? "mock",
        choices: [
          { index: 0, message, finish_reason: scripted.type === "text" ? "stop" : "tool_calls" },
        ],
      });
    },
  });

  return {
    url: `http://localhost:${server.port}/v1`,
    port: server.port,
    requests,
    enqueue: (...responses) => queue.push(...responses),
    stop: () => server.stop(true),
  };
}
