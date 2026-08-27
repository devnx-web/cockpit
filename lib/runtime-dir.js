import os from "os";
import path from "path";

/**
 * Diretório de runtime do usuário para uma aplicação, na cascata do XDG.
 * `app` existe porque mais de um serviço publica descriptor aqui: o Cockpit
 * (control.json dos terminais) e a LifeAi (onde o API server dela atende).
 */
export function defaultRuntimeDir(app = "cockpit") {
  const base = process.env.XDG_RUNTIME_DIR;
  if (base && path.isAbsolute(base)) return path.join(base, app);
  const stateHome = process.env.XDG_STATE_HOME;
  if (stateHome && path.isAbsolute(stateHome)) {
    return path.join(stateHome, app);
  }
  const home = os.homedir();
  if (home && path.isAbsolute(home)) {
    return path.join(home, ".local", "state", app);
  }
  const uid =
    typeof process.getuid === "function" ? process.getuid() : os.userInfo().username;
  return path.join(os.tmpdir(), `${app}-${uid}`);
}
