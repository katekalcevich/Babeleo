import OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import { z } from 'zod'
import {
  buildConversationPrompt,
  usesProgressiveFormat,
  TURN_SPEAKER_SENTINEL,
  TURN_EMOTION_SENTINEL,
} from '@/lib/build-conversation-prompt'
import { promptCacheKey, resolveModelConfig } from '@/lib/model-config'

export const runtime = 'nodejs'

const catIdSchema = z.enum(['babe', 'leo'])
const EMOTIONS = ['neutral', 'happy', 'worried', 'annoyed', 'excited', 'affectionate', 'suspicious'] as const
const emotionSchema = z.enum(EMOTIONS)
const EMOTION_SET = new Set<string>(EMOTIONS)

// --- Request validation limits (named constants) --------------------------------------------------
// These are generous safety rails that reject abusive payloads at the edge. The precise context
// policy (latest 10 entries, per-entry/total character budgets) is enforced server-side by
// boundHistory() inside buildConversationPrompt, so no more than 10 entries ever reach the model.
const MAX_MESSAGE_CHARS = 2000
const MAX_TOPIC_CHARS = 200
const REQUEST_MAX_HISTORY_ENTRIES = 100
const REQUEST_MAX_ENTRY_CHARS = 2000

const requestSchema = z.object({
  mode: z.enum(['solo', 'both', 'cats-only', 'surprise']),
  selectedCat: catIdSchema.nullable().optional(),
  topic: z.string().max(MAX_TOPIC_CHARS).nullable().optional(),
  message: z.string().max(MAX_MESSAGE_CHARS).nullable().optional(),
  history: z
    .array(z.object({ speaker: z.enum(['human', 'babe', 'leo']), text: z.string().max(REQUEST_MAX_ENTRY_CHARS) }))
    .max(REQUEST_MAX_HISTORY_ENTRIES)
    .optional(),
})

const turnSchema = z.object({
  speaker: catIdSchema,
  text: z.string(),
  emotion: emotionSchema,
})

const conversationSchema = z.object({
  turns: z.array(turnSchema),
  conversationEnded: z.boolean(),
})

// Scans streamed Structured-Outputs JSON and yields each complete object inside the top-level
// `turns` array the instant its closing brace arrives (cats-only mode). String/escape aware so
// braces inside dialogue text never confuse the depth counter.
function createTurnExtractor() {
  let buf = ''
  let cursor = 0
  let arrayStarted = false
  let inString = false
  let escaped = false
  let depth = 0
  let objStart = -1

  return function push(chunk: string): string[] {
    buf += chunk
    const completed: string[] = []

    if (!arrayStarted) {
      const keyIdx = buf.indexOf('"turns"')
      if (keyIdx === -1) return completed
      const bracketIdx = buf.indexOf('[', keyIdx)
      if (bracketIdx === -1) return completed
      arrayStarted = true
      cursor = bracketIdx + 1
    }

    for (; cursor < buf.length; cursor++) {
      const ch = buf[cursor]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') {
        if (depth === 0) objStart = cursor
        depth++
      } else if (ch === '}') {
        depth--
        if (depth === 0 && objStart !== -1) {
          completed.push(buf.slice(objStart, cursor + 1))
          objStart = -1
        }
      } else if (ch === ']' && depth === 0) {
        break
      }
    }
    return completed
  }
}

type ProgressiveEvent = { kind: 'start'; speaker: 'babe' | 'leo' } | { kind: 'delta'; text: string } | { kind: 'final'; emotion: string }

function normalizeSpeaker(raw: string, fallback: 'babe' | 'leo'): 'babe' | 'leo' {
  const s = raw.toLowerCase()
  if (s.includes('leo')) return 'leo'
  if (s.includes('babe') || s.includes('abe')) return 'babe'
  return fallback
}

function normalizeEmotion(raw: string): string {
  const e = raw.toLowerCase().replace(/[^a-z]/g, '')
  return EMOTION_SET.has(e) ? e : 'neutral'
}

// Stateful parser for the low-overhead streaming micro-format (solo / both / surprise):
//   §<speaker>\n<dialogue text>¶<emotion>   (repeated per turn)
// Emits start (speaker known, text begins), delta (text chunks stream through), and final (emotion
// resolved) events. Speaker/emotion are validated so metadata stays reliable even mid-stream.
function createProgressiveParser(fallbackSpeaker: 'babe' | 'leo') {
  let state: 'seek' | 'speaker' | 'text' | 'emotion' = 'seek'
  let speakerBuf = ''
  let emotionBuf = ''
  let deltaBuf = ''

  function drain(events: ProgressiveEvent[]) {
    if (deltaBuf) {
      events.push({ kind: 'delta', text: deltaBuf })
      deltaBuf = ''
    }
  }

  function push(chunk: string): ProgressiveEvent[] {
    const events: ProgressiveEvent[] = []
    for (const ch of chunk) {
      if (state === 'seek') {
        if (ch === TURN_SPEAKER_SENTINEL) {
          state = 'speaker'
          speakerBuf = ''
        }
      } else if (state === 'speaker') {
        if (ch === '\n') {
          events.push({ kind: 'start', speaker: normalizeSpeaker(speakerBuf, fallbackSpeaker) })
          state = 'text'
        } else if (ch !== '\r') {
          speakerBuf += ch
        }
      } else if (state === 'text') {
        if (ch === TURN_EMOTION_SENTINEL) {
          drain(events)
          state = 'emotion'
          emotionBuf = ''
        } else if (ch === TURN_SPEAKER_SENTINEL) {
          // Malformed: a new turn began before an emotion marker. Close the current turn as neutral.
          drain(events)
          events.push({ kind: 'final', emotion: 'neutral' })
          state = 'speaker'
          speakerBuf = ''
        } else {
          deltaBuf += ch
        }
      } else if (state === 'emotion') {
        if (ch === TURN_SPEAKER_SENTINEL) {
          events.push({ kind: 'final', emotion: normalizeEmotion(emotionBuf) })
          state = 'speaker'
          speakerBuf = ''
        } else {
          emotionBuf += ch
        }
      }
    }
    drain(events)
    return events
  }

  function end(): ProgressiveEvent[] {
    const events: ProgressiveEvent[] = []
    if (state === 'text') {
      drain(events)
      events.push({ kind: 'final', emotion: 'neutral' })
    } else if (state === 'emotion') {
      events.push({ kind: 'final', emotion: normalizeEmotion(emotionBuf) })
    }
    return events
  }

  return { push, end }
}

export async function POST(request: Request) {
  const requestReceivedAt = performance.now()
  const traceId = crypto.randomUUID()

  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: 'The cats can’t hear you right now. The studio isn’t connected.' }, { status: 503 })
  }

  let json: unknown
  try {
    json = await request.json()
  } catch {
    return Response.json({ error: 'That message got lost on the way to the cats.' }, { status: 400 })
  }

  const parsedBody = requestSchema.safeParse(json)
  if (!parsedBody.success) {
    return Response.json({ error: 'That message got lost on the way to the cats.' }, { status: 400 })
  }

  const { mode, selectedCat = null, topic = null, message = null, history = [] } = parsedBody.data
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const cfg = resolveModelConfig()
  const progressive = usesProgressiveFormat(mode)
  const fallbackSpeaker: 'babe' | 'leo' = selectedCat ?? 'babe'
  const encoder = new TextEncoder()

  const { input, profileConfigId, promptChars, historyCount } = buildConversationPrompt({ mode, selectedCat, topic, message, history })

  // Latency dimensions logged up front (no keys, no dialogue text, no profiles — counts only).
  console.log(
    `[v0] conv trace=${traceId} received mode=${mode} model=${cfg.model} effort=${cfg.reasoningEffort ?? 'n/a'} verbosity=${cfg.verbosity ?? 'n/a'} prompt_chars=${promptChars} history=${historyCount} progressive=${progressive}`
  )

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))

      // First event: hand the client the trace id + config so it can correlate its own timings.
      send({ type: 'meta', traceId, model: cfg.model, reasoningEffort: cfg.reasoningEffort ?? null, promptChars, historyCount })

      let firstRawDeltaAt = 0
      let firstTurnAt = 0
      let firstDialogueEventAt = 0
      let turnCount = 0

      const markDialogueEvent = () => {
        if (!firstDialogueEventAt) {
          firstDialogueEventAt = performance.now()
          console.log(`[v0] conv trace=${traceId} first_event=${(firstDialogueEventAt - requestReceivedAt).toFixed(0)}ms`)
        }
      }

      try {
        // Compose request params safely: only attach reasoning/verbosity/cache-key the model supports,
        // so an unsupported parameter can never make the Responses API reject the request.
        const textParam: Record<string, unknown> = {}
        if (!progressive) textParam.format = zodTextFormat(conversationSchema, 'cat_conversation')
        if (cfg.verbosity) textParam.verbosity = cfg.verbosity

        const params: Record<string, unknown> = { model: cfg.model, input, stream: true }
        if (Object.keys(textParam).length) params.text = textParam
        if (cfg.reasoningEffort) params.reasoning = { effort: cfg.reasoningEffort }
        if (cfg.supportsPromptCacheKey) params.prompt_cache_key = promptCacheKey(profileConfigId)

        const openaiStart = performance.now()
        console.log(`[v0] conv trace=${traceId} openai_start=${(openaiStart - requestReceivedAt).toFixed(0)}ms`)

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const completion = await openai.responses.create(params as any)

        const extract = createTurnExtractor()
        const parser = createProgressiveParser(fallbackSpeaker)
        let fullText = ''
        let index = -1
        let curSpeaker: 'babe' | 'leo' = fallbackSpeaker
        let curText = ''

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for await (const event of completion as any) {
          if (event.type !== 'response.output_text.delta') continue
          fullText += event.delta

          if (!firstRawDeltaAt) {
            firstRawDeltaAt = performance.now()
            // first_delta = time to first raw token (NOT the same as first_turn below).
            console.log(`[v0] conv trace=${traceId} first_delta=${(firstRawDeltaAt - openaiStart).toFixed(0)}ms`)
          }

          if (progressive) {
            for (const ev of parser.push(event.delta)) {
              if (ev.kind === 'start') {
                index++
                curSpeaker = ev.speaker
                curText = ''
                markDialogueEvent()
                send({ type: 'turn-start', index, speaker: curSpeaker, emotion: 'neutral' })
              } else if (ev.kind === 'delta') {
                curText += ev.text
                send({ type: 'turn-delta', index, textDelta: ev.text })
              } else {
                const text = curText.trim()
                if (text) {
                  turnCount++
                  if (!firstTurnAt) {
                    firstTurnAt = performance.now()
                    console.log(`[v0] conv trace=${traceId} first_turn=${(firstTurnAt - openaiStart).toFixed(0)}ms`)
                  }
                  send({ type: 'turn-final', index, turn: { speaker: curSpeaker, text, emotion: ev.emotion } })
                }
              }
            }
          } else {
            for (const raw of extract(event.delta)) {
              const parsed = turnSchema.safeParse(JSON.parse(raw))
              if (!parsed.success) continue
              turnCount++
              if (!firstTurnAt) {
                firstTurnAt = performance.now()
                console.log(`[v0] conv trace=${traceId} first_turn=${(firstTurnAt - openaiStart).toFixed(0)}ms`)
              }
              markDialogueEvent()
              send({ type: 'turn', turn: parsed.data })
            }
          }
        }

        if (progressive) {
          for (const ev of parser.end()) {
            if (ev.kind === 'delta') {
              curText += ev.text
              send({ type: 'turn-delta', index, textDelta: ev.text })
            } else if (ev.kind === 'final') {
              const text = curText.trim()
              if (text) {
                turnCount++
                send({ type: 'turn-final', index, turn: { speaker: curSpeaker, text, emotion: ev.emotion } })
              }
            }
          }
        }

        // conversationEnded lives after the turns array, so it's only reliable once the full object
        // has streamed in (cats-only). Progressive modes never end the conversation on their own.
        let conversationEnded = false
        if (!progressive) {
          try {
            conversationEnded = Boolean(JSON.parse(fullText).conversationEnded)
          } catch {}
        }

        const totalMs = performance.now() - requestReceivedAt
        console.log(`[v0] conv trace=${traceId} total=${totalMs.toFixed(0)}ms turns=${turnCount} mode=${mode}`)

        if (turnCount === 0) {
          send({ type: 'error', error: 'The cats got distracted and wandered off.' })
        } else {
          send({ type: 'done', conversationEnded })
        }
      } catch (error) {
        console.error(`[v0] conv trace=${traceId} generation failed:`, error instanceof Error ? error.message : 'unknown error')
        // If turns were already sent, the client keeps them; otherwise it surfaces the error.
        send({ type: 'error', error: 'The cats are temporarily distracted. Try again in a moment.' })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Trace-Id': traceId,
    },
  })
}
