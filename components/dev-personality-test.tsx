'use client'

import { useRef, useState } from 'react'

type Mode = 'solo' | 'both' | 'cats-only' | 'surprise'
type ApiCatId = 'babe' | 'leo'

const scenarios: { label: string; mode: Mode; selectedCat?: ApiCatId | null; topic?: string | null; message?: string | null }[] = [
  { label: 'Dinner is late', mode: 'both', message: 'Dinner is late.' },
  { label: 'A bird appears outside', mode: 'solo', selectedCat: 'babe', message: 'A bird just landed on the windowsill.' },
  { label: 'A raccoon appears', mode: 'both', message: 'There is a raccoon outside again.' },
  { label: 'Who owns the bed?', mode: 'cats-only', topic: 'Who owns the bed?' },
  { label: 'One cat challenges the other', mode: 'cats-only', topic: 'One of them wants the other to move.' },
  { label: 'Touch Babe’s paw', mode: 'solo', selectedCat: 'babe', message: 'Can I touch your paw?' },
  { label: 'Surprise conversation', mode: 'surprise', selectedCat: 'leo' },
]

export function DevPersonalityTest() {
  const [result, setResult] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [voiceStatus, setVoiceStatus] = useState<Record<ApiCatId, 'idle' | 'loading' | 'error'>>({ babe: 'idle', leo: 'idle' })
  const audioRef = useRef<HTMLAudioElement | null>(null)

  async function run(scenario: (typeof scenarios)[number]) {
    setBusy(true)
    setResult(null)
    try {
      const response = await fetch('/api/conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: scenario.mode,
          selectedCat: scenario.selectedCat ?? null,
          topic: scenario.topic ?? null,
          message: scenario.message ?? null,
          history: [],
        }),
      })
      setResult(await response.json())
    } catch {
      setResult({ error: 'Request failed.' })
    } finally {
      setBusy(false)
    }
  }

  async function testVoice(speaker: ApiCatId) {
    setVoiceStatus((prev) => ({ ...prev, [speaker]: 'loading' }))
    try {
      const response = await fetch('/api/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          speaker,
          text: speaker === 'babe' ? 'Hi, I am Babe. Testing my voice.' : 'Hello, this is Leo. Voice check.',
          emotion: 'neutral',
        }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || 'Voice test failed.')
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      if (!audioRef.current) audioRef.current = new Audio()
      const audio = audioRef.current
      audio.src = url
      audio.onended = () => URL.revokeObjectURL(url)
      await audio.play()
      setVoiceStatus((prev) => ({ ...prev, [speaker]: 'idle' }))
    } catch {
      setVoiceStatus((prev) => ({ ...prev, [speaker]: 'error' }))
    }
  }

  return (
    <section className="dev-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">DEVELOPMENT ONLY</p>
          <h2>Personality test panel</h2>
        </div>
        <span className="dev-badge">server profiles</span>
      </div>
      <p className="dev-copy">Run each prompt against the real server-side character definitions and the live OpenAI backend. Full profiles never enter the browser.</p>
      <div className="dev-scenarios">
        {scenarios.map((scenario) => (
          <button key={scenario.label} disabled={busy} onClick={() => run(scenario)}>
            {scenario.label}
          </button>
        ))}
      </div>
      {result != null && <pre className="dev-result">{JSON.stringify(result, null, 2)}</pre>}
      <p className="dev-copy" style={{ marginTop: 20 }}>Play a short line through the live ElevenLabs voices. Audio streams from the server; keys never reach the browser.</p>
      <div className="dev-scenarios">
        <button disabled={voiceStatus.babe === 'loading'} onClick={() => testVoice('babe')}>
          {voiceStatus.babe === 'loading' ? 'Testing Babe Voice…' : voiceStatus.babe === 'error' ? 'Babe Voice Failed — Retry' : 'Test Babe Voice'}
        </button>
        <button disabled={voiceStatus.leo === 'loading'} onClick={() => testVoice('leo')}>
          {voiceStatus.leo === 'loading' ? 'Testing Leo Voice…' : voiceStatus.leo === 'error' ? 'Leo Voice Failed — Retry' : 'Test Leo Voice'}
        </button>
      </div>
    </section>
  )
}
