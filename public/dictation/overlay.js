// =========================================================
// Overlay de ditado (renderer transparente, sem foco)
// Mostra o texto se formando ao vivo. Recebe estados do main via
// window.dictation.onOverlay({ state, text, detail }).
//   state: recording | transcribing | done | error | info | hide
// =========================================================
const card = document.getElementById("card");
const textEl = document.getElementById("text");

const STATES = ["recording", "transcribing", "done", "error", "info"];

function setText(t, placeholder) {
  textEl.textContent = t;
  textEl.classList.toggle("placeholder", !!placeholder);
}

function apply({ state, text, detail }) {
  if (state === "hide") {
    card.classList.remove("show");
    return;
  }
  card.classList.add("show");
  for (const s of STATES) card.classList.toggle(s, s === state);

  if (state === "recording") {
    if (text && text.trim()) setText(text, false);
    else setText("Ouvindo…", true);
  } else if (state === "transcribing") {
    setText(text && text.trim() ? text : "Transcrevendo…", !(text && text.trim()));
  } else if (state === "done") {
    setText(text || "", false);
  } else if (state === "info") {
    setText(detail || "Carregando modelo de voz…", true);
  } else if (state === "error") {
    setText(detail || "Erro no ditado", false);
  }
}

window.dictation.onOverlay(apply);
