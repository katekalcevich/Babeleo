<div align="center">
  <img src="public/images/logo.png" alt="Babeleo logo" width="88" />

# Babeleo

### Two cats. No consensus.

A playful AI conversation app starring Babe and Leo—two cats with distinct personalities, strong opinions, and very different ideas about how the household should be run.

**Chat with my cats.**
</div>

## Meet the cats

| Babe | Leo |
| --- | --- |
| A nervous, needy weirdo who wants Leo to be his best friend but will settle for a warm lap. | A clever, confident alpha cat who lives for the hunt and maintains order with quiet authority. |

## Features

- Chat with Babe, Leo, or both cats together.
- Listen to the cats discuss built-in topics such as raccoons, the bed, dinner, and the vacuum—or choose a surprise topic.
- Continue a conversation with follow-up messages or ask the cats to keep talking.
- Stream responses turn by turn so the conversation starts before the full reply is ready.
- Preserve recent conversation context while keeping prompts bounded.
- Generate expressive dialogue grounded in separate character profiles, shared history, relationship dynamics, and topic-relevant memories.
- Label each turn with an emotion such as happy, suspicious, affectionate, or annoyed.
- Stream distinct Babe and Leo voices through ElevenLabs, with play, stop, replay, mute, and captions-only fallback controls.
- Expose configuration health without revealing secret values.
- Send production analytics through Vercel Analytics.

## Tech stack

- [Next.js 16](https://nextjs.org/) with the App Router and Node.js route handlers
- [React 19](https://react.dev/) and TypeScript 5.7
- [Tailwind CSS 4](https://tailwindcss.com/) with PostCSS
- [OpenAI Node SDK](https://github.com/openai/openai-node) and the Responses API
- [ElevenLabs](https://elevenlabs.io/) streaming text-to-speech
- [Zod](https://zod.dev/) for request and structured-output validation
- [Lucide React](https://lucide.dev/) for interface icons
- [Vercel Analytics](https://vercel.com/analytics)
- pnpm

## Getting started

### Prerequisites

- Node.js 22 or newer
- pnpm
- An OpenAI API key
- Optional: an ElevenLabs API key and one voice ID for each cat

### Install

```bash
pnpm install
```

### Configure the environment

Create `.env.local` in the project root:

```dotenv
OPENAI_API_KEY=your_openai_api_key

# Optional: defaults to gpt-5-mini
OPENAI_MODEL=gpt-5-mini

# Optional: required only for generated voices
ELEVENLABS_API_KEY=your_elevenlabs_api_key
BABE_VOICE=your_babe_voice_id
LEO_VOICE=your_leo_voice_id
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | Yes | Generates conversations through the OpenAI Responses API. |
| `OPENAI_MODEL` | No | Overrides the conversation model. The code defaults to `gpt-5-mini`. |
| `ELEVENLABS_API_KEY` | No | Enables generated speech. Without it, dialogue remains available as text. |
| `BABE_VOICE` | No | ElevenLabs voice ID used for Babe. Required with speech enabled. |
| `LEO_VOICE` | No | ElevenLabs voice ID used for Leo. Required with speech enabled. |

Keep `.env.local` out of source control. The repository's `.gitignore` already ignores `.env*` files.

### Run locally

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Commands

| Command | Description |
| --- | --- |
| `pnpm dev` | Start the Next.js development server. |
| `pnpm build` | Create a production build. |
| `pnpm start` | Run the production server after building. |

The project currently does not define lint or test scripts.

## How conversations work

The browser sends the selected mode, topic or message, and recent transcript to `POST /api/conversation`. The server validates the request, bounds the supplied history, assembles the relevant personality and memory context, and streams model output back as newline-delimited JSON.

Four conversation modes are implemented:

- `solo`: one selected cat replies.
- `both`: Babe and Leo respond in an extended exchange.
- `cats-only`: the cats discuss a topic with each other using validated structured output.
- `surprise`: one or both cats respond according to the selected context.

Solo, both, and surprise conversations use a compact progressive format so speaker identity and dialogue can arrive incrementally. Cats-only conversations stream complete, schema-validated turns. The client appends each turn to the transcript and can begin voice playback while later turns are still being generated.

Conversation context is request-scoped rather than stored in a database. The server keeps at most the latest 10 history entries, caps individual entries at 600 characters, and limits retained history to 4,000 characters.

## Voice playback

`/api/speech` streams MP3 audio from ElevenLabs using `eleven_flash_v2_5`. The client maintains a small reusable audio pool and preloads the current and next lines to reduce gaps between speakers. If speech is unavailable or a line fails, the conversation continues with visible captions.

Because browsers restrict autoplay, interact with the page before expecting generated voices to play.

## API routes

| Route | Method | Description |
| --- | --- | --- |
| `/api/conversation` | `POST` | Validates input and streams AI-generated turns as NDJSON. |
| `/api/speech` | `GET`, `POST` | Streams a Babe or Leo voice response from ElevenLabs. |
| `/api/health` | `GET` | Reports whether OpenAI, ElevenLabs, and both voice IDs are configured. |

The health route returns configuration booleans only; it does not expose credential values.

## Project structure

```text
app/
├── api/
│   ├── conversation/route.ts  # OpenAI conversation stream
│   ├── health/route.ts        # Configuration checks
│   └── speech/route.ts        # ElevenLabs audio stream
├── globals.css                # Theme and responsive interface styles
├── layout.tsx                 # Metadata, fonts, and analytics
└── page.tsx                   # Main page composition
components/
├── babeleo/                   # Hero, listening room, transcript, footer, errors
└── ui/                        # Shared interface primitives
hooks/
└── use-turn-player.ts         # Streaming audio queue and playback controls
lib/
├── personalities/             # Babe and Leo profiles, memories, and relationship
├── build-conversation-prompt.ts
├── cats.ts                    # Display metadata, topics, and seed transcript
├── model-config.ts            # Model capabilities and default selection
└── stream-conversation.ts     # Browser-side NDJSON stream reader
public/images/                 # Logo, portraits, avatars, and decorative artwork
```

## Production

Create a production build and start it with:

```bash
pnpm build
pnpm start
```

Set the same environment variables in the deployment platform. Vercel Analytics is rendered only when `NODE_ENV` is `production`.

The current Next.js configuration serves images unoptimized and allows TypeScript build errors, so run an explicit type check during CI if stricter release gates are needed.

## Privacy and data notes

- Conversation messages and recent transcript context are sent to OpenAI for generation.
- Dialogue text is sent to ElevenLabs when voice playback is requested and voice configuration is available.
- The app does not include a database or durable conversation-memory store.
- Server logs record timing and count metadata for conversation and speech requests, not dialogue text or API keys.

## Credits

Created by [Kate Kalcevich](https://www.linkedin.com/in/katekalcevich/). Built with v0, OpenAI, and ElevenLabs.
