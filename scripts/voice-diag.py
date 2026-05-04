#!/usr/bin/env python3
"""Diagnóstico do TTS Jarvis — descobre quais parâmetros (seed/speed) produzem
síntese mais próxima da AMOSTRA_APROVADA.wav (voz Jarvis travada).

Estratégia:
  1. Sintetiza voice_ref_text com várias combinações de (seed, speed)
  2. Calcula similaridade espectral (log-mel) entre cada output e a AMOSTRA
  3. Reporta ranking — a combinação no topo é a config oficial

Uso (com o venv do omnivoice):
  /home/ftgk/Documents/omnivoice-test/.venv/bin/python scripts/voice-diag.py

Saída:
  - /tmp/jarvis-diag/*.wav — arquivos pra escuta manual
  - print do ranking por similaridade
"""
import sys
import time
import wave
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from omnivoice import OmniVoice

VOICE_DIR = Path(__file__).resolve().parent.parent / "modules" / "voice"
REF_AUDIO = VOICE_DIR / "voice_ref.wav"
REF_TEXT = (VOICE_DIR / "voice_ref.txt").read_text(encoding="utf-8").strip()
APROVADA = VOICE_DIR / ".locked" / "AMOSTRA_APROVADA.wav"

OUT_DIR = Path("/tmp/jarvis-diag")
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Texto que a AMOSTRA_APROVADA está dizendo (descoberto via Whisper). Pra
# comparar timbre direito, sintetizamos exatamente isso e comparamos.
TEST_TEXT = (
    "Tarefa concluída, senhor. Todos os arquivos foram processados "
    "e o sistema está pronto para a próxima instrução."
)

# Grid de busca: seeds candidatos e speeds candidatos. Volume não é varrido
# porque ele só multiplica o sinal — não muda timbre, só amplitude. Aplicamos
# normalização de RMS antes da comparação pra ignorar volume.
SEEDS = [42, 0, 7, 13, 100, 1024, 2024, 31415]
SPEEDS = [0.85, 0.9, 0.95, 1.0, 1.05]

SAMPLERATE = 24000


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        n = w.getnframes()
        nch = w.getnchannels()
        sw = w.getsampwidth()
        raw = w.readframes(n)
    if sw == 2:
        audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sw == 4:
        audio = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"sampwidth não suportado: {sw}")
    if nch == 2:
        audio = audio.reshape(-1, 2).mean(axis=1)
    if sr != SAMPLERATE:
        # resample simples por interpolação linear (suficiente pra log-mel)
        ratio = SAMPLERATE / sr
        new_n = int(len(audio) * ratio)
        x_old = np.linspace(0, 1, len(audio))
        x_new = np.linspace(0, 1, new_n)
        audio = np.interp(x_new, x_old, audio).astype(np.float32)
    return audio


def write_wav(path: Path, audio: np.ndarray) -> None:
    audio16 = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLERATE)
        w.writeframes(audio16.tobytes())


def normalize_rms(audio: np.ndarray, target_rms: float = 0.1) -> np.ndarray:
    """Normaliza RMS pra remover diferença de volume da comparação."""
    rms = float(np.sqrt(np.mean(audio ** 2)))
    if rms < 1e-9:
        return audio
    return audio * (target_rms / rms)


def log_mel_spectrogram(audio: np.ndarray, n_mels: int = 64) -> torch.Tensor:
    """Espectrograma log-mel — captura informação de timbre/voz."""
    t = torch.from_numpy(audio).float()
    # STFT
    n_fft = 1024
    hop = 256
    spec = torch.stft(t, n_fft=n_fft, hop_length=hop, return_complex=True)
    mag = spec.abs() ** 2  # power
    # filtros mel (aproximação simples sem librosa)
    f_min, f_max = 0, SAMPLERATE / 2
    mel_min = 2595 * np.log10(1 + f_min / 700)
    mel_max = 2595 * np.log10(1 + f_max / 700)
    mels = np.linspace(mel_min, mel_max, n_mels + 2)
    hz = 700 * (10 ** (mels / 2595) - 1)
    bins = np.floor((n_fft + 1) * hz / SAMPLERATE).astype(int)
    fb = torch.zeros(n_mels, mag.shape[0])
    for m in range(1, n_mels + 1):
        l, c, r = bins[m - 1], bins[m], bins[m + 1]
        if c > l:
            fb[m - 1, l:c] = torch.linspace(0, 1, c - l)
        if r > c:
            fb[m - 1, c:r] = torch.linspace(1, 0, r - c)
    mel = fb @ mag
    log_mel = torch.log(mel + 1e-6)
    return log_mel


def similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity entre log-mel spectrograms (com truncamento ao menor)."""
    a = normalize_rms(a)
    b = normalize_rms(b)
    A = log_mel_spectrogram(a)
    B = log_mel_spectrogram(b)
    # truncar pra mesma duração
    n = min(A.shape[1], B.shape[1])
    A = A[:, :n]
    B = B[:, :n]
    a_flat = A.reshape(-1)
    b_flat = B.reshape(-1)
    return float(F.cosine_similarity(a_flat.unsqueeze(0), b_flat.unsqueeze(0)).item())


def main() -> int:
    print(f"[diag] referência: {REF_AUDIO}")
    print(f"[diag] amostra aprovada: {APROVADA}")
    print(f"[diag] texto de teste: {TEST_TEXT[:60]}...")
    print(f"[diag] saída: {OUT_DIR}")
    print()

    target = read_wav(APROVADA)
    print(f"[diag] AMOSTRA_APROVADA: {len(target) / SAMPLERATE:.2f}s")

    print(f"[diag] carregando OmniVoice...")
    t0 = time.time()
    model = OmniVoice.from_pretrained(
        "k2-fsa/OmniVoice", device_map="cuda:0", dtype=torch.float16
    )
    print(f"[diag] modelo pronto em {time.time() - t0:.1f}s")

    print(f"[diag] cacheando voice prompt...")
    voice_prompt = model.create_voice_clone_prompt(
        ref_audio=str(REF_AUDIO), ref_text=REF_TEXT, preprocess_prompt=True
    )

    results = []
    total = len(SEEDS) * len(SPEEDS)
    i = 0
    for seed in SEEDS:
        for speed in SPEEDS:
            i += 1
            torch.manual_seed(seed)
            if torch.cuda.is_available():
                torch.cuda.manual_seed_all(seed)

            gen_kwargs = {"text": TEST_TEXT}
            if speed != 1.0:
                gen_kwargs["speed"] = speed

            t0 = time.time()
            try:
                audio = model.generate(voice_prompt=voice_prompt, **gen_kwargs)
            except TypeError:
                audio = model.generate(
                    ref_audio=str(REF_AUDIO), ref_text=REF_TEXT, **gen_kwargs
                )
            wav = audio[0]
            if isinstance(wav, torch.Tensor):
                wav = wav.detach().cpu().numpy()
            wav = np.asarray(wav, dtype=np.float32)
            sim = similarity(wav, target)

            label = f"seed{seed}_speed{speed}"
            out_path = OUT_DIR / f"{label}.wav"
            write_wav(out_path, wav)
            print(f"[{i}/{total}] {label:30s} sim={sim:.4f} ({len(wav) / SAMPLERATE:.2f}s, {time.time() - t0:.1f}s)")
            results.append((sim, seed, speed, str(out_path)))

    results.sort(reverse=True)
    print()
    print("=" * 70)
    print("RANKING — top 5 mais similares à AMOSTRA_APROVADA.wav:")
    print("=" * 70)
    for sim, seed, speed, path in results[:5]:
        print(f"  sim={sim:.4f}  seed={seed:<8} speed={speed}  →  aplay {path}")
    print()
    print("Para escutar a referência:")
    print(f"  aplay {APROVADA}")
    print()
    sim, seed, speed, path = results[0]
    print(f"VENCEDOR: seed={seed}, speed={speed} (similaridade {sim:.4f})")
    print(f"Sugestão de patch no voice-config.json:")
    print(f'  "speed": {speed},')
    print(f'  "seed": {seed}')
    return 0


if __name__ == "__main__":
    sys.exit(main())
