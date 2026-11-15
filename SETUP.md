# Running the code

Three parts:

| Part | Where | What it does |
|---|---|---|
| `worker/` | Cloudflare (live at https://vexo-baby.marco-44a.workers.dev) | The log database, the API, the AI (spoken note to log entries, likely reason for crying) and the phone page |
| `bridge/bridge.py` | A laptop near the band | Reads the band: spoken notes after a double-tap, crying from loudness |
| `worker/public/index.html` | Any phone | The page caretakers open. No install |

## Phone page

The production address is `https://vexo-baby.marco-44a.workers.dev`.
The ambient redesign on this branch appears there after deployment. The live text feed
uses the shared API access key when the Worker requires authentication.

## Ambient interface

The phone page is a minimal ambient display: a warm off-white screen, a subtle rounded
frame, a small Waby wordmark, a light speech feed above, and a softly glowing amber orb
in the lower third. Transcript text uses Helvetica Neue at weight 300 when installed,
with Helvetica and Arial as system fallbacks.
The orb is rendered with CSS gradients. It stays still at rest. The subtle **Enable voice
response** control starts local browser microphone analysis after permission is granted.
Audio energy drives a smoothed pulse, small wobble, organic border deformation, and glow.
An adaptive noise gate and voice-band filter reduce idle room-noise motion; this is an
audio-reactive heuristic, not a speech classifier, so other sounds may also trigger it.
Silence eases back to a completely still circle. Reduced-motion preferences suppress motion.

The feed polls the existing same-origin `/api/status` and `/api/timeline?hours=1`
endpoints every two seconds while visible. A newer bridge's `band.heard` data supports
interim text and finalized phrases. Older bridges fall back to finalized `band-voice`
event text. Up to six phrases stay on screen; transcripts are not saved in browser storage.
Pass `?k=KEY` once for an authenticated Worker; the key is remembered in this browser
and removed from the address bar. The feed shows a quiet waiting state if the API or
band is unavailable. It displays no sample or invented speech.

The page has no text input, speech playback, or care-event writes. Browser audio analysis
is opt-in and local: no recording is retained, uploaded, or connected to speakers.
**Turn off voice response** releases the microphone; switching tabs or leaving the page
also stops capture. It does not restart automatically. Browser microphone analysis drives
only the orb; the separate band bridge remains the source of transcript text.

The page loads `index.html`, `styles.css`, `feed.js`, and the `orb.js` module from `worker/public/`.
It uses no external fonts or image downloads. A static local preview can show the design,
but live transcript text needs the Worker API and a connected bridge. Local orb motion
works independently on localhost with microphone permission. Deploy with the existing
Worker setup below.

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
