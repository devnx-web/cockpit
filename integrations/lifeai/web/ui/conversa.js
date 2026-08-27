// Aba Conversa — falar com a LifeAi e resolver as aprovações que ela pedir.

import { acompanhar, api, quando } from "./api.js";
import { el, limpar, vazio } from "./dom.js";

const ESCOLHAS = [
  { valor: "once", rotulo: "permitir uma vez", classe: "acao principal" },
  { valor: "session", rotulo: "nesta conversa", classe: "acao" },
  { valor: "always", rotulo: "sempre", classe: "acao" },
  { valor: "deny", rotulo: "recusar", classe: "acao recusa" },
];

function novaSessao() {
  const marca = Math.random().toString(36).slice(2, 8);
  return `console-${Date.now().toString(36)}-${marca}`;
}

export function montarConversa(palco, { avisar }) {
  const coluna = el("aside", { class: "coluna" });
  const listaSessoes = el("div");
  const rolagem = el("div", { class: "rolagem" });
  const campo = el("textarea", {
    rows: "1",
    placeholder: "o que você precisa? (Enter manda, Shift+Enter quebra linha)",
  });
  const botaoMandar = el("button", { class: "acao principal", texto: "mandar" });

  coluna.append(
    el("div", { class: "titulo-secao", texto: "Conversas" }),
    el("div", { style: "padding:0 12px 8px" }, [
      el("button", { class: "acao", texto: "nova conversa", onClick: () => escolher(novaSessao(), true) }),
    ]),
    listaSessoes,
  );
  const painel = el("div", { class: "painel" }, [
    rolagem,
    el("div", { class: "escrita" }, [campo, botaoMandar]),
  ]);
  palco.append(coluna, painel);

  let sessaoAtual = null;
  let rodando = null;   // { runId, desistir }

  function aoFim() {
    rolagem.scrollTop = rolagem.scrollHeight;
  }

  function fala(classe, quem, texto = "") {
    const corpo = el("div", { class: "corpo", texto });
    rolagem.append(el("div", { class: `fala ${classe}` }, [
      el("div", { class: "quem", texto: quem }),
      corpo,
    ]));
    aoFim();
    return corpo;
  }

  async function carregarSessoes() {
    let dados;
    try {
      dados = await api.get("/api/sessions?limit=40");
    } catch (error) {
      limpar(listaSessoes).append(vazio(`não consegui listar as conversas: ${error.message}`));
      return;
    }
    limpar(listaSessoes);
    const sessoes = dados?.data || [];
    if (!sessoes.length) {
      listaSessoes.append(el("div", { style: "padding:0 12px" }, [vazio("nenhuma conversa ainda.")]));
      return;
    }
    for (const sessao of sessoes) {
      const botao = el("button", {
        class: "item",
        "aria-current": sessao.id === sessaoAtual ? "true" : "false",
        onClick: () => escolher(sessao.id, false),
      }, [
        el("span", { texto: sessao.title || sessao.id }),
        el("span", { class: "resumo", texto: `${sessao.message_count ?? 0} msgs · ${quando(sessao.last_active)}` }),
      ]);
      listaSessoes.append(botao);
    }
  }

  async function carregarHistorico(id) {
    limpar(rolagem);
    let dados;
    try {
      dados = await api.get(`/api/sessions/${encodeURIComponent(id)}/messages?order=oldest`);
    } catch (error) {
      // Conversa nova ainda não existe no banco: isso é esperado, não é falha.
      if (error.status !== 404) rolagem.append(vazio(`não consegui ler o histórico: ${error.message}`));
      else rolagem.append(vazio("conversa nova — mande a primeira demanda."));
      return;
    }
    const mensagens = dados?.data || [];
    if (!mensagens.length) {
      rolagem.append(vazio("conversa nova — mande a primeira demanda."));
      return;
    }
    for (const mensagem of mensagens) {
      const conteudo = typeof mensagem.content === "string"
        ? mensagem.content
        : JSON.stringify(mensagem.content ?? "");
      if (!conteudo.trim()) continue;
      if (mensagem.role === "user") fala("de-voce", "você", conteudo);
      else if (mensagem.role === "assistant") fala("dela", "LifeAi", conteudo);
      else fala("ferramenta", mensagem.tool_name || mensagem.role || "ferramenta", conteudo.slice(0, 800));
    }
    aoFim();
  }

  function escolher(id, nova) {
    sessaoAtual = id;
    for (const botao of listaSessoes.querySelectorAll(".item")) botao.setAttribute("aria-current", "false");
    if (nova) {
      limpar(rolagem).append(vazio("conversa nova — mande a primeira demanda."));
      carregarSessoes();
    } else {
      carregarHistorico(id);
      carregarSessoes();
    }
    campo.focus();
  }

  function cartaoAprovacao(evento) {
    const cartao = el("div", { class: "cartao-aprovacao" });
    const pergunta = [evento.title, evento.command, evento.description]
      .filter(Boolean).join("\n") || "a LifeAi pede permissão para seguir";
    const escolhas = el("div", { class: "escolhas" });
    for (const opcao of ESCOLHAS) {
      escolhas.append(el("button", {
        class: opcao.classe,
        texto: opcao.rotulo,
        onClick: async (clique) => {
          for (const botao of escolhas.querySelectorAll("button")) botao.disabled = true;
          try {
            await api.post(`/v1/runs/${encodeURIComponent(evento.run_id)}/approval`, { choice: opcao.valor });
            cartao.replaceChildren(el("div", { class: "pergunta", texto: `${pergunta}\n\n→ ${opcao.rotulo}` }));
          } catch (error) {
            avisar(`não consegui responder: ${error.message}`);
            for (const botao of escolhas.querySelectorAll("button")) botao.disabled = false;
            clique.target.focus();
          }
        },
      }));
    }
    cartao.append(el("div", { class: "pergunta", texto: pergunta }), escolhas);
    rolagem.append(cartao);
    aoFim();
  }

  function travar(ativo) {
    campo.disabled = ativo;
    botaoMandar.textContent = ativo ? "parar" : "mandar";
    botaoMandar.className = ativo ? "acao recusa" : "acao principal";
  }

  async function mandar() {
    if (rodando) {
      try {
        await api.post(`/v1/runs/${encodeURIComponent(rodando.runId)}/stop`, {});
      } catch (error) {
        avisar(`não consegui parar: ${error.message}`);
      }
      return;
    }
    const texto = campo.value.trim();
    if (!texto) return;
    if (!sessaoAtual) sessaoAtual = novaSessao();
    campo.value = "";
    campo.style.height = "auto";
    fala("de-voce", "você", texto);
    travar(true);

    let runId;
    try {
      const criado = await api.post("/v1/runs", { input: texto, session_id: sessaoAtual });
      runId = criado?.run_id;
      if (!runId) throw new Error("a LifeAi não devolveu o run");
    } catch (error) {
      travar(false);
      fala("falhou", "erro", error.message);
      return;
    }

    let corpo = null;
    let houveDelta = false;
    const desistir = acompanhar(runId, (evento) => {
      switch (evento.event) {
        case "tool.started":
          fala("ferramenta", "·", String(evento.tool || "ferramenta"));
          break;
        case "message.delta":
          if (!evento.delta) break;
          if (!corpo) corpo = fala("dela", "LifeAi");
          houveDelta = true;
          corpo.textContent += String(evento.delta);
          aoFim();
          break;
        case "approval.request":
          cartaoAprovacao(evento);
          break;
        case "run.completed":
          // O run entrega o texto em pedaços e de novo inteiro no fim; imprimir
          // os dois mostraria a resposta duplicada.
          if (!houveDelta && evento.output) fala("dela", "LifeAi", String(evento.output));
          rodando = null;
          travar(false);
          carregarSessoes();
          break;
        case "run.failed":
        case "run.cancelled":
          fala("falhou", "erro", evento.error || evento.event);
          rodando = null;
          travar(false);
          break;
        default:
          break;
      }
    });
    rodando = { runId, desistir };
  }

  campo.addEventListener("input", () => {
    campo.style.height = "auto";
    campo.style.height = `${Math.min(campo.scrollHeight, 180)}px`;
  });
  campo.addEventListener("keydown", (evento) => {
    if (evento.key !== "Enter" || evento.shiftKey) return;
    evento.preventDefault();
    mandar();
  });
  botaoMandar.addEventListener("click", mandar);

  limpar(rolagem).append(vazio("escolha uma conversa à esquerda ou comece uma nova."));
  carregarSessoes();
  campo.focus();
}
