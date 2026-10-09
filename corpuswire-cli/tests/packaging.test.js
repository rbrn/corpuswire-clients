import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("clean offline CLI installation and packing bundle the canonical local SDK", { timeout: 120_000 }, async () => {
  const cliRoot = fileURLToPath(new URL("../", import.meta.url));
  const sdkRoot = fileURLToPath(new URL("../../corpuswire-sdk/", import.meta.url));
  const root = await mkdtemp(path.join(tmpdir(), "cw-cli-clean-pack-"));
  const stage = path.join(root, "source");
  const stagedCli = path.join(stage, "corpuswire-cli");
  const stagedSdk = path.join(stage, "corpuswire-sdk");
  const extracted = path.join(root, "extracted");
  const installed = path.join(root, "installed");
  const env = { ...process.env, npm_config_cache: path.join(root, "npm-cache") };
  const npm = (args, cwd) => execFileSync("npm", args, { cwd, env, encoding: "utf8", timeout: 30_000 });
  try {
    await mkdir(stagedCli, { recursive: true });
    await mkdir(stagedSdk, { recursive: true });
    await mkdir(extracted);
    for (const file of ["package.json", "package-lock.json", "bin", "lib", "README.md"]) {
      await cp(path.join(cliRoot, file), path.join(stagedCli, file), { recursive: true });
    }
    for (const file of ["package.json", "dist", "src", "README.md", "tsconfig.json"]) {
      await cp(path.join(sdkRoot, file), path.join(stagedSdk, file), { recursive: true });
    }
    // There is no checkout node_modules or registry cache in this staging tree.
    npm(["ci", "--offline", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"], stagedCli);
    const [packed] = JSON.parse(npm(["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", root], stagedCli));
    assert.deepEqual(packed.bundled, ["@corpuswire/sdk"]);
    const tarball = path.join(root, packed.filename);
    execFileSync("tar", ["-xzf", tarball, "-C", extracted], { timeout: 30_000 });
    npm(["install", "--prefix", installed, "--offline", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", tarball], root);
    const distFiles = await readdir(path.join(sdkRoot, "dist"));
    for (const file of distFiles) {
      const canonical = await readFile(path.join(sdkRoot, "dist", file));
      assert.deepEqual(await readFile(path.join(extracted, "package/node_modules/@corpuswire/sdk/dist", file)), canonical, `tarball SDK ${file}`);
      assert.deepEqual(await readFile(path.join(installed, "node_modules/@corpuswire/cli/node_modules/@corpuswire/sdk/dist", file)), canonical, `installed SDK ${file}`);
    }
    const version = execFileSync(process.execPath, [path.join(installed, "node_modules/@corpuswire/cli/bin/corpuswire.js"), "--version"], { encoding: "utf8", timeout: 30_000 });
    assert.equal(version.trim(), JSON.parse(await readFile(path.join(cliRoot, "package.json"))).version);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
