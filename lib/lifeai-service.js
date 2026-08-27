// Identidade do serviço da LifeAi — o que os dois lados precisam concordar.
//
// O daemon (bin/lifeaid.js) publica o descriptor; o Cockpit o lê. O nome da
// unit aparece nas mensagens do painel para o usuário saber o que ligar.

export { defaultRuntimeDir } from "./runtime-dir.js";

export const LIFEAI_SERVICE_NAME = "lifeai";
export const LIFEAI_DESCRIPTOR_VERSION = 1;

// O console web não mora mais aqui: ele é um projeto próprio (lifeai-console),
// com BFF, build e sessão próprios. O Cockpit só sabe o endereço para abrir uma
// janela nele — não serve arquivo, não faz proxy e não emite ticket.
export const LIFEAI_CONSOLE_URL_PADRAO = "http://127.0.0.1:4750";

/** Endereço do console, normalizado sem barra final. */
export function lifeaiConsoleUrl(env = process.env) {
  const bruto = String(env.LIFEAI_CONSOLE_URL || LIFEAI_CONSOLE_URL_PADRAO).trim();
  return bruto.replace(/\/+$/, "") || LIFEAI_CONSOLE_URL_PADRAO;
}
