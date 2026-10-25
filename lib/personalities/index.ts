import { babePersonality } from './babe'
import { leoPersonality } from './leo'

export const personalities = { babe: babePersonality, leo: leoPersonality } as const
export type CatId = keyof typeof personalities
export function getPersonality(catId: CatId) { return personalities[catId] }
export { babePersonality, leoPersonality }

// Full markdown profile — the source of truth. Kept for tooling/debugging; no longer sent on every
// request now that compact profiles + relevant detail selection carry the prompt.
export function profileForPrompt(profile: (typeof personalities)[CatId]) {
  return profile.profile
}

// Compact ~300-700 token profile sent on every request.
export function compactProfile(catId: CatId) {
  return personalities[catId].compact
}

// One- to two-sentence description of a cat, used when the *other* cat is speaking solo.
export function relationshipSummary(catId: CatId) {
  return personalities[catId].relationshipSummary
}

export type RelevantDetail = { catId: CatId; catName: string; id: string; content: string }

// Splits arbitrary text into a set of lowercase word tokens for whole-word keyword matching.
function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z]+/g) ?? [])
}

// Deterministic, dependency-free relevance selector. Scans the current message, topic, and recent
// history for keywords tied to each cat's detailed profile sections and returns only the
// highest-scoring matches, so relevant depth (food, hunting, bedtime, raccoons, health, etc.) is
// added without shipping either full profile. No embeddings, vector store, or extra network call.
export function selectRelevantDetails(catIds: CatId[], haystack: string, maxSections = 3): RelevantDetail[] {
  const tokens = tokenize(haystack)
  const lower = haystack.toLowerCase()
  const scored: { detail: RelevantDetail; score: number }[] = []

  for (const catId of catIds) {
    const cat = personalities[catId]
    for (const section of cat.details) {
      let score = 0
      for (const keyword of section.keywords) {
        // Multi-word keywords fall back to substring matching; single words match whole tokens
        // so "eat" doesn't fire on "great".
        const hit = keyword.includes(' ') ? lower.includes(keyword) : tokens.has(keyword)
        if (hit) score++
      }
      if (score > 0) {
        scored.push({ detail: { catId, catName: cat.name, id: section.id, content: section.content }, score })
      }
    }
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, maxSections).map((s) => s.detail)
}
