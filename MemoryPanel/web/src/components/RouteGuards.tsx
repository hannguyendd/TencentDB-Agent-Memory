/**
 * RouteGuards — Route-level permission guards
 *
 * - ResourceGuard: admin role visiting resource pages → redirect to the workbench
 * - MemberManageGuard: member role visiting the member management page → redirect to the workbench
 */
import { type ReactNode, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCurrentRole, type TeamRole } from '@/services/useCurrentRole';

/** Resource management page guard: hidden from admin */
export function ResourceGuard({ children }: { children: ReactNode }) {
  const role = useCurrentRole();
  const navigate = useNavigate();
  const blocked = role === 'admin';

  useEffect(() => {
    if (blocked) navigate('/', { replace: true });
  }, [blocked, navigate]);

  return blocked ? null : <>{children}</>;
}

/** Member management guard: hidden from reviewer (visible to admin / member).
 *  member can view the member list and add existing members, but the buttons for creating/deleting members and creating/deleting a Team Team
 *  are restricted by role inside TeamManagementPanel. */
export function MemberManageGuard({ children, allowedRoles }: {
  children: ReactNode;
  allowedRoles?: TeamRole[];
}) {
  const role = useCurrentRole();
  const navigate = useNavigate();
  const allowed = allowedRoles ?? ['admin', 'member'];
  const blocked = role !== null && !allowed.includes(role);

  useEffect(() => {
    if (blocked) navigate('/', { replace: true });
  }, [blocked, navigate]);

  return blocked ? null : <>{children}</>;
}
