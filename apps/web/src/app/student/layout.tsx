'use client';

import { ClipboardList, LayoutDashboard, UserRound } from 'lucide-react';
import { AppShell, type NavItem } from '@/components/app/app-shell';

const NAV: NavItem[] = [
  { href: '/student', label: 'Overview', icon: LayoutDashboard, exact: true },
  { href: '/student/results', label: 'My results', icon: ClipboardList },
  { href: '/student/profile', label: 'Profile', icon: UserRound },
];

export default function StudentLayout({ children }: LayoutProps<'/student'>) {
  return (
    <AppShell role="STUDENT" subtitle="Student portal" nav={NAV}>
      {children}
    </AppShell>
  );
}
