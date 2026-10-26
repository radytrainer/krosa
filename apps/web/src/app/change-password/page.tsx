import type { Metadata } from 'next';
import { ForcedPasswordChange } from './forced-password-change';

export const metadata: Metadata = { title: 'Choose a new password' };

export default function ChangePasswordPage() {
  return <ForcedPasswordChange />;
}
