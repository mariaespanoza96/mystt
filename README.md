# transcribe listener

A standalone Discord bot that joins a voice channel on `!join` and streams a
**live, per-speaker transcript** into that voice channel's text chat while
people talk.

Deliberately small: no database, no webhooks, no payments, no personas, just
the voice-receive path, a loudness gate, a transcription client per speaker (a local Whisper server, or the
Mistral Voxtral realtime API), and a rate-limit-safe message writer. No audio
leaves the machine except to the `STT_URL` you set.

```
!join
  ↓
Opus receive stream per member   ← Discord already separates speakers
  ↓ decode 48 kHz stereo
  ↓ box-filter downsample to 16 kHz mono
  ↓ loudness gate (pre-roll · hangover · force-cut)
  ↓ STT_URL http(s): ~4 s chunks cut at quiet frames → Whisper server
  ↓ STT_URL ws(s):   live stream → Mistral realtime socket (one per speaker)
  ↓ text appended in order, per utterance
colour-coded transcript embed, edited in place, finalised on silence
```

## Why the diarisation is exact

Most transcription pipelines guess who spoke with a diarisation model that
clusters voice embeddings, and then live with the mistakes. Discord's voice
gateway hands every member their own Opus stream, so this bot subscribes per
user (`connection.receiver.subscribe(userId)`), transcribes each speaker's
audio separately, and labels every line with the member that produced it. Nobody is
merged into a "Speaker 2", and two people talking over each other stay two
lines.

## Behaviour

- `!join` in a voice channel: join it and post into **the voice channel's own
  text chat**. `!join #channel` posts into a text channel instead.
- `!leave` stops and posts a one-line summary. The bot also leaves on its own
  when the channel stays empty (`IDLE_LEAVE_SECONDS`), when it is moved out, or
  when the voice connection is lost.
- A line opens ~200 ms after speech is detected (with 400 ms of pre-roll sent to
  the model so the first syllable is not clipped).
  - **Whisper** is not a streaming model, so long speech is sent in
    ~`STT_CHUNK_SECONDS` pieces, cut at the quietest moment, and the line grows
    chunk by chunk; the rest lands right after the person stops. The line is
    frozen once its last chunk is back.
  - **Mistral realtime** streams words into the line as they are spoken, and
    the line is frozen ~1.4 s after the person stops (late words up to ~4 s
    later still land in it).
- Noise blips that the model hears no words in are deleted again, and Whisper's
  non-speech tags (`[BLANK_AUDIO]`, `(laughs)`) are stripped.
- Each line is an embed with the speaker's avatar, name and start time. Every
  speaker gets their own colour bar (ten distinct colours, handed out in the
  order people first speak), so a conversation reads at a glance.
- Mention parsing is off: a transcript containing `@everyone` will not ping.
- One session per guild; `!join` from a different channel moves the bot.

## Installation

### Prerequisites

- **Node.js 24 or newer** (`node --version`). The test runner relies on
  `--experimental-test-module-mocks`, which older releases do not ship.
- **npm** (comes with Node).
- **A speech-to-text backend**, one of:
  - a local [whisper.cpp](https://github.com/ggml-org/whisper.cpp) server
    (free, runs on your own machine, no key needed), or
  - a [Mistral](https://console.mistral.ai/) API key for the Voxtral realtime
    API (hosted, billed per minute of audio, streams words as they are spoken).
- **ffmpeg** on your `PATH`, only if you want to run the STT smoke test.
- **Docker** (optional), if you prefer to run the bot in a container.

### 1. Get the code and install dependencies

```sh
git clone <this repository>
cd voicecoder
npm ci
```

`npm ci` installs the exact versions from `package-lock.json`. The Opus
decoder is pure JavaScript (`opusscript`), so no native build tools are needed.

### 2. Create the Discord application

1. Open <https://discord.com/developers/applications> and click **New
   Application**.
2. Under **Bot**, click **Reset Token** and copy the token. This is the value
   for `DISCORD_TOKEN` below. Keep it secret; anyone who has it controls the
   bot.
3. Still under **Bot → Privileged Gateway Intents**, enable **MESSAGE CONTENT
   INTENT**. Without it the bot cannot read `!join`.
4. Under **OAuth2 → URL Generator**, tick the scope `bot`, then the
   permissions `View Channels`, `Connect`, `Speak`, `Send Messages`,
   `Embed Links` and `Read Message History`. Open the generated URL and invite
   the bot to your server. (The bot also prints this exact URL in its log at
   startup.)

### 3. Start a speech backend

**Option A: local whisper.cpp (default).** Build whisper.cpp, download a
model, and start its server:

```sh
whisper-server -m models/ggml-large-v3-turbo.bin \
  --host 127.0.0.1 --port 8090 \
  --inference-path /v1/audio/transcriptions --convert
```

Any OpenAI-compatible `/v1/audio/transcriptions` endpoint works the same way
(speaches, faster-whisper-server, or OpenAI itself with `STT_API_KEY` set).

**Option B: Mistral Voxtral realtime.** No local server. In `.env` set:

```ini
STT_URL=wss://api.mistral.ai/v1/audio/transcriptions/realtime
STT_API_KEY=<your Mistral API key>
```

#### Getting a Mistral API key

1. Sign in (or sign up) at <https://console.mistral.ai/>.
2. Pick a plan for your workspace under **Billing** or **Subscription**. The
   free *Experiment* plan works for trying the bot out; *Scale* is pay-as-you-go
   with higher rate limits. API keys stay unusable until the workspace has a
   plan.
3. Open **API Keys** and click **Create new key**. Give it a name (for
   example `transcribe-listener`) and, if you like, an expiry date.
4. Copy the key straight away. Mistral shows it only once; if you lose it,
   delete it and make a new one. A new key can take a minute or two to start
   working.

Check that the key works before starting the bot:

```sh
curl -s https://api.mistral.ai/v1/models \
  -H "Authorization: Bearer <your Mistral API key>" | head -c 300
```

A JSON list of models means the key is good. `401 Unauthorized` means the key
is wrong, revoked or not active yet.

#### Using the key

Put the key in `.env` as `STT_API_KEY` (shown above). `MISTRAL_API_KEY` also
works and is only read when `STT_URL` is a `wss://` URL, so you can keep a
Whisper setup and a Mistral key in the same file without the key ever going to
the Whisper server. With Docker Compose the key reaches the container from the
same `.env` file.

The bot sends the key as an `Authorization: Bearer <key>` header when it opens
each speaker's realtime socket. The key never appears in the transcript or
the logs. `.env` is ignored by git, but treat the key like a password anyway.
If it leaks, revoke it under **API Keys** and create a new one. Usage is billed
per minute of audio and shows up under **Usage** in the console.

### 4. Configure

```sh
cp .env.example .env
```

Open `.env` and fill in at least `DISCORD_TOKEN`. Everything else has a
working default for a local whisper.cpp server on port 8090; see
[Configuration](#configuration) for the full list. `.env` is ignored by git,
so your token never ends up in a commit.

### 5. Build and run

```sh
npm run build   # compiles src/ to dist/
npm start       # runs dist/index.js
```

For development with automatic reload on save:

```sh
npm run dev
```

On startup the bot logs `bot online` and its invite URL. Join a voice channel
in Discord and type `!join` in any text channel; the live transcript appears
in the voice channel's own text chat. `!leave` stops it, `!help` lists the
commands.

### Running with Docker

```sh
cp .env.example .env     # fill in DISCORD_TOKEN as above
docker compose up -d --build
docker compose logs -f
```

The container reaches a whisper.cpp server on the host through
`host.docker.internal`, so in `.env` set
`STT_URL=http://host.docker.internal:8090/v1/audio/transcriptions`. Nothing
needs to be published: voice audio arrives over outbound UDP.

### Verify the install

```sh
npm test                          # unit tests, fully offline
npx tsx scripts/smoke-stt.mts     # sends fixtures/speech.wav to your STT_URL; expects "quick brown fox"
```

See [Tests](#tests) for the live voice smoke test against a real guild.

### Troubleshooting

- `DISCORD_TOKEN is required` or `401 Unauthorized`: the value in `.env` must
  be the **bot token** (Bot → Reset Token), not the application id or client
  secret.
- The bot ignores `!join`: the MESSAGE CONTENT intent is off, the bot cannot
  see the text channel, or you are not in a voice channel.
- `missing permissions: ...` on join: re-invite the bot with the permissions
  listed in step 2, or fix the channel overrides.
- `transcription request failed: ECONNREFUSED`: the whisper server is not
  running on `STT_URL`. From Docker, use `host.docker.internal` instead of
  `127.0.0.1`.
- `STT_API_KEY (or MISTRAL_API_KEY) is required`: you set a `wss://` URL
  without a Mistral key.
- Mistral rejects the socket with `401`: the key is mistyped, revoked, or not
  active yet. A workspace with no plan also gets `401`. Run the `curl` check in
  [Getting a Mistral API key](#getting-a-mistral-api-key) to confirm.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DISCORD_TOKEN` | – | Bot token |
| `STT_URL` | `http://127.0.0.1:8090/v1/audio/transcriptions` | `http(s)`: Whisper endpoint. `ws(s)`: Mistral realtime socket |
| `STT_API_KEY` / `MISTRAL_API_KEY` | – | Bearer key. Whisper: hosted endpoints only. Mistral: required (`MISTRAL_API_KEY` is a Mistral-only fallback) |
| `STT_MODEL` | – / `voxtral-mini-transcribe-realtime-3` | Whisper `model` field / Mistral model |
| `STT_LANGUAGE` | backend default | Two-letter code (Whisper also takes `auto`) |
| `STT_CHUNK_SECONDS` | `4` | Whisper: chunk length for long utterances (1–30); lower updates sooner |
| `STT_TIMEOUT_SECONDS` | `20` | Whisper: per-request timeout (one retry) |
| `STT_STREAMING_DELAY_MS` | `480` | Mistral: 80–1200 or 2400; lower streams sooner, higher is more accurate |
| `STT_MAX_SESSION_SECONDS` | `240` | Mistral: recycle a speaker socket after this much audio |
| `VAD_RMS_THRESHOLD` | `0.012` | Loudness gate; raise in noisy channels |
| `VAD_SPEECH_FRAMES` | `2` | Loud 100 ms frames before a line opens |
| `VAD_HANGOVER_MS` | `700` | Silence that closes a line |
| `VAD_PREROLL_MS` | `400` | Audio kept ahead of the trigger |
| `VAD_MIN_UTTERANCE_MS` | `300` | Shorter utterances are treated as noise |
| `VAD_MAX_UTTERANCE_SECONDS` | `60` | Hard cut for a single line |
| `EDIT_INTERVAL_MS` / `EDIT_JITTER_MS` | `1100` / `250` | Spacing between edits of one message |
| `IDLE_LEAVE_SECONDS` | `300` | Leave an empty channel after this |
| `MAX_CONCURRENT_SPEAKERS` | `8` | Ceiling on simultaneous speaker pipelines |
| `GUILD_ID` / `CONTROLLER_ROLE_ID` | – | Guild allow-list / who may control the bot |
| `AUTO_JOIN_CHANNEL_ID` | – | Voice channel to join at startup (respects `GUILD_ID`) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## Architecture

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Client, intents, command dispatch, shutdown |
| `src/commands.ts` | `!join` / `!leave` / `!status` parsing, permission checks, one session per guild |
| `src/voice/channel-session.ts` | Join, receiver subscription, per-member pipelines, idle and connection handling |
| `src/voice/speaker-pipeline.ts` | One member: decode → gate → STT → message, utterance lifecycle |
| `src/audio/resampler.ts` | 48 kHz stereo → 16 kHz mono, RMS, 100 ms framing |
| `src/audio/speech-gate.ts` | Loudness gate with pre-roll, hangover, and force-cut |
| `src/stt/transcriber.ts` | The per-speaker STT interface; picks the backend from `STT_URL` |
| `src/stt/whisper-client.ts` | WAV wrapping, the multipart `/v1/audio/transcriptions` request, stock-phrase filter |
| `src/stt/whisper-transcriber.ts` | Whisper: utterance buffering, silence trimming, quiet-point chunking, ordered requests, retries |
| `src/stt/realtime-transcription.ts` | Mistral realtime socket client (session setup, appends, flush, end) |
| `src/stt/realtime-transcriber.ts` | Mistral: a warm socket per speaker, replays audio across reconnects, rotates long sessions |
| `src/transcript/writer.ts` | Coalesced, rate-limited message create/edit/delete |
| `src/config.ts` / `src/logger.ts` | Validated env, JSON logging |

Numbers are codified in `src/config.ts` with range checks; a bad value fails at
boot instead of mid-call.

## Load

Audio is only sent for gated speech. With Whisper that is one request per
chunk; whisper.cpp serves one request at a time, so with many people talking
at once requests queue (large-v3-turbo on a GPU handles a 4 s chunk in well
under a second). Each speaker's requests run in order, and a line stays open
until its last chunk is back. With Mistral, every speaker who talks holds one
websocket while they stay in the channel, billed by Mistral; long monologues
rotate their socket every `STT_MAX_SESSION_SECONDS`.
`MAX_CONCURRENT_SPEAKERS` bounds the pipelines in a busy room.

## Notes

- Stage channels are supported (the bot asks to be un-suppressed); it never
  speaks, only listens (`selfMute`).
- Discord needs no recording permission for this, but tell people the channel
  is being transcribed.
- The bot keeps no archive: the transcript is the messages in the channel.
  Delete them or archive the channel to keep it.

## Tests

```
npm test        # 70 tests: gate, resampling, whisper + realtime clients, chunking, writer, turns, session, commands
npm run typecheck
npx tsx scripts/smoke-stt.mts   # real STT_URL, no Discord: the fixture must come back as text
```

Everything runs offline: both transcription backends are local fakes (an HTTP
server and a realtime websocket), and the voice
library is stubbed (`test/fake-voice.ts`) so the join/leave lifecycle, the
decoder-error path and the one-session-per-guild rule are covered without a
gateway. `npm test` needs Node 24 with `--experimental-test-module-mocks`, which
the script already passes.

After changing voice code, still run
`SMOKE_CHANNEL="<voice channel name>" npx tsx scripts/smoke-voice.mts` once against the
real guild: the fakes cannot prove that Discord's receive path behaves the same.

## Known limits

- Two processes using the same bot token fight over the voice connection; run
  only one.
- The token in `.env` must be the **bot** token from the Developer Portal
  (Bot → Reset Token). An application id pasted there starts with the same
  prefix but Discord answers `401 Unauthorized`.
- A message is deleted if the whole utterance is shorter than
  `VAD_MIN_UTTERANCE_MS`, even when the model guessed a word for the blip.