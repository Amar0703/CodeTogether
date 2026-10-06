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
  value,
  onChange,
  readOnly,
}: {
  name: string;
  value: string;
  onChange: (value: string) => void;
  readOnly: boolean;
}) {
  return (
    <CodeMirror
      aria-label="Code editor"
      value={value}
      onChange={onChange}
      theme={oneDark}
      extensions={[language(name)]}
      editable={!readOnly}
      readOnly={readOnly}
      height="100%"
      basicSetup={{ foldGutter: true, highlightActiveLine: !readOnly, autocompletion: !readOnly }}
    />
  );
}
