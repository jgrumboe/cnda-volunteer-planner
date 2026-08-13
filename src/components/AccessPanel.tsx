/**
 * Access panel — organizer-only, manages memberships (invite/link/revoke).
 * Backed by the manage_membership RPC with last-organizer guard.
 */

import { useCallback, useEffect, useState } from 'react';
import type { PlanState } from '../types';
import { Modal } from './Modal';
import {
  listMemberships,
  addMembership,
  removeMembership,
  updateMembership,
  getPlanId,
  type Membership,
} from '../lib/backend/supabase/memberships';

interface Props {
  state: PlanState;
  onClose: () => void;
}

export function AccessPanel({ state, onClose }: Props) {
  const [members, setMembers] = useState<Membership[]>([]);
  const [planId, setPlanId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // New member form
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<'organizer' | 'volunteer'>('volunteer');

  const refresh = useCallback(async (pid: string) => {
    const result = await listMemberships(pid);
    if (result.error) {
      setError(result.error);
    } else if (result.data) {
      setMembers(result.data);
    }
  }, []);

  useEffect(() => {
    getPlanId().then((id) => {
      if (!id) {
        setError('Could not find plan');
        setLoading(false);
        return;
      }
      setPlanId(id);
      refresh(id).then(() => setLoading(false));
    });
  }, [refresh]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!planId || !newEmail.trim()) return;
    setError(null);
    const result = await addMembership(planId, newEmail.trim(), newRole);
    if (result.error) {
      setError(result.error);
    } else {
      setNewEmail('');
      await refresh(planId);
    }
  };

  const handleRemove = async (email: string) => {
    if (!planId) return;
    setError(null);
    const result = await removeMembership(planId, email);
    if (result.error) {
      setError(result.error);
    } else {
      await refresh(planId);
    }
  };

  const handleRoleChange = async (email: string, role: 'organizer' | 'volunteer') => {
    if (!planId) return;
    setError(null);
    const result = await updateMembership(planId, email, role);
    if (result.error) {
      setError(result.error);
    } else {
      await refresh(planId);
    }
  };

  const handleLink = async (email: string, personId: string | null) => {
    if (!planId) return;
    setError(null);
    const result = await updateMembership(planId, email, undefined, personId);
    if (result.error) {
      setError(result.error);
    } else {
      await refresh(planId);
    }
  };

  return (
    <Modal title="Access management" onClose={onClose}>
      {error ? <div className="signin-error" style={{ marginBottom: 12 }}>{error}</div> : null}

      {loading ? (
        <p style={{ color: 'var(--muted)' }}>Loading...</p>
      ) : (
        <>
          <table className="grid" style={{ marginBottom: 16 }}>
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Linked person</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.email}>
                  <td>{m.email}</td>
                  <td>
                    <select
                      value={m.role}
                      onChange={(e) => handleRoleChange(m.email, e.target.value as 'organizer' | 'volunteer')}
                    >
                      <option value="organizer">Organizer</option>
                      <option value="volunteer">Volunteer</option>
                    </select>
                  </td>
                  <td>
                    <select
                      value={m.personId ?? ''}
                      onChange={(e) => handleLink(m.email, e.target.value || null)}
                    >
                      <option value="">— not linked —</option>
                      {state.people.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button
                      className="btn tiny ghost"
                      title="Revoke access"
                      onClick={() => handleRemove(m.email)}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <form onSubmit={handleAdd} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="email"
              placeholder="email@example.com"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              style={{ flex: 1 }}
            />
            <select value={newRole} onChange={(e) => setNewRole(e.target.value as 'organizer' | 'volunteer')}>
              <option value="volunteer">Volunteer</option>
              <option value="organizer">Organizer</option>
            </select>
            <button className="btn" type="submit" disabled={!newEmail.trim()}>
              Invite
            </button>
          </form>

          <p className="hint" style={{ marginTop: 12 }}>
            Adding someone here gives them access to the plan. They still need to sign in
            (Google for organizers, magic link for volunteers once SMTP is configured).
            Link them to a person so their "My Shifts" tab shows the right schedule.
          </p>
        </>
      )}
    </Modal>
  );
}
