import Image from 'next/image'
import { CATS, type ConversationLine } from '@/lib/cats'

type MessageListProps = { lines: ConversationLine[]; activeIndex: number; label: string }

export function MessageList({ lines, activeIndex, label }: MessageListProps) {
  return (
    <ol className="messages" aria-label={label}>
      {lines.map((line, i) => {
        const isHuman = line.speaker === 'human'
        const name = isHuman ? 'you' : CATS[line.speaker as 'babe' | 'leo'].name.toLowerCase()
        return (
          <li key={i} className={`msg msg--${line.speaker} ${i === activeIndex ? 'is-active' : ''}`} aria-current={i === activeIndex ? 'true' : undefined}>
            {isHuman ? (
              <span className="msg-avatar msg-avatar--human" aria-hidden="true">You</span>
            ) : (
              <Image src={CATS[line.speaker as 'babe' | 'leo'].avatar} alt="" width={56} height={56} className="msg-avatar" />
            )}
            <div className="msg-body">
              <span className="msg-meta">
                <span className="msg-dot" aria-hidden="true" />
                {name}
              </span>
              <p className="msg-bubble">{line.text || '…'}</p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
