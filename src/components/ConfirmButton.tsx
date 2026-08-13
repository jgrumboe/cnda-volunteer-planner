import { useEffect, useState } from 'react';

/**
 * Two-step confirmation, rendered in-app.
 *
 * Deliberately not window.confirm(): embedded and sandboxed browser contexts
 * suppress native dialogs and return false immediately, which silently cancels
 * the action with no feedback at all.
 */
export function ConfirmButton({
  label,
  question,
  confirmLabel = 'Yes, do it',
  className = 'btn',
  danger = false,
  title,
  onConfirm,
}: {
  label: string;
  question: string;
  confirmLabel?: string;
  className?: string;
  danger?: boolean;
  title?: string;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);

  // Don't leave a primed destructive button lying around.
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 10_000);
    return () => clearTimeout(t);
  }, [armed]);

  if (!armed) {
    return (
      <button className={className} title={title} onClick={() => setArmed(true)}>
        {label}
      </button>
    );
  }

  return (
    <span className="confirm-inline">
      <span className="confirm-q">{question}</span>
      <button
        className={`btn tiny ${danger ? 'danger' : 'primary'}`}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button className="btn tiny ghost" onClick={() => setArmed(false)}>
        Cancel
      </button>
    </span>
  );
}
