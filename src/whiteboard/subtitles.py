"""Altyazıları (SRT) Pillow ile karelere gömer.

Referans videodaki görünüm: ekranın altında koyu yarı saydam kutu,
beyaz kalın yazı, en fazla iki satır, ortalanmış.

ASS/libass'a ve font kurulumuna ihtiyaç duymaz; ffmpeg sadece kareleri
birleştirmek için kullanılır.
"""

import os
import re

from PIL import Image, ImageDraw, ImageFont

SRT_TIME = re.compile(r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})")

FONT_CANDIDATES = [
    os.environ.get("WHITEBOARD_FONT", ""),
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
]


def find_font(size):
    for path in FONT_CANDIDATES:
        if path and os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    # Hiçbiri yoksa Pillow'un gömülü fontu (küçük olur ama çalışır)
    return ImageFont.load_default()


def _seconds(match):
    h, m, s, ms = match.groups()
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0


def parse_srt(srt_text):
    """SRT metnini [(start, end, text), ...] listesine çevirir."""
    cues = []
    for block in re.split(r"\r?\n\s*\r?\n", srt_text.strip()):
        lines = [ln for ln in block.splitlines() if ln.strip()]
        if not lines:
            continue
        time_idx = next((i for i, ln in enumerate(lines) if "-->" in ln), None)
        if time_idx is None:
            continue
        start_s, end_s = [p.strip() for p in lines[time_idx].split("-->")]
        m1, m2 = SRT_TIME.search(start_s), SRT_TIME.search(end_s)
        if not m1 or not m2:
            continue
        text = " ".join(lines[time_idx + 1:]).strip()
        text = re.sub(r"<[^>]+>", "", text)  # <i> gibi etiketleri temizle
        if text:
            cues.append((_seconds(m1), _seconds(m2), text))
    return cues


def _wrap(draw, text, font, max_width):
    words = text.split()
    lines, current = [], ""
    for word in words:
        trial = f"{current} {word}".strip()
        if draw.textlength(trial, font=font) <= max_width or not current:
            current = trial
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


class SubtitleRenderer:
    """Kare üzerine altyazı çizer; font nesnesini bir kez yükler."""

    def __init__(self, cues, width, height):
        self.cues = cues
        self.width = width
        self.height = height
        self.font = find_font(int(width * 0.048))
        self.line_gap = int(width * 0.014)
        self.max_text_width = int(width * 0.80)
        self.pad_x = int(width * 0.030)
        self.pad_y = int(width * 0.018)
        self.bottom_margin = int(height * 0.075)

    def text_at(self, t):
        for start, end, text in self.cues:
            if start <= t <= end:
                return text
        return None

    def draw(self, frame, t):
        text = self.text_at(t)
        if not text:
            return frame

        draw = ImageDraw.Draw(frame, "RGBA")
        lines = _wrap(draw, text, self.font, self.max_text_width)
        if len(lines) > 2:  # iki satıra sığdır
            while len(lines) > 2 and len(" ".join(lines)) > 0:
                lines = _wrap(draw, " ".join(lines), self.font, int(self.max_text_width * 1.08))
                if len(lines) <= 2:
                    break
                lines = lines[:2]

        line_h = self.font.size + self.line_gap
        box_h = line_h * len(lines) + self.pad_y * 2
        box_w = max(draw.textlength(ln, font=self.font) for ln in lines) + self.pad_x * 2
        box_w = min(box_w, self.width - int(self.width * 0.06))

        x1 = (self.width - box_w) / 2
        y1 = self.height - self.bottom_margin - box_h

        # Koyu yarı saydam kutu (referanstaki gibi)
        draw.rounded_rectangle(
            [x1, y1, x1 + box_w, y1 + box_h],
            radius=int(self.pad_y * 0.6),
            fill=(32, 32, 32, 165)
        )

        y = y1 + self.pad_y
        for line in lines:
            line_w = draw.textlength(line, font=self.font)
            draw.text(((self.width - line_w) / 2, y), line, font=self.font,
                      fill=(255, 255, 255, 255))
            y += line_h
        return frame
