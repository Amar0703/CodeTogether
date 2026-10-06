import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'CodeTogether — A place to build',
  description:
    'Your shared coding workspace. Create a room, invite your team, and keep your ideas in one place.',
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
