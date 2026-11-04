import { Resvg } from "@resvg/resvg-js";
import pngToIco from "png-to-ico";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const icon = await readFile(join(here, "icon.svg"), "utf8");
const mark = await readFile(join(here, "mark.svg"), "utf8");
const tray = await readFile(join(here, "trayTemplate.svg"), "utf8");

function render(svg, size) {
  return new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    background: "transparent",
  })
    .render()
    .asPng();
}

const appSizes = [16, 32, 64, 128, 256, 512, 1024];
const appImages = new Map();
for (const size of appSizes) appImages.set(size, render(icon, size));
await writeFile(join(here, "icon.png"), appImages.get(1024));
await writeFile(join(here, "icon-512.png"), appImages.get(512));
await writeFile(join(here, "icon-256.png"), appImages.get(256));
await writeFile(join(here, "icon.ico"), await pngToIco([16, 32, 48, 64, 128, 256].map((size) => render(icon, size))));

await writeFile(join(here, "trayTemplate.png"), render(tray, 32));
await writeFile(join(here, "trayTemplate@2x.png"), render(tray, 64));
await writeFile(join(here, "trayTemplate@3x.png"), render(tray, 96));
await writeFile(join(here, "mark.png"), render(mark, 256));

console.log("icons written");
