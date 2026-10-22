import React from "react";
import { createRoot } from "react-dom/client";
import Home from "../../app/page";
import DesktopWorkspace from "../../components/studio/desktop-workspace";
import ResultBubble from "../../components/studio/result-bubble";
import "../../app/globals.css";
import "../../components/studio/glass-workbench.css";
import "../../components/studio/glass-popup.css";

const query = new URLSearchParams(window.location.search);
const workspace = query.get("workspace") === "1";
const resultId = query.get("result");
document.documentElement.dataset.window = workspace ? "workspace" : resultId ? "result" : "panel";
createRoot(document.getElementById("root")!).render(workspace ? <DesktopWorkspace /> : resultId ? <ResultBubble resultId={resultId} /> : <Home />);
