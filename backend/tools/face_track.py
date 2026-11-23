#!/usr/bin/env python3
"""Face positions for ClipGen AI's smart framing (optional; needs OpenCV).

usage: face_track.py <frames_dir> <fps>
Reads frame_0001.jpg, frame_0002.jpg … (one every 1/fps seconds) and prints JSON:
  {"ok": true, "samples": [{"t": 0.0, "cx": 0.52, "cy": 0.40, "w": 0.18, "n": 1}, ...]}
cx/cy/w are fractions of the frame. For each frame the LARGEST detected face is reported (the speaker is usually the
closest). Uses OpenCV's bundled Haar frontal-face cascade: classic, fast, runs on a CPU, no model download.
"""
import json
import os
import sys

try:
    import cv2
except Exception as e:  # OpenCV not installed
    print(json.dumps({"ok": False, "error": "opencv-missing: %s" % e}))
    sys.exit(0)

def main():
    d, fps = sys.argv[1], float(sys.argv[2])
    cascade = cv2.CascadeClassifier(os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml"))
    if cascade.empty():
        print(json.dumps({"ok": False, "error": "cascade-missing"}))
        return
    files = sorted(f for f in os.listdir(d) if f.startswith("frame_") and f.endswith(".jpg"))
    samples = []
    for i, name in enumerate(files):
        img = cv2.imread(os.path.join(d, name), cv2.IMREAD_GRAYSCALE)
        if img is None:
            continue
        h, w = img.shape[:2]
        img = cv2.equalizeHist(img)
        faces = cascade.detectMultiScale(img, scaleFactor=1.12, minNeighbors=5, minSize=(max(24, w // 18), max(24, w // 18)))
        if len(faces):
            x, y, fw, fh = max(faces, key=lambda f: f[2] * f[3])
            samples.append({"t": round(i / fps, 3), "cx": round((x + fw / 2) / w, 4), "cy": round((y + fh / 2) / h, 4), "w": round(fw / w, 4), "n": int(len(faces))})
    print(json.dumps({"ok": True, "frames": len(files), "samples": samples}))

main()
