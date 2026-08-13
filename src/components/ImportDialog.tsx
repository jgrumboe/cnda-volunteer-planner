import { useState } from 'react';
import type { EventDay, Person, PlanState, Task } from '../types';
import { getBackendMode } from '../lib/backend/index';
import {
  detectSheetKind,
  importFormResponses,
  importPersons,
  importTasks,
  mergePeople,
  type ImportReport,
  type SheetKind,
} from '../lib/importers';
import { parseCsv, readXlsx, type Sheet } from '../lib/xlsx';
import { normalize } from '../lib/storage';
import { ConfirmButton } from './ConfirmButton';
import { Modal } from './Modal';

interface Staged {
  sheetName: string;
  kind: SheetKind;
  people?: Person[];
  tasks?: Task[];
  report: ImportReport;
  include: boolean;
}

/** Sheets that look like leftovers rather than the live data — off by default. */
const STALE_NAME = /\b(old|older|copy|backup|alt|previous|archive|20\d\d)\b|\(old\)/i;

const KIND_LABEL: Record<SheetKind, string> = {
  tasks: 'Tasks & timetable',
  persons: 'People list',
  formResponses: 'Google Form registrations',
  unknown: 'Not recognised',
};

export function ImportDialog({
  state,
  onApply,
  onRestore,
  onClose,
}: {
  state: PlanState;
  onApply: (people: Person[], tasks: Task[], replaceTasks: boolean) => void;
  onRestore: (state: PlanState) => void;
  onClose: () => void;
}) {
  const [staged, setStaged] = useState<Staged[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [replaceTasks, setReplaceTasks] = useState(false);
  const [busy, setBusy] = useState(false);
  const [backup, setBackup] = useState<PlanState | null>(null);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    setBackup(null);
    const next: Staged[] = [];

    try {
      for (const file of Array.from(files)) {
        let sheets: Sheet[];
        if (/\.json$/i.test(file.name)) {
          const parsed = JSON.parse(await file.text()) as Partial<PlanState>;
          if (!Array.isArray(parsed.tasks) || !Array.isArray(parsed.people)) {
            throw new Error(`${file.name} is not a planner backup (no people/tasks arrays).`);
          }
          setBackup(normalize(parsed));
          continue;
        }
        if (/\.csv$/i.test(file.name)) {
          sheets = [{ name: file.name.replace(/\.csv$/i, ''), rows: parseCsv(await file.text()) }];
        } else if (/\.xlsx$/i.test(file.name)) {
          sheets = await readXlsx(file);
        } else {
          throw new Error(`${file.name}: only .xlsx, .csv and .json backups are supported.`);
        }

        for (const sheet of sheets) {
          if (sheet.rows.length < 2) continue;
          next.push(stage(sheet, state.days));
        }
      }

      // A workbook often holds leftovers ("Tasks (old)") alongside the live sheet.
      // Keep only the first usable sheet of each kind switched on, so importing
      // never silently doubles up.
      const seenKinds = new Set<SheetKind>();
      for (const s of next) {
        if (!s.include) continue;
        if (seenKinds.has(s.kind)) s.include = false;
        else seenKinds.add(s.kind);
      }

      setStaged(next);
      if (next.length === 0) return;
      if (next.every((s) => s.kind === 'unknown')) {
        setError('Could not recognise any sheet. Expected a Tasks sheet, a People sheet or Form responses.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const usable = staged.filter((s) => s.kind !== 'unknown' && s.include);
  const incomingPeople = usable.flatMap((s) => s.people ?? []);
  const incomingTasks = usable.flatMap((s) => s.tasks ?? []);
  const preview = mergePeople(state.people, incomingPeople);
  const droppedColumns = [...new Set(usable.flatMap((s) => s.report.droppedColumns))];

  return (
    <Modal
      title="Import from spreadsheet"
      wide
      onClose={onClose}
      footer={
        <>
          <button
            className="btn primary"
            disabled={usable.length === 0}
            onClick={() => onApply(incomingPeople, incomingTasks, replaceTasks)}
          >
            Import {preview.added > 0 ? `${preview.added} new` : ''}
            {preview.added > 0 && preview.updated > 0 ? ' + ' : ''}
            {preview.updated > 0 ? `${preview.updated} updated` : ''}
            {incomingTasks.length > 0 ? ` · ${incomingTasks.length} tasks` : ''}
            {preview.added === 0 && preview.updated === 0 && incomingTasks.length === 0 ? 'nothing' : ''}
          </button>
          {incomingTasks.length > 0 ? (
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={replaceTasks}
                onChange={(e) => setReplaceTasks(e.target.checked)}
              />
              Replace existing tasks (also clears assignments)
            </label>
          ) : null}
        </>
      }
    >
      <div
        className={`dropzone ${over ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void handleFiles(e.dataTransfer.files);
        }}
      >
        <p style={{ margin: '0 0 8px' }}>
          {busy ? 'Reading…' : 'Drop the Google Sheets / Forms export here'}
        </p>
        <label className="btn" style={{ display: 'inline-block' }}>
          Choose files
          <input
            type="file"
            accept=".xlsx,.csv,.json"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => void handleFiles(e.target.files)}
          />
        </label>
        <p className="hint" style={{ margin: '10px 0 0' }}>
          <code>.xlsx</code>, <code>.csv</code>, or a <code>.json</code> backup — read entirely in your
          browser. {getBackendMode() === 'local' ? 'Nothing is uploaded anywhere.' : 'Changes sync to all connected organizers.'}
        </p>
      </div>

      {error ? (
        <ul className="issues" style={{ marginTop: 14 }}>
          <li>{error}</li>
        </ul>
      ) : null}

      {backup ? (
        <div className="panel" style={{ marginTop: 14 }}>
          <h3>Restore full backup</h3>
          <p className="hint" style={{ margin: '0 0 10px' }}>
            <strong>{backup.eventName}</strong> — {backup.people.length} people, {backup.tasks.length}{' '}
            tasks, {backup.assignments.length} assignments. Restoring replaces everything currently in this
            browser, including your rule settings.
          </p>
          <ConfirmButton
            className="btn primary"
            label="Restore this backup"
            question={`Replace the current plan (${state.people.length} people, ${state.assignments.length} assignments)?`}
            confirmLabel="Yes, restore"
            onConfirm={() => onRestore(backup)}
          />
        </div>
      ) : null}

      {droppedColumns.length > 0 ? (
        <div className="panel" style={{ marginTop: 14 }}>
          <h3>Columns deliberately not imported</h3>
          <p className="hint" style={{ margin: '0 0 8px' }}>
            Scheduling never needs these, so they are dropped at the file boundary and never stored.
          </p>
          <div className="pilllist">
            {droppedColumns.map((c) => (
              <span className="pill drop" key={c}>
                {c}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {staged.length > 0 ? (
        <div className="panel" style={{ marginTop: 14 }}>
          <h3>Detected sheets</h3>
          <table className="grid">
            <thead>
              <tr>
                <th style={{ width: 34 }}>Use</th>
                <th>Sheet</th>
                <th>Recognised as</th>
                <th className="num">Rows read</th>
                <th className="num">Empty rows</th>
              </tr>
            </thead>
            <tbody>
              {staged.map((s, i) => (
                <tr key={i} style={s.include ? undefined : { opacity: 0.45 }}>
                  <td>
                    <input
                      type="checkbox"
                      checked={s.include}
                      disabled={s.kind === 'unknown'}
                      title={
                        s.kind === 'unknown'
                          ? 'Not a recognised sheet'
                          : 'Include this sheet in the import'
                      }
                      onChange={(e) =>
                        setStaged((prev) =>
                          prev.map((x, xi) => (xi === i ? { ...x, include: e.target.checked } : x)),
                        )
                      }
                    />
                  </td>
                  <td>{s.sheetName}</td>
                  <td style={{ color: s.kind === 'unknown' ? 'var(--faint)' : undefined }}>
                    {KIND_LABEL[s.kind]}
                  </td>
                  <td className="num">{s.report.added}</td>
                  <td className="num">{s.report.skipped}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {usable.some((s) => s.report.messages.length > 0) ? (
            <ul className="issues" style={{ marginTop: 10 }}>
              {usable.flatMap((s) => s.report.messages).map((m, i) => (
                <li key={i} className="warn">
                  {m}
                </li>
              ))}
            </ul>
          ) : null}

          <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
            People are matched by name, so re-importing an updated response sheet adds the new
            registrations and merges availability into the ones already there — it will not create
            duplicates.
          </p>
        </div>
      ) : null}
    </Modal>
  );
}

function stage(sheet: Sheet, days: readonly EventDay[]): Staged {
  const kind = detectSheetKind(sheet.name, sheet.rows);
  const include = kind !== 'unknown' && !STALE_NAME.test(sheet.name);

  if (kind === 'tasks') {
    const { tasks, report } = importTasks(sheet.rows, days);
    return { sheetName: sheet.name, kind, tasks, report, include };
  }
  if (kind === 'formResponses') {
    const { people, report } = importFormResponses(sheet.rows, days);
    return { sheetName: sheet.name, kind, people, report, include };
  }
  if (kind === 'persons') {
    const { people, report } = importPersons(sheet.rows, days);
    return { sheetName: sheet.name, kind, people, report, include };
  }
  return {
    sheetName: sheet.name,
    kind,
    report: { added: 0, skipped: 0, messages: [], droppedColumns: [] },
    include: false,
  };
}
