import type { ThemeMode } from "@yuanfang/shared";
import { api } from "./api";

const THEME_KEY = "yf.theme";
const SCALE_KEY = "yf.uiScale";

export function cachedTheme(): ThemeMode | null {
  const value = localStorage.getItem(THEME_KEY);
  return value === "dark" || value === "light" || value === "system" ? value : null;
}

export function cachedScale(): number | null {
  const value = Number(localStorage.getItem(SCALE_KEY));
  return Number.isFinite(value) && value >= 0.8 && value <= 1.4 ? value : null;
}

/** Apply a theme and keep following the OS when mode is "system". */
export function applyTheme(theme: ThemeMode): () => void {
  localStorage.setItem(THEME_KEY, theme);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const paint = () => {
    const resolved = theme === "system" ? (media.matches ? "dark" : "light") : theme;
    document.documentElement.dataset.theme = resolved;
  };
  paint();
  if (theme !== "system") return () => undefined;
  media.addEventListener("change", paint);
  return () => media.removeEventListener("change", paint);
}

/** Scale the entire renderer, including controls and spacing, like a UI font-size setting. */
export function applyUiScale(scale: number): void {
  const value = Math.min(1.4, Math.max(0.8, Number.isFinite(scale) ? scale : 1));
  localStorage.setItem(SCALE_KEY, String(value));
  document.documentElement.style.setProperty("--ui-scale", String(value));
  void api.setZoom(value).catch(() => undefined);
}

export function applyCachedAppearance(): void {
  const theme = cachedTheme();
  if (theme !== null) applyTheme(theme);
  const scale = cachedScale();
  if (scale !== null) applyUiScale(scale);
}
