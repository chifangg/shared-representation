import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import {
  registerClientTool,
  registerToolResult,
} from "@/core/tools/registry";
import { ReadProjectFile } from "@/core/tools/builtins/ReadProjectFile";
import { ReadProjectFileResultCard } from "@/core/tools/builtins/ReadProjectFileResultCard";
import { WriteProjectFile } from "@/core/tools/builtins/WriteProjectFile";
import { WriteProjectFileResultCard } from "@/core/tools/builtins/WriteProjectFileResultCard";
import { EditProjectFile } from "@/core/tools/builtins/EditProjectFile";
import { RunProjectTests } from "@/core/tools/builtins/RunProjectTests";
import { SearchProjectFiles } from "@/core/tools/builtins/SearchProjectFiles";
import {
  ChangeBlockColor,
  DeleteBlock,
  DiagramOpResultCard,
} from "@/features/diagram/tools/DiagramOps";
import "./styles.css";

// Claude can read / edit / write any file the user uploaded by calling
// these client tools. The handler components live entirely in the
// browser — they look up / mutate ProjectContext.files directly, never
// touching the network. `edit_project_file` reuses the write result
// card because both payloads carry the same diff/size shape.
registerClientTool("read_project_file", ReadProjectFile);
registerToolResult("read_project_file", ReadProjectFileResultCard);
registerClientTool("write_project_file", WriteProjectFile);
registerToolResult("write_project_file", WriteProjectFileResultCard);
registerClientTool("edit_project_file", EditProjectFile);
registerToolResult("edit_project_file", WriteProjectFileResultCard);

// Verify-and-locate tools: `run_project_tests` posts the in-memory
// project to the backend's isolated pytest sandbox (agents with no
// shell used to burn minutes mentally simulating the suite instead);
// `search_project_files` is an in-browser regex grep so finding a hook
// point does not require ingesting whole files.
registerClientTool("run_project_tests", RunProjectTests);
registerClientTool("search_project_files", SearchProjectFiles);

// Chat-driven diagram edits (bidirectional): recolor / delete a block on
// the architecture diagram. These mutate the diagram view, not code.
registerClientTool("change_block_color", ChangeBlockColor);
registerToolResult("change_block_color", DiagramOpResultCard);
registerClientTool("delete_block", DeleteBlock);
registerToolResult("delete_block", DiagramOpResultCard);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
