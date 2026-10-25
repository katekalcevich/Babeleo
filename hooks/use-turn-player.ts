'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export type PlayableTurn = { speaker: 'babe' | 'leo'; text: string; emotion: string }
export type TurnPlayerState = 'idle' | 'loading' | 'playing' | 'error'

// "Concurrency of two": the line currently playing plus one line prefetching ahead of it.
const MAX_PREFETCH_AHEAD = 2
// Safety net in case a stream never fires 'canplay' (e.g. dropped connection) — falls through
// to the caption-only path instead of hanging forever.
const LOAD_TIMEOUT_MS = 8000

// Browsers only allow play() on an element that has already played audibly during a user gesture.
// Lines start playing long after the click (once the model responds), so a fresh `new Audio()` per
// line gets rejected. Instead, a small pool of elements is unlocked on the first gesture and reused.
const POOL_SIZE = 3
const SILENT_WAV = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA=='

type CacheEntry = { audio: HTMLAudioElement; onError: () => void } | 'failed'

// Detached `new Audio()` elements have no owner in the document, so the browser reports the sound
// as coming from an unidentified background source and assistive tech announces it. Mounting the
// elements (hidden from the accessibility tree) ties playback to this page.
function createAttachedAudio() {
  const el = document.createElement('audio')
  el.preload = 'auto'
  el.hidden = true
  el.setAttribute('aria-hidden', 'true')
  el.dataset.babeleoVoice = ''
  document.body.appendChild(el)
  return el
}

function announceMediaSession(turn: PlayableTurn) {
  if (!('mediaSession' in navigator)) return
  navigator.mediaSession.metadata = new MediaMetadata({
    title: turn.speaker === 'babe' ? 'Babe' : 'Leo',
    artist: 'Babe & Leo',
  })
  navigator.mediaSession.playbackState = 'playing'
}

function buildSpeechUrl(turn: PlayableTurn) {
  const params = new URLSearchParams({ speaker: turn.speaker, text: turn.text })
  return `/api/speech?${params.toString()}`
}

export function useTurnPlayer() {
  const [state, setState] = useState<TurnPlayerState>('idle')
  const [currentIndex, setCurrentIndex] = useState(-1)
  const [muted, setMuted] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')

  const currentAudioRef = useRef<HTMLAudioElement | null>(null)
  const turnsRef = useRef<PlayableTurn[]>([])
  const cacheRef = useRef<Map<number, CacheEntry>>(new Map())
  const generationRef = useRef(0)
  const mutedRef = useRef(false)
  const audioUnlockedRef = useRef(false)
  const poolRef = useRef<HTMLAudioElement[]>([])
  const freePoolRef = useRef<HTMLAudioElement[]>([])
  const currentIndexRef = useRef(-1)
  // Tracks the timer + listener-cleanup for whichever line is currently loading/playing, so a
  // session change (stop/replay/play/unmount) can cancel it outright instead of relying solely on
  // the generation check inside each callback.
  const activeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeCleanupRef = useRef<(() => void) | null>(null)
  // Streaming session state: `streamOpen` means more turns may still arrive, and `waitingIndex`
  // records the index playback parked on after exhausting the turns received so far.
  const streamOpenRef = useRef(false)
  const waitingIndexRef = useRef<number | null>(null)
  // Per-line timestamps for perceived-latency instrumentation (request start -> first audible sound).
  const startedAtRef = useRef<Map<number, number>>(new Map())
  const sessionStartRef = useRef(0)

  useEffect(() => {
    mutedRef.current = muted
    if (currentAudioRef.current) currentAudioRef.current.muted = muted
    cacheRef.current.forEach((entry) => {
      if (entry !== 'failed') entry.audio.muted = muted
    })
  }, [muted])

  useEffect(() => {
    currentIndexRef.current = currentIndex
  }, [currentIndex])

  function clearActivePlayback() {
    if (activeTimeoutRef.current) {
      clearTimeout(activeTimeoutRef.current)
      activeTimeoutRef.current = null
    }
    if (activeCleanupRef.current) {
      activeCleanupRef.current()
      activeCleanupRef.current = null
    }
  }

  // Must run synchronously inside a user gesture. Plays silence (unmuted — muted playback doesn't
  // count as activation) on every idle pooled element so later play() calls on them are allowed.
  const unlockAudio = useCallback(() => {
    if (audioUnlockedRef.current) return
    if (poolRef.current.length === 0) {
      for (let i = 0; i < POOL_SIZE; i++) {
        const el = createAttachedAudio()
        poolRef.current.push(el)
        freePoolRef.current.push(el)
      }
    }
    const idle = [...freePoolRef.current]
    Promise.all(
      idle.map((el) => {
        el.muted = false
        el.src = SILENT_WAV
        return el.play().then(() => {
          el.pause()
          if (freePoolRef.current.includes(el)) el.removeAttribute('src')
        })
      })
    )
      .then(() => {
        audioUnlockedRef.current = true
      })
      .catch(() => {
        // Not unlocked yet; the next gesture retries.
      })
  }, [])

  useEffect(() => {
    const events = ['pointerdown', 'click', 'touchend', 'keydown'] as const
    events.forEach((e) => document.addEventListener(e, unlockAudio, true))
    return () => events.forEach((e) => document.removeEventListener(e, unlockAudio, true))
  }, [unlockAudio])

  useEffect(() => {
    return () => {
      generationRef.current += 1
      clearActivePlayback()
      releaseAll()
      document.querySelectorAll('audio[data-babeleo-voice]').forEach((el) => el.remove())
      poolRef.current = []
      freePoolRef.current = []
      audioUnlockedRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function releaseIndex(index: number) {
    const entry = cacheRef.current.get(index)
    if (entry && entry !== 'failed') {
      const { audio, onError } = entry
      audio.removeEventListener('error', onError)
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      if (poolRef.current.includes(audio) && !freePoolRef.current.includes(audio)) {
        freePoolRef.current.push(audio)
      }
    }
    cacheRef.current.delete(index)
    startedAtRef.current.delete(index)
  }

  function releaseAll() {
    cacheRef.current.forEach((entry, index) => releaseIndex(index))
    cacheRef.current.clear()
  }

  // Creates the <audio> element and immediately points it at the GET stream. The element starts
  // buffering over the network as soon as `src` is set — no fetch(), no blob(), no waiting for the
  // full response before something starts happening.
  const startLoading = useCallback((turn: PlayableTurn, index: number) => {
    const audio = freePoolRef.current.shift() ?? createAttachedAudio()
    audio.preload = 'auto'
    audio.muted = mutedRef.current
    startedAtRef.current.set(index, performance.now())
    const onError = () => {
      audio.removeEventListener('error', onError)
      cacheRef.current.set(index, 'failed')
      if (poolRef.current.includes(audio) && !freePoolRef.current.includes(audio)) {
        freePoolRef.current.push(audio)
      }
    }
    cacheRef.current.set(index, { audio, onError })
    audio.addEventListener('error', onError)
    audio.src = buildSpeechUrl(turn)
    audio.load()
    return audio
  }, [])

  function prefetchAround(list: PlayableTurn[], index: number) {
    const end = Math.min(list.length, index + MAX_PREFETCH_AHEAD)
    for (let i = index; i < end; i++) {
      if (!cacheRef.current.has(i)) startLoading(list[i], i)
    }
  }

  const playFrom = useCallback(
    (list: PlayableTurn[], index: number, generation: number) => {
      if (generation !== generationRef.current) return
      // Cancel whatever the previous line's timer/listeners were doing before starting this one, so
      // a stale timeout from an interrupted line can never fire against the new line.
      clearActivePlayback()

      if (index >= list.length) {
        // Streaming: playback caught up to the turns received so far. Park here and let
        // appendTurns() resume us the moment the next turn streams in (buffering, not done).
        if (streamOpenRef.current) {
          waitingIndexRef.current = index
          setState('loading')
          return
        }
        const totalMs = performance.now() - sessionStartRef.current
        console.log(`[v0] playback total_session=${totalMs.toFixed(0)}ms lines=${list.length}`)
        setState('idle')
        setCurrentIndex(-1)
        return
      }

      setCurrentIndex(index)
      setState('loading')
      prefetchAround(list, index)

      const entry = cacheRef.current.get(index)
      const audio = entry && entry !== 'failed' ? entry.audio : null
      let settled = false

      const advance = () => {
        releaseIndex(index)
        if (generation !== generationRef.current) return
        playFrom(list, index + 1, generation)
      }

      if (!audio) {
        setErrorMessage('One line lost its voice. Showing captions only.')
        setState('playing')
        const fallbackTimeout = setTimeout(() => {
          if (settled || generation !== generationRef.current) return
          settled = true
          advance()
        }, 1500)
        activeTimeoutRef.current = fallbackTimeout
        activeCleanupRef.current = () => clearTimeout(fallbackTimeout)
        return
      }

      currentAudioRef.current = audio

      const cleanupListeners = () => {
        audio.removeEventListener('playing', onPlaying)
        audio.removeEventListener('ended', onEnded)
        audio.removeEventListener('error', onError)
      }

      // Guards only against "audio never starts" (dropped connection, stalled buffering). It's
      // cleared the instant playback actually begins so long lines are never cut off mid-line.
      const loadTimeout = setTimeout(() => {
        if (settled || generation !== generationRef.current) return
        settled = true
        cleanupListeners()
        advance()
      }, LOAD_TIMEOUT_MS)

      const onPlaying = () => {
        if (settled) return
        clearTimeout(loadTimeout)
        const startedAt = startedAtRef.current.get(index)
        if (startedAt !== undefined) {
          console.log(`[v0] browser first_audible=${(performance.now() - startedAt).toFixed(0)}ms line=${index}`)
        }
        announceMediaSession(list[index])
        setState('playing')
      }
      const onEnded = () => {
        if (settled || generation !== generationRef.current) return
        settled = true
        clearTimeout(loadTimeout)
        cleanupListeners()
        advance()
      }
      const onError = () => {
        if (settled || generation !== generationRef.current) return
        settled = true
        clearTimeout(loadTimeout)
        cleanupListeners()
        cacheRef.current.set(index, 'failed')
        setErrorMessage('One line lost its voice. Showing captions only.')
        advance()
      }

      activeTimeoutRef.current = loadTimeout
      activeCleanupRef.current = () => {
        clearTimeout(loadTimeout)
        cleanupListeners()
      }

      audio.addEventListener('playing', onPlaying, { once: true })
      audio.addEventListener('ended', onEnded, { once: true })
      audio.addEventListener('error', onError, { once: true })

      audio.play().catch((error: unknown) => {
        console.log(`[v0] audio play rejected line=${index} reason=${error instanceof Error ? error.name : 'unknown'}`)
        if (settled || generation !== generationRef.current) return
        settled = true
        clearTimeout(loadTimeout)
        cleanupListeners()
        audioUnlockedRef.current = false
        setErrorMessage('Audio is blocked by the browser. Tap Replay to hear the voices.')
        setState('error')
      })
    },
    [startLoading]
  )

  const play = useCallback(
    (turns: PlayableTurn[]) => {
      generationRef.current += 1
      const generation = generationRef.current
      clearActivePlayback()
      releaseAll()
      streamOpenRef.current = false
      waitingIndexRef.current = null
      turnsRef.current = turns
      setErrorMessage('')
      sessionStartRef.current = performance.now()
      playFrom(turns, 0, generation)
    },
    [playFrom]
  )

  // Opens a streaming playback session with no turns yet. Playback parks at index 0 until the
  // first turn arrives via appendTurns(), so audio for line 1 starts the moment it's generated
  // instead of waiting for the whole conversation. Call endStream() once no more turns will come.
  const playStream = useCallback(() => {
    generationRef.current += 1
    clearActivePlayback()
    releaseAll()
    streamOpenRef.current = true
    waitingIndexRef.current = 0
    turnsRef.current = []
    setErrorMessage('')
    sessionStartRef.current = performance.now()
    setState('loading')
    setCurrentIndex(-1)
  }, [])

  // Re-opens the current session for more turns without interrupting the line being spoken, so
  // playback parks (instead of finishing) if it reaches the end before the new turns arrive.
  const extendStream = useCallback(() => {
    streamOpenRef.current = true
  }, [])

  const endStream = useCallback(() => {
    streamOpenRef.current = false
    // If playback is parked waiting for turns that will never come, unpark it so it can finalize.
    if (waitingIndexRef.current !== null) {
      const resumeAt = waitingIndexRef.current
      waitingIndexRef.current = null
      playFrom(turnsRef.current, resumeAt, generationRef.current)
    }
  }, [playFrom])

  const stop = useCallback(() => {
    generationRef.current += 1
    clearActivePlayback()
    releaseAll()
    streamOpenRef.current = false
    waitingIndexRef.current = null
    currentAudioRef.current = null
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none'
    setState('idle')
    setCurrentIndex(-1)
  }, [])

  const replay = useCallback(() => {
    if (!turnsRef.current.length) return
    generationRef.current += 1
    const generation = generationRef.current
    clearActivePlayback()
    releaseAll()
    streamOpenRef.current = false
    waitingIndexRef.current = null
    setErrorMessage('')
    sessionStartRef.current = performance.now()
    playFrom(turnsRef.current, 0, generation)
  }, [playFrom])

  const toggleMute = useCallback(() => setMuted((prev) => !prev), [])

  // Appends turns to the list currently being played, so an active playback session
  // keeps flowing into newly generated turns instead of restarting from index 0. If playback
  // parked waiting for more (streaming), this resumes it at the exact index it stopped on.
  const appendTurns = useCallback(
    (newTurns: PlayableTurn[]) => {
      const list = turnsRef.current
      list.push(...newTurns)
      if (waitingIndexRef.current !== null) {
        // Playback was parked waiting for more turns (buffering) — resume it, which also
        // prefetches via playFrom's own prefetchAround call.
        const resumeAt = waitingIndexRef.current
        waitingIndexRef.current = null
        playFrom(list, resumeAt, generationRef.current)
        return
      }
      // Already playing/loading a line: start loading the newly arrived turn(s) now if they fall
      // within the prefetch window (current line + one ahead), instead of waiting for the current
      // line to finish before the next one even starts buffering.
      if (currentIndexRef.current >= 0) {
        prefetchAround(list, currentIndexRef.current)
      }
    },
    [playFrom]
  )

  return { state, currentIndex, muted, errorMessage, play, stop, replay, toggleMute, appendTurns, playStream, extendStream, endStream, unlockAudio }
}
