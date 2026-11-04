/** Turn an Electron accelerator into a short label for the current platform. */
export function formatHotkey(accelerator: string, platform = window.yuanfang.platform): string {
  const isMac = platform === "darwin";
  return accelerator
    .split("+")
    .map((part) => {
      switch (part) {
        case "CommandOrControl":
        case "Command":
        case "Cmd":
          return isMac ? "⌘" : "Ctrl";
        case "Control":
        case "Ctrl":
          return isMac ? "⌃" : "Ctrl";
        case "Shift":
          return isMac ? "⇧" : "Shift";
        case "Alt":
        case "Option":
          return isMac ? "⌥" : "Alt";
        case "Super":
        case "Meta":
          return isMac ? "⌘" : "Win";
        case "Space":
          return "Space";
        default:
          return part;
      }
    })
    .join(isMac ? "" : "+");
}
