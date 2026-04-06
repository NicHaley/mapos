import "./assets/main.css";

import { createRoot } from "react-dom/client";

// Apply dark mode based on system preference
const applyTheme = (dark: boolean) => document.documentElement.classList.toggle("dark", dark);
const mq = window.matchMedia("(prefers-color-scheme: dark)");
applyTheme(mq.matches);
mq.addEventListener("change", (e) => applyTheme(e.matches));
import App from "./App";
import { TooltipProvider } from "./components/ui/tooltip";

createRoot(document.getElementById("root") as HTMLElement).render(
  <TooltipProvider delay={300}>
    <App />
  </TooltipProvider>
);
