import type { Env } from "./types";

export { ConversationDO } from "./conversation";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/message" && request.method === "POST") {
      const body = await request.json<{ sessionId?: string; text?: string }>().catch(() => null);
      if (!body?.text || typeof body.text !== "string") {
        return json({ error: "missing text" }, 400);
      }
      const sessionId = body.sessionId && typeof body.sessionId === "string" ? body.sessionId : crypto.randomUUID();
      const stub = env.CONVERSATION.getByName(sessionId);
      const result = await stub.handleMessage(body.text);
      return json({ sessionId, ...result });
    }

    if (url.pathname === "/api/payment-confirmed" && request.method === "POST") {
      const body = await request.json<{ sessionId?: string }>().catch(() => null);
      if (!body?.sessionId) return json({ error: "missing sessionId" }, 400);
      const stub = env.CONVERSATION.getByName(body.sessionId);
      const result = await stub.confirmPaymentAndBook();
      return json(result);
    }

    if (url.pathname === "/api/state" && request.method === "GET") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) return json({ error: "missing sessionId" }, 400);
      const stub = env.CONVERSATION.getByName(sessionId);
      const state = await stub.getState();
      return json({ sessionId, state });
    }

    return env.ASSETS.fetch(request);
  },
};
