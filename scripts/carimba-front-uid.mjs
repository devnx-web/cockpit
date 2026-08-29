#!/usr/bin/env node
//
// Carimba o `front_uid` nos arquivos da LifeAi que ainda endereçam frente pelo
// nome do terminal.
//
// Hoje o vigia casa a frente por prefixo do título (`~/.lifeai/cron/wake_map.json`)
// e o placar tem o número do terminal petrificado no nome ("Educari isolamento
// (t1)"). Os dois endereços mentem: renomear a janela faz o vigia parar de
// acordar em silêncio, e `t1` é reciclado a cada reinício do Cockpit. O endereço
// que dura é o `front_uid`.
//
// QUANDO RODAR: só depois de reiniciar o Cockpit com a versão que grava
// `~/.cockpit/fronts.json`. Antes disso os uids não existem — não há o que
// carimbar, e este script diz isso e sai.
//
// POR QUE NÃO RODA SOZINHO: ele reescreve arquivos de outro programa, que está
// no ar. Um carimbo errado é pior que carimbo nenhum — uma frente apontada para
// um uid que não existe emudece de vez, que é exatamente a falha que o uid veio
// consertar. Então o padrão é dry-run: ele mostra o que faria e para. Quem
// confere a lista decide, e só então:
//
//   node scripts/carimba-front-uid.mjs             # mostra e sai (padrão)
//   node scripts/carimba-front-uid.mjs --aplicar   # escreve, com backup ao lado

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeTitle } from "../lib/fronts.js";

const APLICAR = process.argv.includes("--aplicar");
const HOME = os.homedir();
const FRONTS_PATH = path.join(HOME, ".cockpit", "fronts.json");
const WAKE_MAP_PATH = path.join(HOME, ".lifeai", "cron", "wake_map.json");
const PLACAR_PATH = path.join(HOME, ".lifeai", "placar.json");

const alertas = [];
function alerta(msg) {
  alertas.push(msg);
  console.log(`  ! ${msg}`);
}

function leJson(filePath) {
  try {
    return { ok: true, dados: JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch (erro) {
    return { ok: false, erro };
  }
}

/**
 * Escrita atômica com backup ao lado. O original vira `.bak-front-uid` antes de
 * qualquer coisa: se o carimbo sair errado, desfazer é um `mv`.
 */
function escreve(filePath, dados) {
  const corpo = `${JSON.stringify(dados, null, 2)}\n`;
  const modo = fs.statSync(filePath).mode & 0o777;
  fs.copyFileSync(filePath, `${filePath}.bak-front-uid`);
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, corpo, { encoding: "utf8", mode: modo });
  fs.chmodSync(tmp, modo);
  fs.renameSync(tmp, filePath);
  console.log(`  gravado: ${filePath} (backup em ${path.basename(filePath)}.bak-front-uid)`);
}

// === as frentes ===========================================================

const frentesLidas = leJson(FRONTS_PATH);
if (!frentesLidas.ok) {
  const motivo = frentesLidas.erro.code === "ENOENT"
    ? `ainda não existe`
    : `ilegível (${frentesLidas.erro.message})`;
  console.log(`O registro de frentes ${motivo}: ${FRONTS_PATH}`);
  console.log("");
  console.log("Ele nasce quando o Cockpit sobe com a versão que grava fronts.json.");
  console.log("Reinicie o Cockpit, abra as frentes de sempre e rode isto de novo.");
  console.log("Nada foi alterado.");
  process.exit(0);
}

/** @type {{uid: string, projectId: string, title: string}[]} */
const FRENTES = (Array.isArray(frentesLidas.dados?.fronts) ? frentesLidas.dados.fronts : [])
  .filter((f) => f?.uid && f?.projectId)
  .map((f) => ({
    uid: String(f.uid),
    projectId: String(f.projectId),
    title: String(f.title || ""),
    norm: normalizeTitle(f.title),
  }));

console.log(`Frentes em ${FRONTS_PATH}: ${FRENTES.length}`);
for (const f of FRENTES) console.log(`  ${f.uid}  ${f.projectId} · ${f.title}`);
if (FRENTES.length === 0) {
  console.log("Nenhuma frente registrada ainda. Nada foi alterado.");
  process.exit(0);
}
console.log("");

/**
 * A mesma regra que o `cron/wake_map.py` aplica hoje: título da entrada como
 * prefixo do título da frente, normalizado (trim, espaço colapsado, minúsculas).
 * Devolve todas as candidatas — mais de uma é ambiguidade, e ambiguidade não se
 * carimba no escuro.
 */
function candidatas(projectId, titulo) {
  const alvo = normalizeTitle(titulo);
  const doProjeto = FRENTES.filter((f) => f.projectId === String(projectId));
  if (!alvo) return doProjeto;
  return doProjeto.filter((f) => f.norm.startsWith(alvo));
}

function escolhe(projectId, titulo, rotulo) {
  const achadas = candidatas(projectId, titulo);
  if (achadas.length === 1) return achadas[0];
  if (achadas.length === 0) {
    alerta(`${rotulo}: nenhuma frente casa — continuaria endereçada só pelo título`);
  } else {
    alerta(
      `${rotulo}: casa com ${achadas.length} frentes (${achadas.map((f) => f.title).join(" | ")})` +
      " — carimbar uma delas escolheria no escuro",
    );
  }
  return null;
}

// === wake_map.json ========================================================

console.log(`wake_map — ${WAKE_MAP_PATH}`);
const mapaLido = leJson(WAKE_MAP_PATH);
/** job_id → front_uid, para o placar reaproveitar o casamento */
const uidPorJob = new Map();
let mapaMudou = false;

if (!mapaLido.ok) {
  alerta(`não deu para ler: ${mapaLido.erro.message}`);
} else {
  for (const [projectId, entradas] of Object.entries(mapaLido.dados || {})) {
    if (!Array.isArray(entradas)) continue;
    for (const entrada of entradas) {
      if (!entrada || typeof entrada !== "object") continue;
      const jobId = String(entrada.job_id || "");
      const rotulo = `wake_map[${projectId}] "${entrada.terminal_title || "(sem título)"}" job ${jobId || "?"}`;
      if (entrada.front_uid) {
        console.log(`  = ${rotulo} já carimbada (${entrada.front_uid})`);
        if (jobId) uidPorJob.set(jobId, String(entrada.front_uid));
        continue;
      }
      const frente = escolhe(projectId, entrada.terminal_title, rotulo);
      if (!frente) continue;
      console.log(`  + ${rotulo}  →  ${frente.title}  →  ${frente.uid}`);
      entrada.front_uid = frente.uid;
      if (jobId) uidPorJob.set(jobId, frente.uid);
      mapaMudou = true;
    }
  }
  if (!mapaMudou) console.log("  (nada a carimbar)");
}
console.log("");

// === placar.json ==========================================================
//
// O placar não repete o título do terminal: a frente ali se chama "Educari
// isolamento (t1)" enquanto o wake_map fala em "Auditoria Educari". Quem liga
// as duas é o `job_id` — o vigia é o mesmo. Por isso a ponte principal aqui é o
// job, e o título só entra como segunda chance, para frente sem vigia.

console.log(`placar — ${PLACAR_PATH}`);
const placarLido = leJson(PLACAR_PATH);
let placarMudou = false;

if (!placarLido.ok) {
  alerta(`não deu para ler: ${placarLido.erro.message}`);
} else {
  const frentes = Array.isArray(placarLido.dados?.frentes) ? placarLido.dados.frentes : [];
  if (frentes.length === 0) alerta("nenhuma frente no placar — estrutura inesperada?");
  for (const item of frentes) {
    if (!item || typeof item !== "object") continue;
    const nome = String(item.nome || "(sem nome)");
    const jobId = String(item.job_id || "");
    const rotulo = `placar "${nome}"`;
    if (item.front_uid) {
      console.log(`  = ${rotulo} já carimbada (${item.front_uid})`);
      continue;
    }
    const porJob = jobId ? uidPorJob.get(jobId) : null;
    if (porJob) {
      console.log(`  + ${rotulo}  →  job ${jobId}  →  ${porJob}`);
      item.front_uid = porJob;
      placarMudou = true;
      continue;
    }
    // Sem vigia (ou vigia fora do wake_map): resta o nome, que no placar carrega
    // o "(t1)" petrificado e por isso raramente casa.
    const projetos = new Set(FRENTES.map((f) => f.projectId));
    const achadas = [];
    for (const projectId of projetos) achadas.push(...candidatas(projectId, nome));
    if (achadas.length === 1) {
      console.log(`  + ${rotulo}  →  ${achadas[0].title}  →  ${achadas[0].uid}`);
      item.front_uid = achadas[0].uid;
      placarMudou = true;
    } else if (jobId) {
      alerta(`${rotulo}: job ${jobId} não está no wake_map e o nome não casa com nenhuma frente`);
    } else {
      alerta(`${rotulo}: sem job_id e o nome não casa com nenhuma frente — segue sem uid`);
    }
  }
  if (!placarMudou) console.log("  (nada a carimbar)");
}
console.log("");

// === fecho ================================================================

// Frente registrada no Cockpit que ninguém do lado da LifeAi endereça: pode ser
// janela nova, pode ser vigia que ficou para trás. É informação, não erro.
const carimbadas = new Set([
  ...uidPorJob.values(),
  ...(Array.isArray(placarLido.dados?.frentes) ? placarLido.dados.frentes : [])
    .map((f) => f?.front_uid).filter(Boolean).map(String),
]);
for (const f of FRENTES) {
  if (!carimbadas.has(f.uid)) {
    console.log(`  ~ frente "${f.title}" (${f.uid}) não é referida por nenhuma entrada da LifeAi`);
  }
}

if (alertas.length) {
  console.log("");
  console.log(`${alertas.length} entrada(s) sem carimbo — reveja antes de aplicar:`);
  for (const a of alertas) console.log(`  ! ${a}`);
}

console.log("");
if (!mapaMudou && !placarMudou) {
  console.log("Nada mudaria. Nada foi alterado.");
  process.exit(0);
}

if (!APLICAR) {
  console.log("Isto foi um ensaio (dry-run). Nada foi alterado.");
  console.log("Confira a lista acima e, se estiver certa, rode com --aplicar.");
  process.exit(0);
}

console.log("Aplicando:");
if (mapaMudou) escreve(WAKE_MAP_PATH, mapaLido.dados);
if (placarMudou) escreve(PLACAR_PATH, placarLido.dados);
console.log("Pronto. Reinicie o vigia da LifeAi para ele reler os arquivos.");
