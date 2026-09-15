import type { Env } from "../types";

export class StripeApiError extends Error {
  constructor(
    public status: number,
    detail: string,
  ) {
    super(`Stripe ${status}: ${detail}`);
    this.name = "StripeApiError";
  }
}

interface PaymentIntent {
  id: string;
  client_secret: string;
  status: string;
}

/** See Env.STUB_MODE's doc, types.ts — load-test-only, never set in
 * production. No real Stripe call, no real charge, no network at all. */
async function stubRequest(path: string): Promise<PaymentIntent> {
  await new Promise((r) => setTimeout(r, 40));
  return {
    id: `stub_pi_${crypto.randomUUID()}`,
    client_secret: "stub_secret",
    status: path.endsWith("/confirm") ? "succeeded" : "requires_confirmation",
  };
}

async function request(env: Env, path: string, params: Record<string, string>): Promise<PaymentIntent> {
  if (env.STUB_MODE === "1") return stubRequest(path);
  if (!env.STRIPE_SECRET_KEY) throw new StripeApiError(0, "STRIPE_SECRET_KEY not configured");
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      // Stripe accepts the secret key as the HTTP Basic username with an
      // empty password — same as every official Stripe client library.
      Authorization: `Basic ${btoa(`${env.STRIPE_SECRET_KEY}:`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  const json = await res.json<PaymentIntent & { error?: { message?: string } }>();
  if (!res.ok) throw new StripeApiError(res.status, json.error?.message ?? res.statusText);
  return json;
}

/** Confirms with Stripe's own official test card token. Deliberate demo
 * simplification, documented as such in ARCHITECTURE.md: a real
 * production flow hands the client_secret to the frontend for Stripe
 * Elements / the actual cardholder to confirm — the Worker should never
 * touch real card details. There's no Stripe.js integration in this
 * prototype's frontend, so this is how the payment step gets proven to
 * work for real, in test mode, without building that UI under time
 * pressure. */
export async function confirmPaymentIntent(env: Env, paymentIntentId: string): Promise<PaymentIntent> {
  return request(env, `/payment_intents/${paymentIntentId}/confirm`, {
    payment_method: "pm_card_visa",
  });
}
