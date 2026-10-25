export type CatId = 'babe' | 'leo'
export type Turn = { speaker: CatId; text: string; emotion: string }
export type ConversationLine = { speaker: 'human' | CatId; text: string; emotion?: string }

export const CATS: Record<CatId, { name: string; bio: string; alt: string; header: string; avatar: string }> = {
  babe: {
    name: 'Babe',
    bio: 'A nervous, needy weirdo who wants Leo to be his best friend but will settle for a warm lap.',
    alt: 'Babe, a gray-and-white tabby cat',
    header: '/images/babe-header.png',
    avatar: '/images/babe-avatar.png',
  },
  leo: {
    name: 'Leo',
    bio: 'A clever, confident alpha cat who lives for the hunt and maintains order with quiet authority.',
    alt: 'Leo, an orange-and-white tabby cat',
    header: '/images/leo-header.png',
    avatar: '/images/leo-avatar.png',
  },
}

export const TOPICS = [
  { label: 'Raccoons', topic: 'Raccoons' },
  { label: 'The bed', topic: 'Who Owns the Bed?' },
  { label: 'Dinner', topic: 'Dinner' },
  { label: 'The vacuum', topic: 'The Vacuum' },
] as const

export const SEED_TRANSCRIPT: Turn[] = [
  { speaker: 'babe', text: 'The raccoon came back. I think we’re becoming friends.', emotion: 'excited' },
  { speaker: 'leo', text: 'It came back for the bins. You happen to be near them.', emotion: 'annoyed' },
  { speaker: 'babe', text: 'Friendship has to start somewhere.', emotion: 'hopeful' },
  { speaker: 'leo', text: 'Preferably somewhere without a lid.', emotion: 'suspicious' },
  { speaker: 'babe', text: 'You could try being more open.', emotion: 'worried' },
  { speaker: 'leo', text: 'So could the bins. That’s the problem.', emotion: 'annoyed' },
  { speaker: 'babe', text: 'Same time tomorrow?', emotion: 'excited' },
  { speaker: 'leo', text: 'I live here.', emotion: 'neutral' },
]
