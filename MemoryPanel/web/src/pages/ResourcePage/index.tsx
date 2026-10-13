/**
 * Generic shell for resource management pages -- shared by Wiki / Code / Skills / Memory
 *
 * Both admin and member display content normally
 * The outer layer is wrapped by ConsoleLayout's Content.Body, and this is a direct child node.
 */
import type { ReactNode } from 'react';
import './styles/page-style.css';

export function ResourcePage({ children }: { children: ReactNode }) {
  return (
    <div className="_memory-page-body">
      {children}
    </div>
  );
}
