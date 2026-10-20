// Child of tests/lib/schema-compat.js: imports the given TypeScript modules of an extracted tag
// (paths relative to the tag folder) and prints, as JSON, each string export whose name ends in SQL:
// { "<file>": { "<NAME>": "<sql>" } }. A child process, so a tag's module never shares a cache or a
// crash with the test run.
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The plugin's modules import each other without a file extension; plain Node needs the ".ts".
register(
  "data:text/javascript," +
    encodeURIComponent(`export async function resolve(specifier, context, next) {
  try { return await next(specifier, context) } catch (err) {
    if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier)) return next(specifier + ".ts", context)
    throw err
  }
}`),
);

const [dir, ...files] = process.argv.slice(2);
const out = {};
for (const file of files) {
  const mod = await import(pathToFileURL(path.join(dir, file)).href);
  const found = {};
  for (const [name, value] of Object.entries(mod)) if (/SQL$/.test(name) && typeof value === "string") found[name] = value;
  out[file] = found;
}
process.stdout.write(JSON.stringify(out));
