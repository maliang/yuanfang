import { createRoot } from "react-dom/client";
import { App } from "./App";
import { api } from "./lib/api";
import { applyCachedAppearance } from "./lib/appearance";
import "./styles.css";

document.body.dataset.platform = api.platform;
applyCachedAppearance();

const container = document.getElementById("root");
if (container === null) throw new Error("root element missing");
createRoot(container).render(<App />);
