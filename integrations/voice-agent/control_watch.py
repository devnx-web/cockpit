"""
Vigia de demandas — o que faz o Maestro falar sem ser perguntado.

Fala **direto** com a Control API loopback por HTTP, sem passar pelo MCP: uma
task de fundo reentrando no tool loop do agente é frágil e disputa o turno com
a conversa. Aqui só entra uma coisa no agente: a instrução de relatar.

Descoberta do control.json na mesma ordem de integrations/cockpit-mcp/src/config.js
(COCKPIT_CONTROL_DESCRIPTOR → XDG_RUNTIME_DIR → ~/.local/state → ~/.config).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger("maestro.watch")

# "working" muda o tempo todo e viraria tagarelice; estes três são os que
# pedem alguma coisa do Fabio ou encerram o assunto.
NOTIFY_STATUSES = frozenset({"waiting", "done", "failed"})

WAIT_MS = 30_000
RETRY_SECONDS = 3


@dataclass
class MaestroState:
    """Memória viva de uma sessão do Maestro."""

    demands_cursor: str | None = None
    # id da demanda -> último status já relatado em voz alta
    reported: dict[str, str] = field(default_factory=dict)
    last_project: str | None = None


def _descriptor_candidates(env: os._Environ[str] | dict[str, str]) -> list[Path]:
    explicit = env.get("COCKPIT_CONTROL_DESCRIPTOR")
    if explicit:
        return [Path(explicit).resolve()]
    candidates = []
    runtime_dir = env.get("XDG_RUNTIME_DIR")
    if runtime_dir:
        candidates.append(Path(runtime_dir) / "cockpit" / "control.json")
    home = env.get("HOME")
    if home:
        candidates.append(Path(home) / ".local" / "state" / "cockpit" / "control.json")
        candidates.append(Path(home) / ".config" / "cockpit" / "control.json")
    return candidates


def discover_control(env: dict[str, str] | None = None) -> tuple[str, str]:
    """Devolve (base_url, token). Levanta RuntimeError se o Cockpit não estiver de pé."""
    env = env if env is not None else os.environ
    url, token = env.get("COCKPIT_CONTROL_URL"), env.get("COCKPIT_CONTROL_TOKEN")
    if url and token:
        return url.rstrip("/"), token

    for candidate in _descriptor_candidates(env):
        try:
            descriptor = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        url, token = descriptor.get("controlUrl"), descriptor.get("token")
        if url and token:
            return str(url).rstrip("/"), str(token)
    raise RuntimeError("control.json não encontrado — o Cockpit está rodando?")


def _describe(demand: dict[str, Any]) -> str:
    project = demand.get("projectName") or demand.get("projectId") or "algum projeto"
    title = demand.get("title") or "a demanda"
    status = demand.get("status")
    if status == "waiting":
        return f'o agente de "{project}" parou esperando resposta sobre {title}'
    if status == "done":
        return f'"{project}" terminou {title}'
    reason = demand.get("error") or "sem detalhe"
    return f'"{project}" falhou em {title} ({reason})'


class DemandWatcher:
    """Long-poll em /demands que vira uma fala curta do Maestro."""

    def __init__(self, session, state: MaestroState, *, env=None) -> None:
        self.session = session
        self.state = state
        self.env = env
        self._task: asyncio.Task | None = None
        # gate: não começar a falar por cima do Fabio
        self._user_quiet = asyncio.Event()
        self._user_quiet.set()

    def on_user_state_changed(self, event) -> None:
        if getattr(event, "new_state", None) == "speaking":
            self._user_quiet.clear()
        else:
            self._user_quiet.set()

    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def aclose(self) -> None:
        if not self._task:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None

    async def _run(self) -> None:
        while True:
            try:
                base_url, token = discover_control(self.env)
                headers = {
                    "Accept": "application/json",
                    "Authorization": f"Bearer {token}",
                    "X-Cockpit-Control-Version": "1",
                }
                # o timeout cobre a espera do servidor com folga
                timeout = httpx.Timeout(WAIT_MS / 1000 + 10)
                async with httpx.AsyncClient(headers=headers, timeout=timeout) as client:
                    while True:
                        await self._poll_once(client, base_url)
            except asyncio.CancelledError:
                raise
            except Exception as error:  # Cockpit fora do ar não vira busy-loop
                logger.debug("vigia de demandas: %s", error)
                await asyncio.sleep(RETRY_SECONDS)

    async def _poll_once(self, client: httpx.AsyncClient, base_url: str) -> None:
        params: dict[str, Any] = {"wait_ms": WAIT_MS}
        if self.state.demands_cursor:
            params["after"] = self.state.demands_cursor
        response = await client.get(f"{base_url}/demands", params=params)
        if response.status_code == 410:
            # cursor de outra instância: recomeça do agora, sem histórico
            self.state.demands_cursor = None
            self.state.reported.clear()
            return
        response.raise_for_status()
        payload = response.json()
        self.state.demands_cursor = payload.get("cursor") or self.state.demands_cursor

        novidades = []
        for demand in payload.get("data", {}).get("demands", []):
            status = demand.get("status")
            demand_id = demand.get("id")
            if status not in NOTIFY_STATUSES or not demand_id:
                continue
            if self.state.reported.get(demand_id) == status:
                continue  # mesma demanda, mesmo estado: já foi dito
            self.state.reported[demand_id] = status
            novidades.append(demand)

        if not novidades:
            return
        await self._user_quiet.wait()
        resumo = "; ".join(_describe(demand) for demand in novidades[:3])
        self.session.generate_reply(
            instructions=(
                "Avise o Fabio, em uma frase curta e natural, do que mudou nas "
                f"demandas: {resumo}. Não leia logs nem caminhos."
            ),
        )
