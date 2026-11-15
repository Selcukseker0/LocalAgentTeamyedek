"""Altyazıları (SRT) Pillow ile karelere gömer.

Referans videodaki görünüm: ekranın altında koyu yarı saydam kutu,
beyaz kalın yazı, en fazla iki satır, ortalanmış.

ASS/libass'a ve font kurulumuna ihtiyaç duymaz; ffmpeg sadece kareleri
birleştirmek için kullanılır.
"""

import os
import re

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover - kullanıcıya anlaşılır mesaj
    raise SystemExit(
        "Pillow kurulu değil. Kurulum: python -m pip install -r requirements.txt"
    ) from None

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


def _norm_word(word):
    """Karşılaştırma için kelimeyi sadeleştirir (noktalama ve büyük/küçük harf)."""
    return re.sub(r"[^\wçğıöşüÇĞİÖŞÜ]", "", str(word)).lower()


def attach_word_timings(cues, words):
    """SRT ipuçlarını TTS kelime zamanlarıyla eşleştirir.

    cues: [(start, end, text), ...]
    words: [{"word"/"text": ..., "start": float, "end": float}, ...]

    Dönüş: [(start, end, text, [(word, w_start, w_end), ...])]
    Eşleşme oranı düşükse (kelimeler farklıysa) o ipucu için karaoke kapalı kalır.
    """
    if not words:
        return [(s, e, t, []) for s, e, t in cues]

    normalized = []
    for item in words:
        text = item.get("word") or item.get("text") or ""
        key = _norm_word(text)
        if not key:
            continue
        try:
            normalized.append((key, float(item.get("start", 0.0)), float(item.get("end", 0.0))))
        except (TypeError, ValueError):
            continue

    out = []
    cursor = 0
    for start, end, text in cues:
        tokens = [tok for tok in text.split() if tok.strip()]
        keys = [_norm_word(tok) for tok in tokens]
        # Cümle başını zaman çizelgesinde bul (kaymayı tolere et)
        begin = cursor
        found = None
        for i in range(max(0, cursor - 3), min(len(normalized), cursor + 60)):
            if i < len(normalized) and keys and normalized[i][0] == keys[0]:
                found = i
                break
        if found is not None:
            begin = found

        timed = []
        idx = begin
        matched = 0
        for token, key in zip(tokens, keys):
            if not key:
                timed.append((token, None, None))
                continue
            # 2 kelime ileriye kadar tolerans (TTS farklı bölebilir)
            hit = None
            for j in range(idx, min(len(normalized), idx + 3)):
                if normalized[j][0] == key:
                    hit = j
                    break
            if hit is None:
                timed.append((token, None, None))
                continue
            timed.append((token, normalized[hit][1], normalized[hit][2]))
            idx = hit + 1
            matched += 1

        ratio = matched / max(1, len([k for k in keys if k]))
        if ratio < 0.6:
            timed = []
        else:
            cursor = idx
        out.append((start, end, text, timed))
    return out


class SubtitleRenderer:
    """Kare üzerine altyazı çizer; font nesnesini bir kez yükler."""

    HIGHLIGHT = (242, 183, 5, 235)   # sarı marker (kapakla aynı renk)

    def __init__(self, cues, width, height, words=None):
        self.width = width
        self.height = height
        self.font = find_font(int(width * 0.048))
        self.line_gap = int(width * 0.014)
        self.max_text_width = int(width * 0.80)
        self.pad_x = int(width * 0.030)
        self.pad_y = int(width * 0.018)
        self.bottom_margin = int(height * 0.075)
        # Kelime zamanları varsa karaoke (aktif kelime vurgusu) açılır
        self.cues = attach_word_timings(cues, words) if words else [
            (s, e, t, []) for s, e, t in cues
        ]
        self.karaoke = any(c[3] for c in self.cues)

    def cue_at(self, t):
        for cue in self.cues:
            if cue[0] <= t <= cue[1]:
                return cue
        return None

    def text_at(self, t):
        cue = self.cue_at(t)
        return cue[2] if cue else None

    # --------------------------------------------------- kelime yerleşimi

    def _layout(self, draw, tokens):
        """Kelimeleri en fazla 2 satıra yerleştirir; (satırlar, konumlar) döner."""
        lines = []
        current = []
        current_w = 0.0
        space = draw.textlength(" ", font=self.font)
        for token in tokens:
            width = draw.textlength(token, font=self.font)
            if current and current_w + space + width > self.max_text_width:
                lines.append(current)
                current = [(token, width)]
                current_w = width
            else:
                current_w = current_w + (space if current else 0) + width
                current.append((token, width))
        if current:
            lines.append(current)
        return lines[:2], space

    def draw(self, frame, t):
        cue = self.cue_at(t)
        if not cue:
            return frame
        _start, _end, text, timed = cue

        draw = ImageDraw.Draw(frame, "RGBA")
        space = draw.textlength(" ", font=self.font)

        positioned = []   # (token, x, row, width, w_start, w_end)
        plain_lines = []
        karaoke = False

        if timed:
            tokens = [tok for tok, _ws, _we in timed]
            widths = [draw.textlength(tok, font=self.font) for tok in tokens]
            # 2 satıra sığıyor mu?
            lines, used_space = self._layout(draw, tokens)
            covered = sum(len(line) for line in lines)
            if covered == len(tokens):
                karaoke = True
                timing = [(ws, we) for _tok, ws, we in timed]
                index = 0
                for row, line in enumerate(lines):
                    total = sum(w for _tok, w in line) + space * (len(line) - 1)
                    x = (self.width - total) / 2
                    for tok, w in line:
                        ws, we = timing[index]
                        positioned.append((tok, x, row, w, ws, we))
                        x += w + space
                        index += 1
                plain_lines = ["" for _ in lines]
            else:
                timed = []

        if not karaoke:
            plain_lines = _wrap(draw, text, self.font, self.max_text_width)
            if len(plain_lines) > 2:
                plain_lines = _wrap(draw, " ".join(plain_lines), self.font,
                                    int(self.max_text_width * 1.08))[:2]

        line_h = self.font.size + self.line_gap
        rows = len(plain_lines) if plain_lines else max(1, max((p[2] for p in positioned), default=0) + 1)
        box_h = line_h * rows + self.pad_y * 2

        if karaoke:
            row_widths = []
            for row in range(rows):
                widths_row = [p[3] for p in positioned if p[2] == row]
                if widths_row:
                    row_widths.append(sum(widths_row) + space * (len(widths_row) - 1))
            content_w = max(row_widths or [0])
        else:
            content_w = max((draw.textlength(ln, font=self.font) for ln in plain_lines), default=0)
        box_w = min(content_w + self.pad_x * 2, self.width - int(self.width * 0.06))

        x_box = (self.width - box_w) / 2
        y_box = self.height - self.bottom_margin - box_h

        # Koyu yarı saydam kutu (referanstaki gibi)
        draw.rounded_rectangle(
            [x_box, y_box, x_box + box_w, y_box + box_h],
            radius=int(self.pad_y * 0.6),
            fill=(32, 32, 32, 165)
        )

        if not karaoke:
            y = y_box + self.pad_y
            for line in plain_lines:
                line_w = draw.textlength(line, font=self.font)
                draw.text(((self.width - line_w) / 2, y), line, font=self.font,
                          fill=(255, 255, 255, 255))
                y += line_h
            return frame

        # 1) aktif kelimenin arkasına sarı vurgu
        for _tok, x, row, w, w_start, w_end in positioned:
            if w_start is None or w_end is None or not (w_start <= t <= w_end):
                continue
            y = y_box + self.pad_y + row * line_h
            pad = int(self.font.size * 0.10)
            draw.rounded_rectangle(
                [x - pad, y - pad * 0.35, x + w + pad, y + self.font.size + pad * 0.85],
                radius=int(self.font.size * 0.16),
                fill=self.HIGHLIGHT
            )
            break

        # 2) kelimeler; vurgulu olan koyu renkte
        for tok, x, row, _w, w_start, w_end in positioned:
            y = y_box + self.pad_y + row * line_h
            active = w_start is not None and w_end is not None and w_start <= t <= w_end
            draw.text((x, y), tok, font=self.font,
                      fill=(20, 20, 20, 255) if active else (255, 255, 255, 255))
        return frame
