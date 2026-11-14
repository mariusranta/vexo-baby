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

## Bridge

    git clone https://github.com/VexoAI-Org/vexo-open-kit.git      # inside this repo folder
    python3 -m pip install bleak
    cp env.example .env                                            # then fill in the keys
    python3 bridge/bridge.py 42 --who YourName                     # 42 = the number on the band's bag

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
- A guess to tune on the band: the cry detector. It only measures loudness, so loud talking next
  to the band can set it off. The numbers are at the top of `bridge/bridge.py`.
- Staged for the demo: the day of history from `/api/reset`.
