// Gera os PNGs do app a partir de public/icon.svg
// Sai com PNGs em build/ (icon.png 512x512 + icons/SIZE.png pra electron-builder)
import sharp from "sharp";
import fs from "fs";
import path from "path";
import url from "url";

const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const SVG = path.resolve(ROOT, "..", "public", "icon.svg");
const OUT_DIR = path.resolve(ROOT, "..", "build");
const OUT_ICONS = path.join(OUT_DIR, "icons");

if (!fs.existsSync(SVG)) {
  console.error("✗ não achei public/icon.svg");
  process.exit(1);
}
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(OUT_ICONS, { recursive: true });

const svg = fs.readFileSync(SVG);
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

const tasks = SIZES.map(async (size) => {
  const dest = path.join(OUT_ICONS, `${size}x${size}.png`);
  await sharp(svg, { density: Math.max(72, size) })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(dest);
  return { size, dest };
});

const main = path.join(OUT_DIR, "icon.png");
tasks.push(
  sharp(svg, { density: 512 })
    .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(main)
);

const results = await Promise.all(tasks);
console.log(`✓ ícones gerados em ${OUT_DIR}`);
for (const r of results.slice(0, -1)) {
  console.log(`  · ${path.basename(r.dest)}`);
}
console.log(`  · icon.png (512×512 — usado pelo electron-builder)`);
