import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthShell } from '@/components/app/auth-shell';
import { PageLoading } from '@/components/app/states';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <AuthShell
      title="Sign in"
      description="Student Score Record System. Use your username, or your student ID."
    >
      <Suspense fallback={<PageLoading />}>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
