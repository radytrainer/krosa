'use client';

import {
  CalendarRange,
  LayoutDashboard,
  RefreshCw,
  ScrollText,
  UserCog,
  Users,
} from 'lucide-react';
import { AppShell, type NavItem } from '@/components/app/app-shell';

const NAV: NavItem[] = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { href: '/admin/generations', label: 'Generations', icon: CalendarRange },
  { href: '/admin/students', label: 'Students', icon: Users },
  { href: '/admin/sync', label: 'Sync center', icon: RefreshCw },
  { href: '/admin/audit', label: 'Audit log', icon: ScrollText },
];

const FOOTER: NavItem[] = [{ href: '/admin/account', label: 'Account', icon: UserCog }];

export default function AdminLayout({ children }: LayoutProps<'/admin'>) {
  return (
    <AppShell role="ADMIN" subtitle="Administration" nav={NAV} footerNav={FOOTER}>
      {children}
    </AppShell>
  );
}
