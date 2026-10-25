export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function isConfigured(value: string | undefined) {
  return Boolean(value?.trim())
}

export async function GET() {
  return Response.json({
    openaiConfigured: isConfigured(process.env.OPENAI_API_KEY),
    elevenLabsConfigured: isConfigured(process.env.ELEVENLABS_API_KEY),
    babeVoiceConfigured: isConfigured(process.env.BABE_VOICE),
    leoVoiceConfigured: isConfigured(process.env.LEO_VOICE),
  })
}
