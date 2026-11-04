import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillInfo } from "@yuanfang/shared";

export interface SkillDocument extends SkillInfo {
  content: string;
}

interface SkillFrontmatter {
  name: string;
  description: string;
  body: string;
}

function parseFrontmatter(raw: string): SkillFrontmatter {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { name: "", description: "", body: normalized };
  }
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return { name: "", description: "", body: normalized };
  const header = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n+/, "");
  const fields: Record<string, string> = {};
  for (const line of header.split("\n")) {
    const match = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      fields[match[1].toLowerCase()] = match[2].replace(/^["']|["']$/g, "");
    }
  }
  return { name: fields.name ?? "", description: fields.description ?? "", body };
}

function renderFrontmatter(name: string, description: string, body: string): string {
  const safeDescription = description.replace(/\n/g, " ").trim();
  return `---\nname: ${name}\ndescription: ${safeDescription}\n---\n\n${body.trim()}\n`;
}

export class SkillService {
  readonly #globalDir: string;

  constructor(globalDir: string) {
    this.#globalDir = globalDir;
  }

  async list(projectId?: string | null, projectPath?: string | null): Promise<SkillInfo[]> {
    const results: SkillInfo[] = [];
    await this.#collect(this.#globalDir, "global", null, results);
    if (projectId !== undefined && projectId !== null && projectPath !== undefined && projectPath !== null) {
      await this.#collect(join(projectPath, ".yuanfang", "skills"), "project", projectId, results);
    }
    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(name: string, projectPath?: string | null): Promise<SkillDocument | undefined> {
    const candidates: Array<{ dir: string; scope: "global" | "project"; projectId: string | null }> = [
      { dir: this.#globalDir, scope: "global", projectId: null },
    ];
    if (projectPath !== undefined && projectPath !== null) {
      candidates.push({ dir: join(projectPath, ".yuanfang", "skills"), scope: "project", projectId: null });
    }
    for (const candidate of candidates) {
      const directory = join(candidate.dir, sanitizeName(name));
      try {
        const raw = await readFile(join(directory, "SKILL.md"), "utf8");
        const info = await stat(join(directory, "SKILL.md"));
        const parsed = parseFrontmatter(raw);
        return {
          name: parsed.name.length > 0 ? parsed.name : name,
          description: parsed.description,
          path: join(directory, "SKILL.md"),
          scope: candidate.scope,
          projectId: candidate.projectId,
          updatedAt: Math.floor(info.mtimeMs),
          content: parsed.body,
        };
      } catch {
        // try next scope
      }
    }
    return undefined;
  }

  async write(input: {
    name: string;
    description: string;
    body: string;
    scope?: "global" | "project";
    projectPath?: string | null;
  }): Promise<SkillDocument> {
    const slug = sanitizeName(input.name);
    const base =
      input.scope === "project" && input.projectPath !== undefined && input.projectPath !== null
        ? join(input.projectPath, ".yuanfang", "skills")
        : this.#globalDir;
    const directory = join(base, slug);
    await mkdir(directory, { recursive: true });
    const file = join(directory, "SKILL.md");
    await writeFile(file, renderFrontmatter(input.name, input.description, input.body), "utf8");
    const info = await stat(file);
    return {
      name: input.name,
      description: input.description,
      path: file,
      scope: input.scope ?? "global",
      projectId: null,
      updatedAt: Math.floor(info.mtimeMs),
      content: input.body,
    };
  }

  async delete(name: string, scope: "global" | "project", projectPath?: string | null): Promise<boolean> {
    const base =
      scope === "project" && projectPath !== undefined && projectPath !== null
        ? join(projectPath, ".yuanfang", "skills")
        : this.#globalDir;
    const directory = join(base, sanitizeName(name));
    try {
      const { rm } = await import("node:fs/promises");
      await rm(directory, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  async #collect(
    directory: string,
    scope: "global" | "project",
    projectId: string | null,
    output: SkillInfo[],
  ): Promise<void> {
    let dirents;
    try {
      dirents = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const file = join(directory, dirent.name, "SKILL.md");
      try {
        const raw = await readFile(file, "utf8");
        const info = await stat(file);
        const parsed = parseFrontmatter(raw);
        output.push({
          name: parsed.name.length > 0 ? parsed.name : dirent.name,
          description: parsed.description,
          path: file,
          scope,
          projectId,
          updatedAt: Math.floor(info.mtimeMs),
        });
      } catch {
        // Not a skill directory.
      }
    }
  }
}

function sanitizeName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "skill";
}
