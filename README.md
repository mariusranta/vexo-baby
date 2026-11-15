<img width="1414" height="2000" alt="Waby Device Overview" src="https://github.com/user-attachments/assets/ae5af247-65f6-49e8-ae03-8a0285483485" />
# Waby

A wristband for babies that keeps every caretaker on the same page.

Built at VexoHacks (Y Combinator, November 14, 2026) on the Vexo Open band.

## The problem

A baby is looked after by several people in a day: a parent, the other parent, a grandparent, a sitter. Each handoff loses information. When the baby cries, the new caretaker starts guessing. Was she fed? When did she nap? What calmed her last time?

Babies cry about two hours a day in their first weeks. Most of the stress for a new caretaker is the minutes of trial and error, not the crying itself.

## What Waby does

The band is on the baby. It listens, and it keeps one shared log.

1. **Talk, and it logs.** Say "I just gave her a bottle, four ounces" near the band. It becomes a log entry. No app to open, no typing, hands stay free.
2. **It hears crying.** A sound model on the device recognizes a baby's cry and logs when it starts and stops.
3. **It says why, with evidence.** "She is crying, and she is probably hungry. She last ate 2 hours 50 minutes ago. Try this first: offer a feed."
4. **Ask it anything.** "When did she last eat?" or "Are you hungry, sweetie?" It answers out loud.
5. **It learns what works for this baby.** The log records what ended each cry (a feed, a pacifier, rocking), and uses that in its next suggestion.

The reason for crying comes from this baby's own history.

## How it works

```
baby's band ──Bluetooth──> laptop bridge ──> Cloudflare Worker ──> phone page
 (mic, motion)              │                 (log, AI, voice)      (any phone)
                            ├─ Deepgram: speech to text
                            └─ YAMNet: is that a cry? (runs on the laptop)
```

| Part | Where it runs | What it does |
|---|---|---|
| `bridge/bridge.py` | Laptop near the band | Reads the band's microphone. Sends words to Deepgram. Runs the cry model. Posts to the API |
| `bridge/cry_model.py` | Laptop | YAMNet, Google's sound classifier. Scores each half second for "baby cry" |
| `worker/src/index.js` | Cloudflare Worker + D1 | The log, the API, the AI that turns words into log entries and answers questions, and text to speech |
| `worker/public/` | Any phone browser | The Waby page: live words from the band, answers, crying alerts, the day's timeline |

In a real product the laptop's job moves to a phone or a small home hub.

## What we measured

- **Cry detection, clean recordings:** 4 recordings of different babies, all detected within 1 second. Median score 0.54 to 0.94. A person reading aloud scored 0.00.
- **Cry detection, through the band in the hackathon room:** a cry played at 40% phone volume next to the band was detected in about 2 seconds. 3.5 minutes of people talking around the band never scored above 0.02, so no false alarms.
- **Voice answers:** about 4 seconds from the end of a question to the phone speaking.

Not tested: quiet fussing, older babies, a real baby wearing the band.

## What is real, staged, and future

**Real, running on the band today**
- Always-on listening, speech to text, notes turned into log entries
- Cry detection with an on-device model
- Likely reason with evidence, spoken aloud
- Spoken questions and answers
- Shared log and phone page

**Staged for the demo**
- The baby (a recording of a real baby crying, played next to the band)
- The day of history in the log before the demo starts

**Future**
- A soft, sealed, baby-sized band. The Vexo Open band is a development board for an adult wrist
- A speaker on the band, so it answers from the wrist and not from a phone
- Hand cues from the motion sensor (hands to mouth, eye rubbing) to catch hunger and tiredness before the crying starts
- Heart rate and temperature once the hardware has them
- Tuning the cry model to each baby

Waby is not a medical device and makes no health claims.

## Run it

Full steps, the API table and tuning notes are in [SETUP.md](SETUP.md). The short version:

```
git clone https://github.com/VexoAI-Org/vexo-open-kit.git     # inside this repo folder
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r bridge/requirements.txt
cp env.example .env                                           # then fill in the keys
bridge/run-bluetooth.sh 66 YourName                           # 66 = the number on your band's bag
```

Double-tap the band first so it can be found. Then open the phone page with the team's key link.

No band? `.venv/bin/python bridge/bridge.py --sim --say "fed four ounces"` runs against a pretend one.

## Built with

- [Vexo Open kit](https://github.com/VexoAI-Org/vexo-open-kit): the band and its Python library
- [Deepgram](https://deepgram.com): speech to text and text to speech
- [YAMNet](https://www.kaggle.com/models/google/yamnet): sound classification, running on the laptop
- Cloudflare Workers, D1 and Workers AI: the API, the database and the language model

## Team

[mnlanza](https://github.com/mnlanza), [mariusranta](https://github.com/mariusranta), [wilmaatiainen-ops](https://github.com/wilmaatiainen-ops)
