/**
 * WorkbenchPage -- task board page
 *
 * ConsoleLayout already provides the Content + Content.Body wrapper, so the page only needs to render the content.
 */
import { useMemo } from 'react';
import { useAuthStore } from '@/stores/auth';
import { useTeams, useAgents } from '@/services';
import { useCurrentRole } from '@/services/useCurrentRole';
import TaskWorkbench from './components/TaskWorkbench';

export function WorkbenchPage() {
  const { auth } = useAuthStore();
  const role = useCurrentRole();
  const { activeTeamId } = useTeams();
  const { agents: teamAgentList } = useAgents(activeTeamId);
  const teamAgents = useMemo(
    () => teamAgentList.map((a) => ({ id: a.agent_id, name: a.name })),
    [teamAgentList]
  );

  if (!auth) return null;

  return (
    <TaskWorkbench
      activeTeamId={activeTeamId}
      currentUser={auth.user_id}
      agents={teamAgents}
      isAdmin={role === 'admin'}
    />
  );
}
