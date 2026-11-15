# Running the code

Three parts:

| Part | Where | What it does |
|---|---|---|
| `worker/` | Cloudflare (live at https://vexo-baby.marco-44a.workers.dev) | The log database, the API, the AI (spoken note to log entries, likely reason for crying) and the phone page |
| `bridge/bridge.py` | A laptop near the band | Reads the band: spoken notes after a double-tap, crying from loudness |
| `worker/public/index.html` | Any phone | The page caretakers open. No install |

## Phone page

Open `https://vexo-baby.marco-44a.workers.dev/?k=KEY&who=YourName` once (ask Marco for KEY).
The page remembers both, so after that the plain address works.

## Voice conversation interface

The phone page is a responsive Waby speech-to-text UI with a warm neutral canvas,
large speaker-labeled transcripts, and a glowing orb anchored to the bottom edge.
Its static files are `worker/public/index.html`, `styles.css`, `app.js`, and
`assets/waby-orb.png`; Wrangler serves them together. The orb uses the supplied image
and changes animation for listening, processing, and spoken replies. Reduced-motion
preferences disable those animations.

- **Ask Waby** sends a question to `/api/ask` and adds the reply to this tab's conversation.
- **Log care** sends a reviewed care note to `/api/notes`. Questions never use that endpoint.
- **Tap to speak** starts browser speech recognition when supported. Speech appears live on the
  transcript canvas and fills the composer; the caretaker reviews it and presses Send.
  Tap **Finish speaking** to stop input. Microphone access begins only after a click.
- **Spoken replies** enables browser speech synthesis. It is off by default and can be stopped
  by unchecking it or starting voice input.
- The header's **Baby's day** history button opens a drawer with the existing status, recorded
  feeding/sleep/diaper information, and 24-hour timeline. Close it with its close button or Escape.
- The settings button changes the shared access key and caretaker name in this browser. Existing
  `?k=KEY&who=YourName` links still work; both parameters are read before being removed from the URL.

Voice input needs a supported browser, microphone permission, and HTTPS (or localhost). Some
browser speech services require a network connection. Unsupported or denied speech input leaves
typing available. Speech recognition here is the browser's service, separate from the band's
Deepgram pipeline. The redesigned page uses the same Worker API and access key as before.

For local development, with Node.js installed, run `npm ci`, `npm run db:local`, and `npm run dev`
from `worker/`. Configure local Worker secrets in ignored `.dev.vars` as needed. Deploy the
Worker normally to publish all three public files. The browser UI does not start the band bridge.

## Bridge

    git clone https://github.com/VexoAI-Org/vexo-open-kit.git      # inside this repo folder
    uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r bridge/requirements.txt
    cp env.example .env                                            # then fill in the keys
    bridge/run-bluetooth.sh 42 YourName                            # 42 = the number on the band's bag. On a Mac: in Terminal.app
    .venv/bin/python bridge/bridge.py 42 --usb --who YourName      # or on the USB cable

Double-tap the band first so it can be found. Close the Vexo dashboard tab: one program at a time.

- Just talk near the band. It listens all the time and keeps only what is about the baby.
  (`--always no` goes back to double-tap first, then speak.)
- Type a note in the terminal and press Enter: same thing without the microphone.
- Type `c` and Enter: switch crying on or off by hand (demo safety net).
- `--meter yes` prints the loudness number, to choose `--cry-db` (default 30; smaller = must be louder).
- No band: `python3 bridge/bridge.py --sim --say "fed four ounces"`.

## API

Every call needs the header `x-key: KEY`.

| Call | Body | Answer |
|---|---|---|
| `GET /api/status` | | crying, asleep, minutes since feed and diaper, sleep total, `reason` (cause, try_first, confidence, evidence) |
| `GET /api/timeline?hours=24` | | `events`, oldest first |
| `POST /api/notes` | `{text, who, source}` | the log entries the words became |
| `POST /api/events` | `{type, at, amount, unit, detail, who, source}` | the saved entry. Types: feed diaper sleep_start sleep_end cry_start cry_end soothe medicine note |
| `POST /api/ask` | `{question}` | `{answer}` from the log |
| `DELETE /api/events/ID` | | removes one entry |
| `POST /api/reset` | `{seed: true}` | wipes the log and fills in a demo day that ends with a feed almost due |

## Deploy

    cd worker && npm install && npx wrangler deploy

The AI uses Cloudflare's model until an OpenAI key is set: `npx wrangler secret put OPENAI_API_KEY`.

## What is real and what is a guess

- Real: spoken note to log entry, the log, the likely reason, the ask box, the phone page.
- The cry detector is YAMNet, Google's sound classifier, running on the laptop (`bridge/cry_model.py`).
  On two recordings of real babies it scored 0.54 and 0.83 (median), on a person reading aloud 0.00.
  Not yet measured through the band's microphone in a loud room. `--meter yes` prints the score.
  `--cry loudness` goes back to the old loudness rule, `--cry off` leaves only `c` + Enter.
- Staged for the demo: the day of history from `/api/reset`.
