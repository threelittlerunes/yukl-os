import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchCommand, isCommandName } from "../scripts/yukl.js";
import { validatePlugins } from "../scripts/validate-config.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yukl-seams-"));
  try {
    return await fn(dir);
  } finally {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch (err) {
        if (err.code !== "EPERM" && err.code !== "EBUSY") throw err;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      }
    }
  }
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, ["scripts/yukl.js", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function hasStackTrace(stderr) {
  return /\n\s+at [^\n]+:\d+:\d+/.test(stderr);
}

// ---------------------------------------------------------------------------
// command-name seam
// ---------------------------------------------------------------------------

test("isCommandName accepts lower-case slug names", () => {
  assert.equal(isCommandName("nosuch"), true);
  assert.equal(isCommandName("my-command"), true);
});

test("isCommandName refuses paths, capitals and empty names", () => {
  for (const bad of ["../x", "Upper", "a/b", "nosuch!", "1x", "-x", ""]) {
    assert.equal(isCommandName(bad), false, `${bad} must not be a command name`);
  }
});

test("CLI exits 2 with an unknown-command message for a missing command module", () => {
  const result = runCli(["nosuch"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command "nosuch"/);
  assert.equal(result.stdout, "");
  assert.ok(!hasStackTrace(result.stderr), "an unknown command must not print a stack trace");
});

for (const bad of ["../x", "Upper", "a/b"]) {
  test(`CLI refuses "${bad}" with an unknown-command message and exit 2`, () => {
    const result = runCli([bad]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown command/);
    assert.ok(!hasStackTrace(result.stderr), "a refused command must not print a stack trace");
  });
}

// ---------------------------------------------------------------------------
// built-in control
// ---------------------------------------------------------------------------

test("built-in commands still go through parseArgs and are never dispatched as plugins", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(
      join(dir, "render.js"),
      'export function run() {\n  throw new Error("plugin render ran");\n}\n',
    );
    const result = runCli(["render"], { YUKL_COMMANDS_DIR: dir });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /render requires exactly one stage id/);
    assert.ok(!result.stderr.includes("plugin render ran"));
  });
});

// ---------------------------------------------------------------------------
// external command dispatch
// ---------------------------------------------------------------------------

test("CLI dispatches an external command module from YUKL_COMMANDS_DIR", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(
      join(dir, "hello.js"),
      'export async function run(argv) {\n  console.log(`hello ${argv.join(",")}`);\n  return 0;\n}\n',
    );
    const result = runCli(["hello", "a", "b"], { YUKL_COMMANDS_DIR: dir });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "hello a,b");
  });
});

test("CLI uses a command module's numeric return value as the exit code", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "three.js"), "export function run() {\n  return 3;\n}\n");
    const result = runCli(["three"], { YUKL_COMMANDS_DIR: dir });
    assert.equal(result.status, 3);
  });
});

test("a command module that throws exits non-zero without a stack trace", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(
      join(dir, "boom.js"),
      'export function run() {\n  throw new Error("kaboom");\n}\n',
    );
    const result = runCli(["boom"], { YUKL_COMMANDS_DIR: dir });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /command "boom" failed: kaboom/);
    assert.ok(!hasStackTrace(result.stderr), "a thrown command must not print a stack trace");
  });
});

test("dispatchCommand resolves commands from the injected commands directory", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "quiet.js"), "export function run(argv) {\n  return argv.length;\n}\n");
    const code = await dispatchCommand("quiet", ["x", "y"], { commandsDir: dir });
    assert.equal(code, 2);
  });
});

// ---------------------------------------------------------------------------
// validator plugins
// ---------------------------------------------------------------------------

test("validatePlugins returns no errors for a missing validators directory", async () => {
  await withTempDir(async (dir) => {
    const { ok, errors } = await validatePlugins({ validatorsDir: join(dir, "absent") });
    assert.equal(ok, true);
    assert.deepEqual(errors, []);
  });
});

test("validatePlugins ignores a .gitkeep in an otherwise empty validators directory", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, ".gitkeep"), "");
    const { ok, errors } = await validatePlugins({ validatorsDir: dir });
    assert.equal(ok, true);
    assert.deepEqual(errors, []);
  });
});

test("validatePlugins surfaces a validator's errors with the plugin prefix", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(
      join(dir, "demo.js"),
      'export const name = "demo";\nexport function validate(root) {\n  return { errors: [`boom at ${root}`] };\n}\n',
    );
    const { ok, errors } = await validatePlugins({ validatorsDir: dir });
    assert.equal(ok, false);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^\[plugin:demo\] /);
    assert.match(errors[0], /boom at /);
  });
});

test("validatePlugins reports a module missing a name export as an error", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(
      join(dir, "nameless.js"),
      "export function validate() {\n  return { errors: [] };\n}\n",
    );
    const { ok, errors } = await validatePlugins({ validatorsDir: dir });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => /missing a "name" export/.test(e)));
  });
});

test("validatePlugins reports a module missing a validate export as an error", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "invalid.js"), 'export const name = "invalid";\n');
    const { ok, errors } = await validatePlugins({ validatorsDir: dir });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => /^\[plugin:invalid\] .*missing a "validate" export/.test(e)));
  });
});
