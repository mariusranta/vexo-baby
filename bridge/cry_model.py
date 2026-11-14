# Hears crying in sound with YAMNet, Google's small sound classifier (521 kinds of sound,
# trained on AudioSet). It runs on the laptop: about 1 ms for each second of sound.
#   model/yamnet.tflite          the model (Apache 2.0, from TensorFlow Hub)
#   model/yamnet_class_map.csv   the names of its 521 sounds
# Needs:  pip install numpy ai-edge-litert av
import os

import numpy as np
from ai_edge_litert.interpreter import Interpreter

HERE = os.path.dirname(os.path.abspath(__file__))
WINDOW = 15600           # samples the model looks at: 0.975 s at 16 kHz
HOP = 7800               # a new answer every 0.49 s
# Rows of the class map that mean crying: "Crying, sobbing", "Baby cry, infant cry", "Whimper", "Wail, moan".
CRY_CLASSES = (19, 20, 21, 22)


class CryModel:
    def __init__(self, path=os.path.join(HERE, "model", "yamnet.tflite")):
        self.net = Interpreter(path)
        self.inp = self.net.get_input_details()[0]["index"]
        self.out = self.net.get_output_details()[0]["index"]
        self.net.resize_tensor_input(self.inp, [WINDOW])
        self.net.allocate_tensors()
        self.sound = np.zeros(0, dtype=np.float32)

    def feed_pcm(self, pcm: bytes):
        """16 kHz mono 16 bit sound in. Returns one number from 0 to 1 for each new half
        second: how sure the model is that it hears crying."""
        self.sound = np.concatenate([self.sound, np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0])
        scores = []
        while len(self.sound) >= WINDOW:
            self.net.set_tensor(self.inp, self.sound[:WINDOW])
            self.net.invoke()
            scores.append(float(self.net.get_tensor(self.out).reshape(-1)[list(CRY_CLASSES)].max()))
            self.sound = self.sound[HOP:]
        return scores
