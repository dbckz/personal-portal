import type { Metadata } from 'next';
import { MobileShell } from './MobileShell';

export const metadata: Metadata = {
  title: 'Portal',
  description: 'Mobile view of Dave\'s portal',
};

export default function MobilePage() {
  return <MobileShell />;
}
