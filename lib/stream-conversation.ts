import type { CatId, Turn } from '@/lib/cats'

export type HistoryEntry = { speaker: 'human' | CatId; text: string }

export type ConversationBody = {
  mode: 'solo' | 'both' | 'cats-only' | 'surprise'
  selectedCat: CatId | null
  topic: string | null
  message: string | null
  history: HistoryEntry[]
}

// onTurnStart/onTurnDelta drive live captions; onTurnFinal fires once a turn's full text + emotion
// are known and triggers audio playback. cats-only turns arrive complete, so all three fire together.
export type StreamHandlers = {
  onTurnStart?: (index: number, speaker: CatId) => void
  onTurnDelta?: (index: number, fullText: string) => void
  onTurnFinal?: (turn: Turn, index: number) => void
}

type StreamMessage = {
  type: string
  turn?: Turn
  index?: number
  speaker?: CatId
  textDelta?: string
  traceId?: string
  conversationEnded?: boolean
  error?: string
}

export function isAbortError(err: unknown) {
  return err instanceof DOMException && err.name === 'AbortError'
}

// Reads the NDJSON stream from /api/conversation. Handles both wire formats: the progressive
// micro-format (turn-start/turn-delta/turn-final) and cats-only whole `turn` objects.
export async function streamConversation(body: ConversationBody, handlers: StreamHandlers = {}, signal?: AbortSignal) {
  const res = await fetch('/api/conversation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    let errorText = 'The cats are temporarily distracted.'
    try {
      errorText = (await res.json()).error || errorText
    } catch {}
    throw new Error(errorText)
  }

  const reader = res.body.getReader()
  // Aborting must stop the network read, not just make callers ignore late callbacks.
  signal?.addEventListener('abort', () => {
    try {
      reader.cancel()
    } catch {}
  })
  const decoder = new TextDecoder()
  const turns: Turn[] = []
  const partial = new Map<number, string>()
  let conversationEnded = false
  let traceId = ''
  let buffer = ''
  let catsOnlyIndex = -1

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let msg: StreamMessage
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }

      if (msg.type === 'meta') {
        traceId = msg.traceId ?? ''
      } else if (msg.type === 'turn' && msg.turn) {
        const index = ++catsOnlyIndex
        handlers.onTurnStart?.(index, msg.turn.speaker)
        handlers.onTurnDelta?.(index, msg.turn.text)
        turns.push(msg.turn)
        handlers.onTurnFinal?.(msg.turn, index)
      } else if (msg.type === 'turn-start' && typeof msg.index === 'number' && msg.speaker) {
        partial.set(msg.index, '')
        handlers.onTurnStart?.(msg.index, msg.speaker)
      } else if (msg.type === 'turn-delta' && typeof msg.index === 'number' && msg.textDelta) {
        const next = (partial.get(msg.index) ?? '') + msg.textDelta
        partial.set(msg.index, next)
        handlers.onTurnDelta?.(msg.index, next)
      } else if (msg.type === 'turn-final' && msg.turn && typeof msg.index === 'number') {
        turns.push(msg.turn)
        handlers.onTurnFinal?.(msg.turn, msg.index)
      } else if (msg.type === 'done') {
        conversationEnded = Boolean(msg.conversationEnded)
      } else if (msg.type === 'error') {
        if (turns.length === 0) throw new Error(msg.error || 'The cats are temporarily distracted.')
      }
    }
  }

  if (!turns.length) throw new Error('The cats are temporarily distracted.')
  return { turns, conversationEnded, traceId }
}
