import { DurableObject } from "cloudflare:workers";
import { AiUnavailableError, interpretProfile, sayProfile } from "./engine/ai";
import { EMPTY_USER_PROFILE, REQUIRED_PROFILE_FIELDS, isProfileComplete, type Env, type UserProfile } from "./types";

const FIELD_LABELS: Record<keyof UserProfile, string> = {
  firstName: "il suo nome",
  email: "la sua email",
  city: "in che città vive",
  preferredSport: "se preferisce padel o tennis",
  householdSize: "quante persone è di solito il suo nucleo familiare",
  economicTier: "il suo profilo di spesa preferito (Smart/Pro/Luxury)",
};

export interface OnboardingResult {
  reply: string;
  profile: UserProfile;
  complete: boolean;
}

/** One Durable Object per traveller, addressed by a client-generated id
 * persisted in the browser's localStorage (see public/index.html) —
 * deliberately NOT the same as a conversation's own sessionId (one
 * ConversationDO per trip; one UserProfileDO per person, reused across
 * every trip they start in this same browser). Replaces the old
 * hardcoded DEMO_TRAVELLER stand-in with something that actually
 * persists, without solving real cross-device identity — see the doc on
 * UserProfile in types.ts. */
export class UserProfileDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private async loadProfile(): Promise<UserProfile> {
    const stored = await this.ctx.storage.get<UserProfile>("profile");
    return stored ?? { ...EMPTY_USER_PROFILE };
  }

  private async saveProfile(profile: UserProfile): Promise<void> {
    await this.ctx.storage.put("profile", profile);
  }

  async getProfile(): Promise<UserProfile> {
    return this.loadProfile();
  }

  /** Opens the one-time onboarding — asks the first missing field without
   * needing any traveller input yet, so the app has something to say (and
   * speak) the moment the page loads for someone with no saved profile. */
  async startOnboarding(): Promise<OnboardingResult> {
    const profile = await this.loadProfile();
    const missing = REQUIRED_PROFILE_FIELDS.find((f) => profile[f] === null);
    if (!missing) {
      return { reply: await sayProfile(this.env, { kind: "profile_complete", firstName: profile.firstName! }), profile, complete: true };
    }
    const reply = await sayProfile(this.env, { kind: "ask_profile_field", field: missing, isFirstAsk: true });
    return { reply, profile, complete: false };
  }

  /** Single entry point for one onboarding turn — same one-field-at-a-time
   * shape as ConversationDO's collecting_traveller stage (see
   * conversation.ts), just for the persistent profile instead of a
   * single trip's traveller data. */
  async handleOnboardingMessage(text: string): Promise<OnboardingResult> {
    const profile = await this.loadProfile();

    let updated = profile;
    try {
      const extraction = await interpretProfile(this.env, text, this.describeMissing(profile));
      updated = { ...profile };
      for (const [k, v] of Object.entries(extraction) as [keyof UserProfile, UserProfile[keyof UserProfile]][]) {
        if (v !== null && v !== undefined) updated[k] = v as never;
      }
      await this.saveProfile(updated);
    } catch (err) {
      if (err instanceof AiUnavailableError) {
        return { reply: "Scusa, non ho capito bene — puoi ripetere?", profile, complete: isProfileComplete(profile) };
      }
      throw err;
    }

    const missing = REQUIRED_PROFILE_FIELDS.find((f) => updated[f] === null);
    if (missing) {
      // isFirstAsk is only ever true for the very first question of the
      // whole onboarding, asked once by startOnboarding() before any
      // traveller input exists — every question asked from here on
      // (regardless of which field) already follows a real exchange, so
      // the "let me explain why" framing never repeats.
      const reply = await sayProfile(this.env, { kind: "ask_profile_field", field: missing, isFirstAsk: false });
      return { reply, profile: updated, complete: false };
    }
    const reply = await sayProfile(this.env, { kind: "profile_complete", firstName: updated.firstName! });
    return { reply, profile: updated, complete: true };
  }

  private describeMissing(profile: UserProfile): string | null {
    const missing = REQUIRED_PROFILE_FIELDS.find((f) => profile[f] === null);
    return missing ? FIELD_LABELS[missing] : null;
  }
}
