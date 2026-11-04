import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "target",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  ".vscode",
  ".cache",
  "coverage",
  ".turbo",
  ".gradle",
  "Pods",
  ".DS_Store",
]);

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".7z",
  ".mp3",
  ".mp4",
  ".mov",
  ".wav",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".wasm",
  ".so",
  ".dylib",
  ".dll",
  ".class",
  ".jar",
  ".lock",
  ".sqlite",
  ".db",
]);

const LANGUAGES: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript React",
  ".js": "JavaScript",
  ".jsx": "JavaScript React",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".kt": "Kotlin",
  ".swift": "Swift",
  ".c": "C",
  ".h": "C",
  ".cc": "C++",
  ".cpp": "C++",
  ".hpp": "C++",
  ".cs": "C#",
  ".rb": "Ruby",
  ".php": "PHP",
  ".sh": "Shell",
  ".bash": "Shell",
  ".zsh": "Shell",
  ".sql": "SQL",
  ".md": "Markdown",
  ".mdx": "MDX",
  ".json": "JSON",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".toml": "TOML",
  ".html": "HTML",
  ".css": "CSS",
  ".scss": "SCSS",
  ".vue": "Vue",
  ".svelte": "Svelte",
};

export interface IndexedFile {
  path: string;
  size: number;
  mtime: number;
  language: string;
  summary: string;
}

export interface IndexOptions {
  maxFiles?: number;
  maxDepth?: number;
  maxFileBytes?: number;
}

export class ProjectIndexer {
  async scan(root: string, options: IndexOptions = {}): Promise<IndexedFile[]> {
    const maxFiles = options.maxFiles ?? 5000;
    const maxDepth = options.maxDepth ?? 10;
    const maxFileBytes = options.maxFileBytes ?? 1_500_000;
    const entries: IndexedFile[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (entries.length >= maxFiles || depth > maxDepth) return;
      let dirents;
      try {
        dirents = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      for (const dirent of dirents) {
        if (entries.length >= maxFiles) return;
        if (
          dirent.name.startsWith(".") &&
          dirent.name !== ".github" &&
          dirent.name !== ".env.example"
        ) {
          continue;
        }
        if (SKIP_DIRS.has(dirent.name)) continue;
        const absolute = join(dir, dirent.name);
        if (dirent.isSymbolicLink()) continue;
        if (dirent.isDirectory()) {
          await walk(absolute, depth + 1);
          continue;
        }
        if (!dirent.isFile()) continue;
        if (isSensitive(dirent.name)) continue;
        const extension = extname(dirent.name).toLowerCase();
        if (BINARY_EXTENSIONS.has(extension)) continue;
        let info;
        try {
          info = await stat(absolute);
        } catch {
          continue;
        }
        if (info.size > maxFileBytes) continue;
        const path = relative(root, absolute).split(sep).join("/");
        const language = LANGUAGES[extension] ?? "";
        let summary = "";
        if (
          info.size <= 200_000 &&
          (language === "Markdown" || language === "MDX" || language === "" || language === "TypeScript" || language === "JavaScript")
        ) {
          summary = await summarizeFile(absolute, language);
        }
        entries.push({ path, size: info.size, mtime: Math.floor(info.mtimeMs), language, summary });
      }
    };
    await walk(root, 0);
    return entries;
  }

  async readme(root: string): Promise<string> {
    for (const name of ["README.md", "README.mdx", "readme.md", "README.txt", "README"]) {
      try {
        const content = await readFile(join(root, name), "utf8");
        return content.slice(0, 8000);
      } catch {
        // try the next spelling
      }
    }
    return "";
  }

  async topLevel(root: string): Promise<string[]> {
    try {
      const dirents = await readdir(root, { withFileTypes: true });
      return dirents
        .filter((dirent) => !dirent.name.startsWith(".") && dirent.name !== "node_modules")
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .slice(0, 40)
        .map((dirent) => (dirent.isDirectory() ? `${dirent.name}/` : dirent.name));
    } catch {
      return [];
    }
  }

  async digest(projectId: string, root: string, indexedFiles: number): Promise<string> {
    const [readme, top] = await Promise.all([this.readme(root), this.topLevel(root)]);
    const readmeHead = readme
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .slice(0, 8)
      .join("\n");
    return [
      `Project: ${projectId}`,
      `Root: ${root}`,
      `Indexed files: ${indexedFiles}`,
      `Top level: ${top.join(", ")}`,
      readmeHead.length > 0 ? `README head:\n${readmeHead}` : "",
    ]
      .filter((line) => line.length > 0)
      .join("\n");
  }
}

function isSensitive(name: string): boolean {
  return (
    /^\.env($|\.)/i.test(name) ||
    /\.(pem|key|p12|pfx|keystore)$/i.test(name) ||
    /^id_(rsa|ed25519|ecdsa)$/i.test(name) ||
    /^credentials(\.json)?$/i.test(name) ||
    /^secrets?(\.|$)/i.test(name)
  );
}

async function summarizeFile(absolute: string, language: string): Promise<string> {
  let text: string;
  try {
    text = (await readFile(absolute, "utf8")).slice(0, 40_000);
  } catch {
    return "";
  }
  if (language === "Markdown" || language === "MDX") {
    const lines = text.split(/\r?\n/);
    const heading = lines.find((line) => /^#{1,3}\s+/.test(line.trim()));
    const paragraph = lines
      .filter((line) => line.trim().length > 0 && !line.trim().startsWith("#") && !line.trim().startsWith("```"))
      .slice(0, 2)
      .join(" ")
      .trim();
    return [heading?.replace(/^#+\s+/, ""), paragraph].filter(Boolean).join(" · ").slice(0, 220);
  }
  const lines = text.split(/\r?\n/);
  const comments: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      const cleaned = trimmed.replace(/^[/#*]+\s?/, "").replace(/\*\/$/, "").trim();
      if (cleaned.length > 0) comments.push(cleaned);
      if (comments.length >= 2) break;
      continue;
    }
    if (trimmed.startsWith("import ") || trimmed.startsWith("from ") || trimmed.startsWith("export ")) {
      continue;
    }
    break;
  }
  if (comments.length > 0) return comments.join(" · ").slice(0, 220);
  const firstCode = lines.find((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("import ") && !trimmed.startsWith("export {");
  });
  return firstCode?.trim().slice(0, 160) ?? "";
}
