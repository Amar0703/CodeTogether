'use client';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { cpp } from '@codemirror/lang-cpp';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { useMemo } from 'react';
import { keymap } from '@codemirror/view';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import type { CollaborativeDocument } from '../lib/document';
export function language(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  if (['js', 'jsx', 'mjs', 'ts', 'tsx'].includes(ext ?? ''))
    return javascript({
      typescript: ext === 'ts' || ext === 'tsx',
      jsx: ext === 'jsx' || ext === 'tsx',
    });
  if (ext === 'py') return python();
  if (['c', 'cpp', 'h', 'hpp'].includes(ext ?? '')) return cpp();
  if (ext === 'json') return json();
  if (ext === 'html') return html();
  if (ext === 'css') return css();
  if (ext === 'md') return markdown();
  return [];
}
export default function Editor({
  name,
  document,
  readOnly,
}: {
  name: string;
  document: CollaborativeDocument;
  readOnly: boolean;
}) {
  const extensions = useMemo(
    () => [
      language(name),
      yCollab(document.text, document.awareness, { undoManager: document.undo }),
      keymap.of(yUndoManagerKeymap),
    ],
    [name, document],
  );
  const initial = useMemo(() => document.text.toString(), [document]);
  return (
    <CodeMirror
      aria-label="Code editor"
      value={initial}
      theme={oneDark}
      extensions={extensions}
      editable={!readOnly}
      readOnly={readOnly}
      height="100%"
      basicSetup={{
        history: false,
        historyKeymap: false,
        foldGutter: true,
        highlightActiveLine: !readOnly,
        autocompletion: !readOnly,
      }}
    />
  );
}
