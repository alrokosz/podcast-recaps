export interface ModeDefinition {
  label: string;
  spokenIntro: (show: string) => string;
  instructions: string;
  /** Whether this mode looks up outside background on the web before writing. */
  research?: boolean;
}

export const MODES = {
  "previously-on": {
    label: "Previously On",
    spokenIntro: (show: string) => `Previously, on ${show}.`,
    instructions: `Write a dramatic "previously on" cold open, like a TV recap before a new episode.
- 120 to 200 words.
- Focus on the 3 to 5 earlier threads that matter most for the next episode.
- Short, vivid sentences, in present or past tense, and end on the tension the next episode picks up.
- Do not open with "Previously on", because it is added automatically.`,
  },
  recap: {
    label: "Recap",
    spokenIntro: (show: string) => `Here is the story so far on ${show}.`,
    instructions: `Write a clear catch-up of the story so far, for a listener returning after a break.
- 250 to 400 words, mostly chronological.
- Give the most space to threads that matter for the next episode.
- Plain, informative tone, like a well-prepared friend explaining where things stand.`,
  },
  "further-context": {
    label: "Further Context",
    spokenIntro: (show: string) => `Before this episode of ${show}, some background.`,
    research: true,
    instructions: `Write a short briefing that gives outside background for the next episode.
- 120 to 300 words. Use the low end when there are only a few background facts.
- Open with at most two sentences on where the story stands. Do not retell earlier episodes after that.
- Everything after the opening must come from the verified outside background: who people are, what places and terms mean, and history the show assumes the listener knows.
- Skip background facts that would not help the listener follow this episode.
- Attribute lightly, such as "historians note", and never read out web addresses or source names.
- Informative, curious tone, like a museum audio guide.`,
  },
} satisfies Record<string, ModeDefinition>;

export type Mode = keyof typeof MODES;

export const isMode = (value: string): value is Mode => value in MODES;

export const usesResearch = (mode: Mode): boolean => (MODES[mode] as ModeDefinition).research === true;

/** Optional tone presets. Each replaces the mode's built-in tone but keeps its length and structure. */
export const TONES = {
  dramatic: "Dramatic and suspenseful, like a TV cold open, with short punchy sentences.",
  documentary: "Calm, even, and factual, like a documentary narrator.",
  conversational: "Warm and conversational, like a well-read friend catching the listener up.",
  playful: "Light and playful, with gentle humor, without mocking the people or events involved.",
} as const;

export type Tone = keyof typeof TONES;

export const isTone = (value: string): value is Tone => value in TONES;
