// A neutral core module: it loads an adapter by joining a directory with a
// validated name, so no adapter path is written as a string literal and the
// file names no agent. The runtime-neutrality check must leave it alone.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function loadFrom(adaptersDir, name) {
  return import(pathToFileURL(join(adaptersDir, `${name}.js`)).href);
}
