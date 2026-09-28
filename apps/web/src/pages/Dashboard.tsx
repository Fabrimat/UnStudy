import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, Doc, uploadFailed, uploadFile } from '../api';

const busy = (d: Doc) =>
  (d.status === 'uploaded' && !uploadFailed(d)) || d.jobs.some((j) => j.status === 'queued' || j.status === 'running');

function docStatus(d: Doc) {
  if (d.status === 'uploaded') return uploadFailed(d) ? 'Upload failed — please upload the file again' : 'Analyzing…';
  if (d.status === 'rejected') return `Rejected: ${d.rejectReason}`;
  const job = d.jobs[0];
  if (!job) return `${d.pages} pages · ${d.credits} credits`;
  if (job.status === 'done') return 'Done';
  if (job.status === 'failed') return 'Failed';
  return `${job.progress}%`;
}

export default function Dashboard() {
  const qc = useQueryClient();
  const [errors, setErrors] = useState<string[]>([]);
  const docs = useQuery({
    queryKey: ['documents'],
    queryFn: () => api<Doc[]>('/documents'),
    refetchInterval: (q) => (q.state.data?.some(busy) ? 3000 : false),
  });

  async function upload(files: FileList | null) {
    for (const file of Array.from(files ?? [])) {
      try {
        await uploadFile(file);
      } catch (e) {
        setErrors((list) => [...list, `${file.name}: ${(e as Error).message}`]);
      }
      await qc.invalidateQueries({ queryKey: ['documents'] });
    }
  }

  return (
    <section className="space-y-6">
      <label
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          upload(e.dataTransfer.files);
        }}
        className="block cursor-pointer rounded-lg border-2 border-dashed bg-white p-10 text-center"
      >
        Drop PDFs here or click to choose (max 50 MB, 400 pages each)
        <input type="file" accept="application/pdf" multiple hidden onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
      </label>
      {errors.map((e) => <p key={e} className="text-red-600">{e}</p>)}
      <ul className="divide-y rounded border bg-white">
        {docs.data?.length === 0 && <li className="p-3 text-gray-500">No documents yet.</li>}
        {docs.data?.map((d) => (
          <li key={d.id} className="flex justify-between gap-4 p-3">
            <Link to={`/documents/${d.id}`} className="truncate underline">{d.filename}</Link>
            <span className="shrink-0 text-sm text-gray-600">{docStatus(d)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
