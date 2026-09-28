import { useQuery } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { api } from '../api';

export default function Login() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api<{ google: boolean }>('/auth/providers') });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api('/auth/magic-link', { method: 'POST', body: JSON.stringify({ email }) });
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main className="mx-auto mt-24 max-w-sm space-y-4 p-6">
      <h1 className="text-2xl font-semibold">Log in to Summarize</h1>
      {sent ? (
        <p>Check your inbox: we sent a login link to {email}. It is valid for 15 minutes.</p>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <label className="block">
            Email
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-full rounded border bg-white p-2" />
          </label>
          <button className="w-full rounded bg-black p-2 text-white">Send login link</button>
          {error && <p className="text-red-600">{error}</p>}
        </form>
      )}
      {providers.data?.google && (
        <a href="/api/auth/google" className="block rounded border bg-white p-2 text-center">Continue with Google</a>
      )}
    </main>
  );
}
