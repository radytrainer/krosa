import { GraduationCap } from 'lucide-react';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
              View academic results across all five terms. Sign-in becomes available once accounts
              are set up.
            </CardDescription>
          </div>
          <SystemStatus />
        </CardHeader>
      </Card>
    </main>
  );
}
