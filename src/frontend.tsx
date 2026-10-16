import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// follow the OS theme (shadcn's dark variant keys off a .dark class)
const dark = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", dark.matches);
dark.addEventListener("change", applyTheme);
applyTheme();

const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

// https://bun.com/docs/bundler/hot-reloading#import-meta-hot-data
(import.meta.hot.data.root ??= createRoot(document.getElementById("root")!)).render(app);
