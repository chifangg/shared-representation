/**
 * Shared ignore rules for reading a project folder in, used by both the
 * plain upload paths (project.tsx) and the folder-sync picker
 * (folderSync.ts). Lives in its own module so those two files do not
 * import each other: project.tsx consumes folderSync for write-back,
 * and a cycle back the other way left import bindings uninitialized at
 * module-evaluation time under Vite dev.
 */

const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  "bower_components",
  "vendor",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".parcel-cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "venv",
  ".venv",
  "env",
  ".env",
  "target",
  ".gradle",
  ".idea",
  ".vscode",
  "coverage",
  ".nyc_output",
]);

const IGNORED_FILE_NAMES = new Set([".DS_Store", "Thumbs.db"]);

const IGNORED_FILE_EXTS = [".pyc", ".pyo", ".class", ".o", ".so", ".dll"];

export function shouldIgnorePath(path: string): boolean {
  const parts = path.split("/");
  for (const part of parts) {
    if (IGNORED_DIR_NAMES.has(part)) return true;
  }
  const filename = parts[parts.length - 1] || "";
  if (IGNORED_FILE_NAMES.has(filename)) return true;
  for (const ext of IGNORED_FILE_EXTS) {
    if (filename.endsWith(ext)) return true;
  }
  return false;
}
