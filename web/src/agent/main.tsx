import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Softphone from "./Softphone";
import "../theme.css";
import "./phone.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Softphone />
  </StrictMode>
);
