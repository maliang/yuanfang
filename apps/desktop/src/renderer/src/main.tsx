import { createRoot } from "react-dom/client";
import { App } from "./App";
import { api } from "./lib/api";
import "./styles.css";

document.body.dataset.platform = api.platform;

const container = document.getElementById("root");
if (container === null) throw new Error("root element missing");
createRoot(container).render(<App />);
