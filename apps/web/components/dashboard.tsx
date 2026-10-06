'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowRight,
  Plus,
  Search,
  LayoutGrid,
  LogOut,
  FolderCode,
  LockKeyhole,
  Globe2,
  Link2,
  ArrowUpRight,
  Code2,
} from 'lucide-react';
import type { Room, User } from '@codetogether/contracts';
import { api, ApiError, message } from '../lib/api';
import { Brand, Avatar, Loading, ErrorBanner, Modal } from './ui';
export function Dashboard() {
  const router = useRouter();
  const [user, setUser] = useState<User>();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<'create' | 'join' | null>(null);
  const [busy, setBusy] = useState(false);
  const [modalError, setModalError] = useState('');
  useEffect(() => {
    Promise.all([api<{ user: User }>('/auth/me'), api<{ rooms: Room[] }>('/rooms')])
      .then(([u, r]) => {
        setUser(u.user);
        setRooms(r.rooms);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) router.replace('/login');
        else setError(message(err));
      });
  }, [router]);
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setModalError('');
    const form = new FormData(e.currentTarget);
    try {
      const result = await api<{ room: Room }>('/rooms', 'POST', Object.fromEntries(form));
      router.push(`/rooms/${result.room.id}`);
    } catch (err) {
      setModalError(message(err));
    } finally {
      setBusy(false);
    }
  }
  async function join(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setModalError('');
    const value = String(new FormData(e.currentTarget).get('link')).trim();
    try {
      const match = value.match(/(?:\/join\/)?([a-f0-9]{64})\/?$/);
      if (match) {
        router.push(`/join/${match[1]}`);
        return;
      }
      const roomId = value.match(/(?:\/rooms\/)?([a-f0-9-]{36})\/?$/)?.[1];
      if (!roomId) throw new Error('Paste a room invitation or a public room link.');
      await api(`/rooms/${roomId}/join`, 'POST');
      router.push(`/rooms/${roomId}`);
    } catch (err) {
      setModalError(message(err));
    } finally {
      setBusy(false);
    }
  }
  const showModal = (value: 'create' | 'join') => {
    setModalError('');
    setModal(value);
  };
  if (!user)
    return error ? (
      <div className="standalone">
        <ErrorBanner error={error} />
        <button className="button" onClick={() => window.location.reload()}>
          Try again
        </button>
      </div>
    ) : (
      <Loading />
    );
  const visible = rooms.filter((r) =>
    `${r.name} ${r.description}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="dashboard">
      <aside className="sidebar">
        <Brand />
        <div className="sidebar-label">WORKSPACE</div>
        <Link className="nav-item active" href="/">
          <LayoutGrid size={18} /> My rooms <span>{rooms.length}</span>
        </Link>
        <button className="nav-item" onClick={() => showModal('join')}>
          <Link2 size={18} /> Join a room
        </button>
        <div className="sidebar-note">
          <div className="mini-symbol">
            <Code2 />
          </div>
          <h3>Make something great.</h3>
          <p>
            Start a room. Share an idea.
            <br />
            See where it takes you.
          </p>
          <button className="text-button" onClick={() => showModal('create')}>
            Start building <ArrowUpRight size={15} />
          </button>
        </div>
        <div className="user-card">
          <Avatar name={user.name} />
          <div>
            <strong>{user.name}</strong>
            <span>Personal workspace</span>
          </div>
          <button
            aria-label="Sign out"
            className="icon-button"
            onClick={async () => {
              try {
                await api('/auth/logout', 'POST');
                router.replace('/login');
              } catch (err) {
                setError(message(err));
              }
            }}
          >
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      <main className="dashboard-main">
        <header className="dashboard-top">
          <span>
            Workspace <span className="breadcrumb-slash">/</span> <strong>My rooms</strong>
          </span>
          <span className="quiet-label">A place to build, together</span>
        </header>
        <div className="dashboard-content">
          <div className="welcome">
            <div>
              <span className="eyebrow">YOUR WORKSPACE, YOUR POSSIBILITIES</span>
              <h1>
                Hey, {user.name.split(' ')[0]}
                <span className="brand-dot">.</span>
              </h1>
              <p className="muted">Pick up where you left off, or start something new.</p>
            </div>
            <button className="button primary" onClick={() => showModal('create')}>
              <Plus size={18} /> Create a room
            </button>
          </div>
          <ErrorBanner error={error} />
          <section className="welcome-banner">
            <div>
              <span className="eyebrow">GREAT IDEAS NEED A LITTLE SPACE</span>
              <h2>One room. A world of possibilities.</h2>
              <p>Your code, your people, and a shared place to make progress.</p>
              <button className="text-button" onClick={() => showModal('join')}>
                Have an invite? Join your team <ArrowRight size={16} />
              </button>
            </div>
            <div className="banner-graphic" aria-hidden="true">
              <span>
                {'{'}
                <Code2 size={46} />
                {'}'}
              </span>
              <i className="orb one" />
              <i className="orb two" />
            </div>
          </section>
          <div className="rooms-heading">
            <div>
              <h2>
                Your rooms <span className="count-badge">{rooms.length}</span>
              </h2>
              <p className="muted">A home for every project.</p>
            </div>
            <label className="search">
              <Search size={17} />
              <input
                aria-label="Search rooms"
                placeholder="Search your rooms…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          </div>
          {visible.length > 0 ? (
            <div className="room-grid">
              {visible.map((room, i) => (
                <Link href={`/rooms/${room.id}`} className="room-card" key={room.id}>
                  <div className="room-card-top">
                    <span className={`room-icon tone-${i % 3}`}>
                      <FolderCode size={24} />
                    </span>
                    <span className="role-badge">{room.role.toLowerCase()}</span>
                  </div>
                  <h3>{room.name}</h3>
                  <p>{room.description || 'A fresh space for your next idea.'}</p>
                  <div className="room-card-bottom">
                    <span>
                      {room.visibility === 'PRIVATE' ? (
                        <LockKeyhole size={13} />
                      ) : (
                        <Globe2 size={13} />
                      )}
                      {room.visibility.toLowerCase()}
                      <span className="dot-separator">·</span>
                      {new Date(room.updatedAt).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                    <ArrowUpRight size={18} />
                  </div>
                </Link>
              ))}
              <button className="new-room-card" onClick={() => showModal('create')}>
                <span>
                  <Plus size={22} />
                </span>
                <strong>Make room for an idea</strong>
                <p>Create a new workspace</p>
              </button>
            </div>
          ) : (
            <div className="empty-state">
              <span className="empty-icon">
                <FolderCode size={34} />
              </span>
              <h3>{search ? 'No rooms found' : 'Your next project starts here'}</h3>
              <p>
                {search
                  ? 'Try a different name or clear your search.'
                  : 'Create your first room and invite someone to build with you.'}
              </p>
              <button
                className="button primary"
                onClick={() => (search ? setSearch('') : showModal('create'))}
              >
                {search ? 'Clear search' : 'Create your first room'}
                <ArrowRight size={16} />
              </button>
            </div>
          )}
          <footer className="dashboard-footer">
            <span>
              <span className="status-dot" /> Files persist between sessions
            </span>
            <span>Built for the way you think.</span>
          </footer>
        </div>
      </main>
      {modal && (
        <Modal
          title={modal === 'create' ? 'Make room for an idea' : 'Join your people'}
          close={() => !busy && setModal(null)}
        >
          <p className="muted">
            {modal === 'create'
              ? 'Give your project a name. You can invite your team next.'
              : 'Paste an invitation link or a public room link to get started.'}
          </p>
          <form onSubmit={modal === 'create' ? create : join}>
            <ErrorBanner error={modalError} />
            {modal === 'create' ? (
              <>
                <label>
                  Room name
                  <input
                    name="name"
                    placeholder="e.g. Binary Search Practice"
                    required
                    minLength={2}
                    maxLength={80}
                    autoFocus
                  />
                </label>
                <label>
                  Description <span className="muted">(optional)</span>
                  <textarea
                    name="description"
                    placeholder="What are you building?"
                    maxLength={400}
                    rows={3}
                  />
                </label>
                <label>
                  Visibility
                  <select name="visibility">
                    <option value="PRIVATE">Private — invitation required</option>
                    <option value="PUBLIC">Public — anyone with the link can join as viewer</option>
                  </select>
                </label>
              </>
            ) : (
              <label>
                Room or invitation link
                <input name="link" placeholder="Paste your link here" required autoFocus />
              </label>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="button"
                onClick={() => setModal(null)}
                disabled={busy}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? 'One moment…' : modal === 'create' ? 'Create room' : 'Join room'}
                <ArrowRight size={16} />
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
