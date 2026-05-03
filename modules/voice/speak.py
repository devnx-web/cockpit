"""Cliente leve usado pelo hook Stop do Claude Code.

Lê a transcript da sessão (passada via stdin pelo hook ou em $1), extrai
a última mensagem do assistant, aplica o speech_mode/max_chars do
config.json e envia via Unix socket para o daemon.

Uso direto:
  python speak.py "texto a falar"
Uso via hook (transcript_path em stdin JSON):
  echo '{"transcript_path": "/path/to/transcript.jsonl"}' | python speak.py
"""
from __future__ import annotations

import json
import re
import socket
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.json"


def load_config() -> dict:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def extract_text_from_message(msg: dict) -> str:
    """Pega texto plano da última mensagem do assistant."""
    content = msg.get("message", {}).get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
        return "\n".join(parts).strip()
    return ""


def last_assistant_text(transcript_path: str) -> str:
    last = ""
    try:
        with open(transcript_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("type") == "assistant":
                    text = extract_text_from_message(obj)
                    if text:
                        last = text
    except FileNotFoundError:
        return ""
    return last


CODE_FENCE_RE = re.compile(r"```.*?```", re.DOTALL)
INLINE_CODE_RE = re.compile(r"`[^`]+`")
URL_RE = re.compile(r"https?://\S+")
MD_LINK_RE = re.compile(r"\[([^\]]+)\]\([^\)]+\)")
EMOJI_RE = re.compile(
    "["
    "\U0001F300-\U0001FAFF"
    "\U00002600-\U000027BF"
    "\U0001F1E0-\U0001F1FF"
    "]+",
    flags=re.UNICODE,
)


def clean_for_speech(text: str) -> str:
    text = CODE_FENCE_RE.sub(" ", text)
    text = INLINE_CODE_RE.sub(" ", text)
    text = MD_LINK_RE.sub(r"\1", text)
    text = URL_RE.sub("", text)
    text = EMOJI_RE.sub("", text)
    text = re.sub(r"^[#>\-\*\+\s]+", "", text, flags=re.MULTILINE)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def apply_mode(text: str, mode: str, max_chars: int) -> str:
    if not text:
        return ""
    if mode == "first_sentence":
        m = re.search(r"[\.\!\?…]\s", text)
        text = text[: m.end()].strip() if m else text
    elif mode == "first_n_sentences":
        sentences = re.split(r"(?<=[\.\!\?…])\s+", text)
        text = " ".join(sentences[:2]).strip()
    elif mode == "verbatim":
        # modo legenda: fala o texto como ele é, sem reescrever nem cortar
        # por frase. Só respeita max_chars como rede de segurança.
        pass
    if len(text) > max_chars:
        cut = text[:max_chars]
        last_space = cut.rfind(" ")
        text = (cut[:last_space] if last_space > 0 else cut) + "…"
    return text


def summarize_with_llm(raw_text: str, summarize_cfg: dict) -> str:
    """Manda o texto cru pra um LLM e devolve uma versão para fala.
    Se falhar, retorna string vazia (deixa o caller decidir o fallback)."""
    if not summarize_cfg.get("enabled"):
        return ""
    provider = summarize_cfg.get("provider", "openai")
    if provider != "openai":
        return ""
    api_key = summarize_cfg.get("api_key", "").strip()
    if not api_key:
        return ""
    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key, timeout=float(summarize_cfg.get("timeout", 8)))
        resp = client.chat.completions.create(
            model=summarize_cfg.get("model", "gpt-4o-mini"),
            max_tokens=int(summarize_cfg.get("max_tokens", 120)),
            temperature=0.3,
            messages=[
                {"role": "system", "content": summarize_cfg.get("system_prompt", "")},
                {"role": "user", "content": raw_text[:6000]},
            ],
        )
        out = (resp.choices[0].message.content or "").strip()
        return out
    except Exception as e:
        print(f"[speak] summarize falhou: {e}", file=sys.stderr)
        return ""


def send_speak(socket_path: str, text: str) -> dict:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(2.0)
        s.connect(socket_path)
        s.sendall((json.dumps({"cmd": "speak", "text": text}) + "\n").encode("utf-8"))
        data = b""
        while not data.endswith(b"\n"):
            chunk = s.recv(4096)
            if not chunk:
                break
            data += chunk
        return json.loads(data.decode("utf-8") or "{}")


def main() -> int:
    cfg = load_config()
    if not cfg.get("enabled", True):
        return 0

    text = ""
    if len(sys.argv) > 1:
        text = " ".join(sys.argv[1:])
    else:
        try:
            payload = json.loads(sys.stdin.read() or "{}")
        except json.JSONDecodeError:
            payload = {}
        transcript = payload.get("transcript_path")
        if transcript:
            text = last_assistant_text(transcript)

    raw = clean_for_speech(text)
    if not raw:
        return 0
    mode = cfg.get("speech_mode", "first_sentence")
    if mode == "summary":
        summarized = summarize_with_llm(text, cfg.get("summarize", {}))
        text = summarized or apply_mode(raw, "first_sentence", int(cfg.get("max_chars", 400)))
    else:
        text = apply_mode(raw, mode, int(cfg.get("max_chars", 400)))
    if not text:
        return 0

    try:
        resp = send_speak(cfg["socket_path"], text)
        if not resp.get("ok"):
            print(f"[speak] daemon error: {resp.get('error')}", file=sys.stderr)
            return 2
    except (ConnectionRefusedError, FileNotFoundError, socket.timeout) as e:
        print(f"[speak] daemon offline: {e}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
