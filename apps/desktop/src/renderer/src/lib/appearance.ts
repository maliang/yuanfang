import type { ThemeMode } from "@yuanfang/shared";
import { api } from "./api";

const THEME_KEY = "yf.theme";
const SCALE_KEY = "yf.uiScale";
const ACCENT_KEY = "yf.accent";
const DEFAULT_ACCENT = "#7c8cff";

export function cachedTheme(): ThemeMode | null {
  const value = localStorage.getItem(THEME_KEY);
  return value === "dark" || value === "light" || value === "system" ? value : null;
}

export function cachedScale(): number | null {
  const value = Number(localStorage.getItem(SCALE_KEY));
  return Number.isFinite(value) && value >= 0.8 && value <= 1.4 ? value : null;
}

export function cachedAccent(): string | null {
  const value = localStorage.getItem(ACCENT_KEY);
  return value !== null && /^#[0-9a-fA-F]{6}$/.test(value) ? value : null;
}

export function validAccent(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
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

/** Apply the user's accent color without replacing the rest of the theme. */
export function applyAccent(accent: string): void {
  if (!validAccent(accent)) return;
  const value = accent.toLowerCase();
  localStorage.setItem(ACCENT_KEY, value);
  const root = document.documentElement.style;
  root.setProperty("--accent", value);
  root.setProperty("--accent-soft", `${value}24`);
  const red = Number.parseInt(value.slice(1, 3), 16) / 255;
  const green = Number.parseInt(value.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(value.slice(5, 7), 16) / 255;
  const linear = (channel: number) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
  root.setProperty("--accent-contrast", luminance > 0.36 ? "#0b0d15" : "#ffffff");
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
  const accent = cachedAccent();
  applyAccent(accent ?? DEFAULT_ACCENT);
  const scale = cachedScale();
  if (scale !== null) applyUiScale(scale);
}
