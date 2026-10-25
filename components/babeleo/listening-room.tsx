'use client'

import { useEffect, useRef, useState } from 'react'
import { Mic, Play, Plus, Send, Shuffle, Square, Volume2, VolumeX } from 'lucide-react'
import { useTurnPlayer, type PlayableTurn } from '@/hooks/use-turn-player'
import { CATS, SEED_TRANSCRIPT, TOPICS, type ConversationLine, type Turn } from '@/lib/cats'
import { isAbortError, streamConversation, type HistoryEntry } from '@/lib/stream-conversation'
import { ErrorRegion } from './error-note'
import { MessageList } from './message-list'

const SURPRISE_TOPICS = [
  'the bird that keeps sitting on the fence',
  'a strange new smell in the hallway',
  'whose turn it is to sit in the sunny spot',
  'the box that arrived today',
  'the human leaving with a suitcase',
  'the noise behind the fridge',
  'the empty treat drawer',
  'the cat next door staring through the window',
  'the new rug in the living room',
  'a moth that got inside last night',
  'why the human talks to the little glowing rectangle',
  'the bath running upstairs',
]

const catIndices = (lines: ConversationLine[]) =>
  lines.flatMap((l, i) => (l.speaker === 'human' ? [] : [i]))

const toPlayable = (lines: ConversationLine[]): PlayableTurn[] =>
  lines.flatMap((l) => (l.speaker === 'human' ? [] : [{ speaker: l.speaker, text: l.text, emotion: l.emotion ?? 'neutral' }]))

export function ListeningRoom() {
  const [topicIndex, setTopicIndex] = useState(0)
  const [lines, setLines] = useState<ConversationLine[]>(SEED_TRANSCRIPT)
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'error'>('idle')
  // Maps each line the player is voicing (by player index) back to its position in `lines`.
  const [playbackMap, setPlaybackMap] = useState<number[]>([])
  const [micState, setMicState] = useState<'idle' | 'listening'>('idle')
  const [voiceError, setVoiceError] = useState('')
  const [voiceSupported, setVoiceSupported] = useState(true)
  const [draft, setDraft] = useState('')
  const [followUpDraft, setFollowUpDraft] = useState('')
  const [playError, setPlayError] = useState('')
  const [followUpError, setFollowUpError] = useState('')
  const player = useTurnPlayer()
  const requestIdRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const surpriseTopicRef = useRef<string | null>(null)
  const recognitionRef = useRef<any>(null)
  const linesRef = useRef(lines)
  linesRef.current = lines
  const playerBarRef = useRef<HTMLDivElement>(null)

  // Scrolls the viewport only; focus deliberately stays on whatever triggered playback.
  const revealPlayer = () => {
    requestAnimationFrame(() => {
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      playerBarRef.current?.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' })
    })
  }

  useEffect(() => {
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    setVoiceSupported(Boolean(Ctor))
    return () => {
      try { recognitionRef.current?.abort?.() } catch {}
      abortRef.current?.abort()
      requestIdRef.current += 1
      player.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const beginRequest = () => {
    // A new request supersedes any in-flight one; the id bump makes its late callbacks no-ops.
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const requestId = ++requestIdRef.current
    return { controller, isStale: () => requestId !== requestIdRef.current }
  }

  const clearActionErrors = () => {
    setPlayError('')
    setFollowUpError('')
  }

  const appendLine = (line: Turn, voice: boolean) => {
    const index = linesRef.current.length
    linesRef.current = [...linesRef.current, line]
    setLines(linesRef.current)
    if (voice) {
      setPlaybackMap((prev) => [...prev, index])
      player.appendTurns([line])
    }
  }

  const loadTopic = async (topic: string, keepGoing = false) => {
    const { controller, isStale } = beginRequest()
    setLoadState('loading')
    clearActionErrors()
    try {
      const history: HistoryEntry[] = keepGoing ? linesRef.current.map((t) => ({ speaker: t.speaker, text: t.text })) : []
      const stillSpeaking = player.state === 'playing' || player.state === 'loading'
      if (keepGoing && stillSpeaking) {
        player.extendStream()
      } else {
        setVoiceError('')
        player.playStream()
        setPlaybackMap([])
      }
      if (!keepGoing) {
        revealPlayer()
        linesRef.current = []
        setLines([])
      }
      await streamConversation({ mode: 'cats-only', selectedCat: null, topic, message: null, history }, {
        onTurnFinal: (t) => { if (!isStale()) appendLine(t, true) },
      }, controller.signal)
      if (!isStale()) {
        player.endStream()
        setLoadState('idle')
      }
    } catch (err) {
      if (isStale() || isAbortError(err)) return
      player.stop()
      setLoadState('error')
    }
  }

  const respond = async (message: string, continueThread = false) => {
    const { controller, isStale } = beginRequest()
    setLoadState('loading')
    setVoiceError('')
    clearActionErrors()
    const previous = continueThread ? linesRef.current : []
    const history: HistoryEntry[] = previous.map((t) => ({ speaker: t.speaker, text: t.text }))
    linesRef.current = [...previous, { speaker: 'human', text: message }]
    setLines(linesRef.current)
    try {
      // Open a streaming session so the first reply speaks as soon as it's generated.
      player.playStream()
      if (!continueThread) revealPlayer()
      setPlaybackMap([])
      await streamConversation({ mode: 'both', selectedCat: null, topic: null, message, history }, {
        onTurnFinal: (t) => {
          if (isStale()) return
          appendLine(t, true)
        },
      }, controller.signal)
      if (!isStale()) {
        player.endStream()
        setLoadState('idle')
      }
    } catch (err) {
      if (isStale() || isAbortError(err)) return
      player.stop()
      setLoadState('idle')
      setVoiceError('They got distracted. Try again.')
    }
  }

  const chooseTopic = (index: number) => { setTopicIndex(index); loadTopic(TOPICS[index].topic) }
  const surprise = () => {
    const pool = SURPRISE_TOPICS.filter((t) => t !== surpriseTopicRef.current)
    const topic = pool[Math.floor(Math.random() * pool.length)]
    surpriseTopicRef.current = topic
    setTopicIndex(-1)
    loadTopic(topic)
  }
  const activeTopic = topicIndex >= 0 ? TOPICS[topicIndex].topic : surpriseTopicRef.current ?? SURPRISE_TOPICS[0]
  const activeLabel = topicIndex >= 0 ? TOPICS[topicIndex].label : 'a surprise topic'

  const playAll = () => {
    if (lines.length === 0) {
      setPlayError('Nothing to play yet. Pick a topic or send Babe and Leo a message first.')
      return
    }
    setPlayError('')
    setPlaybackMap(catIndices(lines))
    player.play(toPlayable(lines))
    revealPlayer()
  }
  const stopEverything = () => {
    abortRef.current?.abort()
    requestIdRef.current += 1
    player.stop()
    setLoadState('idle')
  }

  const submitText = (e: React.FormEvent) => {
    e.preventDefault()
    const message = draft.trim()
    if (!message) {
      setVoiceError('Type a message for Babe and Leo first.')
      return
    }
    setDraft('')
    respond(message)
  }

  const submitFollowUp = (e: React.FormEvent) => {
    e.preventDefault()
    const message = followUpDraft.trim()
    if (!message) {
      setFollowUpError('Type a reply for Babe and Leo first.')
      return
    }
    if (linesRef.current.length === 0) {
      setFollowUpError('There’s no conversation to reply to yet. Pick a topic or send a message above.')
      return
    }
    setFollowUpDraft('')
    respond(message, true)
  }

  const toggleMic = () => {
    if (micState === 'listening') {
      recognitionRef.current?.stop?.()
      return
    }
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!Ctor) {
      setVoiceError('Voice input isn’t supported in this browser. Type your message instead.')
      return
    }
    setVoiceError('')
    const recognition = new Ctor()
    recognition.lang = 'en-US'
    recognition.interimResults = false
    recognition.maxAlternatives = 1
    let handled = false
    recognition.onresult = (event: any) => {
      handled = true
      setMicState('idle')
      const text = event.results?.[0]?.[0]?.transcript?.trim() ?? ''
      if (text) respond(text)
      else setVoiceError('Didn’t catch that. Try again or type your message.')
    }
    recognition.onerror = (event: any) => {
      handled = true
      setVoiceError(
        event?.error === 'not-allowed' || event?.error === 'service-not-allowed'
          ? 'Microphone access is blocked. Allow mic access or type your message instead.'
          : event?.error === 'no-speech'
          ? 'Didn’t catch that. Try again or type your message.'
          : 'Voice input hit a snag. Try again or type your message.'
      )
      setMicState('idle')
    }
    recognition.onend = () => { if (!handled) setMicState('idle') }
    recognitionRef.current = recognition
    try {
      recognition.start()
      setMicState('listening')
    } catch {
      setVoiceError('Voice input hit a snag. Try again or type your message.')
      setMicState('idle')
    }
  }

  const isPlaying = player.state === 'playing' || player.state === 'loading'
  const activeIndex = isPlaying && player.currentIndex >= 0 ? playbackMap[player.currentIndex] ?? -1 : -1
  const current = activeIndex >= 0 ? lines[activeIndex] : undefined
  const loadError = loadState === 'error' ? 'They got distracted. Try another topic.' : null

  const busy = loadState === 'loading'
  const micLabel = !voiceSupported
    ? 'Voice unavailable, type below'
    : micState === 'listening'
    ? 'Listening… tap to stop'
    : busy
    ? 'Meowing…'
    : 'Tap to speak'

  return (
    <section className="room" aria-labelledby="room-title">
      <h2 id="room-title" className="sr-only" tabIndex={-1}>What Babe and Leo are arguing about</h2>
      <div className="tabs" role="group" aria-label="Choose a topic">
        {TOPICS.map((t, i) => (
          <button key={t.label} type="button" className="tab" aria-pressed={topicIndex === i} onClick={() => chooseTopic(i)}>
            {t.label}
          </button>
        ))}
        <button type="button" className="tab tab-surprise" aria-pressed={topicIndex === -1} onClick={surprise}>
          <Shuffle size={16} aria-hidden="true" />
          Surprise me
        </button>
      </div>

      <div className="join-in" role="group" aria-labelledby="join-title">
        <h3 id="join-title" className="sr-only">Talk to Babe and Leo</h3>
        <div className="live-controls">
          <button
            type="button"
            className={`mic-btn is-${micState === 'listening' ? 'listening' : busy ? 'meowing' : 'idle'}`}
            onClick={toggleMic}
            aria-label={voiceSupported ? micLabel : 'Voice input unavailable'}
          >
            <Mic size={30} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <p className="mic-label">{micLabel}</p>
        </div>

        <ErrorRegion messages={[voiceError]} />

        <form className="composer" onSubmit={submitText}>
          <input
            type="text"
            value={draft}
            onChange={(e) => { setDraft(e.target.value); if (voiceError) setVoiceError('') }}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault() }}
            placeholder="Or type a message to Babe and Leo…"
            aria-label="Type a message to Babe and Leo"
            aria-invalid={voiceError ? true : undefined}
          />
          <button type="submit" aria-label="Send message">
            <Send size={16} aria-hidden="true" />
          </button>
        </form>
      </div>

      <div className="player-bar" ref={playerBarRef}>
        <span aria-hidden="true" />
        <button
          type="button"
          className="play-btn"
          onClick={() => (player.state === 'idle' ? playAll() : stopEverything())}
          aria-label={player.state === 'idle' ? 'Play conversation' : 'Stop conversation'}
        >
          {player.state === 'idle' ? <Play size={20} fill="currentColor" aria-hidden="true" /> : <Square size={16} fill="currentColor" aria-hidden="true" />}
        </button>
        <button type="button" className="icon-btn" onClick={player.toggleMute} aria-label={player.muted ? 'Unmute voices' : 'Mute voices'} aria-pressed={player.muted}>
          {player.muted ? <VolumeX size={18} aria-hidden="true" /> : <Volume2 size={18} aria-hidden="true" />}
        </button>
      </div>
      <ErrorRegion messages={[playError, loadError, player.errorMessage]} />

      <MessageList lines={lines} activeIndex={activeIndex} label={`Conversation about ${activeLabel}`} />

      {busy && lines.length > 0 && <p className="note note-pending">More is on the way…</p>}
      <hr className="room-divider" />
      <div className="room-actions">
        <form className="composer composer-follow-up" onSubmit={submitFollowUp}>
          <input
            type="text"
            value={followUpDraft}
            onChange={(e) => { setFollowUpDraft(e.target.value); if (followUpError) setFollowUpError('') }}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault() }}
            placeholder="Say more to Babe and Leo…"
            aria-label="Say more to Babe and Leo, continuing this conversation"
            aria-invalid={followUpError ? true : undefined}
          />
          <button type="submit" aria-label="Send reply">
            <Send size={16} aria-hidden="true" />
          </button>
        </form>
        <span className="room-actions-or">or</span>
        <button type="button" className="primary-btn" onClick={() => loadTopic(activeTopic, linesRef.current.length > 0)}>
          <Plus size={16} aria-hidden="true" />
          Keep them talking
        </button>
      </div>
      <ErrorRegion messages={[followUpError]} />
    </section>
  )
}
