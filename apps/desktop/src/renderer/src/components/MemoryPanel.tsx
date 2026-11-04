import { useEffect, useMemo, useState } from "react";
import type { MemoryEntry, MemoryKind } from "@yuanfang/shared";
import { formatRelative } from "../lib/format";

export function MemoryPanel({
  projectId,
  onClose,
}: {
  projectId: string | null;
  onClose: () => void;
}) {
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "global" | "project">(projectId === null ? "global" : "all");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<MemoryKind>("note");
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);

  const load = () => {
    void window.yuanfang.getMemories({ projectId }).then(setMemories);
  };

  useEffect(load, [projectId]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return memories.filter((memory) => {
      if (scope === "global" && memory.scope !== "global") return false;
      if (scope === "project" && memory.scope !== projectId) return false;
      if (needle.length === 0) return true;
      return (
        memory.title.toLowerCase().includes(needle) ||
        memory.body.toLowerCase().includes(needle) ||
        memory.tags.some((tag) => tag.toLowerCase().includes(needle))
      );
    });
  }, [memories, query, scope]);

  const save = async () => {
    if (title.trim().length === 0 || body.trim().length === 0) return;
    setSaving(true);
    try {
      if (editingId !== null) {
        await window.yuanfang.updateMemory({
          id: editingId,
          change: { title: title.trim(), body: body.trim(), pinned },
        });
      } else {
        await window.yuanfang.addMemory({
          scope: scope === "project" && projectId !== null ? projectId : "global",
          kind,
          title: title.trim(),
          body: body.trim(),
          pinned,
        });
      }
      setTitle("");
      setBody("");
      setPinned(false);
      setEditingId(null);
      setShowForm(false);
      load();
    } finally {
      setSaving(false);
    }
  };

  const edit = (memory: MemoryEntry) => {
    setEditingId(memory.id);
    setTitle(memory.title);
    setBody(memory.body);
    setPinned(memory.pinned);
    setShowForm(true);
  };

  const togglePin = async (memory: MemoryEntry) => {
    await window.yuanfang.updateMemory({ id: memory.id, change: { pinned: !memory.pinned } });
    load();
  };

  const remove = async (memory: MemoryEntry) => {
    if (!window.confirm(`删除记忆「${memory.title}」？`)) return;
    await window.yuanfang.deleteMemory(memory.id);
    load();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div>
            <h2>记忆</h2>
            <p>系统 Agent 和项目负责人共用的长期记忆。下一次对话会从这里开始。</p>
          </div>
          <div className="modal-header-actions">
            <button
              className="primary-button"
              onClick={() => {
                setEditingId(null);
                setTitle("");
                setBody("");
                setPinned(false);
                setShowForm((value) => !value);
              }}
            >
              {showForm ? "收起" : "新建记忆"}
            </button>
            <button className="icon-button" onClick={onClose}>
              ✕
            </button>
          </div>
        </header>

        {showForm ? (
          <div className="memory-form">
            <div className="form-row">
              <label>
                标题
                <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="一句话记住" />
              </label>
              <label>
                类型
                <select value={kind} onChange={(event) => setKind(event.target.value as MemoryKind)}>
                  <option value="note">笔记</option>
                  <option value="decision">决策</option>
                  <option value="architecture">架构</option>
                  <option value="preference">偏好</option>
                </select>
              </label>
              <label>
                范围
                <select value={scope === "all" ? "global" : scope} onChange={(event) => setScope(event.target.value as "global" | "project")}>
                  <option value="global">全局</option>
                  {projectId !== null ? <option value="project">当前项目</option> : null}
                </select>
              </label>
            </div>
            <label>
              内容
              <textarea value={body} rows={4} onChange={(event) => setBody(event.target.value)} placeholder="写下事实、原因和下次要注意什么。" />
            </label>
            <div className="form-actions">
              <label className="inline-check">
                <input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.target.checked)} />
                置顶
              </label>
              <button className="primary-button" disabled={saving} onClick={() => void save()}>
                {saving ? "保存中…" : editingId === null ? "保存记忆" : "保存修改"}
              </button>
            </div>
          </div>
        ) : null}

        <div className="filter-row">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索记忆…" />
          <select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}>
            <option value="all">全部</option>
            <option value="global">全局</option>
            {projectId !== null ? <option value="project">当前项目</option> : null}
          </select>
          <span className="muted">{filtered.length} 条</span>
        </div>

        <div className="memory-list">
          {filtered.map((memory) => (
            <div key={memory.id} className="memory-card">
              <div className="memory-card-top">
                <span className={`chip ${memory.kind}`}>{memory.kind}</span>
                {memory.pinned ? <span className="chip pinned">置顶</span> : null}
                <span className="memory-time">{formatRelative(memory.updatedAt)}</span>
              </div>
              <h4>{memory.title}</h4>
              <p>{memory.body}</p>
              {memory.tags.length > 0 ? <div className="tag-row">{memory.tags.map((tag) => <span key={tag} className="tag">{tag}</span>)}</div> : null}
              <div className="memory-actions">
                <button className="small-button ghost" onClick={() => void togglePin(memory)}>
                  {memory.pinned ? "取消置顶" : "置顶"}
                </button>
                <button className="small-button ghost" onClick={() => edit(memory)}>
                  编辑
                </button>
                <button className="small-button danger" onClick={() => void remove(memory)}>
                  删除
                </button>
              </div>
            </div>
          ))}
          {filtered.length === 0 ? <div className="transcript-empty">没有匹配的记忆。</div> : null}
        </div>
      </div>
    </div>
  );
}
