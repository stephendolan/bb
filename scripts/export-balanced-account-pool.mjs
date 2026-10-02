import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { forkPluginPackageJson, forkPluginTsconfig, registryAliasImports, registryItemsForImports, registryPackages } from "./lib/plugin-fork.mjs";
import { SHIMMED_TYPE_PACKAGES } from "../packages/plugin-build/src/runtime-shims.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "plugins/account-pool");
const sdkVersion = process.argv[2] ?? "0.5.29";
const target = join(root, "exported/account-pool-balanced");
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true, filter: (path) => !path.split("/").some((part) => ["node_modules", "dist", ".bundled-runtime", "tsconfig.deploy.json"].includes(part)) });
async function files(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (["node_modules", "dist"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (/\.(tsx?|mts|cts)$/.test(entry.name)) result.push(path);
  }
  return result;
}
const imports = new Set();
for (const path of await files(target)) for (const specifier of registryAliasImports(await readFile(path, "utf8"))) imports.add(specifier);
const registryDir = join(root, "packages/plugin-registry/r");
const registry = await Promise.all((await readdir(registryDir)).filter((name) => name.endsWith(".json") && name !== "index.json").map(async (name) => JSON.parse(await readFile(join(registryDir, name), "utf8"))));
const items = registryItemsForImports(imports, registry);
for (const item of items) for (const file of item.files) {
  const path = join(target, file.target);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, file.content);
}
const app = JSON.parse(await readFile(join(root, "apps/app/package.json"), "utf8"));
const registryManifest = JSON.parse(await readFile(join(root, "packages/plugin-registry/package.json"), "utf8"));
const dependencies = registryPackages(items, { shimmedPackages: new Set(SHIMMED_TYPE_PACKAGES), versions: { ...registryManifest.devDependencies, ...app.devDependencies, ...app.dependencies } });
const original = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
const { manifest } = forkPluginPackageJson(original, { sdkSpecifier: sdkVersion, workspaceBinsByPackage: new Map([["@bb/plugin-build", ["bb-plugin-build"]]]), registryDependencies: dependencies });
manifest.name = "bb-plugin-account-pool-balanced";
manifest.version = "0.1.0";
manifest.bb.name = "Balanced Account Pooler";
manifest.bb.description = "Balance new Claude and Codex conversations by account usage, with durable per-conversation account assignments.";
manifest.description = manifest.bb.description;
manifest.repository = { type: "git", url: "https://github.com/stephendolan/bb.git", directory: "exported/account-pool-balanced" };
manifest.scripts.build = "bb plugin build .";
manifest.engines.bbPluginSdk = ">=0.5.29";
manifest.devDependencies.oxlint = "^1.0.0";
await writeFile(join(target, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
const tsconfig = forkPluginTsconfig(JSON.parse(await readFile(join(source, "tsconfig.json"), "utf8")));
await writeFile(join(target, "tsconfig.json"), JSON.stringify(tsconfig, null, 2) + "\n");
await writeFile(join(target, ".gitignore"), "node_modules/\n");
console.log(`Exported ${items.length} registry components to ${target}`);

const routingGuide = join(target, "skills/account-pool/references/accounts-and-routing.md");
await writeFile(routingGuide, (await readFile(routingGuide, "utf8")).replace("bb plugin enable account-pool", "bb plugin enable account-pool-balanced"));
const hover = join(target, "components/ui/menu-item-hover.tsx");
await writeFile(hover, (await readFile(hover, "utf8")).replace("  handlersRef.current = handlers;", "  React.useLayoutEffect(() => {\n    handlersRef.current = handlers;\n  }, [handlers]);"));
