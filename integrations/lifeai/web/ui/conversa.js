// Aba Conversa — falar com a LifeAi e resolver as aprovações que ela pedir.
//
// Cada conversa tem a **sua** rolagem e o **seu** run. Antes havia uma rolagem
// só para todas: um run disparado na conversa A escrevia "na rolagem atual", e
// se você tivesse trocado para B nesse meio-tempo, a resposta de A brotava
// dentro de B. Agora o callback do stream fecha sobre o chat dono do run, então
// para onde você olha não muda para onde a resposta vai.

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

  const nomeConversa = el("span", { class: "nome", texto: "nenhuma conversa" });
  const botaoRenomear = el("button", { class: "acao", texto: "renomear", disabled: true });
  const cabecalho = el("div", { class: "cabecalho-conversa" }, [nomeConversa, botaoRenomear]);

  const campo = el("textarea", {
    rows: "1",
    placeholder: "o que você precisa? (Enter manda, Shift+Enter quebra linha)",
  });
  // Símbolo em vez de palavra: o botão é redondo e do tamanho de uma linha, e
  // "mandar" não caberia. O `title`/`aria-label` continuam dizendo o que é —
  // para quem passa o mouse e para quem usa leitor de tela.
  const botaoMandar = el("button", {
    class: "acao principal",
    texto: "➤",
    title: "mandar",
    "aria-label": "mandar",
  });
  const blocoEscrita = el("div", { class: "escrita" }, [campo, botaoMandar]);

  coluna.append(
    el("div", { class: "titulo-secao", texto: "Conversas" }),
    el("div", { style: "padding:0 12px 8px" }, [
      el("button", { class: "acao", texto: "nova conversa", onClick: () => escolher(novaSessao(), true) }),
    ]),
    listaSessoes,
  );
  const painel = el("div", { class: "painel" }, [cabecalho, blocoEscrita]);
  palco.append(coluna, painel);

  /** Cartaz de boas-vindas: some quando a primeira conversa é escolhida. */
  const cartazInicial = el("div", { class: "rolagem" }, [
    vazio("escolha uma conversa à esquerda ou comece uma nova."),
  ]);

  /** id da sessão → { id, rolagem, rodando, carregado, sujo, rascunho } */
  const chats = new Map();
  /** id → { title, preview } como o núcleo devolveu, para rótulo e renomeio. */
  const conhecidas = new Map();
  let sessaoAtual = null;

  function chatDe(id) {
    const existente = chats.get(id);
    if (existente) return existente;
    // Quem chama já apontou `sessaoAtual` para a conversa que vai ficar à vista.
    const rolagem = el("div", { class: "rolagem", hidden: id !== sessaoAtual });
    cartazInicial.hidden = true;
    painel.insertBefore(rolagem, blocoEscrita);
    const chat = {
      id, rolagem, rodando: null, carregado: false, sujo: false, rascunho: "", cartaz: null,
      fluxo: criarFluxo(rolagem),
    };
    chats.set(id, chat);
    return chat;
  }

  function aoFim(chat) {
    chat.rolagem.scrollTop = chat.rolagem.scrollHeight;
  }

  /** `08:42`, no fuso de quem está lendo. Sem `instante`, é agora. */
  function horaCurta(instante) {
    const data = instante ? new Date(Number(instante) * 1000) : new Date();
    if (Number.isNaN(data.getTime())) return "";
    return data.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  /** Chave de dia, para saber quando entra um separador de data. */
  function diaDe(instante) {
    const data = instante ? new Date(Number(instante) * 1000) : new Date();
    return Number.isNaN(data.getTime()) ? "" : data.toDateString();
  }

  function rotuloDia(instante) {
    const data = instante ? new Date(Number(instante) * 1000) : new Date();
    const hoje = new Date();
    const ontem = new Date(hoje.getTime() - 86_400_000);
    if (data.toDateString() === hoje.toDateString()) return "hoje";
    if (data.toDateString() === ontem.toDateString()) return "ontem";
    return data.toLocaleDateString("pt-BR", { day: "2-digit", month: "long" });
  }

  /**
   * Uma bolha. O horário mora *dentro* dela, embaixo à direita, como em
   * qualquer aplicativo de conversa: encostado no texto ele pertence àquela
   * fala, e não vira uma terceira coluna de metadado atravessando a tela.
   *
   * O texto fica num `<span>` próprio de propósito. Os deltas do run chegam com
   * `+=` no nó devolvido daqui — se isso fosse a bolha inteira, cada letra nova
   * apagaria o horário junto.
   */
  function falaEm(container, classe, quem, texto = "", instante) {
    const alvo = el("span", { class: "texto", texto });
    container.append(el("div", { class: `fala ${classe}` }, [
      el("div", { class: "corpo" }, [
        // Só o erro se identifica: nas outras, o lado da bolha já diz quem
        // falou, e repetir "você"/"LifeAi" a cada linha é o ruído que fazia
        // isto parecer log em vez de conversa.
        classe === "falhou" ? el("span", { class: "quem", texto: quem }) : null,
        alvo,
        el("span", { class: "hora", texto: horaCurta(instante) }),
      ]),
    ]));
    return alvo;
  }

  /** Saída de ferramenta é dado de processo e pode vir enorme; só a ponta. */
  const LIMITE_DETALHE = 2000;

  function recortar(texto) {
    const limpo = String(texto ?? "");
    return limpo.length > LIMITE_DETALHE ? `${limpo.slice(0, LIMITE_DETALHE)}\n…` : limpo;
  }

  /**
   * A primeira frase do pensamento, para o rótulo do bloco fechado. Sem isso o
   * resumo seria só "pensou", que não diz se ela está escolhendo a ferramenta
   * certa ou dando voltas — e é justamente isso que se quer saber sem abrir.
   */
  function resumoCurto(texto) {
    const frase = String(texto).replace(/\s+/g, " ").trim();
    const corte = frase.search(/[.!?]\s/);
    const inicio = corte > 20 ? frase.slice(0, corte + 1) : frase;
    return inicio.length > 90 ? `${inicio.slice(0, 90)}…` : inicio;
  }

  /**
   * Escreve numa rolagem — ou num fragmento, quando é histórico — cuidando de
   * duas coisas que a conversa tinha errado:
   *
   * **Ordem.** A bolha da LifeAi era criada no primeiro delta e reaproveitada
   * até o fim do run. Tudo que ela dizia *depois* de chamar uma ferramenta
   * voltava para dentro daquela primeira bolha, então a tela mostrava o texto
   * inteiro primeiro e a pilha de ferramentas embaixo — o inverso do que
   * aconteceu. Aqui uma ferramenta encerra a bolha corrente, e o texto seguinte
   * abre outra abaixo dela.
   *
   * **Ruído.** Chamadas seguidas caem num mesmo `<details>` fechado. O resumo
   * diz quantas foram e como terminaram; o detalhe fica a um clique.
   */
  function criarFluxo(container) {
    let grupo = null;

    function abrirGrupo() {
      if (grupo) return grupo;
      const linhas = el("div", { class: "linhas" });
      const rotulo = el("span", { class: "rotulo" });
      container.append(el("details", { class: "ferramentas" }, [
        el("summary", {}, [rotulo]),
        linhas,
      ]));
      grupo = { linhas, rotulo, itens: [] };
      return grupo;
    }

    function resumir() {
      if (!grupo) return;
      const total = grupo.itens.length;
      const rodando = grupo.itens.find((item) => item.pendente);
      if (rodando) {
        grupo.rotulo.textContent = total > 1
          ? `${total} ferramentas · executando ${rodando.nome}…`
          : `executando ${rodando.nome}…`;
        return;
      }
      const falhas = grupo.itens.filter((item) => item.falhou).length;
      // Nomes distintos: a LifeAi repete a mesma ferramenta muitas vezes por
      // turno, e "tool_describe, tool_describe, tool_describe" não informa nada.
      const nomes = [...new Set(grupo.itens.map((item) => item.nome))];
      const amostra = nomes.slice(0, 3).join(", ") + (nomes.length > 3 ? ", …" : "");
      grupo.rotulo.textContent =
        `${total} ${total === 1 ? "ferramenta" : "ferramentas"}` +
        (falhas ? ` · ${falhas} com erro` : "") +
        (amostra ? ` · ${amostra}` : "");
    }

    function linhaFerramenta(nome, detalhe, estado) {
      return el("div", { class: "linha-tool" }, [
        el("div", { class: "topo-tool" }, [
          el("span", { class: "nome", texto: nome }),
          estado,
        ]),
        detalhe ? el("pre", { class: "detalhe", texto: recortar(detalhe) }) : null,
      ]);
    }

    return {
      /** Encerra o agrupamento corrente sem escrever nada. */
      fechar() {
        grupo = null;
      },
      texto(classe, quem, conteudo = "", instante) {
        grupo = null;
        return falaEm(container, classe, quem, conteudo, instante);
      },
      /** Separador de data, no meio da rolagem — "hoje", "ontem", "26 de agosto". */
      dia(instante) {
        grupo = null;
        container.append(el("div", { class: "marco-dia" }, [
          el("span", { texto: rotuloDia(instante) }),
        ]));
      },
      /** Nó solto (cartão de aprovação): também interrompe o agrupamento. */
      anexar(node) {
        grupo = null;
        container.append(node);
      },
      iniciou(nome, previa) {
        const atual = abrirGrupo();
        const estado = el("span", { class: "estado", texto: "…" });
        atual.linhas.append(linhaFerramenta(nome, previa, estado));
        atual.itens.push({ nome, estado, pendente: true, falhou: false });
        resumir();
      },
      concluiu(nome, duracao, falhou) {
        if (!grupo) return;
        // Casa pelo nome; se não achar (chamadas paralelas do mesmo turno),
        // fecha a mais antiga ainda pendente em vez de deixá-la em "…".
        const item = grupo.itens.find((x) => x.pendente && x.nome === nome)
          || grupo.itens.find((x) => x.pendente);
        if (!item) return;
        item.pendente = false;
        item.falhou = Boolean(falhou);
        item.estado.textContent = falhou ? "falhou" : `${duracao ?? 0}s`;
        if (falhou) item.estado.classList.add("erro");
        resumir();
      },
      /**
       * O raciocínio dela, recolhido. Interrompe o agrupamento de ferramentas
       * de propósito: pensamento vem *antes* de decidir a ferramenta, então
       * costurá-lo dentro do bloco anterior inverteria a ordem dos fatos.
       *
       * Fechado por padrão porque é longo e chega em blocos: quem quiser
       * conferir o caminho clica, quem só quer a resposta não perde a bolha
       * dela no meio do texto.
       */
      pensou(texto) {
        grupo = null;
        const limpo = String(texto || "").trim();
        if (!limpo) return;
        container.append(el("details", { class: "pensamento" }, [
          el("summary", {}, [
            el("span", { class: "rotulo", texto: `pensou · ${resumoCurto(limpo)}` }),
          ]),
          el("pre", { class: "detalhe", texto: limpo }),
        ]));
      },
      /** Ferramenta lida do histórico: já terminou, o que importa é a saída. */
      registrada(nome, saida) {
        const atual = abrirGrupo();
        atual.linhas.append(linhaFerramenta(nome, saida, null));
        atual.itens.push({ nome, pendente: false, falhou: false });
        resumir();
      },
    };
  }

  /**
   * "conversa nova — mande a primeira demanda." e afins. Guardamos o nó para
   * poder tirá-lo na primeira fala: limpar a rolagem inteira não serve, porque
   * numa conversa com histórico ela já tem conteúdo de verdade.
   */
  function cartaz(chat, texto) {
    chat.cartaz = vazio(texto);
    chat.rolagem.append(chat.cartaz);
  }

  function limparRolagem(chat) {
    limpar(chat.rolagem);
    chat.cartaz = null;
    chat.fluxo.fechar();
  }

  /** Tira o cartaz e marca a rolagem como escrita, antes de qualquer saída. */
  function escrever(chat) {
    if (chat.cartaz) {
      chat.cartaz.remove();
      chat.cartaz = null;
    }
    // Um histórico que chegue atrasado não pode apagar por cima do que o run
    // já imprimiu aqui.
    chat.sujo = true;
  }

  function fala(chat, classe, quem, texto = "", instante) {
    escrever(chat);
    const corpo = chat.fluxo.texto(classe, quem, texto, instante);
    aoFim(chat);
    return corpo;
  }

  /**
   * O id é gerado aqui no navegador e é ilegível (`console-mf3k2x-a9b1`). O
   * núcleo devolve `preview` junto com a sessão, então só caímos no id quando
   * a conversa ainda não existe lá — e aí "conversa nova" diz mais.
   */
  function rotuloDe(id) {
    const dados = conhecidas.get(id);
    if (dados?.title) return dados.title;
    if (dados?.preview) return dados.preview;
    return conhecidas.has(id) ? id : "conversa nova";
  }

  function marcarAtual() {
    for (const botao of listaSessoes.querySelectorAll(".item")) {
      botao.setAttribute("aria-current", botao.dataset.id === sessaoAtual ? "true" : "false");
    }
  }

  async function carregarSessoes() {
    let dados;
    try {
      // Fora as acordadas do cron: cada disparo abre uma sessão própria, então
      // um job de 2 em 2 minutos soterra as conversas de verdade — em uma noite
      // são umas 700 linhas iguais. O que elas fizeram está na Agenda, em
      // "últimas acordadas", que é o lugar onde isso se lê de fato. A exclusão
      // vai no servidor de propósito: filtrar aqui devolveria páginas curtas,
      // porque o `limit` é aplicado no SQL antes de qualquer filtro nosso.
      dados = await api.get("/api/sessions?limit=40&exclude_source=cron");
    } catch (error) {
      limpar(listaSessoes).append(vazio(`não consegui listar as conversas: ${error.message}`));
      return;
    }
    limpar(listaSessoes);
    const sessoes = dados?.data || [];
    for (const sessao of sessoes) {
      conhecidas.set(sessao.id, { title: sessao.title, preview: sessao.preview });
      listaSessoes.append(el("button", {
        class: "item",
        "data-id": sessao.id,
        onClick: () => escolher(sessao.id, false),
      }, [
        el("span", { texto: rotuloDe(sessao.id) }),
        el("span", { class: "resumo", texto: `${sessao.message_count ?? 0} msgs · ${quando(sessao.last_active)}` }),
      ]));
    }
    // Uma conversa nova só nasce no banco no primeiro run. Sem esta linha ela
    // sumiria da lista entre o clique em "nova conversa" e a primeira resposta.
    const pendente = sessaoAtual;
    if (pendente && !sessoes.some((sessao) => sessao.id === pendente)) {
      listaSessoes.prepend(el("button", {
        class: "item",
        "data-id": pendente,
        onClick: () => escolher(pendente, true),
      }, [
        el("span", { texto: rotuloDe(pendente) }),
        el("span", { class: "resumo", texto: "conversa nova — ainda não enviada" }),
      ]));
    }
    if (!listaSessoes.childNodes.length) {
      listaSessoes.append(el("div", { style: "padding:0 12px" }, [vazio("nenhuma conversa ainda.")]));
    }
    marcarAtual();
    atualizarCabecalho();
  }

  async function carregarHistorico(chat) {
    let dados;
    try {
      dados = await api.get(`/api/sessions/${encodeURIComponent(chat.id)}/messages?order=oldest`);
    } catch (error) {
      if (chat.sujo) return;
      // Conversa nova ainda não existe no banco: isso é esperado, não é falha.
      limparRolagem(chat);
      if (error.status !== 404) cartaz(chat, `não consegui ler o histórico: ${error.message}`);
      else cartaz(chat, "conversa nova — mande a primeira demanda.");
      return;
    }

    // O banco guarda em ordem de inserção (`ORDER BY id`), que é a ordem real
    // do turno: texto, ferramentas, texto de novo. Reproduzir isso é só não
    // reagrupar nada — o fluxo cuida de compactar as ferramentas vizinhas.
    const pronto = document.createDocumentFragment();
    const fluxo = criarFluxo(pronto);
    // Uma conversa longa atravessa dias. Sem o marco, a bolha das 23:58 e a das
    // 00:14 ficam coladas como se fossem o mesmo instante.
    let diaEscrito = null;
    for (const mensagem of dados?.data || []) {
      const conteudo = typeof mensagem.content === "string"
        ? mensagem.content
        : JSON.stringify(mensagem.content ?? "");
      if (mensagem.role === "tool") {
        fluxo.registrada(mensagem.tool_name || "ferramenta", conteudo);
        continue;
      }
      // Assistente sem texto é a linha que só carregava chamadas de ferramenta:
      // imprimi-la abriria uma bolha vazia no meio do bloco.
      if (!conteudo.trim()) continue;
      const instante = mensagem.timestamp;
      const dia = diaDe(instante);
      if (dia && dia !== diaEscrito) {
        fluxo.dia(instante);
        diaEscrito = dia;
      }
      if (mensagem.role === "user") fluxo.texto("de-voce", "você", conteudo, instante);
      else if (mensagem.role === "assistant") fluxo.texto("dela", "LifeAi", conteudo, instante);
      else fluxo.registrada(mensagem.tool_name || mensagem.role || "ferramenta", conteudo);
    }

    // O fetch pode ter demorado mais que o primeiro envio: se já escrevemos
    // aqui, o histórico chegou tarde e não manda mais nesta rolagem.
    if (chat.sujo) return;
    limparRolagem(chat);
    if (pronto.childNodes.length) chat.rolagem.append(pronto);
    else cartaz(chat, "conversa nova — mande a primeira demanda.");
    aoFim(chat);
  }

  function escolher(id, nova) {
    const anterior = sessaoAtual ? chats.get(sessaoAtual) : null;
    if (anterior) anterior.rascunho = campo.value;

    // O campo de renomear vale para a conversa em que foi aberto: trocar de
    // conversa com ele aberto salvaria o nome na anterior.
    fecharRenomear();

    sessaoAtual = id;
    const chat = chatDe(id);
    for (const [outro, aberto] of chats) aberto.rolagem.hidden = outro !== id;

    if (!chat.carregado) {
      chat.carregado = true;
      if (nova) cartaz(chat, "conversa nova — mande a primeira demanda.");
      else carregarHistorico(chat);
    }

    campo.value = chat.rascunho;
    ajustarAltura();
    refletir(chat);
    marcarAtual();
    atualizarCabecalho();
    carregarSessoes();
    campo.focus();
  }

  // ---- título da conversa ----

  function atualizarCabecalho() {
    nomeConversa.textContent = sessaoAtual ? rotuloDe(sessaoAtual) : "nenhuma conversa";
    botaoRenomear.disabled = !sessaoAtual;
  }

  async function renomear(id, titulo) {
    try {
      await api.patch(`/api/sessions/${encodeURIComponent(id)}`, { title: titulo });
    } catch (error) {
      // 404: a sessão só passa a existir para o núcleo depois do primeiro run.
      // 400: o núcleo exige título único na base e devolve o motivo por escrito.
      if (error.status === 404) avisar("essa conversa ainda não existe para a LifeAi — mande a primeira mensagem antes de renomear.");
      else avisar(`não consegui renomear: ${error.message}`);
      return false;
    }
    conhecidas.set(id, { ...(conhecidas.get(id) || {}), title: titulo });
    atualizarCabecalho();
    carregarSessoes();
    return true;
  }

  /** Devolve o cabeçalho ao modo leitura; inerte se ele já estiver assim. */
  function fecharRenomear() {
    if (cabecalho.contains(nomeConversa)) return;
    cabecalho.replaceChildren(nomeConversa, botaoRenomear);
  }

  function abrirRenomear() {
    if (!sessaoAtual) return;
    const id = sessaoAtual;
    const entrada = el("input", { type: "text", class: "renomear", maxlength: "120" });
    entrada.value = conhecidas.get(id)?.title || "";
    const confirmar = el("button", { class: "acao principal", texto: "salvar" });
    const cancelar = el("button", { class: "acao", texto: "cancelar" });

    function fechar() {
      fecharRenomear();
      botaoRenomear.focus();
    }
    async function salvar() {
      confirmar.disabled = true;
      const ok = await renomear(id, entrada.value.trim());
      confirmar.disabled = false;
      if (ok) fechar();
      else entrada.focus();
    }

    confirmar.addEventListener("click", salvar);
    cancelar.addEventListener("click", fechar);
    entrada.addEventListener("keydown", (evento) => {
      if (evento.key === "Enter") { evento.preventDefault(); salvar(); }
      else if (evento.key === "Escape") { evento.preventDefault(); fechar(); }
    });

    cabecalho.replaceChildren(entrada, confirmar, cancelar);
    entrada.focus();
    entrada.select();
  }

  botaoRenomear.addEventListener("click", abrirRenomear);

  // ---- envio e acompanhamento ----

  function cartaoAprovacao(chat, evento) {
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
    escrever(chat);
    chat.fluxo.anexar(cartao);
    aoFim(chat);
  }

  /** Reflete o estado de um chat na escrita — só se ele for o que está à vista. */
  function refletir(chat) {
    if (!chat || chat.id !== sessaoAtual) return;
    const ativo = Boolean(chat.rodando);
    campo.disabled = ativo;
    botaoMandar.textContent = ativo ? "■" : "➤";
    botaoMandar.title = ativo ? "parar" : "mandar";
    botaoMandar.setAttribute("aria-label", botaoMandar.title);
    botaoMandar.className = ativo ? "acao recusa" : "acao principal";
  }

  async function mandar() {
    if (!sessaoAtual) sessaoAtual = novaSessao();
    const chat = chatDe(sessaoAtual);

    if (chat.rodando) {
      // Entre o POST /v1/runs e a resposta ainda não há id para parar.
      if (!chat.rodando.runId) {
        avisar("ainda estou abrindo o run — espere um instante para poder parar.");
        return;
      }
      try {
        await api.post(`/v1/runs/${encodeURIComponent(chat.rodando.runId)}/stop`, {});
      } catch (error) {
        avisar(`não consegui parar: ${error.message}`);
      }
      return;
    }

    const texto = campo.value.trim();
    if (!texto) return;
    campo.value = "";
    chat.rascunho = "";
    campo.style.height = "auto";
    fala(chat, "de-voce", "você", texto);
    chat.rodando = { runId: null, desistir: null };
    refletir(chat);

    let runId;
    try {
      const criado = await api.post("/v1/runs", { input: texto, session_id: chat.id });
      runId = criado?.run_id;
      if (!runId) throw new Error("a LifeAi não devolveu o run");
    } catch (error) {
      chat.rodando = null;
      refletir(chat);
      fala(chat, "falhou", "erro", error.message);
      return;
    }

    // `corpo` é a bolha que está sendo escrita agora. Zerá-la a cada ferramenta
    // é o que mantém a ordem: o texto que vier depois abre bolha nova, abaixo
    // do bloco de ferramentas, em vez de ser costurado no que veio antes dele.
    let corpo = null;
    let houveDelta = false;
    const desistir = acompanhar(runId, (evento) => {
      switch (evento.event) {
        case "tool.started":
          escrever(chat);
          chat.fluxo.iniciou(String(evento.tool || "ferramenta"), evento.preview);
          corpo = null;
          aoFim(chat);
          break;
        case "tool.completed":
          chat.fluxo.concluiu(String(evento.tool || "ferramenta"), evento.duration, evento.error);
          break;
        case "message.delta":
          if (!evento.delta) break;
          if (!corpo) corpo = fala(chat, "dela", "LifeAi");
          houveDelta = true;
          // Depois de uma ferramenta o texto costuma vir precedido de linhas em
          // branco; numa bolha vazia isso vira um vão antes da primeira letra.
          corpo.textContent += corpo.textContent
            ? String(evento.delta)
            : String(evento.delta).replace(/^\s+/, "");
          aoFim(chat);
          break;
        case "reasoning.available":
          // O núcleo já mandava isto e o console jogava fora — daí a sensação
          // de que ela some entre a pergunta e a resposta. O `_thinking` (o
          // pensamento letra a letra) continua fora do stream por decisão do
          // núcleo, então o que chega aqui é o bloco fechado, depois de pronto.
          escrever(chat);
          chat.fluxo.pensou(evento.text);
          corpo = null;
          aoFim(chat);
          break;
        case "approval.request":
          cartaoAprovacao(chat, evento);
          break;
        case "run.completed":
          // O run entrega o texto em pedaços e de novo inteiro no fim; imprimir
          // os dois mostraria a resposta duplicada.
          if (!houveDelta && evento.output) fala(chat, "dela", "LifeAi", String(evento.output));
          chat.rodando = null;
          refletir(chat);
          carregarSessoes();
          break;
        case "run.failed":
        case "run.cancelled":
          fala(chat, "falhou", "erro", evento.error || evento.event);
          chat.rodando = null;
          refletir(chat);
          break;
        default:
          break;
      }
    });
    chat.rodando = { runId, desistir };
    refletir(chat);
  }

  function ajustarAltura() {
    campo.style.height = "auto";
    campo.style.height = `${Math.min(campo.scrollHeight, 180)}px`;
  }

  campo.addEventListener("input", () => {
    ajustarAltura();
    if (sessaoAtual) chatDe(sessaoAtual).rascunho = campo.value;
  });
  campo.addEventListener("keydown", (evento) => {
    if (evento.key !== "Enter" || evento.shiftKey) return;
    evento.preventDefault();
    mandar();
  });
  botaoMandar.addEventListener("click", mandar);

  painel.insertBefore(cartazInicial, blocoEscrita);
  carregarSessoes();
  campo.focus();
}
