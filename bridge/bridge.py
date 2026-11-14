# The laptop bridge: reads the band and writes to the baby log in the cloud.
#
#   python3 bridge/bridge.py 42                 band 42 over Bluetooth (double-tap the band first)
#   python3 bridge/bridge.py 42 --usb           the same band on the USB cable
#   python3 bridge/bridge.py --sim --say "fed four ounces"     no band, typed words
#
# What it does:
#   1. Double-tap the band, then speak a note ("fed four ounces"). The laptop plays a
#      sound when it starts and stops listening. The words go to Deepgram (speech to
#      text) and then to our API, which turns them into log entries.
#   2. Listens to how loud it is. Loud for most of a few seconds = crying started.
#      Quiet for a while = crying stopped. Only the loudness number is used for this:
#      no sound leaves the laptop unless you double-tap. Turn it off with --cry-db 0.
#      With --always yes there is no tapping: it listens all the time, like the Vexo
#      dashboard's Live transcript, and the API throws away what is not about the baby.
#   3. The keyboard is a safety net for the demo: type a note and press Enter, or type
#      "c" + Enter to switch crying on or off by hand.
#
# Settings come from the file .env in the repo folder: BABY_API, BABY_KEY, DEEPGRAM_API_KEY.
import collections
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_env():
    """Lines of .env in the repo folder become environment variables (what is set already wins)."""
    try:
        with open(os.path.join(REPO, ".env"), encoding="utf-8") as f:
            for line in f:
                name, _, value = line.strip().partition("=")
                if name and not name.startswith("#") and value.strip():
                    os.environ.setdefault(name.strip(), value.strip().strip("'\""))
    except OSError:
        pass


def find_kit():
    """The folder vexo-open-kit: named in VEXO_KIT, inside this repo, next to it, or where Marco keeps it."""
    places = [os.environ.get("VEXO_KIT", ""), os.path.join(REPO, "vexo-open-kit"),
              os.path.join(os.path.dirname(REPO), "vexo-open-kit"),
              os.path.expanduser("~/Documents/vexo-hack/vexo-open-kit")]
    for place in places:
        if place and os.path.isdir(os.path.join(place, "examples", "python")):
            return place
    sys.exit("Cannot find the folder vexo-open-kit. Clone it into this repo folder:\n"
             "    git clone https://github.com/VexoAI-Org/vexo-open-kit.git")


load_env()
sys.path.insert(0, os.path.join(find_kit(), "examples", "python"))
import kit  # noqa: E402  (also lets Python find the band library)
import speech  # noqa: E402
from vexo_open.sync import Band, VexoError  # noqa: E402

args = kit.args(more=[
    ("--who", os.environ.get("BABY_WHO", ""), "your name, shown next to your notes"),
    ("--note-seconds", "12", "the longest a spoken note can be (it stops by itself after a pause)"),
    ("--cry-db", "30", "how loud counts as crying: the loudness number (rms dB below the maximum) must be at or "
                       "under this. Smaller = must be louder. 0 = no cry detection"),
    ("--always", "yes", "yes (the default) = listen all the time; no = only after a double-tap. yes: listen all the time, like the Vexo dashboard's Live transcript: no tapping. Every "
                       "finished sentence goes to Deepgram and the API keeps only what is about the baby"),
    ("--cry", "model", "how crying is detected: model = a sound classifier (YAMNet) that knows what a baby's cry "
                       "sounds like, loudness = anything loud for a few seconds, off = only by hand"),
    ("--meter", "no", "yes = print the loudness number a few times a second, to choose --cry-db"),
    kit.SAY,
])
API = os.environ.get("BABY_API", "").rstrip("/")
KEY = os.environ.get("BABY_KEY", "")
if not API:
    sys.exit("BABY_API is not set. Copy env.example to .env in the repo folder and fill it in.")
NOTE_SECONDS = float(args.note_seconds)
CRY_DB = float(args.cry_db)
CRY = args.cry if args.cry in ("model", "loudness", "off") else "model"
if CRY_DB <= 0 and CRY == "loudness":
    CRY = "off"
model = None
if CRY == "model" and not args.say:
    try:
        from cry_model import CryModel
        from vexo_open.audio import PcmDecoder
        model, decoder = CryModel(), PcmDecoder()
    except Exception as problem:                      # not installed: say so and carry on with loudness
        print("The cry model is not available (%s). Using loudness. To get it: pip install numpy ai-edge-litert av" % problem)
        CRY = "loudness"

# The cry model gives a number from 0 to 1 twice a second. Measured through band 66 in the
# hackathon room (loud, people talking all around): 3.5 minutes of talk never went over 0.02;
# a cry video at 40% phone volume next to the band swung between 0.1 and 0.96 (babies breathe),
# mean about 0.45. So a low bar is safe, and the answer must be smoothed over a few seconds.
MODEL_ON = 0.15        # a half second counts as crying from this number up
MODEL_START = 2        # this many of the last 4 half seconds must count: crying started
MODEL_SURE = 0.5       # or one half second this sure
MODEL_QUIET = 0.1      # under this for all of the last 10 half seconds (5 s): crying stopped

# How the cry detector decides. Guesses to tune on the real band; see SETUP.md.
START_WINDOW = 4.0     # seconds looked at to decide "crying started"
START_SHARE = 0.65     # this share of that window must be loud (talking has more gaps than crying)
STOP_WINDOW = 8.0      # seconds looked at to decide "crying stopped"
STOP_SHARE = 0.15      # at most this share of that window may be loud


def post(path, body):
    """One POST to our API. Returns the answer, or None after printing what went wrong."""
    ask = urllib.request.Request(API + "/api" + path, data=json.dumps(body).encode("utf-8"), method="POST",
                                 headers={"content-type": "application/json", "x-key": KEY,
                                          "user-agent": "vexo-baby-bridge"})
    try:
        with urllib.request.urlopen(ask, timeout=30) as answer:
            return json.loads(answer.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        print("  The API said no (status %d): %s" % (error.code, error.read(300).decode("utf-8", "replace")))
    except (OSError, ValueError) as problem:
        print("  Could not reach the API: %s" % problem)
    return None


def sound(name):
    """A short system sound on the laptop: the band has no speaker and its light is busy."""
    path = "/System/Library/Sounds/%s.aiff" % name
    if sys.platform == "darwin" and os.path.exists(path):
        subprocess.Popen(["afplay", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def send_note(text, source):
    text = (text or "").strip()
    if not text:
        print("  Nothing was heard.")
        return
    print('  Note: "%s"' % text)
    answer = post("/notes", {"text": text, "source": source, "who": args.who or None})
    if answer is not None and not answer.get("events"):
        print("  Nothing about the baby in that, so nothing was logged.")
    for e in (answer or {}).get("events", []):
        amount = " %g %s" % (e["amount"], e.get("unit") or "") if e.get("amount") is not None else ""
        print("  Logged: %s%s%s" % (e["type"], amount, " (%s)" % e["detail"] if e.get("detail") else ""))


class Cry:
    """Decides "crying" from the loudness readings alone."""

    def __init__(self):
        self.readings = collections.deque()          # (time, loud?)
        self.scores = collections.deque(maxlen=20)   # the cry model's last answers
        self.crying = False
        self.paused_until = 0.0

    def pause(self, seconds):
        """Forget what was heard and ignore the next seconds: a caretaker is talking to the band."""
        self.readings.clear()
        self.paused_until = time.time() + seconds

    def share(self, now, window):
        recent = [loud for t, loud in self.readings if now - t <= window]
        return (sum(recent) / len(recent), len(recent)) if recent else (0.0, 0)

    def feed(self, rms_db):
        now = time.time()
        if now < self.paused_until:
            return None
        self.readings.append((now, rms_db <= CRY_DB))
        while self.readings and now - self.readings[0][0] > STOP_WINDOW:
            self.readings.popleft()
        if not self.crying:
            share, count = self.share(now, START_WINDOW)
            if count >= START_WINDOW * 5 and share >= START_SHARE:      # the window must be mostly full
                self.crying = True
                return "cry_start"
        else:
            share, count = self.share(now, STOP_WINDOW)
            if count >= STOP_WINDOW * 5 and share <= STOP_SHARE:
                self.crying = False
                return "cry_end"
        return None

    def feed_score(self, score):
        """One answer of the cry model. Returns "cry_start", "cry_end" or None."""
        if time.time() < self.paused_until:
            return None
        self.scores.append(score)
        if not self.crying and (score >= MODEL_SURE or sum(x >= MODEL_ON for x in list(self.scores)[-4:]) >= MODEL_START):
            self.crying = True
            return "cry_start"
        if self.crying and len(self.scores) >= 10 and max(list(self.scores)[-10:]) < MODEL_QUIET:
            self.crying = False
            return "cry_end"
        return None

    def set(self, crying, source):
        self.crying = crying
        self.readings.clear()
        self.scores.clear()
        kind = "cry_start" if crying else "cry_end"
        print("%s  %s" % (time.strftime("%H:%M:%S"), "CRYING started" if crying else "Crying stopped"))
        post("/events", {"type": kind, "source": source})


cry = Cry()
todo = collections.deque()          # jobs for the main loop: ("note",), ("typed", text), ("cry", kind)


def on_level(m):
    live["loudness"] = m.rms_db
    if args.meter == "yes":
        print("  loudness %2d  %s" % (m.rms_db, "#" * max(0, (60 - m.rms_db) // 2)))
    if CRY == "loudness":
        change = cry.feed(m.rms_db)
        if change:
            todo.append(("cry", change))


def read_keyboard():
    for line in sys.stdin:
        line = line.strip()
        if line:
            todo.append(("typed", line))


def flash(band, colour, back=False):
    """A short flash of the band's light, so the person knows the tap was felt. The light is
    locked while the microphone is on, so the loudness meter is switched off for the flash."""
    try:
        band.configure(mic_level=False)
        band.set_led(colour)
        band.wait(0.5)
        band.led_off()
        if back and CRY_DB > 0:
            band.configure(mic_level=0.1)
    except VexoError as problem:
        print("  (no flash: %s)" % problem)


def listen_for_note(band):
    """Mic on, words to Deepgram, stop after a pause in the talking or at NOTE_SECONDS."""
    if args.say:                                       # typed words in place of the microphone
        return args.say
    heard = {"last": None}

    def on_text(text, final):
        heard["last"] = time.time()
        if final:
            print("  Heard: %s" % text)

    ears = speech.create().start(on_text)

    def feed(a):
        ears.feed(a.opus, a.seq)

    band.on("audio", feed)
    try:
        flash(band, "#00ff00")                         # green: go ahead, speak
        band.configure(audio=True)
        sound("Glass")
        started = time.time()
        while time.time() - started < NOTE_SECONDS:
            band.wait(0.2)
            if heard["last"] and time.time() - heard["last"] > 1.8:      # they stopped talking
                break
            if not heard["last"] and time.time() - started > 6:           # nobody said anything
                break
        band.configure(audio=False)
    finally:
        band.off("audio", feed)
    sound("Pop")
    flash(band, "#ffffff", back=True)                  # white: got it
    return ears.stop()


live = {"heard": None, "final": False, "new": False, "loudness": None}    # what the phone page shows as "the band hears"


def report(band_name):
    """Tells the API every second or so that the bridge is alive and what it is hearing,
    so the phone page can show that live transcription works. Runs on its own thread."""
    last = 0.0
    while True:
        time.sleep(0.5)
        if live["new"] or time.time() - last > 4:
            body = {"name": band_name, "loudness": live["loudness"], "cry_score": live.get("cry")}
            if live["new"]:
                body.update(heard=live["heard"], final=live["final"])
                live["new"] = False
            last = time.time()
            post("/band", body)


ALWAYS = args.always == "yes" and not args.say
said = {"words": [], "last": 0.0}           # with --always: finished sentences waiting for a pause


def on_sentence(text, final):
    said["last"] = time.time()
    if text.strip():
        live["heard"], live["final"], live["new"] = text.strip(), bool(final), True
    if final and text.strip():
        if not said["words"]:
            said["first"] = time.time()
        said["words"].append(text.strip())


band = Band.connect(args.number, args.transport)
if not ALWAYS:
    band.on("double-tap", lambda e: todo.append(("note",)))
band.on("mic-level", on_level)
if CRY_DB > 0:
    band.configure(events=True, mic_level=0.1)
else:
    band.configure(events=True)
def on_sound(a):
    """Every packet of sound: to Deepgram for the words, and to the cry model on this laptop."""
    if ears:
        ears.feed(a.opus, a.seq)
    if model:
        pcm = decoder.feed(a.opus, a.seq)
        if dump:
            dump.write(pcm)
        for score in model.feed_pcm(pcm):
            recent.append(score)
            live["cry"] = max(recent)                  # the page shows the last 2 seconds, not one jumpy half second
            if args.meter == "yes":
                print("%s  cry %.2f  loud %s  %s" % (time.strftime("%H:%M:%S"), score, live["loudness"], "#" * int(score * 30)), flush=True)
            change = cry.feed_score(score)
            if change:
                todo.append(("cry", change))


recent = collections.deque(maxlen=4)
dump = open(os.environ["BABY_DUMP"], "wb") if os.environ.get("BABY_DUMP") else None    # raw sound, for tuning
ears = None
if ALWAYS:
    try:
        ears = speech.create().start(on_sentence)
    except VexoError as problem:
        print("No speech to text: %s" % problem)
if ALWAYS or model:
    band.on("audio", on_sound)
    band.configure(audio=True)
    if ears:
        print("Listening all the time: just talk. Only what is about the baby is logged.")
threading.Thread(target=read_keyboard, daemon=True).start()
threading.Thread(target=report, args=(band.name,), daemon=True).start()

print("Connected to %s. Writing to %s" % (band.name, API))
print("Just talk near the band, or type a note here and press Enter." if ALWAYS
      else "Double-tap the band and speak a note. Or type a note here and press Enter.")
print('Type "c" and Enter to switch crying on or off by hand. Stop with Ctrl+C.')
print({"model": "Cry detection: a sound model on this laptop that knows a baby's cry.",
       "loudness": "Cry detection: anything loud (loudness at or under %g) for a few seconds." % CRY_DB,
       "off": "Cry detection is off."}[CRY if (model or CRY != "model") else "off"])

ends = time.time() + args.seconds if args.seconds else None
last_note = 0.0
try:
    while ends is None or time.time() < ends:
        if not band.wait(0.1):
            time.sleep(0.5)                                                # the link dropped; the library is getting it back
        # A pause ends a note. In a room where people never stop talking, 8 seconds does.
        if ALWAYS and said["words"] and (time.time() - said["last"] > 1.5 or time.time() - said.get("first", 0) > 8):
            words, said["words"] = " ".join(said["words"]), []
            print("%s  Heard: %s" % (time.strftime("%H:%M:%S"), words))
            if len(words.split()) >= 2:
                send_note(words, "band-voice")
        while todo:
            job = todo.popleft()
            if job[0] == "cry":
                cry.set(job[1] == "cry_start", "band-auto")
            elif job[0] == "typed":
                if job[1].lower() == "c":
                    cry.set(not cry.crying, "manual")
                else:
                    send_note(job[1], "laptop")
            elif job[0] == "note" and time.time() - last_note > 3:        # one double-tap, one note
                print("%s  Listening for a note..." % time.strftime("%H:%M:%S"))
                cry.pause(NOTE_SECONDS + 5)
                try:
                    send_note(listen_for_note(band), "band-voice")
                except VexoError as problem:
                    print("  No note this time. %s" % problem)
                if CRY_DB > 0:
                    band.configure(mic_level=0.1)
                cry.pause(3)
                last_note = time.time()
                todo.clear()                                               # taps and loudness from while we listened
except KeyboardInterrupt:
    pass
finally:
    if cry.crying:
        post("/events", {"type": "cry_end", "source": "manual"})
    try:
        band.disconnect()
    except VexoError:
        pass
