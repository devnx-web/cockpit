// Identidade do serviço da LifeAi — o que os dois lados precisam concordar.
//
// O daemon (bin/lifeaid.js) publica o descriptor; o Cockpit o lê. O nome da
// unit aparece nas mensagens do painel para o usuário saber o que ligar.

export { defaultRuntimeDir } from "./runtime-dir.js";

export const LIFEAI_SERVICE_NAME = "lifeai";
export const LIFEAI_DESCRIPTOR_VERSION = 1;
