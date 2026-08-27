// Construção de elementos sem innerHTML.
//
// Tudo que aparece nesta interface vem de um agente que lê e-mail, terminal,
// repositório e Telegram. Texto de processo é dado, nunca marcação: por isso o
// conteúdo entra sempre por textContent.

export function el(tag, atributos = {}, filhos = []) {
  const node = document.createElement(tag);
  for (const [chave, valor] of Object.entries(atributos)) {
    if (valor === null || valor === undefined || valor === false) continue;
    if (chave === "class") node.className = valor;
    else if (chave === "texto") node.textContent = String(valor);
    else if (chave.startsWith("on") && typeof valor === "function") {
      node.addEventListener(chave.slice(2).toLowerCase(), valor);
    } else node.setAttribute(chave, valor === true ? "" : String(valor));
  }
  for (const filho of [].concat(filhos)) {
    if (filho === null || filho === undefined || filho === false) continue;
    node.append(typeof filho === "string" ? document.createTextNode(filho) : filho);
  }
  return node;
}

export function limpar(node) {
  node.replaceChildren();
  return node;
}

/** Par rótulo/valor das fichas. */
export function par(rotulo, valor) {
  return el("div", { class: "par" }, [
    el("dt", { texto: rotulo }),
    el("dd", { texto: valor === null || valor === undefined || valor === "" ? "—" : String(valor) }),
  ]);
}

export function vazio(texto) {
  return el("p", { class: "vazio", texto });
}
