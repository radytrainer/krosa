import { GraduationCap, LogIn } from 'lucide-react';
import Link from 'next/link';
import { HomeRedirect } from '@/components/app/home-redirect';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SystemStatus } from '@/components/system-status';

export default function Home() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <Card className="w-full max-w-md">
        <CardHeader className="gap-4">
          <div className="flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <GraduationCap className="size-6" aria-hidden />
          </div>
          <div className="space-y-1">
            <CardTitle className="text-2xl">Student Score Record System</CardTitle>
            <CardDescription>
              View academic results across all five terms. Students sign in with their student ID;
              administrators with their username.
            </CardDescription>
          </div>
          <SystemStatus />
        </CardHeader>
        <CardContent>
          <Link href="/login" className={buttonVariants({ size: 'lg', className: 'w-full' })}>
            <LogIn aria-hidden />
            Sign in
          </Link>
        </CardContent>
      </Card>
      <HomeRedirect />
    </main>
  );
}
