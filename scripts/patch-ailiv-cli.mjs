#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { applyAilivCliBranding, hasAilivCliBranding } from "../lib/ailiv-cli-branding.js";

function resolveBinary() {
  const explicit = process.argv.find((arg) => arg.startsWith("--binary="))?.slice(9);
  const command = explicit || execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
  return fs.realpathSync(command);
}

function atomicReplace(destination, contents, mode) {
  const temporary = `${destination}.ailiv-${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { mode });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, destination);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

const binary = resolveBinary();
const backup = `${binary}.before-ailiv`;
const stat = fs.statSync(binary);
if (!stat.isFile() || stat.size < 1_000_000 || stat.size > 1_000_000_000) {
  throw new Error(`Executável inesperado; patch cancelado: ${binary}`);
}

if (process.argv.includes("--restore")) {
  if (!fs.existsSync(backup)) throw new Error(`Backup não encontrado: ${backup}`);
  atomicReplace(binary, fs.readFileSync(backup), stat.mode);
  console.log(`Identidade original restaurada em ${binary}`);
  process.exit(0);
}

const original = fs.readFileSync(binary);
const result = applyAilivCliBranding(original);
if (result.total === 0) {
  if (hasAilivCliBranding(original)) {
    console.log(`A identidade Ailiv já está aplicada em ${binary}`);
    process.exit(0);
  }
  throw new Error("Nenhuma assinatura visual conhecida foi encontrada; a versão do CLI pode ter mudado.");
}

if (!fs.existsSync(backup)) {
  fs.copyFileSync(binary, backup, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backup, stat.mode);
}
atomicReplace(binary, result.output, stat.mode);

console.log(`Identidade Ailiv aplicada em ${binary}`);
console.log(`Backup preservado em ${backup}`);
for (const replacement of result.replacements.filter(({ count }) => count > 0)) {
  console.log(`${replacement.count}x ${replacement.from} -> ${replacement.to.trimEnd()}`);
}
