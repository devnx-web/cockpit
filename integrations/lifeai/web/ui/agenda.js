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
        par("quando", job.schedule),
        par("estado", pausada ? "pausada" : "ativa"),
        par("próxima vez", quando(job.next_run_at)),
        par("última vez", quando(job.last_run_at)),
        job.deliver ? par("entrega", job.deliver) : null,
      ]),
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
    el("div", { class: "titulo-secao", texto: "Agendadas" }),
    lista,
  );
  carregar();
}
