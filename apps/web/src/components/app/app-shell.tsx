'use client';

import {
  GraduationCap,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Suspense, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import { PageLoading } from '@/components/app/states';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAuth, useRequireRole } from '@/lib/auth';
import type { Role } from '@/lib/types';
import { cn } from '@/lib/utils';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Match only the exact path (for portal home links). */
  exact?: boolean;
}

/** Per-browser preference; storage can be unavailable (private mode), so failures are ignored. */
const COLLAPSED_KEY = 'ssrs:sidebar-collapsed';

const listeners = new Set<() => void>();

/** Sidebar preference as an external store: shared by tabs, server snapshot = expanded. */
const collapsedStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    window.addEventListener('storage', listener);
    return () => {
      listeners.delete(listener);
      window.removeEventListener('storage', listener);
    };
  },
  get(): boolean {
    try {
      return window.localStorage.getItem(COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  },
  set(value: boolean) {
    try {
      window.localStorage.setItem(COLLAPSED_KEY, value ? '1' : '0');
    } catch {
      // The preference simply isn't remembered.
    }
    listeners.forEach((l) => l());
  },
};

function isCurrent(pathname: string, item: NavItem): boolean {
  return item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/** Shows `label` beside the control while the sidebar is collapsed to icons. */
function RailTooltip({
  label,
  enabled,
  children,
}: {
  label: string;
  enabled: boolean;
  children: ReactElement;
}) {
  if (!enabled) return children;
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function NavLinks({
  items,
  pathname,
  collapsed,
  onNavigate,
}: {
  items: NavItem[];
  pathname: string;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  return (
    <ul className="space-y-1">
      {items.map((item) => {
        const current = isCurrent(pathname, item);
        return (
          <li key={item.href}>
            <RailTooltip label={item.label} enabled={collapsed}>
              <Link
                href={item.href}
                onClick={onNavigate}
                aria-current={current ? 'page' : undefined}
                aria-label={collapsed ? item.label : undefined}
                className={cn(
                  'relative flex h-9 items-center gap-3 rounded-lg px-2.5 text-sm font-medium text-sidebar-foreground/75 transition-colors outline-none hover:bg-sidebar-accent/60 hover:text-sidebar-foreground focus-visible:ring-3 focus-visible:ring-sidebar-ring/40',
                  collapsed && 'justify-center px-0',
                  current &&
                    'bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                )}
              >
                <item.icon className="size-[18px] shrink-0" aria-hidden />
                {collapsed ? null : <span className="truncate">{item.label}</span>}
              </Link>
            </RailTooltip>
          </li>
        );
      })}
    </ul>
  );
}

function Brand({ subtitle, collapsed = false }: { subtitle: string; collapsed?: boolean }) {
  return (
    <div className={cn('flex min-w-0 items-center gap-2.5', collapsed && 'justify-center')}>
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
        <GraduationCap className="size-5" aria-hidden />
      </div>
      {collapsed ? null : (
        <div className="min-w-0 leading-tight">
          <p className="truncate text-sm font-semibold">Score Records</p>
          <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        </div>
      )}
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

function UserBlock({
  name,
  detail,
  collapsed,
}: {
  name: string;
  detail: string;
  collapsed: boolean;
}) {
  const { signOut } = useAuth();
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 border-t border-sidebar-border pt-3',
        collapsed && 'flex-col gap-2',
      )}
    >
      <RailTooltip label={`${name} · ${detail}`} enabled={collapsed}>
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-xs font-semibold text-sidebar-accent-foreground"
          role="img"
          aria-label={`${name}, ${detail}`}
        >
          {initials(name)}
        </span>
      </RailTooltip>
      {collapsed ? null : (
        <div className="min-w-0 flex-1" aria-hidden>
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="truncate text-xs text-muted-foreground">{detail}</p>
        </div>
      )}
      <RailTooltip label="Sign out" enabled={collapsed}>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Sign out"
          onClick={() => void signOut()}
          className="text-sidebar-foreground/70 hover:text-sidebar-foreground"
        >
          <LogOut aria-hidden />
        </Button>
      </RailTooltip>
    </div>
  );
}

interface AppShellProps {
  role: Role;
  subtitle: string;
  nav: NavItem[];
  footerNav?: NavItem[];
  children: ReactNode;
}

/**
 * Portal layout: sidebar on large screens (collapsible to an icon rail, remembered per browser),
 * slide-out menu below `lg`. Renders nothing until the signed-in user is confirmed to have
 * `role`. Everything depends on the session and the URL, so the prerendered HTML is only the
 * loading state.
 */
export function AppShell(props: AppShellProps) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Shell {...props} />
    </Suspense>
  );
}

function Shell({ role, subtitle, nav, footerNav, children }: AppShellProps) {
  const me = useRequireRole(role);
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const collapsed = useSyncExternalStore(collapsedStore.subscribe, collapsedStore.get, () => false);

  if (!me) return <PageLoading />;
  const name = me.student?.fullName ?? me.displayName ?? me.username;
  const detail = me.student?.studentCode ?? (role === 'ADMIN' ? 'Administrator' : me.username);

  const toggle = () => collapsedStore.set(!collapsed);

  /** `rail`: icons only (collapsed desktop sidebar). `onNavigate`: inside the mobile menu. */
  const sidebar = (rail: boolean, onNavigate?: () => void) => (
    <div className="flex h-full flex-col gap-6 px-3 py-4">
      <div className={cn('flex items-center gap-2', rail ? 'flex-col' : 'justify-between')}>
        <Brand subtitle={subtitle} collapsed={rail} />
        {onNavigate ? null : (
          <RailTooltip label="Expand sidebar" enabled={rail}>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggle}
              aria-label={rail ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!rail}
              className="text-sidebar-foreground/60 hover:text-sidebar-foreground"
            >
              {rail ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
            </Button>
          </RailTooltip>
        )}
      </div>
      <nav aria-label="Main" className="flex-1 overflow-x-hidden overflow-y-auto">
        <NavLinks items={nav} pathname={pathname} collapsed={rail} onNavigate={onNavigate} />
      </nav>
      <div className="space-y-3">
        {footerNav ? (
          <nav aria-label="Account">
            <NavLinks
              items={footerNav}
              pathname={pathname}
              collapsed={rail}
              onNavigate={onNavigate}
            />
          </nav>
        ) : null}
        <UserBlock name={name} detail={detail} collapsed={rail} />
      </div>
    </div>
  );

  return (
    <div className="flex min-h-full flex-1">
      <a
        href="#main"
        className="sr-only z-50 rounded bg-background px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <aside
        className={cn(
          'sticky top-0 hidden h-dvh shrink-0 border-r border-sidebar-border bg-sidebar transition-[width] duration-200 lg:block',
          collapsed ? 'w-[4.25rem]' : 'w-64',
        )}
      >
        {sidebar(collapsed)}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-card/95 px-4 backdrop-blur lg:hidden">
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger
              render={<Button variant="ghost" size="icon" aria-label="Open navigation" />}
            >
              <Menu aria-hidden />
            </SheetTrigger>
            <SheetContent side="left" className="w-72 bg-sidebar p-0">
              <SheetHeader className="sr-only">
                <SheetTitle>Navigation</SheetTitle>
              </SheetHeader>
              {sidebar(false, () => setMenuOpen(false))}
            </SheetContent>
          </Sheet>
          <Brand subtitle={subtitle} />
        </header>
        <main
          id="main"
          className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
