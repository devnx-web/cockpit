// O inventário do Cockpit em disco.
//
// "Que frentes existem nesta máquina, de quem é a máquina, e o que está aberto
// em cada uma agora." Escrito em arquivo, e não servido por rota autenticada,
// pelo mesmo motivo que a tela Frentes do console lê `~/.lifeai` com `fs`: a
// hora em que mais se precisa saber o que está aberto é justamente quando o
// processo não responde. Um snapshot velho se denuncia pelo `updatedAt` —
// "visto às 11:40" é informação; tela em branco não é.
//
// O `device` amarra o inventário à conta que fez o login: o Control já conhece
// este device pelo token emitido em `Cockpit - <hostname>`. Com isso o endereço
// de uma frente passa a ser `conta → device_uid → front_uid`, sem depender de
// `t2` — que é reciclado a cada reinício.
//
// Nada aqui é segredo: uid de device, uid de frente, título e status. Nenhum
// token, nenhum caminho de credencial, nenhuma saída de terminal.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FLUSH_DELAY_MS = 500;

export function defaultDevicePath(homeDir = os.homedir()) {
  return path.join(homeDir, ".cockpit", "device.json");
}

export function defaultInventoryPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".cockpit", "inventory.json");
}

/**
 * Lê a identidade da máquina. Só lê: quem a cria é o coletor de uso
 * (`lib/usage/sync.js`), e um inventário não é motivo para inventar device uid
 * — sem ele o snapshot ainda vale, só não é endereçável pela conta ainda.
 */
export function readDevice(devicePath = defaultDevicePath()) {
  try {
    const bruto = JSON.parse(fs.readFileSync(devicePath, "utf8"));
    if (bruto?.device_uid) {
      return {
        uid: String(bruto.device_uid),
        name: String(bruto.device_name || os.hostname()),
      };
    }
  } catch { /* sem device.json ainda: o Cockpit funciona igual */ }
  return { uid: null, name: os.hostname() };
}

export function createInventoryWriter({
  filePath = defaultInventoryPath(),
  devicePath = defaultDevicePath(),
  collect,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  if (typeof collect !== "function") throw new TypeError("collect é obrigatório");

  let timer = null;
  let writeQueue = Promise.resolve();
  let closed = false;
  let device = null;

  function identidade() {
    // Relido enquanto não houver uid: o device.json nasce no primeiro sync de
    // uso, que pode acontecer depois do primeiro terminal abrir.
    if (!device?.uid) device = readDevice(devicePath);
    return device;
  }

  function serialize() {
    const { uid, name } = identidade();
    return JSON.stringify(
      {
        schemaVersion: 1,
        device: { uid, name },
        updatedAt: new Date(now()).toISOString(),
        fronts: collect(),
      },
      null,
      2,
    );
  }

  function flush() {
    let body;
    try {
      body = serialize();
    } catch (error) {
      log(`[inventory] falha ao montar snapshot: ${error.message}`);
      return writeQueue;
    }
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeQueue = writeQueue
      .then(() => fs.promises.mkdir(path.dirname(filePath), { recursive: true }))
      .then(() => fs.promises.writeFile(tmp, body, { encoding: "utf8", mode: 0o600 }))
      .then(() => fs.promises.rename(tmp, filePath))
      .catch((error) => {
        log(`[inventory] falha ao salvar: ${error.message}`);
        return fs.promises.unlink(tmp).catch(() => {});
      });
    return writeQueue;
  }

  /**
   * Agenda a reescrita. Chamado a cada nascimento, morte, renome e mudança de
   * status de terminal — status muda a cada bloco de saída do agente, então o
   * debounce não é economia de estilo: sem ele o inventário viraria I/O contínuo
   * durante uma resposta longa.
   */
  function schedule() {
    if (timer || closed) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, FLUSH_DELAY_MS);
    timer?.unref?.();
  }

  async function close() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    closed = true;
    await flush();
    await writeQueue;
  }

  return { schedule, flush, close, get filePath() { return filePath; } };
}
