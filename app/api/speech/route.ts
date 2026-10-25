import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const speechSchema = z.object({
  speaker: z.enum(['babe', 'leo']),
  text: z.string().min(1).max(600),
})

const FRIENDLY_ERROR = 'The cats lost their voice for a moment. Try again in a bit.'

function voiceIdFor(speaker: 'babe' | 'leo') {
  return speaker === 'babe' ? process.env.BABE_VOICE : process.env.LEO_VOICE
}

function errorResponse(status: number, message: string) {
  return Response.json({ error: message }, { status })
}

async function handleSpeech(speaker: 'babe' | 'leo', text: string) {
  const requestStart = performance.now()

  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) return errorResponse(503, FRIENDLY_ERROR)

  const voiceId = voiceIdFor(speaker)?.trim()
  if (!voiceId) return errorResponse(503, FRIENDLY_ERROR)

  try {
    const upstream = await fetch(
      // eleven_flash_v2_5 is the low-latency model; mp3_22050_32 is the smallest/fastest-to-first-byte
      // output format ElevenLabs offers, which matters more for perceived latency than final audio fidelity.
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_22050_32`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_flash_v2_5',
        }),
      }
    )

    const upstreamRespondedMs = performance.now() - requestStart

    if (!upstream.ok || !upstream.body) {
      console.error('[v0] ElevenLabs speech request failed:', upstream.status)
      const friendly =
        upstream.status === 401 || upstream.status === 403
          ? 'The cats’ voices are locked right now. Check the studio credentials.'
          : upstream.status === 422
          ? 'That line was too tricky for them to say.'
          : upstream.status === 429
          ? 'The cats need to catch their breath. Try again shortly.'
          : FRIENDLY_ERROR
      const status = upstream.status === 429 ? 429 : upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502
      return errorResponse(status, friendly)
    }

    // Instrument time-to-first-byte and total stream duration without buffering: a TransformStream
    // timestamps the first chunk as it passes through, then logs the total on flush, while every
    // chunk is forwarded to the client the instant it arrives.
    let firstByteAt: number | null = null
    let bytes = 0
    const timedStream = upstream.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (firstByteAt === null) {
            firstByteAt = performance.now()
            console.log(
              `[v0] speech ttfb=${(firstByteAt - requestStart).toFixed(0)}ms (elevenlabs_responded=${upstreamRespondedMs.toFixed(0)}ms) speaker=${speaker} chars=${text.length}`
            )
          }
          bytes += chunk.byteLength
          controller.enqueue(chunk)
        },
        flush() {
          const totalMs = performance.now() - requestStart
          console.log(`[v0] speech total=${totalMs.toFixed(0)}ms bytes=${bytes} speaker=${speaker}`)
        },
      })
    )

    return new Response(timedStream, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
        // Time until ElevenLabs began streaming (its own generation + network), known before we
        // start piping bytes. Visible per-line in DevTools → Network → Timing → Server Timing.
        'Server-Timing': `elevenlabs;desc="ElevenLabs TTFB";dur=${upstreamRespondedMs.toFixed(0)}`,
      },
    })
  } catch (error) {
    console.error('[v0] Speech generation failed:', error instanceof Error ? error.message : 'unknown error')
    return errorResponse(500, FRIENDLY_ERROR)
  }
}

// GET powers the <audio src> element directly so the browser streams and plays progressively
// instead of JS having to buffer a blob before playback can start.
export async function GET(request: Request) {
  const url = new URL(request.url)
  const parsed = speechSchema.safeParse({
    speaker: url.searchParams.get('speaker'),
    text: url.searchParams.get('text'),
  })
  if (!parsed.success) return errorResponse(400, 'That request got lost on the way to the cats.')
  return handleSpeech(parsed.data.speaker, parsed.data.text)
}

// POST is kept for any non-audio-element callers (e.g. one-off voice tests).
export async function POST(request: Request) {
  let json: unknown
  try {
    json = await request.json()
  } catch {
    return errorResponse(400, 'That request got lost on the way to the cats.')
  }
  const parsed = speechSchema.safeParse(json)
  if (!parsed.success) return errorResponse(400, 'That request got lost on the way to the cats.')
  return handleSpeech(parsed.data.speaker, parsed.data.text)
}
