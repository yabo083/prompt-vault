import { DiffEditor } from "@monaco-editor/react";

export default function ComparatorDiff({ original, modified }: { original: string; modified: string }) {
  return (
    <DiffEditor
      original={original}
      modified={modified}
      language="plaintext"
      theme={document.documentElement.dataset.theme === "dark" ? "vs-dark" : "light"}
      options={{
        readOnly: true,
        renderSideBySide: true,
        minimap: { enabled: false },
        fontSize: 12,
        lineHeight: 19,
        scrollBeyondLastLine: false,
        wordWrap: "on",
      }}
    />
  );
}
