import { compactProfile, getPersonality, relationshipSummary, selectRelevantDetails, type CatId } from './personalities'

export type ConversationMode = 'solo' | 'both' | 'cats-only' | 'surprise'
export type HistorySpeaker = 'human' | CatId
export type HistoryEntry = { speaker: HistorySpeaker; text: string }
export type ConversationPromptInput = {
  mode: ConversationMode
  selectedCat: CatId | null
  topic: string | null
  message: string | null
  history: HistoryEntry[]
}

const EMOTIONS = ['neutral', 'happy', 'worried', 'annoyed', 'excited', 'affectionate', 'suspicious'] as const

// --- Conversation context policy (named constants; also referenced by the request schema) ---------
// Keep no more than the latest N dialogue entries verbatim; keep the most recent when trimming.
export const MAX_HISTORY_ENTRIES = 10
// Per-entry character cap; longer entries are truncated, not dropped.
export const MAX_ENTRY_CHARS = 600
// Total character budget across all kept entries; oldest kept entries are dropped first to fit.
export const MAX_TOTAL_HISTORY_CHARS = 4000

// --- Progressive micro-format sentinels (solo / both / surprise) ----------------------------------
// Rare characters that never appear in dialogue (the profiles forbid bracketed stage directions), so
// they're safe pure delimiters for streaming plain text. The route's parser imports these, keeping
// the emitted format and the parser in one source of truth.
export const TURN_SPEAKER_SENTINEL = '§'
export const TURN_EMOTION_SENTINEL = '¶'

// True for modes that use the low-overhead streaming micro-format; cats-only keeps Structured Outputs.
export function usesProgressiveFormat(mode: ConversationMode) {
  return mode !== 'cats-only'
}

// Truncate to a hard char cap without cutting mid-nonsense; keeps it simple and deterministic.
function clampEntry(text: string) {
  return text.length > MAX_ENTRY_CHARS ? `${text.slice(0, MAX_ENTRY_CHARS - 1)}…` : text
}

// Enforces the context policy: drop a duplicated trailing human message, keep the latest
// MAX_HISTORY_ENTRIES, clamp each entry, then drop oldest kept entries until under the total budget.
export function boundHistory(history: HistoryEntry[], message: string | null): HistoryEntry[] {
  let entries = history.slice()

  // Defensive dedup: if the caller left the newest human message as the final history item AND also
  // sent it as `message`, remove it here so it never appears twice in the assembled prompt.
  const last = entries[entries.length - 1]
  if (message && last && last.speaker === 'human' && last.text.trim() === message.trim()) {
    entries = entries.slice(0, -1)
  }

  entries = entries.slice(-MAX_HISTORY_ENTRIES).map((e) => ({ speaker: e.speaker, text: clampEntry(e.text) }))

  let total = entries.reduce((sum, e) => sum + e.text.length, 0)
  while (entries.length > 1 && total > MAX_TOTAL_HISTORY_CHARS) {
    total -= entries[0].text.length
    entries.shift()
  }
  return entries
}

function formatHistory(history: HistoryEntry[]) {
  if (!history.length) return 'No prior conversation.'
  return history.map((h) => `${h.speaker === 'human' ? 'Human' : getPersonality(h.speaker).name}: ${h.text}`).join('\n')
}

// Which cats' compact profiles anchor the stable prefix, plus a stable id for the prompt-cache key.
function profileConfig(input: ConversationPromptInput): { primary: CatId | null; both: boolean; configId: string } {
  if (input.mode === 'both' || input.mode === 'cats-only') return { primary: null, both: true, configId: 'both' }
  if (input.mode === 'solo') {
    const primary = input.selectedCat ?? 'babe'
    return { primary, both: false, configId: `solo-${primary}` }
  }
  // surprise
  if (input.selectedCat) return { primary: input.selectedCat, both: false, configId: `solo-${input.selectedCat}` }
  return { primary: null, both: true, configId: 'both' }
}

const otherCat = (cat: CatId): CatId => (cat === 'babe' ? 'leo' : 'babe')

function progressiveFormatInstruction(turns: 'one' | 'two' | 'extended') {
  const turnRule =
    turns === 'one'
      ? 'Return exactly one turn.'
      : turns === 'two'
        ? 'Return one turn, or two turns if the second cat would naturally chime in; give each turn its own block.'
        : 'Return between 8 and 10 turns, mostly alternating between the cats; give each turn its own block.'
  return `Output format — follow it exactly and output nothing else. For each turn: the character ${TURN_SPEAKER_SENTINEL} immediately followed by the speaker id (babe or leo) and a newline, then the spoken dialogue, then the character ${TURN_EMOTION_SENTINEL} immediately followed by one emotion from the list above. Example: ${TURN_SPEAKER_SENTINEL}babe
That raccoon respects me, I am certain of it.${TURN_EMOTION_SENTINEL}excited
${turnRule} Never use the ${TURN_SPEAKER_SENTINEL} or ${TURN_EMOTION_SENTINEL} characters anywhere except as these markers.`
}

function modeInstruction({ mode, selectedCat, topic, message }: ConversationPromptInput) {
  if (mode === 'solo') {
    const cat = getPersonality(selectedCat ?? 'babe')
    const opener = message
      ? `The human is speaking one-on-one with ${cat.name} and has just sent a message (below).`
      : `The human is paying attention to ${cat.name} but has not said anything specific yet; react naturally.`
    return `${opener} Reply as ${cat.name}.\n${progressiveFormatInstruction('one')}`
  }
  if (mode === 'both') {
    if (message) {
      return `The human is speaking with both cats at once and has just sent a message (below). The cat most likely to respond answers the human first, then the other cat reacts, and the two build a real back-and-forth about it — with each other and with what the human said — until it reaches a natural pause. Keep it on the human's subject and don't repeat points.\n${progressiveFormatInstruction('extended')}`
    }
    return `The human is paying attention to both cats but has not said anything specific yet; react naturally. Decide which cat is most likely to respond first, and only let the other cat add one short turn if it would naturally react.\n${progressiveFormatInstruction('two')}`
  }
  if (mode === 'cats-only') {
    return `Leo and Babe are talking to each other, not to the human, about: ${topic || 'whatever is on their minds right now'}. Return between 6 and 10 alternating turns that build a real back-and-forth exchange between them. Return a JSON object matching the schema: a "turns" array of { speaker, text, emotion } and a "conversationEnded" boolean. Set conversationEnded to true only if the exchange has naturally wound down; otherwise false.`
  }
  const cat = selectedCat ? getPersonality(selectedCat) : null
  return `${cat ? cat.name : 'One of the cats'} spontaneously starts a short conversation with the human, unprompted, based on ${cat ? `${cat.name}'s` : 'their'} personality and current mood.\n${progressiveFormatInstruction('one')}`
}

export function buildConversationPrompt(input: ConversationPromptInput) {
  const { primary, both, configId } = profileConfig(input)
  const history = boundHistory(input.history, input.message)

  // --- Stable prefix (system): rules + compact profiles. Identical for a given configId across
  // requests, so it stays prompt-cache friendly. Dynamic content goes in the user message below. ---
  const profilesBlock = both
    ? `Compact personality profile — Babe:\n${compactProfile('babe')}\n\nCompact personality profile — Leo:\n${compactProfile('leo')}`
    : `Compact personality profile — ${getPersonality(primary!).name}:\n${compactProfile(primary!)}\n\nThe other cat, ${getPersonality(otherCat(primary!)).name}, for context only (do not speak as them):\n${relationshipSummary(otherCat(primary!))}`

  const system = `You are generating the next turn(s) of dialogue for Babeleo, a private household with two cats named Leo and Babe. You must speak strictly as the cats themselves. Never mention that you are an AI, a language model, a prompt, or that this is role-play, and never narrate physical actions in brackets or stage directions. Keep individual turns to one or two sentences. Preserve each cat's distinct personality, speaking style, and their established relationship. Do not invent significant household memories or events that are not already established in their profiles; if something is unknown, respond with an in-character guess, question, or assumption instead. Choose one emotion for every turn from exactly this list: ${EMOTIONS.join(', ')}.

${profilesBlock}`

  // --- Dynamic suffix (user): mode + format, then relevant detail, then history, then newest message
  // last (recency + cache friendliness). The message appears exactly once, here at the end. ---------
  const detailCats: CatId[] = both ? ['babe', 'leo'] : [primary!]
  const haystack = [input.message ?? '', input.topic ?? '', ...history.map((h) => h.text)].join(' ')
  const relevant = selectRelevantDetails(detailCats, haystack)
  const relevantBlock = relevant.length
    ? `Relevant background (use only if it fits the moment; do not recite it):\n${relevant.map((d) => `- (${d.catName}) ${d.content}`).join('\n')}`
    : ''

  const parts = [
    modeInstruction(input),
    relevantBlock,
    `Conversation so far:\n${formatHistory(history)}`,
    input.message ? `The human's latest message: "${input.message}"` : '',
  ].filter(Boolean)

  const user = parts.join('\n\n')

  return {
    input: [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: user },
    ],
    profileConfigId: configId,
    promptChars: system.length + user.length,
    historyCount: history.length,
  }
}
