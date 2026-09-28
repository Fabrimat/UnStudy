import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api } from '../api';

export default function Verify() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice and the token is single-use
    started.current = true;
    api('/auth/magic-link/verify', { method: 'POST', body: JSON.stringify({ token: params.get('token') ?? '' }) })
      .then(() => qc.invalidateQueries({ queryKey: ['me'] }))
      .then(() => navigate('/', { replace: true }))
      .catch(() => setError('This login link is invalid or has expired.'));
  }, [params, navigate, qc]);

  return (
    <main className="mx-auto mt-24 max-w-sm space-y-3 p-6">
      {error ? (
        <>
          <p>{error}</p>
          <Link to="/login" className="underline">Request a new link</Link>
        </>
      ) : (
        <p>Logging in…</p>
      )}
    </main>
  );
}
