import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface RoleDefinition {
  name: string;
  description: string;
  instructions: string;
}

const DEFAULT_ROLES: Record<string, { description: string; instructions: string }> = {
  架构师: {
    description: "负责边界、接口、数据结构和技术选型",
    instructions:
      "先理解现有代码和约束，再给方案。优先写清接口、数据流、失败路径和权衡；不要直接大改 UI。需要落地时，把实现拆成可验证的小任务。",
  },
  前端: {
    description: "负责界面、交互和可访问性",
    instructions:
      "先读现有组件和样式，保持设计语言一致。关注加载/空/错误状态、键盘可达性和窄屏表现。改完给出截图或可复现的验证步骤。",
  },
  后端: {
    description: "负责 API、数据、任务与可靠性",
    instructions:
      "先确认接口契约和错误语义。处理并发、幂等、超时和失败恢复；不要静默吞错。改完给出调用示例和测试结果。",
  },
  测试: {
    description: "负责复现、验证和回归",
    instructions:
      "默认只读产品代码。先写清复现步骤和预期，再设计最小验证；发现缺陷时给出文件/行号、实际结果和期望结果。除非任务明确要求，不修改产品逻辑。",
  },
  文档: {
    description: "负责 README、示例和运维说明",
    instructions:
      "先跑通或读懂要写的流程，再写文档。面向第一次使用的人，命令可复制、步骤可验证；不要写无法执行的占位内容。",
  },
  执行: {
    description: "通用执行角色",
    instructions: "按任务说明完成实现，保持最小改动，完成后给出改动摘要、验证方式和剩余风险。",
  },
};

export class RoleService {
  readonly #file: string;
  #cache: Record<string, { description: string; instructions: string }> | undefined;

  constructor(file: string) {
    this.#file = file;
  }

  async list(): Promise<RoleDefinition[]> {
    const roles = await this.#load();
    return Object.entries(roles)
      .map(([name, role]) => ({ name, description: role.description, instructions: role.instructions }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }

  async get(name: string): Promise<RoleDefinition> {
    const roles = await this.#load();
    const role = roles[name] ?? roles["执行"]!;
    return { name: roles[name] === undefined ? "执行" : name, description: role.description, instructions: role.instructions };
  }

  async upsert(name: string, description: string, instructions: string): Promise<RoleDefinition> {
    const roles = await this.#load();
    roles[name] = { description, instructions };
    this.#cache = roles;
    await this.#write(roles);
    return { name, description, instructions };
  }

  async #load(): Promise<Record<string, { description: string; instructions: string }>> {
    if (this.#cache !== undefined) return this.#cache;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#file, "utf8"));
      const roles =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as { roles?: unknown }).roles
          : undefined;
      if (roles !== null && typeof roles === "object" && !Array.isArray(roles)) {
        this.#cache = { ...DEFAULT_ROLES, ...(roles as Record<string, { description: string; instructions: string }>) };
        return this.#cache;
      }
    } catch {
      // No roles file yet.
    }
    this.#cache = { ...DEFAULT_ROLES };
    return this.#cache;
  }

  async #write(roles: Record<string, { description: string; instructions: string }>): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ roles }, null, 2), { mode: 0o600 });
    await rename(temporary, this.#file);
  }
}
