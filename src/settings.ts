import { z } from "zod";
import { MODES, TONES } from "./modes.js";
import { DEFAULT_SETTINGS, type RecapSettings } from "./pipeline.js";

/** API models, plus "claude-code" for recaps written by the user's Claude Code session through the plugin. */
export const MODELS = ["claude-opus-5-5", "claude-haiku-5-5", "claude-code"] as const;

const modeNames = Object.keys(MODES) as [keyof typeof MODES, ...(keyof typeof MODES)[]];
const toneNames = Object.keys(TONES) as [keyof typeof TONES, ...(keyof typeof TONES)[]];

/** Every field is optional, and missing ones take the defaults. */
export const SettingsInputSchema = z
  .object({
    mode: z.enum(modeNames),
    tone: z.enum(toneNames).nullable(),
    instructions: z.string().trim().max(1000, "Instructions can be at most 1,000 characters.").nullable(),
    model: z.enum(MODELS),
    effort: z.enum(["low", "medium", "high"]),
    voice: z
      .string()
      .regex(/^[\p{L}\p{N} ()._-]{1,60}$/u, "Voice names contain only letters, numbers, spaces, and ()._-")
      .nullable(),
    wordsPerMinute: z.number().int().min(90).max(360).nullable(),
    pauseSeconds: z.number().min(0).max(10),
  })
  .partial()
  .strict();

export type SettingsInput = z.infer<typeof SettingsInputSchema>;

/** Validates settings and fills in defaults, always in the same key order so equal settings serialize equally. */
export const resolveSettings = (input: unknown, base: RecapSettings = DEFAULT_SETTINGS): RecapSettings => {
  const parsed = SettingsInputSchema.parse(input ?? {});
  // Unset options arrive as undefined, which would otherwise overwrite the defaults.
  const given = Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined));
  const merged: RecapSettings = { ...base, ...given };
  return {
    mode: merged.mode,
    tone: merged.tone,
    instructions: merged.instructions || null,
    model: merged.model,
    effort: merged.effort,
    voice: merged.voice || null,
    wordsPerMinute: merged.wordsPerMinute,
    pauseSeconds: merged.pauseSeconds,
  };
};

/** Turns a validation error into one readable line. */
export const describeError = (error: unknown): string =>
  error instanceof z.ZodError
    ? error.issues.map(({ path, message }) => (path.length ? `${path.join(".")}: ${message}` : message)).join("; ")
    : error instanceof Error
      ? error.message
      : String(error);
