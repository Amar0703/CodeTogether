'use client';
import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  ChevronDown,
  Code2,
  Copy,
  FileCode2,
  FilePlus2,
  Folder,
  FolderPlus,
  LockKeyhole,
  LogOut,
  Pencil,
  RefreshCw,
  Save,
  Settings2,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import type { RoomDetail, RoomFile } from '@codetogether/contracts';
import { api, ApiError, message } from '../lib/api';
import { Avatar, ErrorBanner, Loading, Modal } from './ui';
const Editor = dynamic(() => import('./editor'), { ssr: false, loading: () => <Loading /> });
type Dialog = 'file' | 'folder' | 'rename' | 'invite' | 'settings' | null;
export function Workspace({ id }: { id: string }) {
  const router = useRouter();
  const [detail, setDetail] = useState<RoomDetail>();
  const [active, setActive] = useState<RoomFile>();
  const [draft, setDraft] = useState('');
  const [folderId, setFolderId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [dialogError, setDialogError] = useState('');
  const [invite, setInvite] = useState('');
  const [copied, setCopied] = useState(false);
  const [people, setPeople] = useState(true);
  const dirty = !!active && draft !== active.content;
  const canEdit = detail?.room.role !== 'VIEWER';
  const isOwner = detail?.room.role === 'OWNER';
  const refresh = useCallback(async () => {
    const result = await api<RoomDetail>(`/rooms/${id}`);
    setDetail(result);
    return result;
  }, [id]);
  useEffect(() => {
    refresh()
      .then((result) => {
        const file = result.files.find((f) => f.kind === 'FILE');
        setActive(file);
        setDraft(file?.content ?? '');
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401)
          router.replace(`/login?next=${encodeURIComponent(`/rooms/${id}`)}`);
        else setError(message(err));
      });
  }, [id, refresh, router]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const save = useCallback(async () => {
    if (!active || !dirty || !canEdit || saving) return;
    setSaving(true);
    setError('');
    try {
      const result = await api<{ file: RoomFile }>(`/files/${active.id}`, 'PATCH', {
        content: draft,
        version: active.version,
      });
      setActive(result.file);
      setDetail((prev) =>
        prev
          ? { ...prev, files: prev.files.map((f) => (f.id === result.file.id ? result.file : f)) }
          : prev,
      );
    } catch (err) {
      setError(message(err));
    } finally {
      setSaving(false);
    }
  }, [active, dirty, canEdit, saving, draft]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [save]);
  const discard = () => !dirty || window.confirm('You have unsaved changes. Discard your draft?');
  async function openFile(file: RoomFile) {
    if (saving || busy) return;
    if (file.kind === 'FOLDER') {
      setFolderId(file.id);
      setCollapsed((previous) => {
        const next = new Set(previous);
        if (next.has(file.id)) next.delete(file.id);
        else next.add(file.id);
        return next;
      });
      return;
    }
    if (file.id === active?.id || !discard()) return;
    setBusy(true);
    try {
      const result = await api<{ file: RoomFile }>(`/files/${file.id}`);
      setActive(result.file);
      setDraft(result.file.content);
      setFolderId(null);
      setError('');
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  async function reload() {
    if (saving || !discard()) return;
    setBusy(true);
    try {
      const result = await refresh();
      const file =
        result.files.find((f) => f.id === active?.id) ??
        result.files.find((f) => f.kind === 'FILE');
      setActive(file);
      setDraft(file?.content ?? '');
      if (!result.files.some((f) => f.id === folderId)) setFolderId(null);
      setError('');
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  const showDialog = (value: Dialog) => {
    setDialogError('');
    setInvite('');
    setCopied(false);
    setDialog(value);
  };
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setDialogError('');
    const data = new FormData(e.currentTarget);
    try {
      if (dialog === 'invite') {
        const result = await api<{ url: string }>(`/rooms/${id}/invites`, 'POST', {
          role: data.get('role'),
          expiresInHours: Number(data.get('expiresInHours')),
        });
        setInvite(result.url);
      } else if (dialog === 'settings') {
        await api(`/rooms/${id}`, 'PATCH', Object.fromEntries(data));
        await refresh();
        setDialog(null);
      } else if (dialog === 'rename') {
        const target = folderId ? detail?.files.find((f) => f.id === folderId) : active;
        if (!target) throw new Error('Select a file or folder first.');
        await api(`/files/${target.id}/name`, 'PATCH', { name: data.get('name') });
        const result = await refresh();
        if (active) {
          const renamed = result.files.find((f) => f.id === active.id);
          if (renamed) setActive({ ...active, name: renamed.name, path: renamed.path });
        }
        setDialog(null);
      } else {
        const parentId = String(data.get('parentId') ?? '') || null;
        const result = await api<{ file: RoomFile }>(`/rooms/${id}/files`, 'POST', {
          name: data.get('name'),
          kind: dialog === 'folder' ? 'FOLDER' : 'FILE',
          parentId,
        });
        await refresh();
        if (parentId)
          setCollapsed((prev) => {
            const next = new Set(prev);
            next.delete(parentId);
            return next;
          });
        if (result.file.kind === 'FILE') {
          setActive(result.file);
          setDraft(result.file.content);
          setFolderId(null);
        } else setFolderId(result.file.id);
        setDialog(null);
      }
    } catch (err) {
      setDialogError(message(err));
    } finally {
      setBusy(false);
    }
  }
  async function removeFile() {
    const target = folderId ? detail?.files.find((f) => f.id === folderId) : active;
    if (
      !target ||
      !discard() ||
      !window.confirm(
        `Delete ${target.name}${target.kind === 'FOLDER' ? ' and everything inside it' : ''}? This cannot be undone.`,
      )
    )
      return;
    setBusy(true);
    try {
      await api(`/files/${target.id}`, 'DELETE');
      const result = await refresh();
      const remaining =
        result.files.find((f) => f.id === active?.id) ??
        result.files.find((f) => f.kind === 'FILE');
      setActive(remaining);
      setDraft(remaining?.content ?? '');
      setFolderId(null);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  async function memberAction(userId: string, role?: string) {
    setBusy(true);
    setError('');
    try {
      await api(
        `/rooms/${id}/members/${userId}`,
        role ? 'PATCH' : 'DELETE',
        role ? { role } : undefined,
      );
      await refresh();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  function tree(parentId: string | null, depth = 0): React.ReactNode {
    return detail?.files
      .filter((f) => f.parentId === parentId)
      .sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'FOLDER' ? -1 : 1,
      )
      .map((file) => (
        <div key={file.id}>
          <button
            className={`tree-file ${(file.id === active?.id && !folderId) || file.id === folderId ? 'selected' : ''}`}
            style={{ paddingLeft: 14 + depth * 16 }}
            onClick={() => void openFile(file)}
            title={file.path}
            disabled={busy || saving}
          >
            {file.kind === 'FOLDER' ? (
              <>
                {collapsed.has(file.id) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                <Folder size={16} className="folder-icon" />
              </>
            ) : (
              <FileCode2 size={16} className="file-icon" />
            )}
            <span>{file.name}</span>
          </button>
          {file.kind === 'FOLDER' && !collapsed.has(file.id) && tree(file.id, depth + 1)}
        </div>
      ));
  }
  if (!detail)
    return error ? (
      <main className="standalone">
        <ErrorBanner error={error} />
        <button className="button" onClick={() => router.push('/')}>
          Back to rooms
        </button>
      </main>
    ) : (
      <Loading />
    );
  const target = folderId ? detail.files.find((f) => f.id === folderId) : active;
  return (
    <main className="studio">
      <header className="studio-header">
        <button
          className="studio-back"
          aria-label="Back to rooms"
          disabled={saving}
          onClick={() => {
            if (discard()) router.push('/');
          }}
        >
          <span className="brand-symbol">
            <Code2 size={22} />
          </span>
          <ArrowLeft size={16} />
        </button>
        <span className="studio-divider" />
        <div className="studio-title">
          <strong>{detail.room.name}</strong>
          <span>
            <LockKeyhole size={11} /> {detail.room.visibility.toLowerCase()} workspace
          </span>
        </div>
        <span className="role-badge">{detail.room.role.toLowerCase()}</span>
        <div className="studio-actions">
          <button
            className={`button small ${people ? 'pressed' : ''}`}
            aria-label="Toggle members"
            onClick={() => setPeople(!people)}
          >
            <Users size={16} />
            <span>{detail.members.length}</span>
          </button>
          {isOwner && (
            <>
              <button
                className="button small"
                onClick={() => showDialog('settings')}
                aria-label="Room settings"
              >
                <Settings2 size={16} />
              </button>
              <button className="button primary small" onClick={() => showDialog('invite')}>
                <UserPlus size={16} /> Invite
              </button>
            </>
          )}
        </div>
      </header>
      <div className="studio-body">
        <aside className="file-panel">
          <div className="panel-heading">
            <span>EXPLORER</span>
            <button
              className="icon-button"
              aria-label="Refresh files"
              title="Refresh files"
              disabled={busy || saving}
              onClick={() => void reload()}
            >
              <RefreshCw size={14} />
            </button>
          </div>
          <button className="tree-root" onClick={() => setFolderId(null)}>
            <ChevronDown size={14} />
            <Folder size={15} />
            {detail.room.name}
          </button>
          <div className="file-tree">
            {tree(null)}
            {!detail.files.length && (
              <p className="panel-hint">No files yet. Add one to start building.</p>
            )}
          </div>
          {canEdit && (
            <>
              <div className="file-tools">
                <button
                  className="icon-button"
                  aria-label="New file"
                  title="New file"
                  disabled={busy || saving}
                  onClick={() => {
                    if (discard()) showDialog('file');
                  }}
                >
                  <FilePlus2 size={17} />
                </button>
                <button
                  className="icon-button"
                  aria-label="New folder"
                  title="New folder"
                  disabled={busy || saving}
                  onClick={() => showDialog('folder')}
                >
                  <FolderPlus size={17} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Rename selected"
                  title="Rename selected"
                  disabled={!target || busy || saving}
                  onClick={() => showDialog('rename')}
                >
                  <Pencil size={15} />
                </button>
                <button
                  className="icon-button danger-text"
                  aria-label="Delete selected"
                  title="Delete selected"
                  disabled={!target || busy || saving}
                  onClick={() => void removeFile()}
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <div className="panel-hint">
                {folderId
                  ? `Selected folder: ${target?.name}`
                  : 'Select the room name to add files at the root.'}
              </div>
            </>
          )}
          <div className="workspace-note">
            <span className="status-dot" />
            <strong>A little focus goes a long way.</strong>
            <p>Save your work. Come back with a fresh perspective.</p>
          </div>
        </aside>
        <section className="editor-panel">
          <div className="editor-toolbar">
            <div className="file-tab">
              <FileCode2 size={15} />
              {active?.name ?? 'Welcome'}
              {dirty && <span className="unsaved-dot" aria-label="Unsaved changes" />}
            </div>
            <div className="save-actions">
              <span className="save-state">
                {saving ? (
                  'Saving…'
                ) : dirty ? (
                  'Unsaved changes'
                ) : (
                  <>
                    <Check size={13} /> Saved
                  </>
                )}
              </span>
              <button
                className="button primary small"
                disabled={!dirty || saving || busy || !canEdit}
                onClick={() => void save()}
              >
                <Save size={14} /> Save
              </button>
            </div>
          </div>
          <div className="file-breadcrumb">
            {active?.path.slice(1).split('/').join('  /  ') ?? 'Open a file to start'}
            <span>{canEdit ? 'Ctrl / ⌘ + S to save' : 'Viewer · read-only'}</span>
          </div>
          <ErrorBanner error={error} />
          {error.includes('changed since') && (
            <div className="conflict-actions">
              <button
                className="button small"
                onClick={() => {
                  const blob = new Blob([draft], { type: 'text/plain' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `draft-${active?.name ?? 'file.txt'}`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Download your draft
              </button>
              <button className="button small" onClick={() => void reload()}>
                Reload saved version
              </button>
            </div>
          )}
          <div className="editor-surface">
            {active ? (
              <Editor
                key={active.id}
                name={active.name}
                value={draft}
                onChange={setDraft}
                readOnly={!canEdit || busy}
              />
            ) : (
              <div className="editor-empty">
                <Code2 size={40} />
                <h2>A blank page. A fresh start.</h2>
                <p>Create a file or choose one from the explorer.</p>
                {canEdit && (
                  <button className="button primary" onClick={() => showDialog('file')}>
                    <FilePlus2 size={16} /> Create a file
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="editor-bottom">
            <span>
              <span className="status-dot" />
              {canEdit ? 'Ready to build' : 'Read-only access'}
            </span>
            <span>
              {active
                ? `Version ${active.version}  ·  ${draft.split('\n').length} lines  ·  UTF-8`
                : 'No file selected'}
            </span>
          </div>
        </section>
        {people && (
          <aside className="people-panel">
            <div className="panel-heading">
              <span>
                ROOM MEMBERS <b>{detail.members.length}</b>
              </span>
              <button
                className="icon-button"
                aria-label="Hide members"
                onClick={() => setPeople(false)}
              >
                <X size={15} />
              </button>
            </div>
            <p className="panel-hint">The people who share this space.</p>
            {detail.members.map((member) => (
              <div className="member" key={member.id}>
                <div className="member-info">
                  <Avatar name={member.name} small />
                  <div>
                    <strong>{member.name}</strong>
                    <span>{member.role.toLowerCase()}</span>
                  </div>
                </div>
                {isOwner && member.role !== 'OWNER' && (
                  <div className="member-controls">
                    <select
                      aria-label={`Role for ${member.name}`}
                      value={member.role}
                      disabled={busy}
                      onChange={(e) => void memberAction(member.id, e.target.value)}
                    >
                      <option value="EDITOR">Editor</option>
                      <option value="VIEWER">Viewer</option>
                    </select>
                    <button
                      className="icon-button danger-text"
                      aria-label={`Remove ${member.name}`}
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`Remove ${member.name} from this room?`))
                          void memberAction(member.id);
                      }}
                    >
                      <X size={13} />
                    </button>
                  </div>
                )}
              </div>
            ))}
            {isOwner && (
              <button className="invite-outline" onClick={() => showDialog('invite')}>
                <UserPlus size={16} /> Invite someone
              </button>
            )}
            <div className="room-description">
              <span className="eyebrow">ABOUT THIS ROOM</span>
              <p>
                {detail.room.description ||
                  'A shared space to work through ideas, one line at a time.'}
              </p>
            </div>
            <div className="manual-note">
              <RefreshCw size={16} />
              <p>
                Use refresh to load your team’s latest saved files. Live editing is coming in a
                later phase.
              </p>
            </div>
            {!isOwner && (
              <button
                className="button small leave-button"
                disabled={busy || saving}
                onClick={async () => {
                  if (
                    !discard() ||
                    !window.confirm(
                      'Leave this room? You will need an invitation to rejoin private rooms.',
                    )
                  )
                    return;
                  setBusy(true);
                  try {
                    const { user } = await api<{ user: { id: string } }>('/auth/me');
                    await api(`/rooms/${id}/members/${user.id}`, 'DELETE');
                    router.push('/');
                  } catch (err) {
                    setError(message(err));
                    setBusy(false);
                  }
                }}
              >
                <LogOut size={14} /> Leave room
              </button>
            )}
          </aside>
        )}
      </div>
      {dialog && (
        <Modal
          title={
            {
              file: 'Create a file',
              folder: 'Create a folder',
              rename: 'Rename item',
              invite: 'Build better together',
              settings: 'Room settings',
            }[dialog]
          }
          close={() => !busy && setDialog(null)}
        >
          <form onSubmit={submit}>
            <ErrorBanner error={dialogError} />
            {dialog === 'invite' ? (
              <>
                <p className="muted">
                  Anyone with this invitation can join with the role you choose.
                </p>
                <label>
                  Access level
                  <select name="role">
                    <option value="EDITOR">Editor — can edit and save files</option>
                    <option value="VIEWER">Viewer — read-only access</option>
                  </select>
                </label>
                <label>
                  Invitation expires in
                  <select name="expiresInHours">
                    <option value="24">24 hours</option>
                    <option value="72">3 days</option>
                    <option value="168">7 days</option>
                  </select>
                </label>
                {invite && (
                  <div className="invite-result">
                    <label>
                      Invitation link
                      <input value={invite} readOnly onFocus={(e) => e.target.select()} />
                    </label>
                    <button
                      type="button"
                      className="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(invite);
                          setCopied(true);
                        } catch {
                          setDialogError('Select and copy the invitation link above.');
                        }
                      }}
                    >
                      <Copy size={14} />
                      {copied ? 'Copied!' : 'Copy link'}
                    </button>
                  </div>
                )}
              </>
            ) : dialog === 'settings' ? (
              <>
                <label>
                  Room name
                  <input
                    name="name"
                    defaultValue={detail.room.name}
                    minLength={2}
                    maxLength={80}
                    required
                  />
                </label>
                <label>
                  Description
                  <textarea
                    name="description"
                    defaultValue={detail.room.description}
                    maxLength={400}
                    rows={3}
                  />
                </label>
                <label>
                  Visibility
                  <select name="visibility" defaultValue={detail.room.visibility}>
                    <option value="PRIVATE">Private</option>
                    <option value="PUBLIC">Public — anyone with the link can join as viewer</option>
                  </select>
                </label>
                <div className="danger-zone">
                  <p>Deleting a room permanently removes its files, members, and invitations.</p>
                  <button
                    type="button"
                    className="button danger"
                    disabled={busy}
                    onClick={async () => {
                      if (
                        !window.confirm(
                          `Permanently delete "${detail.room.name}" and all its files?`,
                        )
                      )
                        return;
                      setBusy(true);
                      try {
                        await api(`/rooms/${id}`, 'DELETE');
                        setDraft(active?.content ?? '');
                        router.push('/');
                      } catch (err) {
                        setDialogError(message(err));
                        setBusy(false);
                      }
                    }}
                  >
                    Delete room
                  </button>
                </div>
              </>
            ) : (
              <>
                <label>
                  Name
                  <input
                    name="name"
                    placeholder={dialog === 'folder' ? 'e.g. src' : 'e.g. solution.py'}
                    defaultValue={dialog === 'rename' ? target?.name : ''}
                    maxLength={100}
                    required
                    autoFocus
                  />
                </label>
                {dialog !== 'rename' && (
                  <label>
                    Folder
                    <select name="parentId" defaultValue={folderId ?? ''}>
                      <option value="">/ (root)</option>
                      {detail.files
                        .filter((f) => f.kind === 'FOLDER')
                        .map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.path}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
              </>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                {busy
                  ? 'One moment…'
                  : dialog === 'invite'
                    ? 'Generate invitation'
                    : dialog === 'settings'
                      ? 'Save changes'
                      : dialog === 'rename'
                        ? 'Rename'
                        : 'Create'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </main>
  );
}
