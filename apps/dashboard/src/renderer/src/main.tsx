import "./assets/main.css";

import { createRoot } from "react-dom/client";
import { TooltipProvider } from "./components/ui/tooltip";
import App from "./App";

createRoot(document.getElementById("root") as HTMLElement).render(
  <TooltipProvider>
    <App />
  </TooltipProvider>
);
