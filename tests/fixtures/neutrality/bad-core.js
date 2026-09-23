// A non-neutral core module: it spawns a specific agent binary by name.
// The runtime-neutrality check must report the literal name it carries.
import { spawn } from "node:child_process";

export function startAgent(args) {
  return spawn("orca", args, { stdio: "inherit" });
}
