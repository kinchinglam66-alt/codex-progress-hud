import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/ui", { recursive: true });
await Promise.all([
  cp("src/ui/index.html", "dist/ui/index.html"),
  cp("src/ui/styles.css", "dist/ui/styles.css")
]);

