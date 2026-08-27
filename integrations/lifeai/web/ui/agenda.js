// Aba Agenda — tarefas recorrentes da LifeAi: criar, pausar, retomar, disparar.
//
// É por aqui que ela deixa de ser só "quem responde quando chamam" e passa a
// fazer coisas sozinha, então cada job criado merece o mesmo cuidado de uma
// demanda nova: quem escreve o prompt está autorizando o que roda depois.

import { api, quando } from "./api.js";
import { el, limpar, par, vazio } from "./dom.js";

const EXEMPLOS = "ex.: 08:00, a cada 2h, seg 09:00, 0 9 * * 1-5";

export function montarAgenda(palco, { avisar }) {
  const painel = el("div", { class: "painel" });
  const rolagem = el("div", { class: "rolagem" });
  const lista = el("div");
  painel.append(rolagem);
  palco.append(painel);

  const campoNome = el("input", { type: "text", placeholder: "resumo diário do repositório" });
  const campoQuando = el("input", { type: "text", placeholder: EXEMPLOS });
  const campoPrompt = el("textarea", { placeholder: "o que ela deve fazer toda vez que isso disparar" });
  const campoEntrega = el("input", { type: "text", placeholder: "telegram (em branco: só registra)" });
  const botaoCriar = el("button", { class: "acao principal", texto: "agendar" });

  const formulario = el("form", { class: "formulario" }, [
    el("label", {}, ["nome", campoNome]),
    el("label", {}, ["quando", campoQuando]),
    el("label", {}, ["demanda", campoPrompt]),
    el("label", {}, ["entregar em", campoEntrega]),
    el("div", { class: "linha" }, [botaoCriar]),
  ]);

  formulario.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const nome = campoNome.value.trim();
    const agenda = campoQuando.value.trim();
    const prompt = campoPrompt.value.trim();
    if (!nome || !agenda || !prompt) {
      avisar("nome, quando e demanda são obrigatórios.");
      return;
    }
    botaoCriar.disabled = true;
    try {
      await api.post("/api/jobs", {
        name: nome,
        schedule: agenda,
        prompt,
        deliver: campoEntrega.value.trim() || undefined,
      });
      campoNome.value = "";
      campoQuando.value = "";
      campoPrompt.value = "";
      await carregar();
    } catch (error) {
      avisar(`não consegui agendar: ${error.message}`);
    } finally {
      botaoCriar.disabled = false;
    }
  });

  async function agir(rota, corpo, aviso) {
    try {
      await api.post(rota, corpo || {});
      await carregar();
    } catch (error) {
      avisar(`${aviso}: ${error.message}`);
    }
  }

  /**
   * O núcleo devolve a agenda já interpretada — `{kind:"interval", minutes:3,
   * display:"every 3m"}` — e não a string que foi digitada. Jogar isso num
   * texto dava `[object Object]`; o `display` é o campo feito para ser lido.
   */
  function agendaLegivel(schedule) {
    if (!schedule || typeof schedule === "string") return schedule;
    if (schedule.display) return schedule.display;
    if (schedule.cron) return schedule.cron;
    return JSON.stringify(schedule);
  }

  /**
   * Quanto falta para a próxima acordada. É o único sinal na tela que se move
   * sozinho: sem ele, um job que trabalha em silêncio (responde `[SILENT]`
   * porque não há o que relatar) fica visualmente idêntico a um job morto.
   */
  function faltam(iso) {
    if (!iso) return null;
    const alvo = new Date(iso).getTime();
    if (Number.isNaN(alvo)) return null;
    const segundos = Math.round((alvo - Date.now()) / 1000);
    if (segundos <= 0) return "agora";
    if (segundos < 60) return `em ${segundos}s`;
    const minutos = Math.floor(segundos / 60);
    if (minutos < 60) return `em ${minutos}m${String(segundos % 60).padStart(2, "0")}s`;
    return `em ${Math.floor(minutos / 60)}h${String(minutos % 60).padStart(2, "0")}m`;
  }

  /**
   * O núcleo distingue "rodou e não tinha o que dizer" de "rodou e falhou", mas
   * só no `last_status` — nada disso chegava aqui. Uma entrega que falha
   * (`last_delivery_error`) é o caso mais traiçoeiro: o job rodou bem, produziu
   * resposta, e ela não chegou a lugar nenhum.
   */
  function resultado(job) {
    const partes = [];
    if (job.last_status) partes.push(job.last_status);
    const feitas = job.repeat?.completed;
    if (Number.isFinite(feitas)) partes.push(`${feitas} ${feitas === 1 ? "acordada" : "acordadas"}`);
    if (job.failure_streak) partes.push(`${job.failure_streak} falha(s) seguidas`);
    return partes.join(" · ") || null;
  }

  /**
   * Quais jobs estão com as acordadas abertas. A lista se redesenha sozinha a
   * cada 10s; sem lembrar disso, o bloco se fecharia na cara de quem está
   * lendo — e ainda por cima logo depois de ter sido aberto.
   */
  const abertos = new Set();

  /** `2026-08-27_00-10-12` → `00:10:12`, que é o que interessa numa lista curta. */
  function horaDoArquivo(nome) {
    const partes = String(nome || "").split("_");
    if (partes.length !== 2) return String(nome || "");
    return partes[1].replaceAll("-", ":");
  }

  function linhaAcordada(saida) {
    const silencio = saida.silent;
    return el("div", { class: "linha-acordada" }, [
      el("div", { class: "topo-acordada" }, [
        el("span", { class: "hora", texto: horaDoArquivo(saida.run_at) }),
        el("span", {
          class: `marca${silencio ? " silencio" : ""}`,
          // "[SILENT]" é a resposta certa quando não há o que dizer: o job
          // acordou, olhou e decidiu não incomodar. Escrever isso por extenso
          // é a diferença entre "trabalhando quieto" e "morto".
          texto: silencio ? "silêncio" : "relatou",
        }),
      ]),
      silencio ? null : el("pre", {
        class: "detalhe-acordada",
        texto: saida.truncated ? `${saida.response}\n…` : saida.response,
      }),
    ]);
  }

  async function preencherAcordadas(jobId, alvo) {
    limpar(alvo).append(vazio("carregando…"));
    let dados;
    try {
      dados = await api.get(`/api/jobs/${encodeURIComponent(jobId)}/executions?limit=12`);
    } catch (error) {
      limpar(alvo).append(vazio(`não consegui ler as acordadas: ${error.message}`));
      return;
    }
    limpar(alvo);
    // Falhas vivem no ledger e podem não ter deixado saída nenhuma — mostrá-las
    // primeiro, senão uma tentativa que morreu antes de falar some da tela.
    for (const execucao of dados?.executions || []) {
      if (execucao.status === "completed") continue;
      alvo.append(el("div", { class: "linha-acordada" }, [
        el("div", { class: "topo-acordada" }, [
          el("span", { class: "hora", texto: quando(execucao.claimed_at) }),
          el("span", { class: "marca erro", texto: execucao.status }),
        ]),
        execucao.error ? el("pre", { class: "detalhe-acordada", texto: execucao.error }) : null,
      ]));
    }
    const saidas = dados?.outputs || [];
    if (!saidas.length && !(dados?.executions || []).length) {
      alvo.append(vazio("ainda não acordou nenhuma vez."));
      return;
    }
    for (const saida of saidas) alvo.append(linhaAcordada(saida));
  }

  function blocoAcordadas(job) {
    const corpo = el("div", { class: "linhas-acordadas" });
    const caixa = el("details", { class: "acordadas", open: abertos.has(job.id) }, [
      el("summary", { texto: "últimas acordadas" }),
      corpo,
    ]);
    caixa.addEventListener("toggle", () => {
      if (caixa.open) {
        abertos.add(job.id);
        preencherAcordadas(job.id, corpo);
      } else {
        abertos.delete(job.id);
      }
    });
    // Já vinha aberto de antes do redesenho: o `toggle` não dispara sozinho.
    if (caixa.open) preencherAcordadas(job.id, corpo);
    return caixa;
  }

  function ficha(job) {
    const pausada = job.state === "paused" || job.enabled === false;
    const acoes = el("div", { class: "acoes" }, [
      el("button", {
        class: "acao",
        texto: pausada ? "retomar" : "pausar",
        onClick: () => agir(
          `/api/jobs/${encodeURIComponent(job.id)}/${pausada ? "resume" : "pause"}`,
          {},
          pausada ? "não consegui retomar" : "não consegui pausar",
        ),
      }),
      el("button", {
        class: "acao",
        texto: "rodar agora",
        onClick: () => agir(`/api/jobs/${encodeURIComponent(job.id)}/run`, {}, "não consegui disparar"),
      }),
      el("button", {
        class: "acao recusa",
        texto: "apagar",
        onClick: async (clique) => {
          if (clique.target.dataset.confirma !== "sim") {
            clique.target.dataset.confirma = "sim";
            clique.target.textContent = "apagar mesmo?";
            return;
          }
          try {
            await api.del(`/api/jobs/${encodeURIComponent(job.id)}`);
            await carregar();
          } catch (error) {
            avisar(`não consegui apagar: ${error.message}`);
          }
        },
      }),
    ]);

    return el("div", { class: `ficha${pausada ? " pausada" : ""}` }, [
      el("h2", { texto: job.name || job.id }),
      el("dl", {}, [
        par("quando", agendaLegivel(job.schedule)),
        par("estado", pausada ? "pausada" : "ativa"),
        par("próxima vez", pausada
          ? "—"
          : [quando(job.next_run_at), faltam(job.next_run_at)].filter(Boolean).join("  ·  ")),
        par("última vez", quando(job.last_run_at)),
        resultado(job) ? par("resultado", resultado(job)) : null,
        job.last_error ? par("erro", job.last_error) : null,
        job.last_delivery_error ? par("entrega falhou", job.last_delivery_error) : null,
        job.deliver ? par("entrega", job.deliver) : null,
      ]),
      blocoAcordadas(job),
      job.prompt ? el("div", { class: "prompt", texto: job.prompt }) : null,
      acoes,
    ]);
  }

  async function carregar() {
    let dados;
    try {
      dados = await api.get("/api/jobs");
    } catch (error) {
      limpar(lista).append(vazio(`não consegui listar a agenda: ${error.message}`));
      return;
    }
    limpar(lista);
    const jobs = dados?.jobs || dados?.data || [];
    if (!jobs.length) {
      lista.append(vazio("nenhuma tarefa agendada — use o formulário acima."));
      return;
    }
    for (const job of jobs) lista.append(ficha(job));
  }

  rolagem.append(
    el("div", { class: "titulo-secao", texto: "Nova tarefa" }),
    formulario,
    // A aba não é mais remontada a cada visita (ui/app.js), então a lista só se
    // atualiza sozinha depois de uma ação daqui — daí o botão.
    el("div", { class: "titulo-secao" }, [
      el("span", { texto: "Agendadas  " }),
      el("button", { class: "acao", texto: "atualizar", onClick: () => carregar() }),
    ]),
    lista,
  );
  carregar();

  /**
   * A contagem regressiva só serve se andar. Refetch em vez de contar no
   * cliente porque é o mesmo pedido que traz `last_status` e `last_run_at`
   * novos: assim a acordada aparece na tela no instante em que acontece.
   *
   * Dois cuidados: nada de pedir com a aba escondida (ela fica montada em
   * memória, viva, atrás de `hidden`), e nada de redesenhar por cima de um
   * "apagar mesmo?" pendente — seria cancelar a confirmação do Fabio sozinho.
   */
  setInterval(() => {
    if (painel.offsetParent === null) return;
    if (lista.querySelector('[data-confirma="sim"]')) return;
    carregar();
  }, 10_000);
}
