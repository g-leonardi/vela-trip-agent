import { DurableObject } from "cloudflare:workers";
import type { Env, FollowUpEntry } from "./types";

/** A single, well-known instance (always addressed by the same name, see
 * conversation.ts) — not one per conversation or per user, just one
 * durable log for the whole deployment. Exists to actually back the
 * "lascia i tuoi dati, ti ricontatto" promise in booking_unverified's
 * message (engine/ai.ts): a real Stripe charge can succeed while HOFJ's
 * own booking confirmation never reports success (verified live
 * 2026-09-15 — see ARCHITECTURE.md), and without this, a traveller who
 * gives up at that point leaves no trace anywhere a human could find to
 * reconcile the charge with a real reservation.
 *
 * Deliberately NOT exposed over HTTP: these entries carry real contact
 * details (name/email/phone) and a real Stripe PaymentIntent id, and this
 * prototype has no auth layer to gate a read endpoint safely. Inspecting
 * it today means reading this DO's storage directly (wrangler tooling),
 * not a public route — see the scope-cut note in ARCHITECTURE.md. */
export class FollowUpDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async record(entry: FollowUpEntry): Promise<void> {
    const list = (await this.ctx.storage.get<FollowUpEntry[]>("entries")) ?? [];
    list.push(entry);
    await this.ctx.storage.put("entries", list);
  }

  async list(): Promise<FollowUpEntry[]> {
    return (await this.ctx.storage.get<FollowUpEntry[]>("entries")) ?? [];
  }
}
