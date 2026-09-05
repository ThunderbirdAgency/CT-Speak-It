import { readFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
const root = new URL("../", import.meta.url).pathname;
const pages = [
  "index.html",
  "account.html",
  "install.html",
  "help.html",
  "privacy.html",
  "terms.html",
  "desktop/settings.html",
  "desktop/overlay.html",
];
let links = 0;
for (const page of pages) {
  const html = await readFile(path.join(root, page), "utf8");
  assert.match(html, /<html lang="en"/);
  assert.match(html, /<title>[^<]+<\/title>/);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((x) => x[1]);
  assert.equal(ids.length, new Set(ids).size, "Duplicate IDs in " + page);
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const ref = match[1];
    if (/^(https?:|mailto:|data:)/.test(ref)) continue;
    const [file, anchor] = ref.split("#");
    let target = file
      ? file.startsWith("/")
        ? path.join(root, file)
        : path.join(root, path.dirname(page), file)
      : path.join(root, page);
    if (target === root || target === root.slice(0, -1))
      target = path.join(root, "index.html");
    if (!path.extname(target)) target += ".html";
    await access(target);
    links++;
    if (anchor && target.endsWith(".html"))
      assert.match(
        await readFile(target, "utf8"),
        new RegExp('id="' + anchor + '"'),
        "Missing anchor " + ref + " in " + page,
      );
  }
}
for (const folder of ["api", "api/_lib", "web", "desktop"])
  for (const file of await readdir(path.join(root, folder)))
    if (/\.(m?js|cjs)$/.test(file))
      execFileSync(
        process.execPath,
        ["--check", path.join(root, folder, file)],
        { stdio: "pipe" },
      );
console.log(
  `✓ ${pages.length} pages, ${links} local links/assets, unique IDs and JavaScript syntax verified.`,
);
