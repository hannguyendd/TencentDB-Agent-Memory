import type { ReactNode } from 'react';
import { Card } from 'tea-component';
import './asset-page-header.css';

interface AssetPageHeaderProps {
  title: string;
  scope: ReactNode;
  agent?: ReactNode;
  actions?: ReactNode;
  subtitle?: ReactNode;
}

/**
 * Shared header for asset pages.
 *
 * Only responsible for the visual layout of the title, asset scope, Agent filter and action bar; each asset page still maintains its own
 * data fetching, permission checks and button enabled state, to avoid coupling the business semantics of different assets into the generic component.
 */
export function AssetPageHeader({ title, scope, agent, actions, subtitle }: AssetPageHeaderProps) {
  return (
    <Card className="_asset-page-header">
      <Card.Body>
        <div className="_asset-page-header-main">
          <h2 className="_asset-page-header-title">{title}</h2>
          <div className="_asset-page-header-right">
            <div className="_asset-page-header-filters">
              {scope}
              {agent}
            </div>
            {actions && <div className="_asset-page-header-actions">{actions}</div>}
          </div>
        </div>
        {subtitle && <div className="_asset-page-header-subtitle">{subtitle}</div>}
      </Card.Body>
    </Card>
  );
}
