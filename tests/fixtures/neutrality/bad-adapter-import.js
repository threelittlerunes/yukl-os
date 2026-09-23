// A non-neutral core module: it imports a bundled adapter by string-literal
// path. The runtime-neutrality check must report the import.
import { createFakeRuntime } from "../adapters/fake.js";

export function make() {
  return createFakeRuntime({ script: [] });
}
