/**
 * AdminResourceLock -- lock notice when an Admin account accesses resource management.
 * Uses Tea `Card` + `Icon` to carry the empty-state notice.
 */
import { useTranslation } from 'react-i18next';
import { Card } from 'tea-component';
import { LockOnIcon } from 'tea-icons-react';
import './admin-resource-lock.css';

export function AdminResourceLock() {
  const { t } = useTranslation();
  return (
    <div className="_memory-admin-lock-wrap">
      <Card className="_memory-admin-lock-card">
        <Card.Body>
          <LockOnIcon size={32} className="_memory-admin-lock-icon" />
          <div className="_memory-admin-lock-title">{t('adminLock.title')}</div>
          <div className="_memory-admin-lock-desc">
            {t('adminLock.desc')}
          </div>
        </Card.Body>
      </Card>
    </div>
  );
}
