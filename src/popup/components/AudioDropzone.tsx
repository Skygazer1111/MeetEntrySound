import { useRef, useState } from 'react';

interface Props {
  busy: boolean;
  error: string | null;
  onFile: (file: File) => void;
}

export function AudioDropzone({ busy, error, onFile }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <div>
      <div
        className={`dropzone${over ? ' over' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const file = e.dataTransfer.files[0];
          if (file) onFile(file);
        }}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <path d="M12 16V4m0 0L7 9m5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div className="dropzone-title">{busy ? 'Processing…' : 'Drop your entrance music here'}</div>
        <div className="muted">MP3 or WAV, up to 15 MB · or click to browse</div>
        <input
          ref={input}
          type="file"
          accept=".mp3,.wav,audio/mpeg,audio/wav"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) onFile(file);
          }}
        />
      </div>
      {error && <div className="alert error">{error}</div>}
    </div>
  );
}
