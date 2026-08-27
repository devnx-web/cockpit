// Busca determinística de projetos por nome, id, apelido, stack e descrição.
//
// Existe para o orquestrador conseguir transformar "manda pra PhD" num projeto
// concreto. Com dezenas de projetos de nome parecido, a resposta certa muitas
// vezes é "não dá pra saber" — por isso o retorno carrega `ambiguous`, e quem
// chama deve perguntar em vez de chutar.
//
// Sem I/O e sem modelo: pontuação fixa, mesmo resultado para a mesma entrada.

export const PROJECT_CATALOG_LIMITS = Object.freeze({
  descriptionMaxChars: 400,
  aliasesMaxItems: 12,
  aliasMaxChars: 40,
  stackMaxItems: 12,
  stackItemMaxChars: 40,
  defaultAgentMaxChars: 80,
});

// Campos que a interface pode gravar num projeto. A allowlist filtra a
// mudança, não o projeto: o que já existe no projects.json e não está aqui
// sobrevive a um update.
export const EDITABLE_PROJECT_FIELDS = Object.freeze([
  "id",
  "name",
  "path",
  "color",
  "icon",
  "shell",
  "group",
  "hidden",
  "commands",
  "env",
  "description",
  "aliases",
  "stack",
  "defaultAgent",
]);

// Cada sinal vale uma vez só, mesmo que case em vários lugares do campo.
export const PROJECT_SEARCH_WEIGHTS = Object.freeze({
  exactId: 100,
  exactAlias: 100,
  exactName: 90,
  allTokensInName: 70,
  someTokensInName: 25,
  aliasToken: 55,
  idToken: 45,
  stackToken: 30,
  descriptionToken: 20,
});

// Abaixo disso o melhor candidato não é confiável o bastante para agir sozinho.
const CONFIDENT_SCORE = 60;
// Se o segundo colocado chega perto assim do primeiro, os dois são plausíveis.
const RUNNER_UP_RATIO = 0.85;

export function pickProjectFields(changes) {
  if (!changes || typeof changes !== "object") return {};
  const picked = {};
  for (const field of EDITABLE_PROJECT_FIELDS) {
    if (Object.hasOwn(changes, field)) picked[field] = changes[field];
  }
  return picked;
}

function validateStringList(value, label, { maxItems, maxChars }) {
  if (!Array.isArray(value)) return `${label} deve ser uma lista`;
  if (value.length > maxItems) return `${label}: no máximo ${maxItems} itens`;
  for (const item of value) {
    if (typeof item !== "string") return `${label} deve conter apenas texto`;
    if (item.length > maxChars) return `${label}: cada item tem no máximo ${maxChars} caracteres`;
  }
  return null;
}

/** Valida os campos de catálogo quando presentes. Todos são opcionais. */
export function validateCatalogFields(project) {
  const L = PROJECT_CATALOG_LIMITS;
  if (project.description !== undefined) {
    if (typeof project.description !== "string") return "descrição deve ser texto";
    if (project.description.length > L.descriptionMaxChars) {
      return `descrição: no máximo ${L.descriptionMaxChars} caracteres`;
    }
  }
  if (project.aliases !== undefined) {
    const error = validateStringList(project.aliases, "apelidos", {
      maxItems: L.aliasesMaxItems,
      maxChars: L.aliasMaxChars,
    });
    if (error) return error;
  }
  if (project.stack !== undefined) {
    const error = validateStringList(project.stack, "stack", {
      maxItems: L.stackMaxItems,
      maxChars: L.stackItemMaxChars,
    });
    if (error) return error;
  }
  if (project.env !== undefined) {
    if (!project.env || typeof project.env !== "object" || Array.isArray(project.env)) {
      return "env deve ser um objeto CHAVE=valor";
    }
    for (const [key, value] of Object.entries(project.env)) {
      if (typeof value !== "string") return `env "${key}" deve ser texto`;
    }
  }
  if (project.defaultAgent !== undefined) {
    if (typeof project.defaultAgent !== "string") return "agente padrão deve ser texto";
    if (project.defaultAgent.length > L.defaultAgentMaxChars) {
      return `agente padrão: no máximo ${L.defaultAgentMaxChars} caracteres`;
    }
  }
  return null;
}

export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function tokenize(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.split(" ") : [];
}

// Casa por prefixo de palavra, não por substring: "financ" acha "financeiro",
// mas "ia" não acha "financeiro".
function wordsOf(value) {
  return tokenize(value);
}

function hasToken(words, token) {
  return words.some((word) => word.startsWith(token));
}

function listWords(list) {
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => wordsOf(item));
}

export function scoreProject(project, tokens, query = tokens.join(" ")) {
  if (!project?.id || tokens.length === 0) return { score: 0, matchedOn: [] };

  const W = PROJECT_SEARCH_WEIGHTS;
  const idWords = wordsOf(project.id);
  const nameWords = wordsOf(project.name);
  const aliasWords = listWords(project.aliases);
  const stackWords = listWords(project.stack);
  const descriptionWords = wordsOf(project.description);

  let score = 0;
  const matchedOn = [];
  const award = (points, label) => {
    score += points;
    matchedOn.push(label);
  };

  if (normalizeText(project.id) === query) award(W.exactId, "id");
  else if (idWords.length && tokens.some((token) => hasToken(idWords, token))) {
    award(W.idToken, "id");
  }

  const aliasesNormalized = Array.isArray(project.aliases)
    ? project.aliases.map((alias) => normalizeText(alias))
    : [];
  if (aliasesNormalized.includes(query)) award(W.exactAlias, "alias");
  else if (aliasWords.length && tokens.some((token) => hasToken(aliasWords, token))) {
    award(W.aliasToken, "alias");
  }

  if (normalizeText(project.name) === query) {
    award(W.exactName, "name");
  } else if (nameWords.length) {
    const matched = tokens.filter((token) => hasToken(nameWords, token)).length;
    if (matched === tokens.length) award(W.allTokensInName, "name");
    else if (matched > 0) award(W.someTokensInName, "name");
  }

  if (stackWords.length && tokens.some((token) => hasToken(stackWords, token))) {
    award(W.stackToken, "stack");
  }
  if (descriptionWords.length && tokens.some((token) => hasToken(descriptionWords, token))) {
    award(W.descriptionToken, "description");
  }

  return { score, matchedOn };
}

/**
 * Ranqueia projetos contra uma busca em linguagem natural.
 *
 * `ambiguous` é o sinal operacional: quando true, quem chama deve perguntar em
 * vez de escolher. Fica true se o melhor candidato é fraco, se o segundo chega
 * perto demais, ou se o vencedor não tem descrição cadastrada — sem descrição
 * não há como confirmar que é o projeto certo.
 */
export function findProjects(projects, query, { limit = 5 } = {}) {
  const normalizedQuery = normalizeText(query);
  const tokens = normalizedQuery ? normalizedQuery.split(" ") : [];
  const safeLimit = Math.max(1, Math.min(20, Number(limit) || 5));

  const candidates = (Array.isArray(projects) ? projects : [])
    .map((project) => {
      const { score, matchedOn } = scoreProject(project, tokens, normalizedQuery);
      return { project, score, matchedOn };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || String(a.project.name).localeCompare(String(b.project.name)))
    .slice(0, safeLimit);

  const [top, runnerUp] = candidates;
  const ambiguous =
    !top ||
    top.score < CONFIDENT_SCORE ||
    (!!runnerUp && runnerUp.score >= top.score * RUNNER_UP_RATIO) ||
    !String(top.project.description || "").trim();

  return { query: normalizedQuery, candidates, ambiguous };
}
