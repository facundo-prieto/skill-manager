// shadcn's dark variant keys off a .dark class on <html>. "system" follows the OS, live.
export type Theme = "light" | "dark" | "system";

const KEY = "skill-manager:theme";
const os = matchMedia("(prefers-color-scheme: dark)");

export const getTheme = (): Theme => (localStorage.getItem(KEY) as Theme | null) ?? "system";

export function applyTheme() {
  const t = getTheme();
  document.documentElement.classList.toggle("dark", t === "dark" || (t === "system" && os.matches));
}

export function setTheme(t: Theme) {
  if (t === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, t);
  applyTheme();
}

os.addEventListener("change", applyTheme);
