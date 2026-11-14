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
