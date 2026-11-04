export interface ToastItem {
  id: number;
  title: string;
  body: string;
  tone: "info" | "warning" | "error";
}

export function Toasts({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toast-stack">
      {items.map((item) => (
        <button key={item.id} className={`toast tone-${item.tone}`} onClick={() => onDismiss(item.id)}>
          <strong>{item.title}</strong>
          <span>{item.body}</span>
        </button>
      ))}
    </div>
  );
}
