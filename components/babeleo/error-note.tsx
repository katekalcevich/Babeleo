import { CircleAlert } from 'lucide-react'

type ErrorRegionProps = { messages: (string | null | undefined)[] }

export function ErrorRegion({ messages }: ErrorRegionProps) {
  const visible = messages.filter((m): m is string => Boolean(m))
  return (
    <div className="error-region" aria-live="polite" aria-atomic="true">
      {visible.map((message) => (
        <p key={message} className="error-note">
          <span className="error-label">
            <CircleAlert size={16} strokeWidth={2.25} aria-hidden="true" />
            Oh no
          </span>
          <span>{message}</span>
        </p>
      ))}
    </div>
  )
}
