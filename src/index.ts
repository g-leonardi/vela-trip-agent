import { isProfileComplete, type Env } from "./types";

export { ConversationDO } from "./conversation";
export { UserProfileDO } from "./userProfile";
export { FollowUpDO } from "./followUp";

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
      const body = await request.json<{ sessionId?: string; text?: string; userId?: string }>().catch(() => null);
      if (!body?.text || typeof body.text !== "string") {
        return json({ error: "missing text" }, 400);
      }
      const sessionId = body.sessionId && typeof body.sessionId === "string" ? body.sessionId : crypto.randomUUID();
      const stub = env.CONVERSATION.getByName(sessionId);
      // Only ever read here, only ever used to seed a conversation's very
      // first turn (see ConversationDO.handleMessage) — the persistent
      // profile itself is owned entirely by UserProfileDO.
      const profile = body.userId ? await env.USER_PROFILE.getByName(body.userId).getProfile() : null;
      const result = await stub.handleMessage(body.text, profile);
      return json({ sessionId, ...result });
    }

    if (url.pathname === "/api/onboarding/start" && request.method === "POST") {
      const body = await request.json<{ userId?: string }>().catch(() => null);
      if (!body?.userId) return json({ error: "missing userId" }, 400);
      const stub = env.USER_PROFILE.getByName(body.userId);
      const result = await stub.startOnboarding();
      return json(result);
    }

    if (url.pathname === "/api/onboarding/message" && request.method === "POST") {
      const body = await request.json<{ userId?: string; text?: string }>().catch(() => null);
      if (!body?.userId) return json({ error: "missing userId" }, 400);
      if (!body?.text || typeof body.text !== "string") return json({ error: "missing text" }, 400);
      const stub = env.USER_PROFILE.getByName(body.userId);
      const result = await stub.handleOnboardingMessage(body.text);
      return json(result);
    }

    if (url.pathname === "/api/profile" && request.method === "GET") {
      const userId = url.searchParams.get("userId");
      if (!userId) return json({ error: "missing userId" }, 400);
      const stub = env.USER_PROFILE.getByName(userId);
      const profile = await stub.getProfile();
      return json({ profile, complete: isProfileComplete(profile) });
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
