import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface RoleDefinition {
  name: string;
  description: string;
  instructions: string;
  model: { provider: string; modelId: string } | null;
}

type StoredRole = { description: string; instructions: string; model?: { provider: string; modelId: string } | null };

const DEFAULT_ROLES: Record<string, { description: string; instructions: string; model?: { provider: string; modelId: string } | null }> = {
  产品经理: {
    description: "澄清目标、用户、范围和验收标准",
    instructions:
      "先问清要解决谁的什么问题，再写目标、非目标、用户故事和可验证的验收标准。避免直接写实现细节；发现范围膨胀时主动砍需求。",
    model: null,
  },
  UI设计师: {
    description: "负责信息架构、交互和视觉一致性",
    instructions:
      "先看现有设计语言和组件。输出页面结构、状态（加载/空/错误/成功）、关键交互和响应式策略；必要时给出可直接落地的样式建议。",
    model: null,
  },
  架构师: {
    description: "负责边界、接口、数据结构和技术选型",
    instructions:
      "先理解现有代码和约束，再给方案。优先写清接口、数据流、失败路径和权衡；不要直接大改 UI。需要落地时，把实现拆成可验证的小任务。",
    model: null,
  },
  前端: {
    description: "负责界面、交互和可访问性",
    instructions:
      "先读现有组件和样式，保持设计语言一致。关注加载/空/错误状态、键盘可达性和窄屏表现。改完给出截图或可复现的验证步骤。",
    model: null,
  },
  后端: {
    description: "负责 API、数据、任务与可靠性",
    instructions:
      "先确认接口契约和错误语义。处理并发、幂等、超时和失败恢复；不要静默吞错。改完给出调用示例和测试结果。",
    model: null,
  },
  全栈: {
    description: "端到端实现一条完整功能",
    instructions: "同时关注前端、后端和数据契约，先打通最小闭环，再补边界与错误状态；避免只改一半。",
    model: null,
  },
  测试: {
    description: "负责复现、验证和回归",
    instructions:
      "默认只读产品代码。先写清复现步骤和预期，再设计最小验证；发现缺陷时给出文件/行号、实际结果和期望结果。除非任务明确要求，不修改产品逻辑。",
    model: null,
  },
  代码审查: {
    description: "审查改动、风险和可维护性",
    instructions:
      "以审查者视角阅读 diff，优先找正确性、并发、错误处理、兼容性和测试缺口。按严重程度列出问题，给出文件/行号和具体修改建议。",
    model: null,
  },
  安全审计: {
    description: "检查权限、注入、密钥和攻击面",
    instructions:
      "检查输入边界、鉴权、权限提升、命令注入、路径穿越、密钥泄露和依赖风险。给出可复现的攻击路径和修复优先级。",
    model: null,
  },
  合规审查: {
    description: "检查隐私、数据、许可证与上线合规风险",
    instructions:
      "你负责合规与隐私审查，不替代律师给出法律结论。先明确适用场景、用户地域、数据流和第三方依赖，再逐项检查：数据最小化与目的限制、用户同意与隐私政策、敏感数据与跨境传输、账号与权限、日志留存、内容安全、开源许可证与第三方素材授权、广告/支付/未成年人和行业监管要求。对每个问题给出：严重级别、证据（文件/行号/配置/请求链路）、可能后果、可执行的修复建议和需要人工确认的事项。区分『硬性违规』与『风险提示』，不要用模糊的合规口号代替具体证据；发现不确定的法律结论时标记为『需法务确认』。除非任务明确要求，不修改产品代码。",
    model: null,
  },
  DevOps: {
    description: "负责构建、部署、CI 和可观测性",
    instructions:
      "先确认环境、构建命令和回滚方式。改动保持可重复、可验证；优先加健康检查、日志和失败恢复，不要引入不可逆操作。",
    model: null,
  },
  文档: {
    description: "负责 README、示例和运维说明",
    instructions:
      "先跑通或读懂要写的流程，再写文档。面向第一次使用的人，命令可复制、步骤可验证；不要写无法执行的占位内容。",
    model: null,
  },
  执行: {
    description: "通用执行角色",
    instructions: "按任务说明完成实现，保持最小改动，完成后给出改动摘要、验证方式和剩余风险。",
    model: null,
  },
};

export class RoleService {
  readonly #file: string;
  #cache: Record<string, StoredRole> | undefined;

  constructor(file: string) {
    this.#file = file;
  }

  async list(): Promise<RoleDefinition[]> {
    const roles = await this.#load();
    return Object.entries(roles)
      .map(([name, role]) => ({
        name,
        description: role.description,
        instructions: role.instructions,
        model: role.model ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }

  async get(name: string): Promise<RoleDefinition> {
    const roles = await this.#load();
    const role = roles[name] ?? roles["执行"]!;
    return {
      name: roles[name] === undefined ? "执行" : name,
      description: role.description,
      instructions: role.instructions,
      model: role.model ?? null,
    };
  }

  async upsert(
    name: string,
    description: string,
    instructions: string,
    model?: { provider: string; modelId: string } | null,
  ): Promise<RoleDefinition> {
    const roles = await this.#load();
    roles[name] = {
      description,
      instructions,
      model: model === undefined ? (roles[name]?.model ?? null) : model,
    };
    this.#cache = roles;
    await this.#write(roles);
    return { name, description, instructions, model: roles[name]!.model ?? null };
  }

  async #load(): Promise<Record<string, StoredRole>> {
    if (this.#cache !== undefined) return this.#cache;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#file, "utf8"));
      const roles =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as { roles?: unknown }).roles
          : undefined;
      if (roles !== null && typeof roles === "object" && !Array.isArray(roles)) {
        this.#cache = { ...DEFAULT_ROLES, ...(roles as Record<string, StoredRole>) };
        return this.#cache;
      }
    } catch {
      // No roles file yet.
    }
    this.#cache = { ...DEFAULT_ROLES };
    return this.#cache;
  }

  async #write(roles: Record<string, StoredRole>): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ roles }, null, 2), { mode: 0o600 });
    await rename(temporary, this.#file);
  }
}
