'use client';
import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { Code2, X, LoaderCircle } from 'lucide-react';
export function Brand() {
  return (
    <Link className="brand" href="/" aria-label="CodeTogether home">
      <span className="brand-symbol">
        <Code2 size={22} />
      </span>
      CodeTogether<span className="brand-dot">.</span>
    </Link>
  );
}
export function Avatar({ name, small = false }: { name: string; small?: boolean }) {
  return (
    <span className={`avatar ${small ? 'small' : ''}`} aria-label={name}>
      {name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()}
    </span>
  );
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" /> Opening your workspace…
    </div>
  );
}
export function ErrorBanner({ error }: { error: string }) {
  return error ? (
    <div className="error-banner" role="alert">
      {error}
    </div>
  ) : null;
}
export function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <button className="icon-button" onClick={close} aria-label="Close dialog">
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
