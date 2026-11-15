"""edge-tts ile seslendirme + kelime zaman damgaları + altyazı üretimi.

Kullanım:
    python tts_timing.py --text-file metin.txt --voice tr-TR-AhmetNeural \
        --rate +20% --media ses.mp3 --words kelimeler.json --srt altyazi.srt

Neden ayrı bir betik: edge-tts'in CLI'sı altyazıyı kendi böldüğü için
zamanlama cümle sınırlarına denk gelmiyor. Kütüphaneyi doğrudan kullanınca
her kelimenin başlangıç/bitiş zamanı (100 ns biriminde) elimize geçiyor;
altyazı ve sahne geçişleri bu gerçek zamanlara göre kuruluyor.
"""

import argparse
import asyncio
import json
import sys

WORD_BOUNDARY_PER_SECOND = 10_000_000  # edge-tts 100 ns biriminde verir

# Altyazı kuralları: en fazla 7 kelime, ~42 karakter, cümle sonunda biter
MAX_WORDS_PER_CUE = 7
MAX_CHARS_PER_CUE = 44
MAX_GAP_SECONDS = 0.65
SENTENCE_END = ".!?…"


def _fmt_timestamp(seconds: float) -> str:
    if seconds < 0:
        seconds = 0.0
    total_ms = int(round(seconds * 1000))
    hours, rem = divmod(total_ms, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, ms = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"


def build_cues(words, max_words=MAX_WORDS_PER_CUE):
    """Kelime zamanlarından cümle sınırlarına saygılı altyazı parçaları üretir.

    Kurallar: cümle sonunda kes, en fazla `max_words` kelime, satır ~44 karakter.
    Tek kelimelik kırıntı oluşmasın diye satır sonu kelimesi taşırılabilir.
    """
    cues = []
    current = []

    def flush():
        nonlocal current
        if not current:
            return
        cues.append({
            "text": " ".join(word["text"] for word in current).strip(),
            "start": current[0]["start"],
            "end": current[-1]["end"],
        })
        current = []

    for word in words:
        text = word.get("text", "").strip()
        if not text:
            continue

        if current:
            text_so_far = " ".join(item["text"] for item in current)
            projected = len(text_so_far) + 1 + len(text)
            gap = word["start"] - current[-1]["end"]
            sentence_done = current[-1]["text"][-1:] in tuple(SENTENCE_END)
            word_ends_sentence = text[-1:] in tuple(SENTENCE_END)
            too_many = len(current) >= max_words
            too_long = projected > MAX_CHARS_PER_CUE and len(current) >= 3
            pause = gap > MAX_GAP_SECONDS

            # Satır sonu kelimesi cümleyi bitiriyorsa taşırmayı kabul et
            if sentence_done or too_many or pause or (too_long and not word_ends_sentence):
                flush()

        current.append({"text": text, "start": float(word["start"]), "end": float(word["end"])})

        if text[-1:] in tuple(SENTENCE_END):
            flush()

    flush()

    # Tek kelimelik kırıntıları önceki parçaya ekle (çok uzamıyorsa)
    merged = []
    for cue in cues:
        if (
            merged
            and len(cue["text"].split()) <= 2
            and len(merged[-1]["text"].split()) + len(cue["text"].split()) <= max_words + 1
        ):
            merged[-1]["text"] = f"{merged[-1]['text']} {cue['text']}".strip()
            merged[-1]["end"] = cue["end"]
        else:
            merged.append(cue)
    return merged


def cues_to_srt(cues):
    blocks = []
    for index, cue in enumerate(cues, start=1):
        blocks.append(
            f"{index}\n{_fmt_timestamp(cue['start'])} --> {_fmt_timestamp(cue['end'])}\n{cue['text']}"
        )
    return "\n\n".join(blocks) + "\n"


async def synthesize(text, voice, rate, media_path, words_path, srt_path):
    import edge_tts  # gecikmeli import: kurulu değilse üst katman yedeğe düşer

    communicate = edge_tts.Communicate(text, voice, rate=rate)
    words = []

    with open(media_path, "wb") as audio:
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                start = chunk["offset"] / WORD_BOUNDARY_PER_SECOND
                end = (chunk["offset"] + chunk["duration"]) / WORD_BOUNDARY_PER_SECOND
                words.append({"text": chunk["text"], "start": start, "end": end})

    if not words:
        raise RuntimeError("edge-tts kelime zamanı döndürmedi")

    cues = build_cues(words)
    with open(words_path, "w", encoding="utf-8") as handle:
        json.dump({"words": words, "cues": cues}, handle, ensure_ascii=False, indent=1)
    with open(srt_path, "w", encoding="utf-8") as handle:
        handle.write(cues_to_srt(cues))

    return {
        "words": len(words),
        "cues": len(cues),
        "duration": words[-1]["end"] if words else 0.0,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--text-file", required=True)
    parser.add_argument("--voice", default="tr-TR-AhmetNeural")
    parser.add_argument("--rate", default="+20%")
    parser.add_argument("--media", required=True)
    parser.add_argument("--words", required=True)
    parser.add_argument("--srt", required=True)
    args = parser.parse_args()

    with open(args.text_file, encoding="utf-8") as handle:
        text = " ".join(handle.read().split())

    if not text:
        raise SystemExit("metin boş")

    info = asyncio.run(
        synthesize(text, args.voice, args.rate, args.media, args.words, args.srt)
    )
    print(json.dumps({"ok": True, **info}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - üst katman hatayı yedeğe çevirir
        print(json.dumps({"ok": False, "error": str(exc)[:300]}, ensure_ascii=False))
        sys.exit(1)
